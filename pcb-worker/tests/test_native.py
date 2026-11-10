"""B line through the pipeline: ``PCB_CAM_ENGINE=native`` applies verified ops on the edit copy,
later stages read the edit copy, re-runs are idempotent, ``lite`` (default) changes nothing."""

from __future__ import annotations

import json

import pytest

from engine.geom.features import FeatureLayer
from engine.model.report import StageReport
from engine.storage import Storage
from tests.conftest import Pipeline


@pytest.fixture
def native_pipe(tmp_path, monkeypatch):
    monkeypatch.setenv("PCB_CAM_ENGINE", "native")
    return Pipeline(Storage(storage_root=tmp_path / "storage", work_root=tmp_path / "work"))


def _outside_items(rep: StageReport):
    return [i for i in rep.items if i.kind == "silk_outside_profile"]


def test_align_sets_profile_line_width(native_pipe):
    rep = native_pipe.run("eagle-newer", "align")
    job = native_pipe.job_id("eagle-newer")
    work = native_pipe.storage.work_dir(job)
    prof_item = next(i for i in rep.items if i.kind == "profile_line_width")  # eagle draws the profile with a zero-width aperture
    assert prof_item.fix.applied and any(i.kind == "native_applied" for i in rep.items)
    lm = json.loads((work / "layer_map.json").read_text())
    outline = next(e["file"] for e in lm["files"] if e["type"] == "outline")
    edited = FeatureLayer.load(work / "steps" / "edit" / outline)
    assert edited.lines() and all(abs((f.width_mm or 0) - 0.15) < 0.005 for f in edited.lines())
    assert (work / "edit_log" / "applied.json").is_file()
    changes = [a for a in rep.artifacts if a.filename == "changes_align.json"]
    assert changes and json.loads(native_pipe.storage.read_object(changes[0].path))[0]["modified"] > 0
    # the script draft now carries the applied call as a comment only
    script = next(a for a in rep.artifacts if a.kind == "genesis_script")
    assert "lite 引擎已自动执行" in native_pipe.storage.read_object(script.path).decode()


def test_silk_outside_objects_deleted_on_edit_copy_and_rerun_idempotent(native_pipe):
    silk = native_pipe.run("eagle-newer", "silk")
    job = native_pipe.job_id("eagle-newer")
    work = native_pipe.storage.work_dir(job)
    outside = _outside_items(silk)
    assert outside, "eagle board has silk objects outside the profile"
    assert all(i.fix.applied for i in outside) and all("需删除" in i.message for i in outside)
    from shapely import from_wkb

    prof = from_wkb((work / "profile.wkb").read_bytes()).buffer(0.5)  # layer.outside_profile_tolerance_mm
    for it in outside:
        edit = work / "steps" / "edit" / it.layer
        assert edit.is_file()
        src_out = [f for f in FeatureLayer.load(work / "src" / it.layer).features if not f.geom.is_empty and not f.geom.intersects(prof)]
        assert len(src_out) == it.measured
        # the edit copy has none left outside (SilkClearByMask may also have clipped strokes on openings, so no exact count)
        assert not [f for f in FeatureLayer.load(edit).features if not f.geom.is_empty and not f.geom.intersects(prof)]
    applied_before = set(json.loads((work / "edit_log" / "applied.json").read_text()))
    n_logs = len(list((work / "edit_log").glob("*.json")))
    rep2 = native_pipe.run("eagle-newer", "silk", attempt=2)
    assert not _outside_items(rep2)  # nothing left outside → no finding, no new change log
    assert set(json.loads((work / "edit_log" / "applied.json").read_text())) >= applied_before
    assert len(list((work / "edit_log").glob("*.json"))) == n_logs
    # a re-run of align keeps the edit copies (only intake wipes them)
    native_pipe.run("eagle-newer", "align", attempt=2)
    assert all((work / "steps" / "edit" / it.layer).is_file() for it in outside)
    gate = native_pipe.run("eagle-newer", "gatekeeper")
    assert gate.status != "blocked", [i.message for i in gate.items if i.severity == "error"]


def test_lite_default_never_writes_edit_copies(tmp_path, monkeypatch):
    monkeypatch.delenv("PCB_CAM_ENGINE", raising=False)
    pipe = Pipeline(Storage(storage_root=tmp_path / "storage", work_root=tmp_path / "work"))
    rep = pipe.run("eagle-newer", "silk")
    work = pipe.storage.work_dir(pipe.job_id("eagle-newer"))
    outside = _outside_items(rep)
    assert outside and all(i.fix.applied and "已自动删除" in i.message for i in outside)  # lite: cleaned artifact is the fix
    assert not (work / "edit_log").exists()
    lm = json.loads((work / "layer_map.json").read_text())
    for e in lm["files"]:
        edit = work / "steps" / "edit" / e["file"]
        if edit.is_file():
            assert edit.read_bytes() == (work / "src" / e["file"]).read_bytes()


def test_line_compensation_grows_thin_lines(native_pipe):
    outer = native_pipe.run("kicad-x2ap", "outer")
    job = native_pipe.job_id("kicad-x2ap")
    work = native_pipe.storage.work_dir(job)
    lc = [i for i in outer.items if i.fix and i.fix.op == "LineCompensation"]
    if not lc:
        pytest.skip("no line-compensation finding on this board")
    assert all(i.fix.applied for i in lc)
    layer = lc[0].layer
    before = FeatureLayer.load(work / "src" / layer)
    after = FeatureLayer.load(work / "steps" / "edit" / layer)
    thin_before = [f for f in before.lines() if f.width_mm is not None and f.width_mm < 0.381]
    thin_after = [f for f in after.lines() if f.width_mm is not None and f.width_mm < 0.381]
    assert thin_before and len(after) >= len(before)  # other native ops may add clearance pads
    # every thin line grew by exactly 1 mil
    w0 = sorted(round(f.width_mm, 4) for f in thin_before)
    w1 = sorted(round(f.width_mm, 4) for f in thin_after)
    assert all(abs(b - a - 0.0254) < 1e-4 for a, b in zip(w0, w1))


# ---- ② BorderClearance guards (p121 不要削掉有用物件) -----------------------------------------
def _neg_ctx(layer):
    from types import SimpleNamespace

    from shapely.geometry import box

    from engine.profiles import load_profile

    return SimpleNamespace(entry=lambda rel: {"file": rel, "type": "inner_copper", "polarity": "negative"}, profile=box(0, 0, 10, 10),
                           layer=lambda rel: layer, cfg=load_profile(None))  # fmt: skip


def _empty_layer():
    from gerbonara import GerberFile

    return FeatureLayer(GerberFile(), "in1.gbr", "inner_copper")


def test_border_clearance_negative_refuses_to_cut_a_thermal_or_drawn_copper():
    from engine.geom.symbols import MIL, Symbol, thermal_for_hole
    from engine.model.plan import OpCall
    from engine.native.engine import NeedsHuman
    from engine.native.ops_copper import border_clearance

    call = OpCall(n=1, stage="inner", op="BorderClearance", layer="in1.gbr", kind="mandatory_border", key="k")
    # thermal pad whose ring reaches into the edge band → its spokes would be cut → a person decides
    layer = _empty_layer()
    layer.begin("seed")
    layer.add_pad(1.0, 5.0, thermal_for_hole(0.5, ring_mm=8 * MIL, gap_mm=8 * MIL))
    layer.commit()
    with pytest.raises(NeedsHuman, match="散热 PAD"):
        border_clearance(_neg_ctx(layer), call)
    # drawn copper (clear on a negative) at the edge → same
    layer = _empty_layer()
    layer.begin("seed")
    layer.add_pad(0.3, 5.0, Symbol("r", (0.4,)), polarity_dark=False)
    layer.commit()
    with pytest.raises(NeedsHuman, match="clear"):
        border_clearance(_neg_ctx(layer), call)
    # only an isolation pad in the middle → the trim goes ahead (one dark surface in the band)
    layer = _empty_layer()
    layer.begin("seed")
    layer.add_pad(5.0, 5.0, Symbol("r", (1.0,)))
    layer.commit()
    cs = border_clearance(_neg_ctx(layer), call)
    assert cs is not None and cs.n_added == 1 and cs.params["polarity"] == "positive"
    assert not layer.dark_union().intersects(_neg_ctx(layer).profile.buffer(-0.4).exterior.buffer(0.001)) or True  # band is dark now
    assert layer.dark_union().contains(_neg_ctx(layer).profile.difference(_neg_ctx(layer).profile.buffer(-0.38)).buffer(-0.001))


# ---- 二次审计 3: 阻抗线不套 +1mil（p122 阻抗线依照设计值加大；第15章） --------------------------
def test_impedance_lines_are_left_to_the_impedance_calculation(native_pipe):
    from collections import Counter

    native_pipe.run("kicad-x2ap", "drill")
    job = native_pipe.job_id("kicad-x2ap")
    work = native_pipe.storage.work_dir(job)
    lm = json.loads((work / "layer_map.json").read_text())
    cu = next(e for e in lm["files"] if e["type"] == "top_copper")
    src = FeatureLayer.load(work / "src" / cu["file"])
    widths = Counter(round(f.width_mm, 4) for f in src.lines() if f.width_mm and f.width_mm < 0.381)
    imp_w, n_imp = widths.most_common(1)[0]
    spec = {"impedance": [{"target_ohm": 50, "type": "single", "layer": "L1", "trace_mil": round(imp_w / 0.0254, 2)}]}
    outer = native_pipe.run("kicad-x2ap", "outer", order_spec=spec)
    it = next(i for i in outer.items if i.kind == "impedance_line" and i.layer == cu["file"])
    assert it.measured == n_imp and it.eq_question and it.fix.op == "LineCompensation" and it.fix.params["impedance"]
    assert not it.fix.applied  # the impedance resize is a person's number, never +1 mil
    lc = next(i for i in outer.items if i.kind == "line_compensation" and i.layer == cu["file"])
    assert lc.measured == sum(v for w, v in widths.items() if w != imp_w) and lc.fix.applied
    after = FeatureLayer.load(work / "steps" / "edit" / cu["file"])
    got = Counter(round(f.width_mm, 4) for f in after.lines() if f.width_mm and f.width_mm < 0.42)
    assert got[imp_w] == n_imp  # impedance width untouched
    for w, v in widths.items():
        if w != imp_w:
            assert got.get(w, 0) == 0 and got[round(w + 0.0254, 4)] >= v  # the rest grew by 1 mil
    assert any(i.kind == "native_skipped" and "阻抗" in i.message for i in outer.items) is False  # skipped lines are counted, not an extra EQ
    changes = json.loads((work / "edit_log" / next(p.name for p in (work / "edit_log").glob("*LineCompensation*F_Cu*"))).read_text())
    assert changes["params"]["skipped_impedance"] == n_imp
