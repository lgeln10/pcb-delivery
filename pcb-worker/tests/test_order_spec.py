"""order_spec stage: deterministic cross-checks of the spec candidate (no LLM here)."""

from __future__ import annotations

from engine.profiles import load_profile
from engine.stages.order_spec import cross_check

LM4 = {"files": [
    {"file": "F.gbr", "type": "top_copper"}, {"file": "In1.gbr", "type": "inner_copper"},
    {"file": "In2.gbr", "type": "inner_copper"}, {"file": "B.gbr", "type": "bottom_copper"},
    {"file": "L1-L2.drl", "type": "drill_blind", "drill_span": [1, 2]},
]}  # fmt: skip
PROFILE = load_profile(None)


def _kinds(items):
    return sorted(i.kind for i in items)


def test_layers_mismatch_and_blind_unstated_are_warn():
    cand = {"layers": 2, "special_process": [], "min_trace_space_mil": {"trace": 3, "space": 6}}
    checks, items = cross_check(cand, LM4, PROFILE)
    assert {i.severity for i in items if i.kind == "order_spec_layers_mismatch"} == {"warn"}
    assert "order_spec_layers_mismatch" in _kinds(items) and "order_spec_blind_unstated" in _kinds(items)
    assert "order_spec_below_capability" in _kinds(items)  # 3 mil < factory 4 mil (0.1 mm)
    assert not any(i.needs_decision for i in items)  # never an EQ: the engineer edits the JSON at the stop


def test_fill_from_gerber_and_implied_specials():
    cand = {"impedance": [{"target_ohm": 50}], "gold_finger": {"bevel_deg": None}, "special_process": ["盲埋孔"]}
    checks, items = cross_check(cand, LM4, PROFILE)
    assert cand["layers"] == 4 and "阻抗" in cand["special_process"] and "金手指" in cand["special_process"]
    assert "order_spec_gold_finger_bevel" in _kinds(items)
    assert "order_spec_blind_unstated" not in _kinds(items)
    assert any(c["message"].startswith("附件未给出") for c in checks)


def test_blind_required_but_only_through_drills():
    lm2 = {"files": [{"file": "F.gbr", "type": "top_copper"}, {"file": "B.gbr", "type": "bottom_copper"}, {"file": "PTH.drl", "type": "drill_pth"}]}
    cand = {"layers": 2, "special_process": ["盲埋孔"], "copper_oz": {"outer": 1, "inner": 1}, "board_thickness_mm": 1.6, "surface_finish": "沉金"}
    checks, items = cross_check(cand, lm2, PROFILE)
    assert _kinds(items) == ["order_spec_blind_missing_drill", "order_spec_inner_copper_on_2l"]
    assert not any(c["message"].startswith("附件未给出") for c in checks)


def test_stage_returns_candidate_with_checks(pipeline):
    pipeline.run("kicad-x2ap", "intake")  # persists layer_map.json the stage falls back to
    rep = pipeline.run("kicad-x2ap", "order_spec", order_spec={"layers": 4, "drill_table": []})
    assert rep.status == "ok" and rep.order_spec_candidate is not None
    assert any("2 个铜层" in c["message"] for c in rep.order_spec_candidate["_checks"])
    assert rep.order_spec_candidate["drill_table"] == []
