"""A1: script whitelist + PAUSE segmentation, the pipe protocol, the fake host, result
reconciliation into ``Fix.applied`` and the gatekeeper's Genesis-output pull-back."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from engine.adapters.genesis import GenesisAdapter
from engine.adapters.genesis_host import FakeGenesisHost, result_from_log
from engine.adapters.genesis_pipe import PREFIX, GenesisPipe, parse_info_file
from engine.model.plan import build_plan
from engine.model.report import Fix, ReportItem, StageReport
from engine.output.genesis_script import build_script, build_segments, check_script
from engine.storage import Storage
from tests.conftest import Pipeline

ROOT = Path(__file__).resolve().parents[1]


def _rep(stage, *items):
    return StageReport(stage=stage, status="ok", items=list(items))


def _item(kind, layer, op, script, *, applied=False, eq=None, iid=None):
    return ReportItem(id=iid or f"{kind}_{layer}", kind=kind, severity="warn", layer=layer, message=kind, eq_question=eq,
                      fix=Fix(type=kind, op=op, auto_fixable=applied, applied=applied, genesis_script=script))  # fmt: skip


REPORTS = {
    "align": _rep("align", _item("profile_line_width", "gko", "SetProfile", "COM sel_change_sym,symbol=r5.906  【待验证】")),
    "outer": _rep(
        "outer",
        _item("smd_pads", "gtl", "SetSmdAttribute", "COM set_attribute,attribute=.smd  【待验证】"),
        _item("line_width", "gtl", "LineCompensation", "COM sel_resize,size=1  【待验证】\nrm -rf /  # 恶意行\nCOM sel_delete,x=`id`"),
        _item("ring", "gtl", "SignalLayerOptimize", "COM chklist_run,chklist=slo  【待验证】"),
    ),
    "silk": _rep("silk", _item("silk_outside_profile", "gto", "DeleteOutsideProfile", "COM sel_delete", applied=True)),
    "net_compare": _rep("net_compare"),
}


# ---- A1.1 whitelist ---------------------------------------------------------------------
def test_whitelist_neutralises_hostile_and_unfilled_lines():
    text = build_script("job-7", REPORTS)
    assert check_script(text) == []
    assert "# rm -rf /" in text and "# REFUSED (shell metachar): COM sel_delete,x=`id`" in text
    assert "COM sel_resize,size=1" in text
    # <job> gets filled, other placeholders keep the line out of execution
    assert "COM netlist_compare,job=job-7,step1=net" in text
    plan = build_plan("j", {"silk": _rep("silk", _item("h", "gto", "SilkTransform", "COM sel_transform,mode=anchor,x_scale=<k>"))})
    t2 = build_script("j", plan)
    assert "# UNFILLED placeholder: COM sel_transform" in t2 and check_script(t2) == []


def test_check_script_flags_bad_lines():
    bad = check_script("#!/bin/csh -f\nCOM open_job,job=x\nrm -rf /\nCOM a,b=$(x)\n")
    assert len(bad) == 2 and "rm -rf" in bad[0] and "metacharacter" in bad[1]


# ---- A1.2 segmentation ------------------------------------------------------------------
def test_segments_cut_after_each_pause_and_are_self_contained():
    parts = build_segments("job-7", REPORTS)
    # SetSmdAttribute + SignalLayerOptimize (outer) and NetlistCompare×2 (net_compare) are judgement
    # calls → one part per stage that has them (A4.2: the person reviews a stage once, in AIOS)
    names = [n for n, _ in parts]
    assert names == [f"genesis_job-7.part{i}.csh" for i in range(1, 3)]
    for i, (_, t) in enumerate(parts, 1):
        assert t.startswith("#!/bin/csh -f") and "COM open_job,job=job-7" in t and "COM close_job,job=job-7" in t
        assert check_script(t) == []
        assert t.count('\nPAUSE "') == 1 and t.count("# PAUSE point [") == 2  # per-call pauses folded into the stage pause
        assert (f'echo "PART_DONE job-7 part{i}"' in t) == (i < 2) and (f'echo "DONE job-7 part{i}"' in t) == (i == 2)
    assert 'PAUSE "[outer] 2 处待人工确认' in parts[0][1] and "SetSmdAttribute gtl, " in parts[0][1] and 'PAUSE "[net_compare] 2 处' in parts[1][1]
    blocks = sum(t.count("# ---- [") for _, t in parts)
    assert blocks == build_script("job-7", REPORTS).count("# ---- [")
    # no judgement call → one part
    only = build_segments("j", {"align": REPORTS["align"]})
    assert len(only) == 1 and '\nPAUSE "' not in only[0][1]


# ---- A1.3 pipe protocol -----------------------------------------------------------------
def test_pipe_protocol_wire_format():
    out = io.StringIO()
    inp = io.StringIO("0\n42\n" "1\nerror text\n" "0\n\nyes\n")
    p = GenesisPipe(inp=inp, out=out)
    r = p.com("get_select_count")
    assert r.ok and r.ans == "42"
    r2 = p.aux("bad_command,x=1")
    assert not r2.ok and r2.ans == "error text"
    r3 = p.pause("continue?")
    assert r3.ok and r3.extra == "yes"
    p.vof()
    lines = out.getvalue().splitlines()
    assert lines == [f"{PREFIX}COM get_select_count", f"{PREFIX}AUX bad_command,x=1", f"{PREFIX}PAUSE continue?", f"{PREFIX}VOF"]
    with pytest.raises(EOFError):
        p.com("after_eof")
    assert parse_info_file("set gNAME = 'l1'\nset gTYPE = (signal drill)\n") == {"gNAME": "l1", "gTYPE": ["signal", "drill"]}


# ---- fake host + result parsing ---------------------------------------------------------
def test_fake_host_runs_parts_and_writes_result(tmp_path):
    drop = tmp_path / "drop"
    g = GenesisAdapter(drop_dir=drop, host="fake")
    plan = build_plan("job-7", REPORTS)
    r = g.deliver("job-7", build_script("job-7", plan), parts=build_segments("job-7", plan), ops=[])
    assert len(r["parts"]) == 2
    res = FakeGenesisHost(drop).run_job("job-7")
    assert res["ok"] and [p["status"] for p in res["parts"]] == ["OK"] * 2
    keys = {c.key for c in plan.calls if not c.applied and (c.script or "").strip()}
    assert {o["key"] for o in res["ops"]} == keys and all(o["status"] == "OK" for o in res["ops"])
    assert (drop / "job-7.result.json").is_file() and "DONE job-7 part2" in res["log"]
    # a failing op stops the flow at its part (LineCompensation is in part 1 with the rest of outer)
    res2 = FakeGenesisHost(drop, fail_ops={"LineCompensation"}).run_job("job-7")
    assert not res2["ok"] and [p["status"] for p in res2["parts"]] == ["FAIL"]
    assert next(o for o in res2["ops"] if o["status"] == "FAIL")["op"] == "LineCompensation"
    # a pause without auto-continue reports PAUSED
    res3 = FakeGenesisHost(drop, auto_continue=False).run_job("job-7")
    assert not res3["ok"] and res3["parts"][0]["status"] == "PAUSED"


def test_result_from_log_shapes():
    log = "START j\nOK SetProfile gko key=abc\nFAIL LineCompensation gtl key=def STATUS=1\n"
    r = result_from_log("j", log)
    assert not r["ok"] and [o["status"] for o in r["ops"]] == ["OK", "FAIL"] and r["ops"][0]["layer"] == "gko"
    assert result_from_log("j", "START j\nOK X - key=k\nDONE j\n")["ok"] and result_from_log("j", "START j\nOK X - key=k\nDONE j\n")["ops"][0]["layer"] is None


# ---- A1.4 / A1.5 end to end through the registry ----------------------------------------
def test_reconcile_applies_fixes_and_gatekeeper_reads_genesis_outputs(tmp_path, monkeypatch):
    pipe = Pipeline(Storage(storage_root=tmp_path / "storage", work_root=tmp_path / "work"))
    out_rep = pipe.run("kicad-x2ap", "output")
    job = pipe.job_id("kicad-x2ap")
    drop = tmp_path / "drop"
    monkeypatch.setenv("PCB_CAM_ENGINE", "genesis")
    monkeypatch.setenv("PCB_GENESIS_DROP_DIR", str(drop))

    # first gatekeeper run: script + parts delivered, the job waits for the host (an EQ the engineer
    # releases when the host is done — aios re-runs the gatekeeper then)
    monkeypatch.setenv("PCB_GENESIS_VERSION", "g2000-v10.3")
    rep1 = pipe.run("kicad-x2ap", "gatekeeper", attempt=2)
    deliv = next(i for i in rep1.items if i.kind == "genesis_delivery")
    assert deliv.eq_question and deliv.fix and deliv.fix.type == "genesis_wait" and rep1.status == "needs_review"
    assert not any(i.kind == "genesis_pending" for i in rep1.items)
    assert (drop / f"{job}.csh").is_file() and (drop / f"{job}.json").is_file()
    env = json.loads((drop / f"{job}.json").read_text())
    assert env["parts"] and env["ops"] and env["protocol"].startswith("genesis-drop-v1") and env["parts_pending"] == env["parts"]
    assert env["genesis_version"] == "g2000-v10.3"
    work = pipe.storage.work_dir(job)
    archived = list((work / "genesis" / "archive" / "g2000-v10.3").rglob("*.csh"))
    assert len(archived) == 1 + len(env["parts"])
    # still waiting → pending EQ, and nothing is delivered twice
    submitted = env["submitted_at"]
    rep1b = pipe.run("kicad-x2ap", "gatekeeper", attempt=3)
    pend = next(i for i in rep1b.items if i.kind == "genesis_pending")
    assert pend.eq_question and pend.fix.type == "genesis_wait" and rep1b.status == "needs_review"
    assert json.loads((drop / f"{job}.json").read_text())["submitted_at"] == submitted and not any(i.kind == "genesis_delivery" for i in rep1b.items)

    # host runs everything and leaves one Gerber under <job>.out/
    gerber = next(a for a in out_rep.artifacts if a.kind == "gerber_review")
    (drop / f"{job}.out").mkdir()
    (drop / f"{job}.out" / gerber.filename).write_bytes(pipe.storage.read_object(gerber.path))
    res = FakeGenesisHost(drop).run_job(job)
    assert res["ok"]

    rep2 = pipe.run("kicad-x2ap", "gatekeeper", attempt=4)
    first = rep2.items[0]
    assert first.kind == "genesis_result" and first.severity == "info" and "执行完成" in first.message
    assert rep2.status != "blocked" and not any(i.eq_question and i.kind.startswith("genesis") for i in rep2.items)
    gen = [i for i in rep2.items if i.kind == "gate_genesis_layer"]
    assert gen and gen[-1].measured == 1 and all(i.severity == "info" for i in gen)
    assert (work / "genesis" / "result.json").is_file() and (work / "genesis_out" / gerber.filename).is_file()
    # fixes whose keys came back OK are now applied in the persisted reports (idempotently)
    outer = StageReport.model_validate_json((work / "reports" / "outer.json").read_text())
    applied = [i.id for i in outer.items if i.fix and i.fix.applied and i.fix.genesis_script]
    assert applied, "no outer fix was marked applied from the Genesis result"
    plan = json.loads((work / "plan" / "plan.json").read_text())
    ok_keys = {o["key"] for o in res["ops"] if o["status"] == "OK"}
    assert all(any(c["key"] in ok_keys and iid in c["item_ids"] for c in plan["calls"]) for iid in applied)

    # a failed part → error + EQ, job not silently ok. (LineCompensation is now applied and no longer
    # in the delivered script — idempotency — so fail on the mandatory NetlistCompare instead.)
    ok_before = {o["key"] for o in res["ops"] if o["status"] == "OK"}
    g = GenesisAdapter(drop_dir=drop)
    n_parts = len(g.part_names(job))
    FakeGenesisHost(drop, fail_ops={"NetlistCompare"}).run_job(job)
    rep3 = pipe.run("kicad-x2ap", "gatekeeper", attempt=5)
    failed = rep3.items[0]
    assert failed.kind == "genesis_result_fail" and failed.eq_question and rep3.status in ("needs_review", "blocked")
    assert failed.fix.type == "genesis_resume" and failed.fix.params["from_part"] >= 1
    # A4.2 / A5: resume from the failed part → only the pending parts run; earlier OK ops survive the merge
    r = g.resume(job, failed.fix.params["from_part"])
    assert r["resumed"] and r["parts"] == json.loads((drop / f"{job}.json").read_text())["parts_pending"] and len(r["parts"]) <= n_parts
    assert not (drop / f"{job}.result.json").exists() and g.status(job)["state"] == "waiting"
    assert g.resume(job, n_parts + 1)["resumed"] is False
    res4 = FakeGenesisHost(drop).run_job(job)
    assert res4["ok"] and [p["name"] for p in res4["parts"]] == r["parts"]
    rep4 = pipe.run("kicad-x2ap", "gatekeeper", attempt=6)
    assert rep4.items[0].kind == "genesis_result" and "执行完成" in rep4.items[0].message
    merged = json.loads((work / "genesis" / "result.json").read_text())
    assert ok_before <= {o["key"] for o in merged["ops"] if o["status"] == "OK"}
    assert g.status(job)["state"] == "done"
    # a PAUSE (host stopped at the stage checkpoint) → EQ that resumes from the next part
    FakeGenesisHost(drop, auto_continue=False).run_job(job)
    rep5 = pipe.run("kicad-x2ap", "gatekeeper", attempt=7)
    paused = rep5.items[0]
    first_pending = int(r["parts"][0].rsplit("part", 1)[1].split(".")[0])  # the resume left parts_pending starting there
    if first_pending < n_parts:
        assert paused.kind == "genesis_paused" and paused.eq_question and paused.fix.params["from_part"] == first_pending + 1
    else:  # a single part that pauses at its end is the final checkpoint, i.e. done
        assert paused.kind == "genesis_result"


def test_queue_cap_and_status(tmp_path):
    drop = tmp_path / "drop"
    plan = build_plan("job-7", REPORTS)
    g = GenesisAdapter(drop_dir=drop, max_jobs=1)
    assert g.status("job-7")["state"] == "not_delivered"
    r1 = g.deliver("job-7", build_script("job-7", plan), parts=build_segments("job-7", plan))
    assert r1["delivered"] and g.in_flight() == ["job-7"]
    r2 = g.deliver("job-8", build_script("job-8", plan), parts=build_segments("job-8", plan))
    assert not r2["delivered"] and r2["queued"] and "job-7" in r2["in_flight"]
    assert g.deliver("job-7", build_script("job-7", plan))["delivered"]  # re-delivering the same job is not a second slot
    FakeGenesisHost(drop).run_job("job-7")
    assert g.in_flight() == [] and g.status("job-7")["state"] == "done"
    assert g.deliver("job-8", build_script("job-8", plan), parts=build_segments("job-8", plan))["delivered"]


# ---- the host agent script itself --------------------------------------------------------
def test_host_agent_runs_parts_via_launch_template(tmp_path):
    drop = tmp_path / "drop"
    plan = build_plan("job-7", REPORTS)
    GenesisAdapter(drop_dir=drop).deliver("job-7", build_script("job-7", plan), parts=build_segments("job-7", plan))
    helper = tmp_path / "fake_csh.py"
    helper.write_text(
        "import sys, pathlib\n"
        "from engine.adapters.genesis_host import FakeGenesisHost\n"
        f"h = FakeGenesisHost(pathlib.Path({str(drop)!r}))\n"
        "st = h.run_script(pathlib.Path(sys.argv[1]).read_text(), pathlib.Path('job-7.log'))\n"
        "sys.exit(0 if st == 'OK' else 1)\n"
    )
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    proc = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "genesis_host_agent.py"), "--drop-dir", str(drop), "--launch", f"{sys.executable} {helper} {{script}}"],
        capture_output=True, text=True, env=env, timeout=120, check=False,
    )  # fmt: skip
    assert proc.returncode == 0, proc.stderr
    res = json.loads((drop / "job-7.result.json").read_text())
    assert res["ok"] and len(res["parts"]) == 2 and len(res["ops"]) == len([c for c in plan.calls if not c.applied and c.script])
    # second pass: nothing pending
    proc2 = subprocess.run([sys.executable, str(ROOT / "tools" / "genesis_host_agent.py"), "--drop-dir", str(drop)], capture_output=True, text=True, env=env, timeout=60, check=False)
    assert proc2.returncode == 0 and "run job-7" not in proc2.stdout
