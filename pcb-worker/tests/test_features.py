"""B0: symbol library (recognition ⇄ generation ⇄ naming) and the editable FeatureLayer
(round trip, queries, transactions, revert, write-back)."""

from __future__ import annotations

import math

import pytest
from gerbonara import apertures as ap
from gerbonara.utils import MM

from engine.geom.features import FeatureLayer
from engine.geom.from_gerbonara import camfile_to_geometry
from engine.geom.layers import open_camfile
from engine.geom.symbols import MIL, Symbol, parse_symbol, symbol_of, thermal_for_hole
from tests.conftest import FIXTURES

KICAD_FCU = FIXTURES / "kicad-x2ap" / "Flashpads-F_Cu.gbr"


# ---- symbols ----------------------------------------------------------------------------
@pytest.mark.parametrize("name,kind,area", [
    ("r40", "r", math.pi * (20 * MIL) ** 2),
    ("s40", "s", (40 * MIL) ** 2),
    ("rect40x20", "rect", 40 * 20 * MIL * MIL),
    ("rect40x20xr5", "rect", 40 * 20 * MIL * MIL - (4 - math.pi) * (5 * MIL) ** 2),
    ("oval40x20", "oval", 20 * 20 * MIL * MIL + math.pi * (10 * MIL) ** 2),
    ("donut_r60x40", "donut_r", math.pi * ((30 * MIL) ** 2 - (20 * MIL) ** 2)),
])  # fmt: skip
def test_parse_generate_name_roundtrip(name, kind, area):
    s = parse_symbol(name)
    assert s.kind == kind and s.name == name
    assert s.polygon().area == pytest.approx(area, rel=0.01)


def test_thermal_symbol_geometry_and_rules():
    s = thermal_for_hole(0.5, ring_mm=8 * MIL, gap_mm=8 * MIL)  # p119: 孔边到内圆≥8mil、内外圆≥8mil、开口≥8mil
    assert s.kind == "ths" and s.params[1] == pytest.approx(0.5 + 16 * MIL) and s.params[0] == pytest.approx(0.5 + 32 * MIL)
    g = s.polygon()
    assert g.geom_type == "MultiPolygon" and len(g.geoms) == 4  # 4 arcs between 4 spokes
    assert parse_symbol(s.name).params[3] == 4
    # generated aperture is a macro that flashes to the same shape
    a = s.to_aperture()
    back = symbol_of(a)
    assert back.kind == "ths" and back.polygon().symmetric_difference(g).area < 0.02 * g.area


def test_standard_apertures_recognised_and_regenerated():
    assert symbol_of(ap.CircleAperture(diameter=1.0, unit=MM)).name == "r39.4"
    assert symbol_of(ap.RectangleAperture(w=1.0, h=1.0, unit=MM)).kind == "s"
    assert symbol_of(ap.RectangleAperture(w=1.0, h=0.5, unit=MM)).name == "rect39.4x19.7"
    assert symbol_of(ap.ObroundAperture(w=1.0, h=0.5, unit=MM)).kind == "oval"
    s = Symbol("rect", (1.0, 0.5), rotation_deg=90)
    a = s.to_aperture()
    assert isinstance(a, ap.RectangleAperture) and (float(a.w), float(a.h)) == (0.5, 1.0)


def test_kicad_macros_recognised_or_kept_as_user():
    layer = FeatureLayer.load(KICAD_FCU)
    kinds = {}
    for f in layer.pads():
        s = f.symbol
        assert s is not None
        kinds.setdefault(s.kind, 0)
        kinds[s.kind] += 1
        if s.kind != "user":  # a recognised symbol regenerates to the same shape
            assert s.polygon().symmetric_difference(f.symbol.polygon()).area < 1e-9
    # RoundRect / RotRect / HorizOval macros come back as rect / oval; custom outlines stay user
    assert kinds.get("rect", 0) + kinds.get("s", 0) + kinds.get("oval", 0) + kinds.get("r", 0) >= 0.7 * sum(kinds.values())
    for f in layer.pads():
        s = f.symbol
        if s.kind != "user":
            assert s.polygon(*f.xy).symmetric_difference(f.geom).area < 0.02 * f.geom.area + 1e-6


def test_resize_semantics():
    s = parse_symbol("rect40x20").resized(2 * MIL)
    assert s.name == "rect42x22"
    assert parse_symbol("r40").resized(-2 * MIL).name == "r38"
    # a user shape resizes by offsetting its outline (Genesis Resize on a drawn pad)
    u = Symbol("user", macro_name="Fp1", aperture=ap.CircleAperture(diameter=1, unit=MM)).resized(0.1)
    assert u.kind == "user" and u.polygon().area == pytest.approx(math.pi * 0.55**2, rel=0.01)


# ---- feature layer ----------------------------------------------------------------------
@pytest.mark.parametrize("board,fname", [("kicad-x2ap", "Flashpads-F_Cu.gbr"), ("eagle-newer", "copper_top.gbr")])
def test_layer_roundtrip_without_edits_is_lossless(board, fname, tmp_path):
    path = FIXTURES / board / fname
    layer = FeatureLayer.load(path)
    src, _ = camfile_to_geometry(open_camfile(path, "top_copper"))
    assert len(layer) == len(open_camfile(path, "top_copper").objects)
    out = tmp_path / fname
    layer.save(out)
    back = FeatureLayer.load(out)
    assert len(back) == len(layer)
    assert back.fold().symmetric_difference(src).area < 5e-4 * max(src.area, 1)  # coordinate quantisation of the file format
    assert layer.fold().symmetric_difference(src).area < 1e-9


def test_queries_nets_and_components():
    layer = FeatureLayer.load(KICAD_FCU)
    pads = layer.pads()
    assert pads and any(f.net for f in layer) and any(f.function for f in pads)
    p = pads[0]
    near = layer.query(p.geom.buffer(0.5))
    assert p in near
    comp = layer.components()
    assert comp[p.fid] in comp.values() and len(set(comp.values())) < len(comp)
    assert layer.stats()["pad"] == len(pads)


def test_transaction_records_and_reverts(tmp_path):
    layer = FeatureLayer.load(KICAD_FCU)
    n0 = len(layer)
    src = layer.fold()
    pad = next(f for f in layer.pads() if f.symbol and f.symbol.kind == "r")
    with pytest.raises(RuntimeError):
        layer.delete(pad)  # outside a transaction
    cs = layer.begin("LineCompensation", {"size_mil": 1})
    bigger = pad.symbol.resized(1 * MIL)
    nf = layer.set_symbol(pad, bigger)
    layer.add_pad(1.0, 1.0, parse_symbol("r40"))
    layer.delete(layer.lines()[0])
    layer.commit()
    assert (cs.n_modified, cs.n_added, cs.n_deleted) == (1, 1, 1) and len(layer) == n0
    assert nf.symbol.name == bigger.name and cs.summary()["details"][0]["before"]["symbol"] == pad.symbol.name
    assert layer.fold().symmetric_difference(src).area > 0
    layer.revert()
    assert len(layer) == n0 and layer.fold().symmetric_difference(src).area < 1e-9
    # write-back after an edit re-reads with the edit in place
    layer.begin("SetProfile")
    layer.move(layer.pads()[0], 0.3, 0.0)
    layer.commit()
    out = tmp_path / "edited.gbr"
    layer.save(out)
    back = FeatureLayer.load(out)
    assert abs(back.pads()[0].xy[0] - layer.pads()[0].xy[0]) < 1e-6 and back.fold().symmetric_difference(layer.fold()).area < 1e-3
    assert cs.to_json().startswith("{")


def test_add_surface_with_hole():
    from shapely.geometry import Point, box

    layer = FeatureLayer.load(KICAD_FCU)
    g = box(0, 0, 2, 2).difference(Point(1, 1).buffer(0.5))
    layer.begin("Contourize")
    feats = layer.add_surface(g)
    assert len(feats) == 1 and feats[0].polarity_dark and feats[0].kind == "surface"
    # the cut-in contour folds back to the same polygon (slit has no area) and survives a write/read
    assert feats[0].geom.symmetric_difference(g).area < 1e-6
    layer.add_surface(box(5, 5, 6, 6).difference(Point(5.5, 5.5).buffer(0.2)), polarity_dark=False)
    layer.commit() if layer._cs else None
    back = FeatureLayer.from_bytes(layer.to_bytes(), "x.gbr")
    assert back.fold().symmetric_difference(layer.fold()).area < 1e-3


def test_components_respect_clearances_cut_by_clear_features():
    """A pad in an antipad a clear region cut into a plane is not attached to the plane (C09 l5: the
    engineer deletes those as NFPs; we kept 40 of them as 'a plane reaches it'). A pad painted over the
    plane with no clearance is attached; a pad wholly erased by a clear joins nothing."""
    from gerbonara.rs274x import GerberFile
    from shapely.geometry import Point, box

    layer = FeatureLayer(GerberFile(), "l5", "inner_copper")
    layer.begin("test")
    plane = layer.add_surface(box(0, 0, 20, 20))[0]
    layer.add_surface(Point(5, 5).buffer(1.5), polarity_dark=False)  # antipad
    in_antipad = layer.add_pad(5, 5, Symbol("r", (1.0,)))
    on_plane = layer.add_pad(15, 15, Symbol("r", (1.0,)))
    layer.add_surface(Point(15, 5).buffer(1.5), polarity_dark=False)
    erased = layer.add_pad(15, 5, Symbol("r", (1.0,)), polarity_dark=True)
    layer.add_surface(Point(15, 5).buffer(1.5), polarity_dark=False)  # drawn after the pad: erases it
    lone = layer.add_pad(30, 30, Symbol("r", (1.0,)))
    layer.commit()
    comp = layer.components(touch=0.02)
    assert comp[in_antipad.fid] != comp[plane.fid]
    assert comp[on_plane.fid] == comp[plane.fid]
    assert comp[erased.fid] not in (comp[plane.fid], comp[in_antipad.fid])
    assert comp[lone.fid] != comp[plane.fid]
    # no clear features at all → the plain overlap rule, unchanged
    plain = FeatureLayer(GerberFile(), "l2", "inner_copper")
    plain.begin("test")
    a = plain.add_surface(box(0, 0, 10, 10))[0]
    b = plain.add_pad(5, 5, Symbol("r", (1.0,)))
    c = plain.add_pad(50, 50, Symbol("r", (1.0,)))
    plain.commit()
    comp = plain.components()
    assert comp[a.fid] == comp[b.fid] != comp[c.fid]


def test_cutin_ring_slits_never_cross_another_hole():
    """C12 L2: with holes in a row, the naive nearest-vertex slit from the exterior to the far hole
    crossed the middle hole, the contour self-intersected and the even-odd fill turned a 60 mm²
    patch of plane into a hole. The contour must fold back to exactly the polygon."""
    from gerbonara import graphic_objects as go
    from shapely.geometry import Point, box

    from engine.geom.features import cutin_ring
    from engine.geom.from_gerbonara import fold_layer

    # a long slab with three antipads on the centre line: the exterior's nearest vertex to the middle
    # hole lies past the outer holes, so a straight slit would cut through them
    slab = box(0, 0, 40, 4).difference(Point(8, 2).buffer(1.2)).difference(Point(20, 2).buffer(1.2)).difference(Point(32, 2).buffer(1.2))
    # plus a cluster of overlapping-clearance rings (the C12 shape): three rings whose nearest exterior
    # vertex is the same corner
    plane = box(0, 0, 40, 40).difference(Point(30, 30).buffer(2)).difference(Point(33, 27).buffer(2)).difference(Point(27, 33).buffer(2)).difference(Point(30, 24).buffer(1))
    for poly in (slab, plane):
        ring = cutin_ring(poly)
        painted, _ = fold_layer([go.Region(ring, unit=MM, polarity_dark=True)])
        assert painted.symmetric_difference(poly).area < 1e-3, painted.symmetric_difference(poly).area


def test_cutin_ring_folds_back_a_real_plane_with_154_holes():
    """C12 L2's plane after the pour clearance (154 antipads): the nearest-vertex slits of the old
    cutin_ring crossed other rings and 2.7 mm² of copper flipped on re-reading; the contour must give
    back the polygon exactly."""
    from gerbonara import graphic_objects as go
    from shapely import wkt

    from engine.geom.features import cutin_ring
    from engine.geom.from_gerbonara import fold_layer

    poly = wkt.loads((FIXTURES / "geom" / "c12_l2_plane_154_holes.wkt").read_text())
    assert len(poly.interiors) >= 150
    painted, _ = fold_layer([go.Region(cutin_ring(poly), unit=MM, polarity_dark=True)])
    assert painted.symmetric_difference(poly).area < 1e-3


def _no_edge_crosses(ring: list[tuple[float, float]]) -> bool:
    """A cut-in contour may touch itself (slits) but never cross itself."""
    from shapely import LineString

    edges = [LineString([ring[i], ring[(i + 1) % len(ring)]]) for i in range(len(ring))]
    edges = [e for e in edges if e.length > 1e-12]
    return not any(edges[i].crosses(edges[j]) for i in range(len(edges)) for j in range(i + 1, len(edges)))


def test_cutin_ring_slits_never_cross_an_earlier_slit():
    """Three holes in a square: A ties to the corner along the diagonal, B (above the diagonal)
    ties to A, C (below the diagonal) finds B's vertex nearest — the naive slit B→C would cut
    the diagonal slit, the contour would self-intersect and a reader may drop the wedge between
    the slits (C09 L2 round 2: 49 mm² of plane)."""
    from gerbonara import graphic_objects as go
    from shapely import make_valid
    from shapely.geometry import Point, Polygon

    from engine.geom.features import cutin_ring
    from engine.geom.from_gerbonara import fold_layer

    outer = Polygon([(0, 0), (20, 0), (20, 20), (0, 20)])
    poly = outer.difference(Point(10, 10).buffer(0.5, 8)).difference(Point(4, 7.5).buffer(0.5, 8)).difference(Point(6, 3).buffer(0.5, 8))
    assert len(poly.interiors) == 3
    ring = cutin_ring(poly)
    assert _no_edge_crosses(ring), "a slit crosses another slit"
    painted, _ = fold_layer([go.Region(ring, unit=MM, polarity_dark=True)])
    assert painted.symmetric_difference(poly).area < 1e-6
    # both shapely repairs agree once the contour only touches itself
    assert make_valid(Polygon(ring)).symmetric_difference(poly).area < 1e-6
