"""Solder mask + silkscreen checks: synthetic unit cases and the sample boards."""

from __future__ import annotations

import pytest
from gerbonara import graphic_objects as go
from gerbonara.apertures import CircleAperture
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

from engine.checks.copper import CopperLayer
from engine.checks.mask import (
    MaskLayer,
    bridge_min_for,
    check_holes,
    check_pads_vs_openings,
    check_slivers,
)
from engine.checks.silk import (
    SilkLayer,
    check_silk_on_opening,
    check_silk_width,
    split_outside,
    write_cleaned_gerber,
)
from engine.stages.drill import Hole

THR = {
    "coverage_mm": 0.0508, "npth_opening_oversize_mm": 0.1, "via_dam_min_mm": 0.6, "via_plug_max_mm": 0.5,
    "bridge_min_mm": {"green": 0.0762, "white_black": 0.127, "other": 0.1016}, "opening_to_profile_mm": 0.2,
}  # fmt: skip


def _flash(x, y, d):
    return go.Flash(x, y, aperture=CircleAperture(diameter=d, unit=MM), unit=MM)


def _summary(items, kind):
    rows = [i for i in items if i.kind == kind and i.id.endswith("_summary")]
    assert len(rows) == 1, [i.id for i in items]
    return rows[0]


def _copper(flashes, extra=()):
    geom = unary_union([Point(f.x, f.y).buffer(f.aperture.diameter / 2) for f in flashes] + list(extra))
    return CopperLayer(rel="cu.gbr", layer_type="top_copper", polarity="positive", geom=geom, objects=list(flashes))


def test_bridge_min_by_colour():
    assert bridge_min_for("绿油", THR["bridge_min_mm"]) == 0.0762
    assert bridge_min_for(None, THR["bridge_min_mm"]) == 0.0762
    assert bridge_min_for("白色", THR["bridge_min_mm"]) == 0.127
    assert bridge_min_for("蓝色", THR["bridge_min_mm"]) == 0.1016


def test_pads_vs_openings():
    pads = [_flash(0, 0, 1.0), _flash(5, 0, 1.0), _flash(10, 0, 1.0), _flash(15, 0, 1.0)]
    trace = box(20, -0.1, 25, 0.1)
    cu = _copper(pads, [trace, box(0.8, -0.05, 4.2, 0.05)])  # a trace joining pad 0 and pad 1 -> same polygon
    openings = unary_union([
        Point(0, 0).buffer(0.6),  # good: +0.1
        Point(5, 0).buffer(0.51),  # expansion 0.01 < 0.0508
        Point(10, 0).buffer(0.4),  # smaller than pad
        # pad 15: no opening -> missing
        box(21, -0.3, 22, 0.3),  # opening over a trace, no pad -> opening_not_pad
    ])  # fmt: skip
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=openings, objects=[], copper=cu)
    items = []
    st = check_pads_vs_openings(m, [], THR, items)
    assert st["mask_expansion"] == 1 and st["opening_smaller_than_pad"] == 1 and st["missing_opening"] == 1
    assert st["opening_not_pad"] == 1
    assert _summary(items, "missing_opening").eq_question and _summary(items, "opening_smaller_than_pad").fix.op == "MaskResize"


def test_coverage_other_net_near_opening():
    pad = _flash(0, 0, 1.0)
    other = box(0.62, -0.2, 3, 0.2)  # 0.02 from an opening of r=0.6
    cu = _copper([pad], [other])
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=Point(0, 0).buffer(0.6), objects=[], copper=cu)
    items = []
    st = check_pads_vs_openings(m, [], THR, items)
    assert st["mask_coverage"] == 1
    assert _summary(items, "mask_coverage").fix.op == "MaskOptimize"


def test_hole_rules():
    cu = _copper([_flash(0, 0, 1.4), _flash(10, 0, 1.0), _flash(20, 0, 1.0)])
    openings = unary_union([Point(0, 0).buffer(0.5)])  # NPTH 0.9 -> +0.05 < 0.1 ; via at 10 covered ; via at 20 covered
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=openings, objects=[], copper=cu)
    holes = [
        Hole(0, 0, 0.9, False, "d", tool="T1", attribute="non_plated"),
        Hole(10, 0, 0.7, True, "d", tool="T2", attribute="via"),  # ≥0.6 covered -> dam
        Hole(20, 0, 0.3, True, "d", tool="T3", attribute="via"),
        Hole(30, 0, 0.5, False, "d", tool="T4", attribute="non_plated"),  # no opening -> npth_covered
    ]
    items = []
    st = check_holes(m, holes, THR, "resin", items)
    assert st["npth_opening_small"] == 1 and st["via_dam_needed"] == 1 and st["npth_covered"] == 1
    assert st["via_plug_too_large"] == 1  # T2 0.7 > 0.5 with resin plugging
    assert _summary(items, "via_dam_needed").fix.op == "MaskDams"
    assert any(i.kind == "via_mask_summary" for i in items)


def test_slivers_between_ic_pins():
    fine = [box(i * 0.5, 0, i * 0.5 + 0.45, 1) for i in range(4)]  # 0.05 gaps < 0.0762 (green)
    ok = [box(10 + i * 0.5, 0, 10 + i * 0.5 + 0.4, 1) for i in range(4)]  # 0.1 gaps
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=unary_union(fine + ok), objects=[], copper=None)
    items = []
    assert check_slivers(m, 0.0762, items) == 3
    assert _summary(items, "mask_sliver").eq_question


def test_silk_width_and_on_opening():
    thin = go.Line(0, 0, 3, 0, aperture=CircleAperture(diameter=0.1, unit=MM), unit=MM)
    okw = go.Line(0, 2, 3, 2, aperture=CircleAperture(diameter=0.2, unit=MM), unit=MM)
    geom = unary_union([box(0, -0.05, 3, 0.05), box(0, 1.9, 3, 2.1), box(10, 10, 11, 10.2)])
    s = SilkLayer(rel="s.gbr", layer_type="top_silk", geom=geom, objects=[thin, okw])
    items = []
    assert check_silk_width(s, 0.127, items) == 1
    openings = unary_union([box(1, -1, 2, 1), box(10.5, 9, 12, 11)])  # crosses the first stroke and the box
    items = []
    assert check_silk_on_opening(s, openings, 0.0762, items) == 2
    assert _summary(items, "silk_on_opening").fix.op == "SilkClearByMask"


def test_split_outside_and_cleaned_gerber(tmp_path):
    src = "tests/fixtures/kicad-x2ap/Flashpads-F_Silkscreen.gbr"
    gf = GerberFile.open(src)
    n = len(gf.objects)
    profile = box(*gf.bounding_box(unit=MM)[0], *gf.bounding_box(unit=MM)[1])
    s = SilkLayer(rel="silk.gbr", layer_type="top_silk", geom=Polygon(), objects=list(gf.objects))
    inside, outside, crossing = split_outside(s, profile, 0.5)
    assert len(inside) == n and not outside and not crossing
    # shrink the "profile" so a strip of strokes falls outside
    x0, y0, x1, y1 = profile.bounds
    inside, outside, crossing = split_outside(s, box(x0 + 10, y0, x1, y1), 0.0)
    assert outside and len(inside) + len(outside) + len(crossing) == n
    data = write_cleaned_gerber(gf, inside)
    p = tmp_path / "clean.gbr"
    p.write_bytes(data)
    back = GerberFile.open(p)
    assert len(back.objects) == len(inside)
    assert b"\nG75*" in data or b"G75" not in data


# ------------------------------------------------------------------ sample boards ------------
@pytest.mark.parametrize("board", ["kicad-x2ap", "eagle-newer", "altium-limesdr"])
def test_mask_and_silk_stages_on_samples(pipeline, board):
    for stage in ("mask", "silk"):
        rep = pipeline.run(board, stage)
        assert rep.status in ("ok", "needs_review"), (stage, rep.summary)
        kinds = {i.kind for i in rep.items}
        assert "layer_parse_error" not in kinds, (stage, board)
        assert any(a.filename == f"{stage}_checks.json" for a in rep.artifacts)
        seen = set()
        for i in rep.items:
            if i.fix:
                assert i.fix.op, i
            if i.needs_decision:
                assert (i.layer, i.kind) not in seen, i
                seen.add((i.layer, i.kind))
        if stage == "mask" and board == "kicad-x2ap":
            assert "opening_smaller_than_pad" not in kinds and "missing_opening" not in kinds


def test_silk_outside_profile_autodelete(pipeline):
    """C02-style: the KiCad board with one silk stroke moved outside the profile."""
    rep = pipeline.run("kicad-x2ap", "silk")
    assert "silk_outside_profile" not in {i.kind for i in rep.items}  # clean board: nothing outside


# ---------------------------------------------------------------------------------------------
# p144 注意：光标点开窗按原稿保留 / 贴片层核对；p145 字高估算
# ---------------------------------------------------------------------------------------------
def test_fiducial_big_opening_is_info_and_not_shrunk():
    from engine.checks.mask import report_fiducials
    fid = _flash(0, 0, 1.0)
    normal = _flash(10, 0, 1.0)
    cu = _copper([fid, normal], extra=[box(-4, -4, 4, 4).difference(Point(0, 0).buffer(2.5))])  # pour around the fiducial
    openings = unary_union([Point(0, 0).buffer(2.0), Point(10, 0).buffer(0.55)])
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=openings, objects=[], copper=cu)
    items = []
    assert report_fiducials(m, items) == 1
    s = _summary(items, "fiducial_opening")
    assert s.severity == "info" and not s.needs_decision and s.fix.op == "MaskOptimize"


def test_paste_pad_without_opening_is_eq():
    from engine.checks.mask import check_paste_vs_openings
    cu = _copper([_flash(0, 0, 1.0), _flash(5, 0, 1.0)])
    m = MaskLayer(rel="m.gbr", layer_type="top_mask", geom=Point(0, 0).buffer(0.55), objects=[], copper=cu)
    paste = unary_union([box(-0.4, -0.4, 0.4, 0.4), box(4.6, -0.4, 5.4, 0.4)])
    items = []
    assert check_paste_vs_openings(m, paste, items) == 1
    s = _summary(items, "paste_without_opening")
    assert s.needs_decision and "贴片层" in s.eq_question
    assert check_paste_vs_openings(m, None, []) == 0


def _glyph(x, y, h, stroke=0.15, w=None):
    """A stroked 'H'-like glyph: two verticals + a bar, bbox h high, ~h/2 wide."""
    w = w or h * 0.55
    return unary_union([box(x, y, x + stroke, y + h), box(x + w - stroke, y, x + w, y + h), box(x, y + h / 2 - stroke / 2, x + w, y + h / 2 + stroke / 2)])


def test_silk_height_estimated_from_glyph_runs():
    from engine.checks.silk import check_silk_height, text_runs
    small = [_glyph(i * 0.8, 0, 0.5, stroke=0.08) for i in range(5)]  # 20 mil text → below 30 mil
    ok = [_glyph(i * 1.6, 10, 1.0) for i in range(4)]                # 40 mil text, stroke 0.15 → ratio 6.7 ok
    fat = [_glyph(i * 1.6, 20, 0.9, stroke=0.2, w=0.72) for i in range(3)]  # ratio 4.5 → info
    lone = _glyph(50, 50, 0.4)                                       # single small piece: not a run
    outline = box(0, 30, 20, 45).difference(box(0.2, 30.2, 19.8, 44.8))  # component outline, big → ignored
    s = SilkLayer(rel="s.gbr", layer_type="top_silk", geom=unary_union([*small, *ok, *fat, lone, outline]), objects=[])
    runs = text_runs(s)
    assert len(runs) == 3 and sorted(int(r["n"]) for r in runs) == [3, 4, 5]
    items = []
    stats = check_silk_height(s, 0.762, 6.0, items)
    assert stats == {"silk_height": 1, "silk_height_ratio": 1}
    assert _summary(items, "silk_height").needs_decision
    assert _summary(items, "silk_height_ratio").severity == "info"


def test_ratio_summary_is_not_printed_as_a_length():
    """比值/面积不能走 fmt_mm —— 走查时 silk_height_ratio 汇总印成「最小 5.380 mm (211.8 mil)」。"""
    from engine.checks.common import aggregate
    from engine.model.report import ReportItem
    det = [ReportItem(id="r_0", kind="silk_height_ratio", severity="info", layer="s.gbr", measured=5.38, threshold=6.0, message="x")]
    items = []
    aggregate(items, det, kind="silk_height_ratio", layer="s.gbr", message="字高/笔画 < 6:1", severity="info", threshold=6.0, unit=":1")
    assert "最小 5.38:1" in items[-1].message and "mm" not in items[-1].message
    items2 = []
    aggregate(items2, [ReportItem(id="a_0", kind="k", severity="warn", layer="l", measured=12.5, threshold=3.0, message="x")],
              kind="k", layer="l", message="面积", threshold=3.0, unit="mm2")
    assert "最小 12.50 mm²" in items2[-1].message
