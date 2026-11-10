"""Prototype: gerbonara graphic objects -> shapely geometry.

gerbonara (1.6.x) has no shapely export of its own. Every GraphicObject
(Flash / Line / Arc / Region, and Excellon holes/slots) exposes
``to_primitives(unit)`` which yields GraphicPrimitives (Circle, Line, Arc,
Rectangle, ArcPoly). Every primitive has ``to_arc_poly()`` and ArcPoly has
``approximate_arcs(max_error)``, giving us a plain point outline we can hand
to shapely.

Polarity handling: objects are folded *in drawing order*. Consecutive runs of
identical polarity are unioned first (``unary_union`` is far faster than a
chain of pairwise unions), then a dark run is unioned into the accumulator and
a clear run is subtracted from it. This mirrors the Gerber painting model
(LPD paints, LPC erases whatever was painted before it).
"""

from __future__ import annotations

import itertools
import math
import time
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from gerbonara import graphic_objects as go
from gerbonara import graphic_primitives as gp
from gerbonara.apertures import RectangleAperture
from gerbonara.utils import MM, approximate_arc
from shapely import make_valid
from shapely.geometry import MultiPoint, MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

DEFAULT_MAX_ERROR_MM = 0.005  # arc flattening tolerance (5 um)


@dataclass
class FoldStats:
    objects: int = 0
    primitives: int = 0
    polygons: int = 0
    degenerate: int = 0
    invalid_fixed: int = 0
    dark_runs: int = 0
    clear_runs: int = 0
    seconds: float = 0.0


def arc_poly_points(arc_poly, max_error: float) -> list[tuple[float, float]]:
    """Flatten an ArcPoly to a point list.

    Re-implements ``ArcPoly.approximate_arcs`` because gerbonara 1.6.3's
    ``utils.approximate_arc`` raises ZeroDivisionError on zero-radius arcs
    (seen in Altium output: arc segments whose center coincides with the start
    point). Those are treated as straight segments here.
    """
    pts: list[tuple[float, float]] = []
    for (x1, y1), (x2, y2), (clockwise, (cx, cy)) in arc_poly.segments:
        if clockwise is None or math.dist((x1, y1), (cx, cy)) < 1e-9:
            pts.append((x1, y1))
        else:
            arc = list(approximate_arc(cx, cy, x1, y1, x2, y2, clockwise, max_error=max_error))
            pts.extend(arc[:-1])  # drop arc end point, next segment starts there
    return pts


def rectangle_points(rect: gp.Rectangle) -> list[tuple[float, float]]:
    """Corners of a rotated rectangle.

    gerbonara 1.6.3 ``Rectangle.to_arc_poly`` has a wrong rotation formula
    (correct only for rotation == 0): a 45-degree rotated square comes out with
    twice its true area. Rotated rectangles are common (KiCad ``RotRect`` /
    ``RoundRect`` macros use primitive 21 / 20 with a rotation), so compute the
    corners ourselves.
    """
    s, c = math.sin(rect.rotation), math.cos(rect.rotation)
    hw, hh = rect.w / 2, rect.h / 2
    return [
        (rect.x + dx * c - dy * s, rect.y + dx * s + dy * c)
        for dx, dy in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))
    ]


def primitive_to_polygon(prim, max_error: float = DEFAULT_MAX_ERROR_MM) -> Polygon | None:
    """Convert one gerbonara GraphicPrimitive to a shapely Polygon (or None if degenerate)."""
    if isinstance(prim, (gp.Line, gp.Arc)):
        # gerbonara's Line.is_zero_size() is True for a zero-*length* stroke, but a
        # zero-length stroke with a round aperture is a full circle (this is how an
        # obround with w == h and every "dot" D01 shows up). Only drop it if the
        # width is zero too.
        if math.isclose(prim.width, 0, abs_tol=1e-9):
            return None
    elif prim.is_zero_size():
        return None
    if isinstance(prim, gp.Rectangle):
        pts = rectangle_points(prim)
    else:
        pts = arc_poly_points(prim.to_arc_poly(), max_error)
    if len(pts) < 3:
        return None
    poly = Polygon(pts)
    if poly.is_empty or math.isclose(poly.area, 0.0, abs_tol=1e-12):
        return None
    return poly


def rect_stroke_polygon(obj, unit=MM, max_error: float = DEFAULT_MAX_ERROR_MM) -> Polygon | None:
    """A draw (D01) with a *rectangle* aperture: the rectangle swept along the path, corners kept.

    gerbonara strokes every draw as a round-capped line of ``aperture.equivalent_width()`` — for a
    rectangle that is its **diagonal** (its own docstring says rectangle draws are "not well-defined").
    The Gerber spec (4.4 / D01) is clear: the aperture is dragged, unrotated, so the stroke is the
    Minkowski sum of the path and the rectangle. This factory's Genesis output draws pads and mask
    openings that way all the time (C12 golden .gts: 2 236 of them; a 0.946 mm square drawn 0.1 mm
    long is a 1.05 × 0.95 opening, not the 1.44 × 1.34 rounded blob gerbonara makes of it) — every
    "×√2" the M6i–M6m comparisons found on such features came from this.
    """
    ap = obj.aperture
    conv = obj.converted(unit)
    w, h = unit.convert_from(ap.unit, ap.w), unit.convert_from(ap.unit, ap.h)
    if isinstance(obj, go.Arc):
        pts = list(approximate_arc(conv.cx, conv.cy, conv.x1, conv.y1, conv.x2, conv.y2, conv.clockwise, max_error=max_error))
    else:
        pts = [(conv.x1, conv.y1), (conv.x2, conv.y2)]
    if not pts:
        return None
    hw, hh = w / 2, h / 2
    corners = ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))
    hulls = [
        MultiPoint([(x + dx, y + dy) for x, y in (a, b) for dx, dy in corners]).convex_hull
        for a, b in zip(pts, pts[1:] or pts)
    ]
    poly = unary_union(hulls) if len(hulls) > 1 else hulls[0]
    if poly.is_empty or math.isclose(poly.area, 0.0, abs_tol=1e-12):
        return None
    return poly if isinstance(poly, Polygon) else poly.convex_hull  # a sampled arc can leave slivers; the hull is the sweep


def valid_polygon(poly):
    """Repair an invalid polygon the way a Gerber painter fills it. A region written with cut-ins
    (one contour, every hole spliced in through a zero-width slit) is a self-touching ring: the
    default ``make_valid`` (linework) may drop the loop between two slits that leave the same
    vertex (C09 L2: 49 mm² of plane), the structure method keeps exactly the enclosed area.
    Falls back to linework when the structure method gives nothing."""
    try:
        fixed = make_valid(poly, method="structure", keep_collapsed=False)
    except Exception:  # pragma: no cover - older GEOS
        fixed = None
    if fixed is None or fixed.is_empty:
        fixed = make_valid(poly)
    return fixed


def iter_object_polygons(
    objects: Iterable, unit=MM, max_error: float = DEFAULT_MAX_ERROR_MM, stats: FoldStats | None = None
) -> Iterator[tuple[bool, Polygon]]:
    """Yield ``(polarity_dark, polygon)`` per primitive, in drawing order.

    Note: an aperture-macro flash may expand to several primitives with mixed
    exposure (e.g. an outline with a clear cut-out); those keep their own
    ``polarity_dark`` from gerbonara.
    """
    for obj in objects:
        if stats:
            stats.objects += 1
        if isinstance(obj, (go.Line, go.Arc)) and isinstance(getattr(obj, "aperture", None), RectangleAperture):
            if stats:
                stats.primitives += 1
            poly = rect_stroke_polygon(obj, unit, max_error)
            if poly is None:
                if stats:
                    stats.degenerate += 1
                continue
            yield bool(obj.polarity_dark), poly
            continue
        for prim in obj.to_primitives(unit=unit):
            if stats:
                stats.primitives += 1
            poly = primitive_to_polygon(prim, max_error)
            if poly is None:
                if stats:
                    stats.degenerate += 1
                continue
            if not poly.is_valid:
                poly = valid_polygon(poly)
                if stats:
                    stats.invalid_fixed += 1
            yield bool(prim.polarity_dark), poly


def fold_layer(
    objects: Iterable, unit=MM, max_error: float = DEFAULT_MAX_ERROR_MM, stats: FoldStats | None = None
) -> tuple[BaseGeometry, FoldStats]:
    """Fold a whole layer (drawing order, dark=union / clear=difference) into one geometry."""
    stats = stats or FoldStats()
    t0 = time.perf_counter()
    acc: BaseGeometry = Polygon()
    for dark, run in itertools.groupby(iter_object_polygons(objects, unit, max_error, stats), key=lambda t: t[0]):
        merged = unary_union([p for _, p in run])
        if dark:
            stats.dark_runs += 1
            acc = merged if acc.is_empty else unary_union([acc, merged])
        else:
            stats.clear_runs += 1
            acc = acc.difference(merged)
    if not acc.is_valid:
        acc = valid_polygon(acc)
    stats.polygons = len(acc.geoms) if isinstance(acc, MultiPolygon) else (0 if acc.is_empty else 1)
    stats.seconds = time.perf_counter() - t0
    return acc, stats


def camfile_to_geometry(camfile, unit=MM, max_error: float = DEFAULT_MAX_ERROR_MM) -> tuple[BaseGeometry, FoldStats]:
    """Convenience: fold a GerberFile / ExcellonFile (``.objects``) into shapely geometry."""
    return fold_layer(camfile.objects, unit=unit, max_error=max_error)
