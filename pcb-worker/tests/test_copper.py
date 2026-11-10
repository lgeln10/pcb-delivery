"""Inner/outer copper checks on the three sample boards + synthetic unit cases.

Aggregation contract (engine/checks/common.aggregate): per (layer, kind) the individual hits
are located ``warn`` rows and exactly one summary row carries the decision (severity/eq).
"""

from __future__ import annotations

import pytest
from gerbonara import graphic_objects as go
from gerbonara.apertures import CircleAperture
from gerbonara.utils import MM
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

from engine.checks.copper import (
    CopperLayer,
    check_edge,
    check_holes_negative,
    check_holes_positive,
    check_isolated_pads,
    check_line_width,
    check_spacing,
)
from engine.stages.drill import Hole


def _layer(geom, objects=(), polarity="positive", layer_type="top_copper"):
    return CopperLayer(rel="l.gbr", layer_type=layer_type, polarity=polarity, geom=geom, objects=list(objects))


THR = {
    "min_annular_ring_mm": 0.1, "hole_clearance_mm": 0.2032, "npth_clearance_mm": 0.305,
    "edge_clearance_mm": 0.254, "isolation_ring_mm": 0.254,
}  # fmt: skip


def _summary(items, kind):
    rows = [i for i in items if i.kind == kind and i.id.endswith("_summary")]
    assert len(rows) == 1, [i.id for i in items]
    return rows[0]


def _details(items, kind):
    return [i for i in items if i.kind == kind and not i.id.endswith("_summary")]


def test_spacing_flags_close_polygons_but_not_touching_or_rounding():
    a = box(0, 0, 1, 1)
    b = box(1.05, 0, 2, 1)  # 0.05 mm gap -> violation
    c = box(5, 0, 6, 1)
    d = box(6, 0, 7, 1)  # touches c at an edge -> not a violation
    e = box(9, 0, 10, 1)
    f = box(10.1, 0, 11, 1)  # 0.100 vs 0.1016 threshold -> within TOL, passes
    items = []
    n = check_spacing(_layer(unary_union([a, b, c, d, e, f])), 0.1016, items)
    assert n == 1
    det = _details(items, "spacing")
    assert len(det) == 1 and det[0].severity == "warn" and det[0].eq_question is None
    assert det[0].measured == pytest.approx(0.05, abs=1e-4) and det[0].location and det[0].location.bbox
    s = _summary(items, "spacing")
    assert s.severity == "error" and s.eq_question and s.measured == 1 and s.fix.op == "SignalLayerChecks"


def test_line_width_uses_aperture_width():
    line = go.Line(0, 0, 5, 0, aperture=CircleAperture(diameter=0.08, unit=MM), unit=MM)
    wide = go.Line(0, 2, 5, 2, aperture=CircleAperture(diameter=0.3, unit=MM), unit=MM)
    metric = go.Line(0, 4, 5, 4, aperture=CircleAperture(diameter=0.1, unit=MM), unit=MM)  # 0.1 vs 4 mil: ok
    items = []
    assert check_line_width(_layer(box(0, -1, 5, 5), [line, wide, metric]), 0.1016, items) == 1
    assert _details(items, "line_width")[0].measured == pytest.approx(0.08)
    assert _summary(items, "line_width").fix.op == "LineCompensation"


def test_positive_hole_checks():
    pad = Point(0, 0).buffer(0.58)  # ring 0.08 < 0.1
    trace = box(0.65, -0.1, 3, 0.1)  # 0.15 mm from the r=0.5 hole edge -> hole_to_copper
    far = box(10, 10, 11, 11)
    inpad = Point(20, 20).buffer(1.0)
    layer = _layer(unary_union([pad, trace, far, inpad]))
    holes = [
        Hole(0, 0, 1.0, True, "d.drl", tool="T1", attribute="plated"),
        Hole(10.5, 12.0, 0.8, False, "d.drl", tool="T2", attribute="non_plated"),  # 0.6 to far copper -> ok
        Hole(10.5, 11.3, 0.4, False, "d.drl", tool="T3", attribute="non_plated"),  # 0.1 to copper -> npth_clearance
        Hole(20, 20, 0.8, False, "d.drl", tool="T4", attribute="non_plated"),  # sits in a pad -> npth_in_pad
    ]
    items = []
    stats = check_holes_positive(layer, holes, THR, items)
    assert stats == {"annular_ring": 1, "hole_to_copper": 1, "npth_clearance": 1, "npth_in_pad": 1, "drill_isolation": 0}
    assert _details(items, "annular_ring")[0].measured == pytest.approx(0.08, abs=1e-3)
    assert _details(items, "hole_to_copper")[0].measured == pytest.approx(0.15, abs=1e-3)
    assert _details(items, "npth_clearance")[0].measured == pytest.approx(0.1, abs=1e-3)
    assert _summary(items, "npth_in_pad").fix.op == "SetDrillAttrs"
    assert sum(1 for i in items if i.needs_decision) == 4


def test_drill_isolation_is_info_between_8_and_10_mil():
    """p122 钻孔隔离 10mil vs 孔到线 8mil: 8–10 mil is not an EQ, just an SLO Drill-to-Cu hint."""
    trace = box(0.72, -0.1, 3, 0.1)  # 0.22 mm from the r=0.5 hole edge: > 8 mil, < 10 mil
    layer = _layer(unary_union([Point(0, 0).buffer(0.6), trace]))
    holes = [Hole(0, 0, 1.0, True, "d.drl", tool="T1", attribute="plated")]
    items = []
    stats = check_holes_positive(layer, holes, {**THR, "drill_isolation_mm": 0.254}, items)
    assert stats["hole_to_copper"] == 0 and stats["drill_isolation"] == 1
    assert {i.severity for i in items if i.kind == "drill_isolation"} == {"info"}
    assert not any(i.needs_decision for i in items)
    assert _summary(items, "drill_isolation").fix.op == "SignalLayerOptimize"


def test_negative_thermal_pads():
    """p119: thermal = dark ring cut by spokes. Good one passes; bad opening / thin ring / annulus flagged."""
    def thermal(cx, cy, r_in, r_out, spoke_w, n=4):
        ring = Point(cx, cy).buffer(r_out, 64).difference(Point(cx, cy).buffer(r_in, 64))
        spokes = [box(cx - 5, cy - spoke_w / 2, cx + 5, cy + spoke_w / 2), box(cx - spoke_w / 2, cy - 5, cx + spoke_w / 2, cy + 5)]
        return ring.difference(unary_union(spokes[: max(1, n // 2)]))
    good = thermal(0, 0, 0.8, 1.2, 0.3)          # hole r0.5: hole→inner 0.3, ring 0.4, 4 openings of 0.3
    narrow = thermal(10, 0, 0.8, 1.2, 0.15)      # openings 0.15 < 0.2032
    thin = thermal(20, 0, 0.6, 0.75, 0.3)        # hole→inner 0.1 < 0.2032
    annulus = Point(30, 0).buffer(1.2, 64).difference(Point(30, 0).buffer(1.0, 64))  # ring 0.2 < 0.254
    layer = _layer(unary_union([good, narrow, thin, annulus]), polarity="negative", layer_type="inner_copper")
    holes = [Hole(x, 0, 1.0, True, "d.drl", tool=f"T{i}", attribute="plated") for i, x in enumerate((0, 10, 20, 30))]
    items = []
    thr = {**THR, "thermal_ring_mm": 0.2032, "thermal_opening_mm": 0.2032, "thermal_min_openings": 2}
    stats = check_holes_negative(layer, holes, thr, items)
    assert stats == {"isolation_ring": 1, "negative_no_clearance": 0, "thermal_ring": 1, "thermal_opening": 1}
    assert _details(items, "thermal_opening")[0].measured == pytest.approx(0.15, abs=0.02)
    assert _details(items, "thermal_ring")[0].measured == pytest.approx(0.1, abs=0.01)
    assert _details(items, "isolation_ring")[0].measured == pytest.approx(0.2, abs=0.01)
    assert {i.fix.op for i in items if i.id.endswith("_summary")} == {"NegativePadReshape"}


def test_negative_hole_checks():
    clearance = Point(0, 0).buffer(0.7)  # dark = clearance pad, hole r=0.5 -> ring 0.2 < 0.254
    layer = _layer(clearance, polarity="negative", layer_type="inner_copper")
    holes = [
        Hole(0, 0, 1.0, True, "d.drl", tool="T1", attribute="plated"),
        Hole(5, 5, 0.3, True, "d.drl", tool="T2", attribute="via"),  # no clearance at all
    ]
    items = []
    stats = check_holes_negative(layer, holes, THR, items)
    assert stats == {"isolation_ring": 1, "negative_no_clearance": 1, "thermal_ring": 0, "thermal_opening": 0}
    assert {i.fix.op for i in items if i.id.endswith("_summary")} == {"NegativePadReshape"}
    assert _summary(items, "negative_no_clearance").severity == "warn"


def test_edge_positive_and_negative():
    profile = box(0, 0, 20, 20)
    near = box(0.1, 5, 2, 6)
    items = []
    assert check_edge(_layer(near), profile, 0.254, items) == 1
    s = _summary(items, "copper_to_edge")
    assert s.severity == "warn" and s.fix.op == "BorderClearance" and s.eq_question
    # negative: dark ring around the border = trimmed; no dark = not trimmed
    trimmed = profile.difference(box(0.4, 0.4, 19.6, 19.6))
    items = []
    assert check_edge(_layer(trimmed, polarity="negative"), profile, 0.381, items) == 0
    items = []
    assert check_edge(_layer(Polygon(), polarity="negative"), profile, 0.381, items) >= 1


def test_isolated_pad_inner_positive():
    lone = go.Flash(3, 3, aperture=CircleAperture(diameter=1.0, unit=MM), unit=MM)
    withhole = go.Flash(8, 8, aperture=CircleAperture(diameter=1.0, unit=MM), unit=MM)
    geom = unary_union([Point(3, 3).buffer(0.5), Point(8, 8).buffer(0.5)])
    layer = _layer(geom, [lone, withhole], layer_type="inner_copper")
    items = []
    assert check_isolated_pads(layer, [Hole(8, 8, 0.4, True, "d.drl", attribute="plated")], items) == 1
    assert _summary(items, "isolated_pad").fix.op == "NfpRemoval"


def test_aggregate_caps_details_but_counts_all():
    polys = [box(i * 2, 0, i * 2 + 1, 1) for i in range(60)] + [box(i * 2 + 1.05, 0, i * 2 + 1.5, 1) for i in range(60)]
    items = []
    assert check_spacing(_layer(unary_union(polys)), 0.1016, items) == 60
    assert len(_details(items, "spacing")) == 50
    assert _summary(items, "spacing").measured == 60


# ------------------------------------------------------------------ sample boards ------------
@pytest.mark.parametrize("board", ["kicad-x2ap", "eagle-newer"])
def test_outer_stage_on_clean_boards(pipeline, board):
    rep = pipeline.run(board, "outer")
    assert rep.status in ("ok", "needs_review"), rep.summary
    kinds = {i.kind for i in rep.items}
    assert "layer_parse_error" not in kinds
    assert "spacing" not in kinds and "line_width" not in kinds  # 0.1 mm designs must not trip 4 mil
    if board == "kicad-x2ap":
        assert "smd_pads" in kinds
    assert any(a.filename == "outer_checks.json" for a in rep.artifacts)
    for i in rep.items:
        if i.fix:
            assert i.fix.op, i
    # at most one decision per (layer, kind)
    seen = set()
    for i in rep.items:
        if i.needs_decision:
            assert (i.layer, i.kind) not in seen, i
            seen.add((i.layer, i.kind))


@pytest.mark.parametrize("board", ["kicad-x2ap", "eagle-newer"])
def test_inner_stage_on_two_layer_boards(pipeline, board):
    rep = pipeline.run(board, "inner")
    assert rep.status == "ok" and "无内层" in rep.summary


def test_inner_stage_on_altium_12_layer(pipeline):
    rep = pipeline.run("altium-limesdr", "inner")
    assert rep.status in ("ok", "needs_review"), rep.summary
    kinds = {i.kind for i in rep.items}
    assert "layer_parse_error" not in kinds
    assert "line_width" not in kinds  # 0.1 mm design must not trip 4 mil
    assert any(a.filename == "inner_checks.json" for a in rep.artifacts)
    decisions = [i for i in rep.items if i.needs_decision]
    assert len(decisions) <= 10 * 8  # ≤ one per layer per kind (8 decision kinds on inner)
    assert "npth_in_pad" in kinds  # LimeSDR "NPTH" header pins sit in pads
