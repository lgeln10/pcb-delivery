"""B2 constructive ops on synthetic layers: NfpRemoval, SliverFill, Teardrops, SilkClearByMask.

Each test plants the situation the book describes, runs the op through a stub context and checks
the post-condition on the resulting geometry — plus the guard case (must NOT change)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from gerbonara import graphic_objects as go
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely.geometry import Point, box

from engine.geom.features import FeatureLayer
from engine.geom.symbols import Symbol
from engine.model.plan import OpCall
from engine.native import ops_construct
from engine.native.ops_construct import (
    contourize,
    copper_cutout,
    mask_construct_pads,
    nfp_removal,
    silk_clear_by_mask,
    sliver_fill,
    teardrops,
)
from engine.profiles import load_profile
from engine.stages.drill import Hole

CFG = load_profile(None)


def _layer(rel: str, ltype: str) -> FeatureLayer:
    return FeatureLayer(GerberFile(), rel, ltype)


def _line(layer: FeatureLayer, x1, y1, x2, y2, w: float, dark: bool = True):
    return layer.add(go.Line(x1, y1, x2, y2, Symbol("r", (w,)).to_aperture(unit=MM), polarity_dark=dark, unit=MM), "line")


def _ctx(layers: dict[str, FeatureLayer], entries: list[dict]):
    return SimpleNamespace(entry=lambda rel: next((e for e in entries if e["file"] == rel), None), entries=lambda: entries,
                           layer=lambda rel: layers[rel], cfg=CFG, profile=box(-5, -5, 30, 30), ctx=None)  # fmt: skip


def _call(op: str, layer: str, **params) -> OpCall:
    return OpCall(n=1, stage="inner", op=op, layer=layer, kind=f"mandatory_{op.lower()}", key="k", params=params)


INNER = [{"file": "in2.gbr", "type": "inner_copper"}]


# ---- B2.1 NfpRemoval ------------------------------------------------------------------------
def test_nfp_removal_deletes_unconnected_pads_keeps_connected_and_fiducials(monkeypatch):
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    layer.add_pad(1, 1, Symbol("r", (1.0,)))  # no hole, nothing attached → NFP
    layer.add_pad(5, 5, Symbol("r", (1.0,)))  # drilled, nothing attached → NFP too (p134)
    keep = layer.add_pad(9, 9, Symbol("r", (1.0,)))
    _line(layer, 9, 9, 9, 15, 0.2)  # attached → functional
    fid = layer.add_pad(14, 14, Symbol("r", (1.0,)).to_aperture and Symbol("r", (1.0,)))
    layer.replace_aperture(fid, Symbol("r", (1.0,)).to_aperture(unit=MM, attrs=((".AperFunction", ("Fiducial", "Local")),)), "fiducial")
    layer.commit()
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [Hole(5, 5, 0.5, True, "d.drl", tool="T1", attribute="via")])
    cs = nfp_removal(_ctx({"in2.gbr": layer}, INNER), _call("NfpRemoval", "in2.gbr"))
    assert cs is not None and cs.n_deleted == 2
    left = {(round(f.xy[0]), round(f.xy[1])) for f in layer.pads()}
    assert left == {(9, 9), (14, 14)} and keep.fid in {f.fid for f in layer.pads()}
    # negative film / non-inner: refused
    neg = [{"file": "in2.gbr", "type": "inner_copper", "polarity": "negative"}]
    assert nfp_removal(_ctx({"in2.gbr": layer}, neg), _call("NfpRemoval", "in2.gbr")) is None


# ---- B2.4 SliverFill ------------------------------------------------------------------------
def test_sliver_fill_only_between_connected_copper(monkeypatch):
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    # a U of 0.2 mm lines whose two arms are 0.05 mm apart (edge to edge) → same component → fill
    _line(layer, 0, 0, 10, 0, 0.2)
    _line(layer, 10, 0, 10, 0.25, 0.2)
    _line(layer, 10, 0.25, 0, 0.25, 0.2)
    # two unconnected parallel lines 0.05 mm apart → different components → must stay apart
    _line(layer, 0, 5, 10, 5, 0.2)
    _line(layer, 0, 5.25, 10, 5.25, 0.2)
    layer.commit()
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [])
    before = layer.dark_union()
    cs = sliver_fill(_ctx({"in2.gbr": layer}, INNER), _call("SliverFill", "in2.gbr"))
    assert cs is not None and cs.n_added >= 1 and cs.params.get("skipped_would_bridge_or_hole", 0) >= 1
    after = layer.dark_union()
    assert after.contains(Point(5, 0.125)) and not before.contains(Point(5, 0.125))  # gap of the U is filled
    assert not after.contains(Point(5, 5.125))  # the two nets are still apart
    # idempotent: a second run adds nothing
    cs2 = sliver_fill(_ctx({"in2.gbr": layer}, INNER), _call("SliverFill", "in2.gbr"))
    assert cs2 is None or cs2.n_added == 0


# ---- B2.5 Teardrops -------------------------------------------------------------------------
def test_teardrops_added_for_small_rings_and_skipped_near_other_nets(monkeypatch):
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    layer.add_pad(0, 0, Symbol("r", (1.0,)))  # ring (1.0-0.8)/2 = 0.1 ≤ 9 mil → teardrop
    _line(layer, 0, 0, 5, 0, 0.2)
    layer.add_pad(10, 0, Symbol("r", (3.0,)))  # ring 1.1 mm → no teardrop
    _line(layer, 10, 0, 15, 0, 0.2)
    layer.add_pad(0, 10, Symbol("r", (1.0,)))  # small ring but a foreign trace 0.05 mm from the teardrop → skip
    _line(layer, 0, 10, 5, 10, 0.2)
    _line(layer, 0.6, 10.4, 3, 10.4, 0.1)
    layer.commit()
    holes = [Hole(0, 0, 0.8, True, "d", tool="T1", attribute="via"), Hole(10, 0, 0.8, True, "d", tool="T1", attribute="via"), Hole(0, 10, 0.8, True, "d", tool="T1", attribute="via")]
    monkeypatch.setattr(ops_construct, "_holes", lambda n: holes)
    before = layer.dark_union()
    cs = teardrops(_ctx({"in2.gbr": layer}, INNER), _call("Teardrops", "in2.gbr"))
    assert cs is not None and cs.n_added == 2 and cs.params.get("skipped_spacing_or_hole") == 1  # one teardrop = a wedge each side of the trace
    after = layer.dark_union()
    # the junction just outside the pad is now wider than the trace, and tapers to it by 2R
    assert after.contains(Point(0.6, 0.2)) and not before.contains(Point(0.6, 0.2))
    assert not after.contains(Point(1.2, 0.2))
    assert not after.contains(Point(11.7, 0.3)) and not after.contains(Point(0.6, 10.2))  # big ring: no teardrop; foreign trace: skipped
    assert (teardrops(_ctx({"in2.gbr": layer}, INNER), _call("Teardrops", "in2.gbr")) or SimpleNamespace(n_added=0)).n_added == 0


# ---- B2.6 SilkClearByMask -----------------------------------------------------------------
def test_silk_clear_by_mask_clips_and_deletes():
    silk = _layer("gto.gbr", "top_silk")
    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    mask.add_pad(5, 5, Symbol("r", (2.0,)))  # opening
    mask.commit()
    silk.begin("seed")
    _line(silk, 0, 5, 10, 5, 0.15)  # crosses the opening → two remainders
    silk.add_pad(5, 5, Symbol("r", (0.4,)))  # entirely inside → gone
    _line(silk, 0, 9, 10, 9, 0.15)  # far away → untouched
    silk.commit()
    entries = [{"file": "gto.gbr", "type": "top_silk"}, {"file": "gts.gbr", "type": "top_mask"}]
    n = _ctx({"gto.gbr": silk, "gts.gbr": mask}, entries)
    cs = silk_clear_by_mask(n, OpCall(n=1, stage="silk", op="SilkClearByMask", layer="gto.gbr", kind="mandatory_silk_clear", key="k"))
    assert cs is not None and cs.n_deleted == 2 and cs.n_added == 2
    u = silk.dark_union()
    clr = CFG["silk"]["clearance_to_opening_mm"]
    assert not u.intersects(Point(5, 5).buffer(1.0 + clr - 0.001))  # nothing left inside opening + clearance
    assert u.contains(Point(1, 5)) and u.contains(Point(9, 5)) and u.contains(Point(5, 9))
    assert silk_clear_by_mask(n, OpCall(n=1, stage="silk", op="SilkClearByMask", layer="gto.gbr", kind="x", key="k")).__len__() == 0


@pytest.mark.parametrize("op", ["NfpRemoval", "SliverFill", "Teardrops"])
def test_copper_ops_ignore_non_copper_layers(op):
    fn = {"NfpRemoval": nfp_removal, "SliverFill": sliver_fill, "Teardrops": teardrops}[op]
    layer = _layer("gts.gbr", "top_mask")
    assert fn(_ctx({"gts.gbr": layer}, [{"file": "gts.gbr", "type": "top_mask"}]), _call(op, "gts.gbr")) is None


# ---- B2.2 Contourize ------------------------------------------------------------------------
def test_contourize_turns_painted_pour_into_surface_but_keeps_traces():
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    for i in range(12):  # a pour painted with overlapping 0.5 mm strokes (pitch 0.3)
        _line(layer, 0, i * 0.3, 6, i * 0.3, 0.5)
    _line(layer, 6, 1.5, 12, 1.5, 0.2)  # a trace leaving the pour: attached, not paint
    _line(layer, 20, 0, 25, 0, 0.2)  # lonely trace
    layer.commit()
    n_lines = len(layer.lines())
    cs = contourize(_ctx({"in2.gbr": layer}, INNER), _call("Contourize", "in2.gbr"))
    assert cs is not None and cs.n_deleted == 12 and cs.n_added == 1
    assert len(layer.surfaces()) == 1 and len(layer.lines()) == n_lines - 12
    pour = layer.surfaces()[0].geom
    assert pour.contains(Point(3, 1.5)) and pour.area == pytest.approx(6.5 * 3.8, rel=0.05)  # bbox 6.5×3.8 minus rounded corners
    assert layer.dark_union().contains(Point(9, 1.5)) and layer.dark_union().contains(Point(22, 0))
    cs2 = contourize(_ctx({"in2.gbr": layer}, INNER), _call("Contourize", "in2.gbr"))
    assert cs2 is None or len(cs2) == 0  # idempotent


# ---- B2.3 MaskConstructPads -------------------------------------------------------------------
def test_mask_construct_pads_by_reference(monkeypatch):
    cu = _layer("gtl.gbr", "top_copper")
    mask = _layer("gts.gbr", "top_mask")
    cu.begin("seed")
    cu.add_pad(2, 2, Symbol("r", (1.0,)))  # has a drawn (region) opening → becomes r1.0 + 2×cov (or the drawn size)
    cu.add_pad(6, 2, Symbol("s", (1.2,)))  # no opening → gets one
    cu.add_pad(10, 2, Symbol("r", (0.6,)))  # via, covered → stays covered (p144)
    cu.commit()
    mask.begin("seed")
    mask.add_surface(Point(2, 2).buffer(0.6))  # drawn opening over the first pad
    mask.commit()
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [Hole(10, 2, 0.3, True, "d", tool="T1", attribute="via")])
    entries = [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}]
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, entries)
    cs = mask_construct_pads(n, OpCall(n=1, stage="outer", op="MaskConstructPads", layer="gtl.gbr", kind="mandatory_construct_pads", key="k"))
    assert cs is not None and cs.layer == "gts.gbr" and cs.n_deleted == 1 and cs.n_added == 2
    pads = {(round(f.xy[0]), round(f.xy[1])): f.symbol for f in mask.pads()}
    assert set(pads) == {(2, 2), (6, 2)} and not mask.surfaces()
    cov = CFG["mask"]["coverage_mm"]
    assert pads[(2, 2)].kind == "r" and pads[(2, 2)].params[0] == pytest.approx(1.2, abs=0.01)  # drawn size 1.2 > 1.0 + 2×cov
    assert pads[(6, 2)].kind == "s" and pads[(6, 2)].params[0] == pytest.approx(1.2 + 2 * cov)
    # second run: nothing to do
    assert mask_construct_pads(n, OpCall(n=2, stage="outer", op="MaskConstructPads", layer="gtl.gbr", kind="x", key="k2")).__len__() == 0


# ---- B2.7 CopperCutout ----------------------------------------------------------------------
def test_copper_cutout_around_gold_fingers(monkeypatch):
    from types import SimpleNamespace as NS

    from engine.native.engine import NeedsHuman

    zone = NS(hull=box(20, 0, 30, 4), side="top", edge="bottom", pads=[])
    monkeypatch.setattr(ops_construct, "_finger_zones", lambda n: [zone])
    # positive inner: plane surface is cut back 3 mm, an isolated pad inside is deleted
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    layer.add_surface(box(0, 0, 40, 20))
    layer.add_pad(25, 5, Symbol("r", (1.0,)))
    layer.commit()
    gf = OpCall(n=1, stage="inner", op="CopperCutout", layer="in2.gbr", kind="gold_finger_inner_copper", key="k")
    cs = copper_cutout(_ctx({"in2.gbr": layer}, INNER), gf)
    assert cs is not None and cs.n_deleted == 2 and cs.n_added == 1
    u = layer.dark_union()
    assert not u.intersects(box(20, 0, 30, 4).buffer(2.99)) and u.contains(Point(5, 10))
    # a trace running through the region would be opened → refused
    layer2 = _layer("in2.gbr", "inner_copper")
    layer2.begin("seed")
    _line(layer2, 0, 2, 40, 2, 0.2)
    layer2.commit()
    with pytest.raises(NeedsHuman):
        copper_cutout(_ctx({"in2.gbr": layer2}, INNER), gf)
    # negative inner: a dark block = clearance
    neg = [{"file": "in1.gbr", "type": "inner_copper", "polarity": "negative"}]
    layer3 = _layer("in1.gbr", "inner_copper")
    gf1 = OpCall(n=1, stage="inner", op="CopperCutout", layer="in1.gbr", kind="gold_finger_inner_copper", key="k")
    cs3 = copper_cutout(_ctx({"in1.gbr": layer3}, neg), gf1)
    assert cs3 is not None and cs3.n_added == 1 and layer3.dark_union().contains(box(20, 0, 30, 4).buffer(2.9))
    # outer: design change → a person
    with pytest.raises(NeedsHuman):
        copper_cutout(_ctx({"gtl.gbr": _layer("gtl.gbr", "top_copper")}, [{"file": "gtl.gbr", "type": "top_copper"}]),
                      OpCall(n=1, stage="outer", op="CopperCutout", layer="gtl.gbr", kind="gold_finger_copper_nearby", key="k"))  # fmt: skip


def test_pour_clearance_cuts_back_from_foreign_copper_and_holes(monkeypatch):
    layer = _layer("in2.gbr", "inner_copper")
    layer.begin("seed")
    layer.add_surface(box(0, 0, 20, 10))  # the pour
    layer.add_pad(5, 5, Symbol("r", (1.0,)))  # foreign pad inside the pour (different component once cut? no: it touches) …
    _line(layer, 25, 5, 30, 5, 0.2)  # far away, untouched
    layer.commit()
    # a pad sitting *in* the pour is connected to it (same component) → the book's 掏铜 is about pads that are
    # not connected: plant one 0.05 mm outside the pour edge instead
    layer.begin("seed2")
    layer.add_pad(20.55, 5, Symbol("r", (1.0,)))  # gap 0.05 < spacing 0.1 → pour cut back to 0.1
    layer.commit()
    holes = [Hole(15, 5, 0.6, True, "d", tool="T1", attribute="plated"),  # no pad of its own in the pour → isolate
             Hole(5, 5, 0.4, True, "d", tool="T2", attribute="via")]  # under the pour-connected pad → untouched
    monkeypatch.setattr(ops_construct, "_holes", lambda n: holes)
    cs = copper_cutout(_ctx({"in2.gbr": layer}, INNER), _call("CopperCutout", "in2.gbr"))
    assert cs is not None and cs.n_deleted == 1 and cs.n_added >= 1
    from shapely.ops import unary_union

    pour = unary_union([f.geom for f in layer.surfaces()])
    iso = CFG["copper"]["inner"]["drill_isolation_mm"]
    assert not pour.intersects(Point(15, 5).buffer(0.3 + iso - 0.01))  # hole isolated
    assert pour.contains(Point(5, 5.6))  # the via under the owned pad: pour still there next to it
    assert Point(20.55, 5).buffer(0.5 + 0.1 - 0.005).intersection(pour).area < 1e-6  # spacing to the foreign pad restored
    assert pour.contains(Point(2, 2)) and layer.dark_union().contains(Point(27, 5))
    cs2 = copper_cutout(_ctx({"in2.gbr": layer}, INNER), _call("CopperCutout", "in2.gbr"))
    assert cs2 is None or len(cs2) == 0


# ---- 二次审计 5a: SMD PAD 与线一起加大（p138 步骤5） ----------------------------------------------
def test_line_compensation_also_grows_smd_pads():
    from engine.native.ops_basic import line_compensation

    layer = _layer("gtl.gbr", "top_copper")
    layer.begin("seed")
    smd = layer.add_pad(2, 2, Symbol("rect", (1.0, 0.5)))
    layer.replace_aperture(smd, Symbol("rect", (1.0, 0.5)).to_aperture(unit=MM, attrs=((".AperFunction", ("SMDPad", "CuDef")),)), "smd")
    layer.add_pad(6, 2, Symbol("rect", (1.0, 0.5)))  # no attribute → not an SMD pad → untouched
    tight = layer.add_pad(10, 2, Symbol("rect", (1.0, 0.5)))
    layer.replace_aperture(tight, Symbol("rect", (1.0, 0.5)).to_aperture(unit=MM, attrs=((".AperFunction", ("SMDPad", "CuDef")),)), "smd")
    _line(layer, 10.775, 1, 10.775, 3, 0.5)  # foreign copper 0.025 mm away (beyond TOUCH, inside the growth) → skipped
    layer.commit()
    n = _ctx({"gtl.gbr": layer}, [{"file": "gtl.gbr", "type": "top_copper", "index": 1}])
    n.ctx = SimpleNamespace(request=SimpleNamespace(order_spec={}))
    cs = line_compensation(n, OpCall(n=1, stage="outer", op="LineCompensation", layer="gtl.gbr", kind="mandatory_compensation", key="k"))
    assert cs is not None and cs.params["smd_pads_grown"] == 1 and cs.params["skipped_would_short"] == 1
    sizes = {round(f.xy[0]): f.symbol.params[:2] for f in layer.pads()}
    assert sizes[2] == pytest.approx((1.0254, 0.5254)) and sizes[6] == (1.0, 0.5) and sizes[10] == (1.0, 0.5)


# ---- 二次审计 5b: 转线路 PAD（p136 construct_pads_auto） -----------------------------------------
def test_drawn_copper_pad_under_a_flash_opening_becomes_a_flash(monkeypatch):
    cu = _layer("gtl.gbr", "top_copper")
    mask = _layer("gts.gbr", "top_mask")
    mask.begin("seed")
    mask.add_pad(2, 2, Symbol("s", (1.2,)))  # opening over a drawn square pad
    mask.add_pad(6, 2, Symbol("s", (1.2,)))  # opening over a trace passing through → not a pad
    mask.commit()
    cu.begin("seed")
    cu.add_surface(box(1.5, 1.5, 2.5, 2.5))  # drawn 1.0 square (opening − 2×cov ≈ 1.1)
    _line(cu, 5, 2, 7, 2, 0.2)
    cu.commit()
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [])
    entries = [{"file": "gtl.gbr", "type": "top_copper"}, {"file": "gts.gbr", "type": "top_mask"}]
    n = _ctx({"gtl.gbr": cu, "gts.gbr": mask}, entries)
    n.save_layer = lambda rel: None
    cs = mask_construct_pads(n, OpCall(n=1, stage="outer", op="MaskConstructPads", layer="gtl.gbr", kind="mandatory_construct_pads", key="k"))
    assert cs is not None and cs.params.get("copper_pads_constructed") == 1
    pads = {(round(f.xy[0]), round(f.xy[1])): f.symbol for f in cu.pads()}
    assert set(pads) == {(2, 2)} and pads[(2, 2)].kind == "s" and pads[(2, 2)].params[0] == pytest.approx(1.2 - 2 * CFG["mask"]["coverage_mm"])
    assert not cu.surfaces() and len(cu.lines()) == 1  # the trace under the second opening is untouched
