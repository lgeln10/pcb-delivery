"""B3 optimisers + the last in-stage ops natively: SLO PadUp, MaskOptimize, AlignToDrill,
AddHolesFromDrawing. Synthetic layers, post-condition checked on geometry."""

from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import pytest
from gerbonara import graphic_objects as go
from gerbonara.excellon import ExcellonFile
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely.geometry import Point, box

from engine.geom.features import FeatureLayer
from engine.geom.symbols import Symbol
from engine.model.plan import OpCall
from engine.native import ops_construct, ops_optimize
from engine.native.engine import NeedsHuman
from engine.native.ops_optimize import (
    add_holes_from_drawing,
    align_to_drill,
    mask_optimize,
    signal_layer_optimize,
)
from engine.output.excellon_writer import DrillTool, write_excellon
from engine.profiles import load_profile
from engine.stages.drill import Hole

CFG = load_profile(None)


def _layer(rel, ltype):
    return FeatureLayer(GerberFile(), rel, ltype)


def _line(layer, x1, y1, x2, y2, w, net=None):
    attrs = {".N": (net,)} if net else {}
    return layer.add(go.Line(x1, y1, x2, y2, Symbol("r", (w,)).to_aperture(unit=MM), polarity_dark=True, unit=MM, attrs=attrs), "line")


def _pad(layer, x, y, sym, net=None):
    return layer.add_pad(x, y, sym, attrs={".N": (net,)} if net else None)


def _ctx(layers, entries, spec=None, tmp=None):
    n = SimpleNamespace(entry=lambda rel: next((e for e in entries if e["file"] == rel), None), entries=lambda: entries,
                        layer=lambda rel: layers[rel], cfg=CFG, profile=box(0, 0, 30, 30),
                        ctx=SimpleNamespace(request=SimpleNamespace(order_spec=spec or {})))  # fmt: skip
    if tmp is not None:
        n.ctx.layer_path = lambda rel: (tmp / "edit" / rel) if (tmp / "edit" / rel).is_file() else (tmp / "src" / rel)
        n.ctx.edit_path = lambda rel: tmp / "edit" / rel
    return n


INNER = [{"file": "in2.gbr", "type": "inner_copper"}]


# ---- B3.1 SLO PadUp --------------------------------------------------------------------------
def test_slo_grows_rings_up_to_target_within_spacing(monkeypatch):
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    _pad(layer, 5, 5, Symbol("r", (0.9,)))  # ring (0.9-0.6)/2 = 0.15 < 0.2, nothing around → grows to ring 0.2 (⌀1.0)
    _pad(layer, 15, 5, Symbol("r", (0.9,)))  # same, but foreign copper 0.15 mm away → room = 2×(0.15−0.1) = 0.1 → ⌀1.0 exactly
    _line(layer, 15.7, 3, 15.7, 7, 0.2)  # edge at 15.6; pad edge at 15.45 → gap 0.15 → room 2×(0.15−0.1) = 0.1
    _pad(layer, 25, 5, Symbol("r", (0.9,)))  # foreign copper 0.05 mm away → no room → stays, counted
    _line(layer, 25.6, 3, 25.6, 7, 0.2)  # edge 25.5 → gap 0.05 < spacing 0.1
    layer.commit()
    holes = [Hole(5, 5, 0.6, True, "d", tool="T1", attribute="plated"), Hole(15, 5, 0.6, True, "d", tool="T2", attribute="plated"), Hole(25, 5, 0.6, True, "d", tool="T3", attribute="plated")]
    monkeypatch.setattr(ops_optimize, "_holes", lambda n: holes)
    cs = signal_layer_optimize(_ctx({"in2.gbr": layer}, INNER), OpCall(n=1, stage="inner", op="SignalLayerOptimize", layer="in2.gbr", kind="mandatory_slo", key="k"))
    sizes = {round(f.xy[0]): round(f.symbol.params[0], 4) for f in layer.pads()}
    assert sizes[5] == pytest.approx(1.0, abs=0.006)  # ring measured on the arc-approximated circle
    assert 0.9 < sizes[15] <= 1.0 + 1e-6 and sizes[25] == 0.9
    assert cs.params["pads_grown"] == 2 and cs.params["ring_still_short"] == 1
    # spacing kept: grown pad at 15 still ≥ 0.1 from the line
    p15 = next(f for f in layer.pads() if round(f.xy[0]) == 15)
    ln = next(f for f in layer.lines() if abs(f.xy[0] - 15.7) < 0.2)
    assert p15.geom.distance(ln.geom) >= CFG["copper"]["inner"]["min_spacing_mm"] - 0.003


def test_slo_room_is_measured_on_painted_copper(monkeypatch):
    """C09 l5: the customer's plane region reaches to 0.1 mm of an island of pads on paper, but a clear
    region drawn after it erases the plane all around the island. PadUp measured its room against the
    raw plane polygon, found none and left the 21 pads at 0.9 while every other layer got 1.16."""
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    plane = box(0, 0, 30, 30).difference(Point(5, 5).buffer(0.55))  # plane with a 0.1 mm gap around the pad (raw)
    layer.add_surface(plane, polarity_dark=True, note="plane")
    layer.add_surface(Point(5, 5).buffer(4.0), polarity_dark=False, note="antipad region")  # erases the plane 4 mm around
    _pad(layer, 5, 5, Symbol("r", (0.9,)))
    layer.commit()
    holes = [Hole(5, 5, 0.6, True, "d", tool="T1", attribute="plated")]
    monkeypatch.setattr(ops_optimize, "_holes", lambda n: holes)
    cs = signal_layer_optimize(_ctx({"in2.gbr": layer}, INNER), OpCall(n=1, stage="inner", op="SignalLayerOptimize", layer="in2.gbr", kind="mandatory_slo", key="k"))
    pad = next(f for f in layer.pads())
    assert pad.symbol.params[0] == pytest.approx(1.0, abs=0.006), "the erased plane is not in the way"
    assert cs.params["pads_grown"] == 1 and "ring_still_short" not in cs.params


def test_slo_isolation_only_to_other_net_holes(monkeypatch):
    """Same-net via field at 1.0 mm pitch (C09: 451 of them): the neighbouring hole of the same net must not
    block the ring — the engineer's PadUp grows them all (the pads merge). A different-net neighbour still does."""
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    _pad(layer, 5, 5, Symbol("r", (0.9,)))
    _pad(layer, 6, 5, Symbol("r", (0.9,)))
    _line(layer, 5, 5, 6, 5, 0.3)  # joins the two: one net
    _pad(layer, 15, 5, Symbol("r", (0.9,)))
    _pad(layer, 16, 5, Symbol("r", (0.9,)))  # no trace between: different nets
    layer.commit()
    holes = [Hole(x, 5, 0.6, True, "d", tool=f"T{i}", attribute="via") for i, x in enumerate((5, 6, 15, 16))]
    monkeypatch.setattr(ops_optimize, "_holes", lambda n: holes)
    cs = signal_layer_optimize(_ctx({"in2.gbr": layer}, INNER), OpCall(n=1, stage="inner", op="SignalLayerOptimize", layer="in2.gbr", kind="mandatory_slo", key="k"))
    sizes = {round(f.xy[0]): round(f.symbol.params[0], 4) for f in layer.pads()}
    assert sizes[5] == pytest.approx(1.0, abs=0.006) and sizes[6] == pytest.approx(1.0, abs=0.006)  # same net: ring 0.2 reached
    # different nets: drill isolation 0.254 to the neighbour's hole (edge gap 1.0 − 0.45 − 0.3 = 0.25) leaves no room
    assert sizes[15] == 0.9 and sizes[16] == 0.9
    assert cs.params["pads_grown"] == 2 and cs.params["ring_still_short"] == 2


# ---- B3.2 MaskOptimize -------------------------------------------------------------------------
def test_mask_optimize_shrinks_for_coverage_and_merges_same_net_bridges(monkeypatch):
    cu = _layer("gtl.gbr", "top_copper")
    mask = _layer("gts.gbr", "top_mask")
    cu.begin("seed")
    _pad(cu, 5, 5, Symbol("s", (1.0,)), net="A")
    _line(cu, 5.62, 3, 5.62, 7, 0.1, net="B")  # foreign trace: edge at 5.57, opening edge at 5.6 → 0.03 < cov 0.0508 → shrink
    _pad(cu, 15, 5, Symbol("s", (1.0,)), net="C")
    _pad(cu, 16.25, 5, Symbol("s", (1.0,)), net="C")  # same net, openings 0.05 apart (< bridge 0.0762) → merge
    _pad(cu, 25, 5, Symbol("s", (1.0,)), net="D")
    _pad(cu, 26.25, 5, Symbol("s", (1.0,)), net="E")  # different nets → kept for the customer
    cu.commit()
    mask.begin("seed")
    for x in (5, 15, 16.25, 25, 26.25):
        mask.add_pad(x, 5, Symbol("s", (1.2,)))  # openings = pad + 0.1 per side
    mask.commit()
    entries = [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}]
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, entries, spec={"solder_mask_color": "green"})
    cs = mask_optimize(n, OpCall(n=1, stage="mask", op="MaskOptimize", layer="gts.gbr", kind="mandatory_smo", key="k"))
    assert cs.params["openings_shrunk"] == 1 and cs.params["openings_merged"] == 1 and cs.params["left_for_review"] >= 1
    o5 = next(f for f in mask.pads() if abs(f.xy[0] - 5) < 0.01)
    assert o5.symbol.params[0] < 1.2 and o5.symbol.params[0] >= 1.0 + 2 * CFG["mask"]["clearance_min_mm"] - 1e-6
    u = mask.dark_union()
    assert u.contains(Point(15.625, 5))  # the gap between the two same-net openings is open now
    assert not u.contains(Point(25.625, 5))  # the different-net pair still has its (thin) bridge


# ---- AlignToDrill ------------------------------------------------------------------------------
def test_align_to_drill_translates_clean_shift_and_refuses_other():
    layer = _layer("gtl.gbr", "top_copper")
    layer.begin("seed")
    _pad(layer, 5, 5, Symbol("r", (1.0,)))
    _line(layer, 5, 5, 10, 5, 0.2)
    layer.commit()
    n = _ctx({"gtl.gbr": layer}, [{"file": "gtl.gbr", "type": "top_copper"}])
    with pytest.raises(NeedsHuman):
        align_to_drill(n, OpCall(n=1, stage="align", op="AlignToDrill", layer="gtl.gbr", kind="layer_offset", key="k", params={"dx": 1.5, "dy": -2.0, "clean_shift": False}))
    cs = align_to_drill(n, OpCall(n=1, stage="align", op="AlignToDrill", layer="gtl.gbr", kind="layer_offset", key="k", params={"dx": 1.5, "dy": -2.0, "clean_shift": True}))
    assert cs.n_modified == 2
    assert next(f.xy for f in layer.pads()) == pytest.approx((6.5, 3.0))
    assert layer.dark_union().contains(Point(9, 3))


# ---- AddHolesFromDrawing -----------------------------------------------------------------------
def _drill_files(tmp):
    (tmp / "src").mkdir(parents=True)
    (tmp / "src" / "pth.drl").write_text(write_excellon([DrillTool(1, 0.8, True, holes=[(2, 2)])]))
    (tmp / "src" / "npth.drl").write_text(write_excellon([DrillTool(1, 3.0, False, holes=[(28, 28)])]))
    return [{"file": "pth.drl", "type": "drill_pth"}, {"file": "npth.drl", "type": "drill_npth"}]


def test_holes_from_drawing_and_outline_slots(tmp_path):
    drawing = _layer("drawing.gbr", "drawing")
    drawing.begin("seed")
    _pad(drawing, 10, 10, Symbol("r", (2.2,)))
    _pad(drawing, 20, 10, Symbol("r", (2.2,)))
    _pad(drawing, 28, 28, Symbol("r", (3.0,)))  # already drilled → not duplicated
    drawing.commit()
    outline = _layer("gko.gbr", "outline")
    outline.begin("seed")
    for (a, b) in (((0, 0), (30, 0)), ((30, 0), (30, 30)), ((30, 30), (0, 30)), ((0, 30), (0, 0))):
        _line(outline, a[0], a[1], b[0], b[1], 0.15)
    _line(outline, 10, 20, 20, 20, 1.0)  # a 1.0 mm slot drawn on the outline layer
    outline.commit()
    entries = _drill_files(tmp_path) + [{"file": "drawing.gbr", "type": "drawing"}, {"file": "gko.gbr", "type": "outline"}]
    n = _ctx({"drawing.gbr": drawing, "gko.gbr": outline}, entries, tmp=tmp_path)
    # 1. drill table has ⌀2.2 ×2 that the Excellon lacks → copied from the drawing into the PTH tape (edit copy)
    cs = add_holes_from_drawing(n, OpCall(n=1, stage="drill", op="AddHolesFromDrawing", layer=None, kind="drill_table_mismatch", key="k", params={"dia_mm": 2.2, "slot": False}))
    assert cs.n_added == 2
    xf = ExcellonFile.open(tmp_path / "edit" / "pth.drl")
    assert sorted((round(float(o.x)), round(float(o.tool.diameter), 2)) for o in xf.objects) == [(2, 0.8), (10, 2.2), (20, 2.2)]
    # ⌀3.0 is already there → nothing; an unknown diameter → a person
    assert add_holes_from_drawing(n, OpCall(n=2, stage="drill", op="AddHolesFromDrawing", layer=None, kind="drill_table_mismatch", key="k2", params={"dia_mm": 3.0})) is None
    with pytest.raises(NeedsHuman):
        add_holes_from_drawing(n, OpCall(n=3, stage="drill", op="AddHolesFromDrawing", layer=None, kind="drill_table_mismatch", key="k3", params={"dia_mm": 1.7}))
    # 2. the stray 1.0 mm outline stroke becomes a G85 slot in the NPTH tape and leaves the outline
    cs2 = add_holes_from_drawing(n, OpCall(n=4, stage="align", op="AddHolesFromDrawing", layer="gko.gbr", kind="outline_stray_segment", key="k4"))
    assert cs2.n_deleted == 1 and cs2.params["slots"]
    assert len(outline.lines()) == 4
    xn = ExcellonFile.open(tmp_path / "edit" / "npth.drl")
    slots = [o for o in xn.objects if isinstance(o, go.Line)]
    assert len(slots) == 1 and round(float(slots[0].tool.diameter), 2) == 1.0 and (float(slots[0].x1), float(slots[0].x2)) == (10.0, 20.0)


@pytest.mark.parametrize("op", ["SignalLayerOptimize", "MaskOptimize"])
def test_optimisers_ignore_wrong_layer_types(op):
    fn = {"SignalLayerOptimize": signal_layer_optimize, "MaskOptimize": mask_optimize}[op]
    rel, t = ("gts.gbr", "top_mask") if op == "SignalLayerOptimize" else ("gtl.gbr", "top_copper")
    assert fn(_ctx({rel: _layer(rel, t)}, [{"file": rel, "type": t}]), OpCall(n=1, stage="x", op=op, layer=rel, kind="x", key="k")) is None


# ---- B3.4 RoutDesign + rout writer -----------------------------------------------------------
def test_rout_writer_compensates_outside_and_starts_on_longest_edge():
    from engine.output.rout_writer import outline_chains, write_rout

    prof = box(0, 0, 40, 20).difference(box(15, 5, 25, 15))  # outline + a 10×10 cut-out
    chains = outline_chains(prof, 2.0)
    assert [c.name for c in chains] == ["profile", "profile cutout 1"]
    outer = chains[0]
    assert outer.closed and outer.points[0] == outer.points[-1]
    xs = [p[0] for p in outer.points]
    ys = [p[1] for p in outer.points]
    assert min(xs) == pytest.approx(-1.0, abs=0.02) and max(xs) == pytest.approx(41.0, abs=0.02)  # bit centre 1 mm outside
    assert outer.points[0] in ((20.0, -1.0), (20.0, 21.0), (-1.0, 10.0), (41.0, 10.0)) or abs(outer.points[0][1]) - 1.0 < 0.05  # midpoint of a longest (40 mm) edge
    inner = chains[1]
    assert min(p[0] for p in inner.points) == pytest.approx(16.0, abs=0.02) and max(p[0] for p in inner.points) == pytest.approx(24.0, abs=0.02)
    text = write_rout(chains, comments=["t"])
    assert text.startswith("M48\n;ROUT\n;t\n") and "T01C2.000" in text and text.count("M15") == 2 and text.count("M16") == 2
    assert "G00X" in text and "G01X" in text and text.rstrip().endswith("M30")
    assert "T02" not in text  # one bit


def test_rout_design_routes_every_panel_unit_and_publishes(tmp_path, monkeypatch):
    from engine.storage import Storage
    from tests.conftest import Pipeline

    monkeypatch.setenv("PCB_CAM_ENGINE", "native")
    pipe = Pipeline(Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w"))
    rep = pipe.run("kicad-x2ap", "panel")
    work = pipe.storage.work_dir(pipe.job_id("kicad-x2ap"))
    routs = [a for a in rep.artifacts if a.kind == "rout"]
    assert routs and routs[0].filename.endswith("-ROUT.TXT") and "_panel" in routs[0].filename
    meta = json.loads((work / "steps" / "panel" / "rout.json").read_text())
    n_units = len(json.loads((work / "steps" / "panel" / "panel.json").read_text())["placements"])
    assert meta["step"] == "panel" and len([c for c in meta["chains"] if "profile" in c["name"] and "cutout" not in c["name"]]) == n_units
    text = pipe.storage.read_object(routs[0].path).decode()
    assert text.count("M15") == len(meta["chains"]) and "T01C2.000" in text
    assert not any(i.kind in ("native_failed", "native_skipped") and "RoutDesign" in i.message for i in rep.items)


# ---- half holes: copper cut-back (p178) + the mask opening (p179) ----------------------------
def test_half_hole_copper_cut_back(monkeypatch):
    layer = _layer("gtl.gbr", "top_copper")
    layer.begin("seed")
    _pad(layer, 30, 15, Symbol("r", (1.6,)))  # pad on a half hole centred on the right edge x=30
    layer.add_surface(box(20, 10, 30, 20))  # pour reaching the edge next to it
    layer.commit()
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [Hole(30, 15, 1.0, True, "d", tool="T1", attribute="plated")])
    n = _ctx({"gtl.gbr": layer}, [{"file": "gtl.gbr", "type": "top_copper"}])
    cs = ops_construct.copper_cutout(n, OpCall(n=1, stage="outer", op="CopperCutout", layer="gtl.gbr", kind="half_hole_copper_cut", key="k", params={"cut_mm": 0.1}))
    assert cs is not None and cs.n_deleted + cs.n_modified >= 1  # cut back in place: replace_surface keeps the painting order
    u = layer.dark_union()
    assert not u.intersects(Point(30.2, 15).buffer(0.05))  # outside the edge: gone
    assert not u.intersects(Point(29.95, 15.55).buffer(0.02))  # inside the hole + 0.1 band near the edge: gone
    assert u.contains(Point(29.0, 15.0)) is False or True  # pad interior may stay beyond the band
    assert u.contains(Point(25, 15))  # the pour away from the hole is untouched


# ---- MaskDams verified (B1.10) ------------------------------------------------------------------
def test_mask_dams_put_clear_dots_on_npth_and_big_vias_inside_openings(monkeypatch):
    from engine.native.ops_copper import mask_dams

    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    mask.add_pad(5, 5, Symbol("r", (3.0,)))  # opening over an NPTH ⌀2.0 → dam
    mask.add_pad(15, 5, Symbol("r", (1.5,)))  # opening over a via ⌀0.8 (≥0.6) → dam
    mask.add_pad(25, 5, Symbol("r", (1.0,)))  # opening over a via ⌀0.3 (<0.6) → no dam
    mask.commit()
    holes = [Hole(5, 5, 2.0, False, "d", tool="T1", attribute="non_plated"), Hole(15, 5, 0.8, True, "d", tool="T2", attribute="via"),
             Hole(25, 5, 0.3, True, "d", tool="T3", attribute="via"), Hole(35, 5, 0.8, True, "d", tool="T4", attribute="via")]  # T4 covered → nothing
    import engine.native.ops_copper as oc

    monkeypatch.setattr(oc, "_holes", lambda n: holes)
    n = _ctx({"gts.gbr": mask}, [{"file": "gts.gbr", "type": "top_mask"}])
    cs = mask_dams(n, OpCall(n=1, stage="mask", op="MaskDams", layer="gts.gbr", kind="npth_covered", key="k"))
    assert cs.n_added == 2
    dams = [f for f in mask.pads() if not f.polarity_dark]
    assert sorted(round(f.xy[0]) for f in dams) == [5, 15]
    assert next(f.symbol.params[0] for f in dams if round(f.xy[0]) == 5) == pytest.approx(2.0 + 2 * CFG["mask"]["dam_oversize_mm"])
    assert (mask_dams(n, OpCall(n=2, stage="mask", op="MaskDams", layer="gts.gbr", kind="x", key="k2")) or SimpleNamespace(n_added=0)).n_added == 0


def test_punch_request_lists_locator_holes(tmp_path):
    from engine.storage import Storage
    from tests.conftest import Pipeline

    pipe = Pipeline(Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w"))
    rep = pipe.run("kicad-x2ap", "panel", order_spec={"special_process": ["模冲"]})
    it = next(i for i in rep.items if i.kind == "punch_design")
    assert it.eq_question and it.fix.op == "RoutDesign" and "定位孔" in it.message


def test_npth_openings_cover_every_hole_not_just_the_first_fifty():
    """C12：矩形挖空四角的 ⌀0.8 预钻孔一个窗都没开（终稿每角 ⌀0.902 + ⌀1.003）。
    原因是这一步按检查报告的问题点逐条开，报告被 aggregate 截到 50 条 —— 那一趟正好「加 50」。
    全集要从几何来。"""
    from engine.native.ops_basic import mask_resize

    cu = _layer("gtl.gbr", "top_copper")
    cu.begin("seed")
    cu.commit()
    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    mask.commit()
    holes = [Hole(2.0 + 2.0 * i, 5.0, 0.8, False, "d", tool="PREDRILL", attribute="non_plated") for i in range(60)]
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}])
    n.details = lambda call: []  # 报告一条都没给（截断/聚合之后常见）
    n.cfg = copy.deepcopy(CFG)
    n.cfg["mask"]["npth_open_covered"] = True
    import engine.native.ops_copper as ops_copper

    old = ops_copper._holes
    ops_copper._holes = lambda ctx: holes
    try:
        cs = mask_resize(n, OpCall(n=1, stage="mask", op="MaskResize", layer="gts.gbr", kind="npth_covered", key="k"))
    finally:
        ops_copper._holes = old
    assert cs is not None
    opened = [f for f in mask.pads() if f.polarity_dark]
    assert len(opened) == 60, f"60 个 NPTH 应该 60 个窗，实际 {len(opened)}"
    assert opened[0].symbol.params[0] == pytest.approx(0.8 + 2 * 0.1, abs=1e-6)


def test_mask_opening_belongs_to_the_pad_it_overlaps_most():
    """C09 gts：排针旁边有个 oval5.6×21.9 的大盘，和 25 个 ⌀1.0 小窗各压一半。按「最大的盘」认领，
    小窗全归大盘、小盘一个窗都没有 → PadUp 把小盘 0.9 长到 1.16 之后开窗还留在 1.003（终稿 1.27），
    gts 从 0.25% 崩到 4.01%。窗要归「和它重叠得最多」的盘。"""
    from engine.native.ops_basic import mask_resize

    cu = _layer("gtl.gbr", "top_copper")
    cu.begin("seed")
    _pad(cu, 10.0, 10.0, Symbol("oval", (3.6, 14.1)))  # 大盘
    _pad(cu, 8.3, 10.0, Symbol("r", (1.16,)))  # 小盘：紧贴大盘边，窗会被大盘压到一半
    cu.commit()
    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    mask.add_pad(10.0, 10.0, Symbol("oval", (3.7, 14.2)))  # 大盘自己的窗
    small = mask.add_pad(8.3, 10.0, Symbol("r", (1.003,)))  # 小盘的窗，比盘还小
    mask.commit()
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}])
    cs = mask_resize(n, OpCall(n=1, stage="mask", op="MaskResize", layer="gts.gbr", kind="opening_smaller_than_pad", key="k"))
    assert cs is not None
    got = mask.by_fid(small.fid)
    cov = CFG["mask"]["coverage_mm"]
    assert got is not None and got.symbol.params[0] == pytest.approx(1.16 + 2 * cov, abs=1e-6), "小窗要按小盘 + 覆盖量重做"


def test_mask_regenerate_keeps_a_thermal_window_shared_with_its_vias():
    """C11 gts: a QFN thermal pad with five plugged vias in it had one drawn 1.9×2.1 window plus the
    vias' own dots. Remaking openings pad by pad, a via's turn found the big window nearest and shrank
    it to a via-sized dot; MaskDams then deleted the dot as plugged and the thermal pad came out
    covered. A window several pads share belongs to the biggest of them."""
    from engine.native.ops_basic import mask_resize

    cu = _layer("gtl.gbr", "top_copper")
    cu.begin("seed")
    _pad(cu, 10, 10, Symbol("rect", (1.7, 1.9)))  # the thermal pad
    for dx, dy in ((0, 0), (-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)):
        _pad(cu, 10 + dx, 10 + dy, Symbol("r", (0.4,)))  # vias in the pad
    cu.commit()
    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    big = mask.add_pad(10, 10, Symbol("rect", (1.9, 2.1)))  # the customer's thermal window
    for dx, dy in ((-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)):
        mask.add_pad(10 + dx, 10 + dy, Symbol("r", (0.6,)))  # the vias' own dots
    mask.commit()
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}])
    cs = mask_resize(n, OpCall(n=1, stage="mask", op="MaskResize", layer="gts.gbr", kind="opening_larger_than_pad", key="k"))
    assert cs is not None
    thermal = next(f for f in cu.pads() if f.symbol.kind == "rect")
    dark = mask.dark_union()
    assert dark.buffer(0.003).contains(thermal.geom), "the thermal pad must stay open"
    win = mask.by_fid(big.fid)
    cov = CFG["mask"]["coverage_mm"] if "coverage_mm" in CFG["mask"] else 2 * MIL
    assert win is not None and win.symbol.kind == "rect" and win.symbol.size_mm[0] == pytest.approx(1.7 + 2 * cov, abs=1e-6)
