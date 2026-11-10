"""第12章 金手指：detection + the four rules on synthetic geometry."""

from __future__ import annotations

from shapely.geometry import Point, box
from shapely.ops import unary_union

from engine.checks.gold_finger import check_inner, check_mask, check_outer, detect_fingers

CFG = {"min_pads": 4, "edge_distance_mm": 3.0, "pad_to_finger_mm": 1.0, "inner_cut_mm": 3.0, "max_pad_area_mm2": 40}
PROFILE = box(0, 0, 60, 40)
FINGERS = [box(5 + i * 2.54, 1.0, 5 + i * 2.54 + 1.5, 6.0) for i in range(8)]  # 8 × (1.5 × 5 mm) on the bottom edge


def _summary(items, kind):
    rows = [i for i in items if i.kind == kind and i.id.endswith("_summary")]
    assert len(rows) == 1, [i.id for i in items]
    return rows[0]


def test_detect_row_on_bottom_edge_only():
    others = [box(30, 20, 31.5, 25), box(40, 20, 41.5, 25), box(50, 20, 51.5, 25), box(20, 20, 21.5, 25)]  # far from edge
    zones = detect_fingers([*FINGERS, *others, Point(30, 10).buffer(1.0)], "top_copper", PROFILE, CFG)
    assert len(zones) == 1 and zones[0].edge == "bottom" and zones[0].n == 8
    assert detect_fingers(FINGERS[:3], "top_copper", PROFILE, CFG) == []  # < min_pads
    assert detect_fingers(FINGERS, "top_copper", None, CFG) == []


def test_outer_rules_bevel_eq_and_copper_nearby():
    via = Point(5 + 3 * 2.54 + 0.75, 6.6).buffer(0.3)  # 0.3 mm above a finger
    zones = detect_fingers([*FINGERS, via], "top_copper", PROFILE, CFG)
    items = []
    stats = check_outer("F.gbr", "F.gbr (L1)", [*FINGERS, via], zones, None, CFG, items)
    assert stats == {"gold_finger_spec": 1, "gold_finger_copper_nearby": 1}
    assert _summary(items, "gold_finger_spec").needs_decision  # bevel/hard gold unstated → ask
    assert _summary(items, "gold_finger_copper_nearby").fix.op == "CopperCutout"
    # spec complete → still listed, but no decision
    items2 = []
    check_outer("F.gbr", "F", FINGERS, zones, {"gold_finger": {"bevel_deg": 45, "hard_gold_uin": 15}}, CFG, items2)
    assert not _summary(items2, "gold_finger_spec").needs_decision


def test_inner_cut_positive_and_negative():
    zones = detect_fingers(FINGERS, "top_copper", PROFILE, CFG)
    plane = box(0, 0, 60, 40)  # positive inner plane covering the finger zone
    items = []
    assert check_inner("In1.gbr", "In1", plane, "positive", zones, CFG, items) == 1
    cut = plane.difference(zones[0].hull.buffer(3.0))
    assert check_inner("In1.gbr", "In1", cut, "positive", zones, CFG, []) == 0
    # negative: dark = clearance; the zone must be dark
    assert check_inner("In2.gbr", "In2", zones[0].hull.buffer(3.2), "negative", zones, CFG, []) == 0
    assert check_inner("In2.gbr", "In2", zones[0].hull.buffer(1.0), "negative", zones, CFG, []) == 1


def test_mask_full_opening():
    zones = detect_fingers(FINGERS, "top_copper", PROFILE, CFG)
    per_pad = unary_union([f.buffer(0.05) for f in FINGERS])
    items = []
    assert check_mask("M.gbr", "M", per_pad, zones, items) == 1
    assert _summary(items, "gold_finger_mask_not_full").needs_decision
    assert check_mask("M.gbr", "M", zones[0].hull.buffer(0.2), zones, []) == 0
