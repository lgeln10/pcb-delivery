"""Unit checks for the gerbonara -> shapely prototype on hand-written Gerber snippets."""

import math

import pytest
from gerbonara.rs274x import GerberFile

from engine.geom.from_gerbonara import camfile_to_geometry

HEADER = "%FSLAX46Y46*%\n%MOMM*%\n"


def fold(body: str):
    g = GerberFile.from_string(HEADER + body + "M02*\n")
    geom, stats = camfile_to_geometry(g)
    return geom, stats


def test_rotated_centerline_macro_area():
    # KiCad RotRect: primitive 21 with 45 deg rotation. gerbonara's own
    # Rectangle.to_arc_poly doubles the area here; we must get 1.8*1.8.
    geom, _ = fold("%AMRotRect*\n21,1,$1,$2,0,0,$3*%\n%ADD10RotRect,1.8X1.8X45*%\nD10*\nX0Y0D03*\n")
    assert geom.area == pytest.approx(3.24, rel=1e-6)


def test_vectorline_macro_135deg():
    # what gerbonara emits when "calculating out" a rotated CenterLine
    geom, _ = fold("%AMCALC*\n20,1,1.8,0.636396,-0.636396,-0.636396,0.636396,0*%\n%ADD10CALC*%\nD10*\nX0Y0D03*\n")
    assert geom.area == pytest.approx(3.24, rel=1e-4)


def test_obround_square_is_circle():
    geom, _ = fold("%ADD10O,2.0X2.0*%\nD10*\nX0Y0D03*\n")
    assert geom.area == pytest.approx(math.pi, rel=2e-3)


def test_zero_length_stroke_is_dot():
    geom, _ = fold("%ADD10C,1.0*%\nD10*\nX0Y0D02*\nX0Y0D01*\n")
    assert geom.area == pytest.approx(math.pi / 4, rel=5e-3)


def test_lpc_subtracts_in_drawing_order():
    body = (
        "%ADD10R,4.0X4.0*%\n%ADD11C,2.0*%\nD10*\nX0Y0D03*\n"
        "%LPC*%\nD11*\nX0Y0D03*\n"
        "%LPD*%\nD11*\nX10000000Y0D03*\n"
    )
    geom, stats = fold(body)
    assert stats.dark_runs == 2 and stats.clear_runs == 1
    assert geom.area == pytest.approx(16 - math.pi + math.pi, rel=2e-3)
    assert len(geom.geoms) == 2  # square with hole + separate circle


@pytest.mark.xfail(
    strict=True,
    reason="gerbonara 1.6.3 bug: parser tests `if self.step_repeat_objects:` (empty list is falsy), "
    "so the SR block is never collected/expanded; the first flash lands once, unrepeated.",
)
def test_step_repeat_expanded_on_parse():
    geom, stats = fold("%ADD10C,1.0*%\n%SRX2Y3I5.0J4.0*%\nD10*\nX0Y0D03*\n%SR*%\n")
    assert stats.objects == 6
    assert geom.area == pytest.approx(6 * math.pi / 4, rel=5e-3)


def test_step_repeat_current_behaviour_is_single_instance():
    # pin the (wrong) behaviour so an upgrade that fixes SR is noticed
    _geom, stats = fold("%ADD10C,1.0*%\n%SRX2Y3I5.0J4.0*%\nD10*\nX0Y0D03*\n%SR*%\n")
    assert stats.objects == 1


def test_zero_radius_arc_does_not_crash():
    # Altium emits arcs whose centre equals the start point (I=J=0)
    geom, _ = fold("%ADD10C,0.2*%\nD10*\nG75*\nG01*\nX0Y0D02*\nG03*\nX1000000Y0I0J0D01*\n")
    assert geom.area > 0


def test_geometry_to_svg_shared_frame_aligns_layers():
    """多层叠加对照:每层自身范围不同,必须能按同一个画框(板外形)出图,否则叠上去是错位的。"""
    from shapely.geometry import box as sbox

    from engine.geom.svg import geometry_to_svg

    small = sbox(10, 10, 20, 20)
    big = sbox(0, 0, 80, 50)
    own = geometry_to_svg(small, "a", "top_copper")
    framed = geometry_to_svg(small, "a", "top_copper", frame=big.bounds)
    other = geometry_to_svg(sbox(60, 40, 70, 45), "b", "bottom_copper", frame=big.bounds)

    def vb(svg: str) -> str:
        return svg.split('viewBox="', 1)[1].split('"', 1)[0]

    assert vb(own) != vb(framed)
    assert vb(framed) == vb(other) == "-1 -51 82 52"  # 板外形 + 1mm 边距,y 翻转


def test_rectangle_aperture_draw_is_the_swept_rectangle_not_a_round_stroke():
    """gerbonara strokes a rectangle-aperture draw as a round line of *diagonal* width (its docstring
    calls rectangle draws "not well-defined"). The factory's Genesis output draws pads and openings
    that way constantly (C12 golden .gts: 2 236 draws) — a 0.946 mm square drawn 0.1 mm long is a
    1.05 × 0.95 opening; gerbonara made a 1.44 × 1.34 blob of it, and every "×√2" the M6i–M6m
    comparisons found on such features was this artefact (ROADMAP §M6m)."""
    from gerbonara import graphic_objects as go
    from gerbonara.apertures import RectangleAperture
    from gerbonara.utils import MM, Inch

    from engine.geom.from_gerbonara import iter_object_polygons

    def one(obj):
        return [p for _, p in iter_object_polygons([obj])][0]

    sq = RectangleAperture(w=0.03725, h=0.03725, unit=Inch)  # the C12 golden square-pad opening, verbatim
    g = one(go.Line(0.72304, 1.96464, 0.72704, 1.96464, sq, unit=Inch, polarity_dark=True))
    x0, y0, x1, y1 = g.bounds
    assert (round(x1 - x0, 3), round(y1 - y0, 3)) == (1.048, 0.946)
    assert g.area == pytest.approx(1.048 * 0.946, abs=1e-3)  # sharp corners: the full bbox is filled
    g = one(go.Line(0, 0, 1, 1, RectangleAperture(w=0.2, h=0.4, unit=MM), unit=MM, polarity_dark=True))
    assert g.area == pytest.approx(0.2 * 0.4 + 1 * 0.4 + 1 * 0.2, abs=1e-9)  # Minkowski sum of segment and rectangle
    assert len(g.exterior.coords) == 7  # a hexagon: the unrotated rectangle dragged along a diagonal
    g = one(go.Line(0, 0, 0, 0, RectangleAperture(w=0.2, h=0.4, unit=MM), unit=MM, polarity_dark=True))
    assert g.area == pytest.approx(0.08, abs=1e-9)  # zero-length draw = one flash of the rectangle
    # round apertures keep gerbonara's stroke
    from gerbonara.apertures import CircleAperture

    g = one(go.Line(0, 0, 1, 0, CircleAperture(diameter=0.2, unit=MM), unit=MM, polarity_dark=True))
    assert g.area == pytest.approx(0.2 + 3.14159 * 0.01, abs=2e-3)
