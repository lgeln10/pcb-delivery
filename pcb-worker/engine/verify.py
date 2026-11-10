"""``make verify CASE=<id>`` / ``make verify-all``: run intake -> align -> drill -> inner -> outer -> mask -> silk on a case
and diff the result against ``cases/<id>/expected/*.json``.

    uv run python -m engine.verify C02_drill_defects        # cases/<id>
    uv run python -m engine.verify cases/C02_drill_defects
    uv run python -m engine.verify --all                    # every cases/C0*
    uv run python -m engine.verify tests/fixtures/kicad-x2ap  # bare fixture: just print reports

No HTTP: the stage functions are called directly with throw-away roots under
``data/verify/<case>/`` (override with ``PCB_VERIFY_ROOT``). Every file in ``cases/<id>/input/``
except ``order_spec.json`` / ``*.md`` is stored as an upload key, exactly like the Node side does.

Expected files (all optional; a missing file skips that comparison):

- ``layer_map.json``  ``files[]`` -> type / index / min_confidence per file; ``needs_llm`` and
  ``unmapped`` lists. An entry may carry ``confirm_as`` (+ optional ``confirm_index``): the
  type a human would set in the layer-confirmation table; the runner applies it before
  align/drill the way the UI does.
- ``findings.json``   ``{"must": [{stage, kind, severity?, min_count?}],
                        "must_not": [{stage|"*", kind?, severity?}], "status": {stage: status}}``
- ``eq.json``         ``{"count": N, "kinds": [...], "by_stage"?: {stage: n}}`` using the Node
                      needs_decision rule (eq_question set, or error without an applied fix).
- ``drill_table.json`` ``{"total_holes"?: N, "tools": [{file, dia_mm, slot, attribute?, count?,
                        drill_dia_mm?}]}`` matched on (file, dia_mm, slot).
- ``outputs.json``    real-board benchmark: our output files vs the factory engineer's golden set.
- ``diff_attribution.json``  存在时接管 outputs.json 的放行判定：C 档（带宽 > 0.1 mm 的形体差异）
                      逐簇归属，归不到已知原因上的必须为 0。XOR 百分比退成参考数字 —— 那些门槛
                      当初是照着自己的残差设的（"残差 + 余量"），只能证明没变差，证明不了和人做得一样。
                      分档见 :mod:`engine.geom.xordiff`。
"""

from __future__ import annotations

import collections
import copy
import json
import os
import shutil
import sys
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from engine.compare import drill_sizes
from engine.geom import xordiff
from engine.geom.from_gerbonara import camfile_to_geometry
from engine.geom.layers import open_camfile
from engine.ingest.classify import COPPER_TYPES, DRILL_TYPES
from engine.model.report import ReportItem, StageReport
from engine.pipeline.context import JobContext, StageRequest
from engine.pipeline.registry import run_stage
from engine.storage import Storage

STAGES = ("intake", "align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output", "gatekeeper")  # all stages, in order
ROOT = Path(__file__).resolve().parents[1]
CASES_DIR = ROOT / "cases"
SKIP_INPUTS = {"order_spec.json", "profile.yaml", "engine.txt"}


@dataclass
class Row:
    ok: bool
    check: str
    detail: str


class Result:
    def __init__(self) -> None:
        self.rows: list[Row] = []

    def add(self, ok: bool, check: str, detail: str = "") -> None:
        self.rows.append(Row(ok, check, detail))

    @property
    def failed(self) -> int:
        return sum(1 for r in self.rows if not r.ok)


# ---------------------------------------------------------------------------------------------
# running
# ---------------------------------------------------------------------------------------------
def _zip_dir(src: Path, dest: Path) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(src).as_posix())


def _fresh_storage(base: Path) -> Storage:
    if base.exists():
        shutil.rmtree(base)
    return Storage(storage_root=base / "storage", work_root=base / "work")


def _run(storage: Storage, job: str, stage: str, keys: list[str], **kw: Any) -> StageReport:
    req = StageRequest(
        tenant_id="verify", input_keys=keys, output_prefix=f"pcb-cam/verify/{job}/output/{stage}/", **kw
    )
    return run_stage(JobContext(job_id=job, stage=stage, request=req, storage=storage))


def _apply_confirmations(layer_map: dict[str, Any], expected: dict[str, Any] | None) -> dict[str, Any]:
    """Emulate the human layer-confirmation step: ``confirm_as`` overrides / promotes entries."""
    lm = copy.deepcopy(layer_map)
    if not expected:
        return lm
    conf = {e["file"]: e for e in expected.get("files", []) if e.get("confirm_as")}
    if not conf:
        return lm
    by_file = {e["file"]: e for e in lm.get("files", [])}
    for name, e in conf.items():
        t = e["confirm_as"]
        entry = by_file.get(name)
        if entry is None:
            entry = {"file": name, "index": None, "side": None, "polarity": "positive", "drill_span": None}
            lm["files"].append(entry)
            by_file[name] = entry
        entry.update(type=t, confidence=1.0, needs_llm=False, reason="confirmed (expected.confirm_as)")
        if "confirm_index" in e:
            entry["index"] = e["confirm_index"]
        elif t == "top_copper":
            entry["index"] = 1
        entry["side"] = "top" if t.startswith("top_") else "bottom" if t.startswith("bottom_") else entry.get("side")
    lm["unmapped"] = [u for u in lm.get("unmapped", []) if u["file"] not in conf]
    copper = [e for e in lm["files"] if e["type"] in COPPER_TYPES]
    n = len(copper)
    for e in copper:
        if e["type"] == "bottom_copper" and e.get("index") is None:
            e["index"] = n
    for e in lm["files"]:
        if e["type"] in DRILL_TYPES and not e.get("drill_span") and n:
            e["drill_span"] = [1, n]
    lm["stackup"] = {
        "copper_layers": n,
        "order": [e["file"] for e in sorted(copper, key=lambda e: e.get("index") or 999)],
        "layer_numbers": {e["file"]: e.get("index") for e in copper},
    }
    return lm


def run_case(case: Path, base: Path) -> tuple[dict[str, StageReport], dict[str, Any] | None]:
    """Run the three stages on ``case/input``; returns reports + the layer_map used downstream."""
    storage = _fresh_storage(base)
    job = case.name
    expected_lm = _load(case / "expected" / "layer_map.json")
    keys: list[str] = []
    for p in sorted((case / "input").iterdir()):
        if not p.is_file() or p.name in SKIP_INPUTS or p.suffix == ".md" or p.name.startswith("."):
            continue
        key = f"pcb-cam/verify/{job}/input/{p.name}"
        storage.put_file(key, p)
        keys.append(key)
    order_spec = _load(case / "input" / "order_spec.json")
    prof = case / "input" / "profile.yaml"
    profile_yaml = prof.read_text("utf-8") if prof.is_file() else None  # per-case factory profile override
    eng = case / "input" / "engine.txt"  # per-case executor (lite | native | hybrid), see PLAN_TWO_TRACKS B1
    if eng.is_file():
        os.environ["PCB_CAM_ENGINE"] = eng.read_text("utf-8").strip() or "lite"
    else:
        os.environ.pop("PCB_CAM_ENGINE", None)

    reports: dict[str, StageReport] = {}
    reports["intake"] = _run(storage, job, "intake", keys, profile_yaml=profile_yaml)
    if reports["intake"].status == "failed" or not reports["intake"].layer_map:
        return reports, None
    lm = _apply_confirmations(reports["intake"].layer_map, expected_lm)
    for stage in STAGES[1:]:
        reports[stage] = _run(storage, job, stage, keys, layer_map=lm, order_spec=order_spec, profile_yaml=profile_yaml)
        if reports[stage].status == "failed":
            break
    return reports, lm


# ---------------------------------------------------------------------------------------------
# comparing
# ---------------------------------------------------------------------------------------------
def _load(p: Path) -> Any | None:
    return json.loads(p.read_text("utf-8")) if p.is_file() else None


def _items(reports: dict[str, StageReport], stage: str) -> list[ReportItem]:
    if stage == "*":
        return [i for r in reports.values() for i in r.items]
    r = reports.get(stage)
    return list(r.items) if r else []


def _match(items: list[ReportItem], spec: dict[str, Any]) -> list[ReportItem]:
    out = items
    for f in ("kind", "severity", "layer"):
        if spec.get(f) is not None:
            out = [i for i in out if getattr(i, f) == spec[f]]
    return out


def _label(spec: dict[str, Any]) -> str:
    parts = [spec.get("stage", "*")]
    for f in ("kind", "severity", "layer"):
        if spec.get(f) is not None:
            parts.append(str(spec[f]))
    return "/".join(parts)


def compare_layer_map(exp: dict[str, Any], intake_lm: dict[str, Any], res: Result) -> None:
    actual = {e["file"]: e for e in intake_lm.get("files", [])}
    unmapped = {u["file"]: u for u in intake_lm.get("unmapped", [])}
    if "copper_layers" in exp:
        got = intake_lm.get("stackup", {}).get("copper_layers")
        res.add(got == exp["copper_layers"], "layer_map.copper_layers", f"expect {exp['copper_layers']} got {got}")
    for e in exp.get("files", []):
        name = e["file"]
        a = actual.get(name)
        if a is None and name in unmapped:
            a = {"type": "unknown", "confidence": unmapped[name].get("confidence"), "index": None}
        if a is None:
            res.add(False, f"layer_map[{name}]", "file not in layer_map (not extracted?)")
            continue
        probs = []
        if a["type"] != e["type"]:
            probs.append(f"type {a['type']} != {e['type']}")
        mc = e.get("min_confidence")
        if mc is not None and (a.get("confidence") or 0) < mc:
            probs.append(f"confidence {a.get('confidence')} < {mc}")
        if e.get("index") is not None and a.get("index") != e["index"]:
            probs.append(f"index {a.get('index')} != {e['index']}")
        res.add(
            not probs, f"layer_map[{name}]",
            "; ".join(probs) or f"{a['type']} conf={a.get('confidence')}" + (f" L{a['index']}" if a.get("index") else ""),
        )  # fmt: skip
    if "needs_llm" in exp:
        got = sorted([f for f, a in actual.items() if a.get("needs_llm")] + [f for f, u in unmapped.items() if u.get("needs_llm")])
        want = sorted(exp["needs_llm"])
        res.add(got == want, "layer_map.needs_llm", f"expect {want} got {got}")
    if "unmapped" in exp:
        got, want = sorted(unmapped), sorted(exp["unmapped"])
        res.add(got == want, "layer_map.unmapped", f"expect {want} got {got}")


def compare_findings(exp: dict[str, Any], reports: dict[str, StageReport], res: Result) -> None:
    for spec in exp.get("must", []):
        n = len(_match(_items(reports, spec.get("stage", "*")), spec))
        want = int(spec.get("min_count", 1))
        res.add(n >= want, f"must {_label(spec)}", f"expect >= {want} got {n}")
    for spec in exp.get("must_not", []):
        hits = _match(_items(reports, spec.get("stage", "*")), spec)
        detail = "" if not hits else "; ".join(f"{i.kind}:{(i.layer or '')}" for i in hits[:3])
        res.add(not hits, f"must_not {_label(spec)}", f"got {len(hits)} {detail}".strip())
    for stage, status in exp.get("status", {}).items():
        got = reports[stage].status if stage in reports else "(not run)"
        res.add(got == status, f"status {stage}", f"expect {status} got {got}")


def compare_eq(exp: dict[str, Any], reports: dict[str, StageReport], res: Result) -> None:
    eqs = [(s, i) for s, r in reports.items() for i in r.eq_items]
    if "count" in exp:
        res.add(len(eqs) == exp["count"], "eq.count", f"expect {exp['count']} got {len(eqs)}")
    if "kinds" in exp:
        got, want = sorted({i.kind for _, i in eqs}), sorted(set(exp["kinds"]))
        res.add(got == want, "eq.kinds", f"expect {want} got {got}")
    for stage, n in exp.get("by_stage", {}).items():
        got = sum(1 for s, _ in eqs if s == stage)
        res.add(got == n, f"eq.by_stage[{stage}]", f"expect {n} got {got}")


def compare_drill_table(exp: dict[str, Any], storage: Storage, job: str, res: Result) -> None:
    key = f"pcb-cam/verify/{job}/output/drill/drill_table.json"
    if not storage.object_exists(key):
        res.add(False, "drill_table", "drill_table.json artifact missing")
        return
    table = json.loads(storage.read_object(key))
    if "total_holes" in exp:
        res.add(table["total_holes"] == exp["total_holes"], "drill_table.total_holes", f"expect {exp['total_holes']} got {table['total_holes']}")
    rows = {(r["file"], round(r["dia_mm"], 3), bool(r["slot"])): r for r in table["tools"]}
    for e in exp.get("tools", []):
        k = (e["file"], round(e["dia_mm"], 3), bool(e.get("slot", False)))
        label = f"drill_table[{e['file']} ⌀{e['dia_mm']}{' slot' if k[2] else ''}]"
        r = rows.pop(k, None)
        if r is None:
            res.add(False, label, "no such tool row")
            continue
        probs = [
            f"{f} {r[f]} != {e[f]}"
            for f in ("attribute", "count", "drill_dia_mm")
            if f in e and r[f] != e[f]
        ]
        res.add(not probs, label, "; ".join(probs) or f"{r['attribute']} x{r['count']} -> {r['drill_dia_mm']}")
    if exp.get("exact", True) and rows:
        res.add(False, "drill_table.extra_tools", ", ".join(f"{f} ⌀{d}{' slot' if s else ''}" for f, d, s in rows))


# ---------------------------------------------------------------------------------------------
def _print_reports(reports: dict[str, StageReport]) -> None:
    for stage, rep in reports.items():
        sev = dict(collections.Counter(i.severity for i in rep.items))
        kinds = dict(collections.Counter(i.kind for i in rep.items))
        print(f"[{stage}] {rep.status} ({rep.duration_ms} ms) {rep.summary}")
        print(f"    severities={sev} kinds={kinds}")
        for i in rep.eq_items:
            print(f"    EQ  [{i.severity}] {i.kind} {i.layer or ''}: {i.message}")
            if i.eq_question:
                print(f"        ? {i.eq_question}")


def verify_case(case: Path, base: Path, *, quiet: bool = False) -> Result:
    res = Result()
    reports, _ = run_case(case, base)
    if not quiet:
        _print_reports(reports)
    exp_dir = case / "expected"
    for stage, rep in reports.items():
        if rep.status == "failed":
            res.add(False, f"stage {stage}", f"failed: {rep.summary}")
    if (e := _load(exp_dir / "layer_map.json")) is not None and reports["intake"].layer_map:
        compare_layer_map(e, reports["intake"].layer_map, res)
    if (e := _load(exp_dir / "findings.json")) is not None:
        compare_findings(e, reports, res)
    if (e := _load(exp_dir / "eq.json")) is not None:
        compare_eq(e, reports, res)
    if (e := _load(exp_dir / "drill_table.json")) is not None:
        compare_drill_table(e, Storage(storage_root=base / "storage", work_root=base / "work"), case.name, res)
    if (e := _load(exp_dir / "edits.json")) is not None:
        global _CURRENT_CASE
        _CURRENT_CASE = case
        compare_edits(e, Storage(storage_root=base / "storage", work_root=base / "work"), case.name, res)
    if (e := _load(exp_dir / "outputs.json")) is not None:
        _CURRENT_CASE = case
        compare_outputs(e, Storage(storage_root=base / "storage", work_root=base / "work"), case.name, res)
    if not res.rows:
        res.add(True, "expected/", "no *.json expectations; stages ran without failure")
    return res


def compare_edits(exp: dict[str, Any], storage: Storage, job: str, res: Result) -> None:
    """``expected/edits.json`` (B line reverse-construction cases)::

        {"applied_ops": ["SetProfile", ...],                        # must appear in edit_log/applied ops
         "layers": [{"layer": "<rel>", "golden": "golden/<file>", "max_xor_ratio": 0.001}],
         "unchanged": ["<rel>", ...]}                                # must NOT have an edit copy

    A layer's edit copy (``steps/edit/<rel>``) is folded and XOR-ed against the golden file
    (relative to the case dir); the ratio is XOR area / golden area."""
    work = storage.work_dir(job, create=False)
    log_dir = work / "edit_log"
    applied_ops: set[str] = set()
    for f in log_dir.glob("*.json") if log_dir.is_dir() else []:
        if f.name == "applied.json":
            continue
        try:
            applied_ops.add(json.loads(f.read_text("utf-8")).get("op", ""))
        except Exception:  # noqa: BLE001
            pass
    for op in exp.get("applied_ops", []):
        res.add(op in applied_ops, f"edits.applied[{op}]", "applied" if op in applied_ops else f"not applied (have {sorted(applied_ops)})")
    for spec in exp.get("layers", []):
        rel = spec["layer"]
        edit = work / "steps" / "edit" / rel
        label = f"edits.layer[{rel}]"
        if not edit.is_file():
            res.add(False, label, "no edit copy written")
            continue
        golden = Path(spec["golden"]) if Path(spec["golden"]).is_absolute() else _CURRENT_CASE / spec["golden"]
        if not golden.is_file():
            res.add(False, label, f"golden missing: {golden}")
            continue
        try:
            g_edit, _ = camfile_to_geometry(open_camfile(edit, spec.get("type", "top_copper")))
            g_gold, _ = camfile_to_geometry(open_camfile(golden, spec.get("type", "top_copper")))
        except Exception as e:  # noqa: BLE001
            res.add(False, label, f"fold failed: {e}")
            continue
        xor = g_edit.symmetric_difference(g_gold).area
        ratio = xor / max(g_gold.area, 1e-9)
        limit = float(spec.get("max_xor_ratio", 0.001))
        res.add(ratio <= limit, label, f"xor {xor:.5f} mm² = {ratio * 100:.4f}% of golden (limit {limit * 100:.3f}%)")
    for rel in exp.get("unchanged", []):
        res.add(not (work / "steps" / "edit" / rel).is_file() or (work / "steps" / "edit" / rel).read_bytes() == (work / "src" / rel).read_bytes(),
                f"edits.unchanged[{rel}]", "untouched")


_CURRENT_CASE = Path(".")


def compare_outputs(exp: dict[str, Any], storage: Storage, job: str, res: Result) -> None:
    """``expected/outputs.json`` — the real-board benchmark (B4): our *output* files against the
    factory engineer's golden set::

        {"layers": [{"output": ".gtl", "golden": "golden/xxx.gtl", "type": "top_copper",
                     "max_xor_ratio": 0.05, "max_missing_ratio"?: 0.02}],
         "drill": {"golden": "golden/xxx.drl", "max_size_mismatch": 0}}

    ``output`` is matched by suffix against the output stage's artifacts. Output files already
    carry the factory origin/format, so no offset is applied. The ratio is XOR / golden area;
    ``missing`` is golden−ours (copper the engineer has and we lack) as a share of golden.

    门禁：只要 ``expected/diff_attribution.json`` 在，``max_xor_ratio`` 就退成参考数字，
    过不过看 C 档（带宽 > 0.1 mm 的形体差异）有没有一簇归不到已知原因上 —— 见
    :mod:`engine.geom.xordiff`。百分比门槛是当初照着自己的残差设的，它只能证明我们没变差，
    不能证明我们和工程师做得一样。"""
    out_dir = Path(storage.storage_root) / "pcb-cam" / "verify" / job / "output" / "output"
    files = list(out_dir.glob("*")) if out_dir.is_dir() else []
    att = _load(_CURRENT_CASE / "expected" / "diff_attribution.json") if _CURRENT_CASE else None
    for spec in exp.get("layers", []):
        suffix = spec["output"]
        cands = [f for f in files if f.name.lower().endswith(suffix.lower()) and "_panel" not in f.name]
        label = f"outputs.layer[{suffix}]"
        if not cands:
            res.add(False, label, f"no output file ending with {suffix} (have {[f.name for f in files][:8]})")
            continue
        golden = Path(spec["golden"]) if Path(spec["golden"]).is_absolute() else _CURRENT_CASE / spec["golden"]
        if not golden.is_file():
            res.add(False, label, f"golden missing: {golden}")
            continue
        try:
            g_out, _ = camfile_to_geometry(open_camfile(cands[0], spec.get("type", "top_copper")))
            g_gold, _ = camfile_to_geometry(open_camfile(golden, spec.get("type", "top_copper")))
        except Exception as e:  # noqa: BLE001
            res.add(False, label, f"fold failed: {e}")
            continue
        base = max(g_gold.area, 1e-9)
        xor = g_out.symmetric_difference(g_gold).area / base
        missing = g_gold.difference(g_out).area / base
        extra = g_out.difference(g_gold).area / base
        if att is not None:
            ref = f"xor {xor * 100:.2f}%（少 {missing * 100:.2f}% 多 {extra * 100:.2f}%，不判定）"
            compare_shape_band(att, suffix, g_out, g_gold, res, ref)
            continue
        limit = float(spec.get("max_xor_ratio", 0.05))
        ok = xor <= limit and (spec.get("max_missing_ratio") is None or missing <= float(spec["max_missing_ratio"]))
        res.add(ok, label, f"xor {xor * 100:.2f}% (limit {limit * 100:.1f}%)  missing {missing * 100:.2f}%  extra {extra * 100:.2f}%  ours {g_out.area:.0f} / golden {g_gold.area:.0f} mm²")
    d = exp.get("drill")
    if d:
        golden = Path(d["golden"]) if Path(d["golden"]).is_absolute() else _CURRENT_CASE / d["golden"]
        cands = [f for f in files if f.name.lower().endswith(str(d.get("output", ".drl")).lower()) and "_panel" not in f.name]
        # several tapes may share the suffix: the Gerber drill layer (every hole of every pass) is the one the factory keeps
        cands.sort(key=lambda f: (b"%ADD" not in f.read_bytes()[:4000], f.name))
        label = "outputs.drill"
        if not cands or not golden.is_file():
            res.add(False, label, "output or golden drill Gerber missing")
        else:
            ours = _drill_sizes(cands[0])
            gold = _drill_sizes(golden)
            diff = {k: (ours.get(k, 0), gold.get(k, 0)) for k in sorted(set(ours) | set(gold)) if ours.get(k, 0) != gold.get(k, 0)}
            if att is not None and att.get("drill") is not None:
                compare_drill_attribution(att["drill"], ours, gold, diff, res)
            else:
                tol = int(d.get("max_size_mismatch", 0))
                res.add(len(diff) <= tol, label, f"{len(ours)} sizes vs golden {len(gold)}; mismatched sizes (ours, golden): {dict(list(diff.items())[:12])}" if diff else f"{len(ours)} tool sizes, hole counts per size all equal")


def compare_drill_attribution(spec: dict[str, Any], ours: dict[tuple[float, str], int],
                              gold: dict[tuple[float, str], int],
                              diff: dict[tuple[float, str], tuple[int, int]], res: Result) -> None:
    """钻孔也走归属，不走「允许错几种」—— ``max_size_mismatch: 5`` 曾经同时放过 9 个骑线过孔
    和 36 个根本没打的 V-cut 端孔::

        {"attributions": [{"id": "vcut_end_holes", "status": "open", "reason": "...", "ref": "...",
                           "sizes": [{"dia_mm": 0.6, "kind": "hole", "ours": 0, "golden": 12}]}]}

    ``ours``/``golden`` 写了就必须一个不差 —— 数目一变，这条归属就不再成立，照样报错。"""
    label = "outputs.drill"
    covered: dict[tuple[float, str], str] = {}
    for e in spec.get("attributions", []):
        for s in e.get("sizes", []):
            k = (float(s["dia_mm"]), str(s.get("kind", "hole")))
            if k not in diff:
                continue
            o, g = diff[k]
            if (s.get("ours") in (None, o)) and (s.get("golden") in (None, g)):
                covered.setdefault(k, str(e.get("id") or "?"))
    loose = {k: v for k, v in diff.items() if k not in covered}
    todo = sorted({v for k, v in covered.items()
                   for e in spec.get("attributions", []) if e.get("id") == v and e.get("status") == "open"})
    head = (f"{len(ours)} 种孔径 / 工程师 {len(gold)} 种，孔数 {sum(ours.values())} vs {sum(gold.values())}；"
            f"对不上 {len(diff)} 种（有主 {len(covered)} / 无主 {len(loose)}）"
            + (f"  待修: {', '.join(todo)}" if todo else ""))
    if loose:
        detail = "; ".join(f"⌀{k[0]}{k[1]} 我们 {o} 工程师 {g}" for k, (o, g) in list(loose.items())[:8])
        res.add(False, label, f"{head}；无主的：{detail}")
    else:
        res.add(True, label, head)


def compare_shape_band(att: dict[str, Any], suffix: str, g_out: Any, g_gold: Any,
                       res: Result, ref: str = "") -> None:
    """``expected/diff_attribution.json`` —— C 档（形体差异）逐簇归属门禁::

        {"skip_layers": [".gto", ".gbo"],                 # 字符层：字体不同，几何比无意义
         "max_report": 8,
         "attributions": [
           {"id": "rail_fill", "layers": [".gtl", ".l5"], "edge_margin_mm": 11,
            "direction": "extra", "min_area_mm2": 1.0,
            "reason": "工艺边铺铜 inset 我们 0.6 / 工程师 0.583，内部避让也不同",
            "status": "open", "ref": "docs/...#C7",
            "expect": {"clusters": 2, "area_mm2": 320, "tolerance": 0.25}}]}

    一簇 C 档差异落进某条归属的范围就算有主；``expect`` 防止一条归属把新冒出来的问题悄悄吃掉。
    归不到任何一条的必须为 0 —— 归不了就是还没查清，不是通过。"""
    label = f"outputs.shape[{suffix}]"
    if suffix in (att.get("skip_layers") or []):
        res.add(True, label, f"跳过：{att.get('skip_reason', '该层不用几何对标')}")
        return
    rep = xordiff.compare(g_out, g_gold)
    entries = [e for e in att.get("attributions", []) if e.get("id")]
    atts, unexplained = xordiff.attribute(rep["clusters"], entries, suffix, tuple(g_gold.bounds))
    over = [f"{a.id}({o})" for a in atts if (o := a.overrun())]
    shown = ";  ".join(c.describe() for c in unexplained[: int(att.get("max_report", 8))])
    named = sum(len(a.matched) for a in atts)
    todo = sorted({a.id for a in atts if a.matched and a.status == "open"})
    ask = sorted({a.id for a in atts if a.matched and a.status == "question"})
    head = (f"C 档 {rep['shape_pct']:.2f}%（{len(rep['clusters'])} 簇：有主 {named} / 无主 "
            f"{len(unexplained)}）  B 档 {(rep['missing'].size + rep['extra'].size):.1f}mm²  "
            f"A 档 {(rep['missing'].noise + rep['extra'].noise):.1f}mm²"
            + (f"  待修: {', '.join(todo)}" if todo else "")
            + (f"  待工程师答: {', '.join(ask)}" if ask else "") + (f"  [{ref}]" if ref else ""))
    if over:
        res.add(False, label, f"{head}；归属已盖过头：{', '.join(over)}")
    elif unexplained:
        res.add(False, label, f"{head}；无主的：{shown}")
    else:
        res.add(True, label, head)


def _drill_sizes(path: Path) -> dict[tuple[float, str], int]:
    """钻孔层 → {(孔径, hole|slot): 孔数}。实现搬到了 engine/compare.py（页面的终稿对比也用它）。"""
    return drill_sizes(path)


def print_table(case: str, res: Result) -> None:
    w = max(len(r.check) for r in res.rows) if res.rows else 10
    print(f"\n== {case} ==")
    for r in res.rows:
        print(f"  {'PASS' if r.ok else 'FAIL'}  {r.check:<{w}}  {r.detail}")
    print(f"  -- {len(res.rows) - res.failed}/{len(res.rows)} passed" + (f", {res.failed} FAILED" if res.failed else ""))


def run_fixture(path: Path, base: Path) -> int:
    """Legacy mode: a fixture dir / archive without expected/ -> just run and print."""
    storage = _fresh_storage(base)
    job = f"fixture-{uuid.uuid4().hex[:6]}"
    key = f"pcb-cam/verify/{job}/input/{path.name if path.is_file() else path.name + '.zip'}"
    if path.is_dir():
        tmp = Path(tempfile.mkdtemp()) / "board.zip"
        _zip_dir(path, tmp)
        storage.put_file(key, tmp)
        shutil.rmtree(tmp.parent, ignore_errors=True)
    else:
        storage.put_file(key, path)
    reports: dict[str, StageReport] = {}
    for stage in STAGES:
        reports[stage] = _run(storage, job, stage, [key])
        if reports[stage].status == "failed":
            break
    _print_reports(reports)
    print(f"work dir: {storage.work_dir(job, create=False)}")
    return 1 if any(r.status == "failed" for r in reports.values()) else 0


def resolve_case(arg: str) -> Path:
    p = Path(arg)
    if not p.exists() and (CASES_DIR / arg).exists():
        p = CASES_DIR / arg
    return p


def main(argv: list[str]) -> int:
    quiet = "-q" in argv
    argv = [a for a in argv if a != "-q"]
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    base_root = Path(os.environ.get("PCB_VERIFY_ROOT", ROOT / "data" / "verify"))
    if argv[0] == "--all":
        targets = sorted(p for p in CASES_DIR.glob("C[0-9]*") if (p / "input").is_dir())
    else:
        targets = [resolve_case(a) for a in argv]
    rc = 0
    for t in targets:
        if not t.exists():
            print(f"not found: {t}", file=sys.stderr)
            return 2
        if not (t / "input").is_dir():
            rc |= run_fixture(t, base_root / t.stem)
            continue
        res = verify_case(t, base_root / t.name, quiet=quiet or len(targets) > 1)
        print_table(t.name, res)
        if res.failed:
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
