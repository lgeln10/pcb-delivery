"""Symbol library (B0.2): Genesis-style parametric pad symbols ⇄ Gerber apertures ⇄ polygons.

Genesis names symbols by shape + size in mils (第2章 / 第6章 p119): ``r40`` round 40 mil,
``s40`` square, ``rect40x20`` rectangle (``rect40x20xr5`` rounded corners), ``oval40x20``,
``donut_r60x40`` (outer × inner), ``ths60x40x45x4x8`` thermal (outer × inner × angle × spokes ×
gap), ``thr`` the rectangular thermal, ``el40x20`` ellipse. Customer Gerbers never carry these:
KiCad flashes ``RoundRect``/``RotRect`` macros, Altium one ``ROTATEDRECTDnn`` macro per rotation.
``symbol_of`` recognises an aperture by *shape* (generate the candidate, compare polygons), so an
op that says "Change Symbol to r40" has something to change; whatever is not recognised stays a
``user`` symbol wrapping the original aperture — it can still be moved/deleted, just not resized
by name.

All params are mm; names are mils (rounded to 0.1 mil) because that is what the book and the
Genesis scripts speak.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from gerbonara import apertures as ap
from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely import affinity
from shapely.geometry import Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.geom.from_gerbonara import DEFAULT_MAX_ERROR_MM, iter_object_polygons

MIL = 0.0254
KINDS = ("r", "s", "rect", "oval", "donut_r", "ths", "thr", "el", "user")
_MATCH_TOL = 0.02  # symmetric difference / area a recognised candidate may have


def _mil(v: float) -> str:
    m = round(v / MIL, 1)
    return f"{m:g}" if m != int(m) else f"{int(m)}"


@dataclass(frozen=True)
class Symbol:
    kind: str
    params: tuple[float, ...] = ()  # mm (角度用度)
    rotation_deg: float = 0.0
    hole_mm: float = 0.0
    macro_name: str | None = None  # kind == "user"
    aperture: Any = field(default=None, compare=False, hash=False)  # kind == "user": the original

    # ---- naming -------------------------------------------------------------------------
    @property
    def name(self) -> str:
        p = self.params
        if self.kind == "r":
            return f"r{_mil(p[0])}"
        if self.kind == "s":
            return f"s{_mil(p[0])}"
        if self.kind == "rect":
            base = f"rect{_mil(p[0])}x{_mil(p[1])}"
            return base + (f"xr{_mil(p[2])}" if len(p) > 2 and p[2] > 0 else "")
        if self.kind == "oval":
            return f"oval{_mil(p[0])}x{_mil(p[1])}"
        if self.kind == "el":
            return f"el{_mil(p[0])}x{_mil(p[1])}"
        if self.kind == "donut_r":
            return f"donut_r{_mil(p[0])}x{_mil(p[1])}"
        if self.kind == "ths":
            return f"ths{_mil(p[0])}x{_mil(p[1])}x{p[2]:g}x{int(p[3])}x{_mil(p[4])}"
        if self.kind == "thr":
            return f"thr{_mil(p[0])}x{_mil(p[1])}x{p[2]:g}x{int(p[3])}x{_mil(p[4])}"
        return f"user_{self.macro_name or 'aperture'}"

    @property
    def size_mm(self) -> tuple[float, float]:
        """Bounding size (w, h) before rotation."""
        p = self.params
        if self.kind in ("r", "s", "donut_r", "ths", "thr"):
            return (p[0], p[0])
        if self.kind in ("rect", "oval", "el"):
            return (p[0], p[1])
        if self.aperture is not None:
            x0, y0, x1, y1 = _flash_polygon(self.aperture).bounds
            return (x1 - x0, y1 - y0)
        return (0.0, 0.0)

    def resized(self, delta_mm: float) -> Symbol:
        """Grow (or shrink) every outline dimension by ``delta`` — Genesis ``sel_resize`` semantics
        (总加大量, both sides together)."""
        p = list(self.params)
        if self.kind in ("r", "s"):
            p[0] = max(p[0] + delta_mm, 0.0)
        elif self.kind in ("rect", "oval", "el"):
            p[0] = max(p[0] + delta_mm, 0.0)
            p[1] = max(p[1] + delta_mm, 0.0)
        elif self.kind == "donut_r" or self.kind in ("ths", "thr"):
            p[0] = max(p[0] + delta_mm, 0.0)
        else:
            # user shape: offset the outline (round joins) — what Genesis' Resize does to a drawn pad
            if self.aperture is None:
                raise ValueError(f"cannot resize user symbol {self.name}")
            g = _flash_polygon(self.aperture).buffer(delta_mm / 2, join_style="round")
            if g.is_empty:
                raise ValueError(f"resize of {self.name} by {delta_mm} leaves nothing")
            name = f"{self.macro_name or 'user'}_r{_mil(delta_mm)}"
            return Symbol("user", (), self.rotation_deg, self.hole_mm, macro_name=name, aperture=outline_macro_aperture(name, g, attrs=getattr(self.aperture, "attrs", None)))
        return Symbol(self.kind, tuple(p), self.rotation_deg, self.hole_mm)

    # ---- geometry -------------------------------------------------------------------------
    def polygon(self, x: float = 0.0, y: float = 0.0, max_error: float = DEFAULT_MAX_ERROR_MM) -> BaseGeometry:
        p = self.params
        k = self.kind
        if k == "r":
            g: BaseGeometry = Point(0, 0).buffer(p[0] / 2, quad_segs=_qs(p[0] / 2, max_error))
        elif k == "s":
            g = box(-p[0] / 2, -p[0] / 2, p[0] / 2, p[0] / 2)
        elif k == "rect":
            w, h = p[0], p[1]
            r = p[2] if len(p) > 2 else 0.0
            g = box(-w / 2, -h / 2, w / 2, h / 2)
            if r > 0:
                g = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r).buffer(r, quad_segs=_qs(r, max_error))
        elif k == "oval":
            w, h = p[0], p[1]
            r = min(w, h) / 2
            g = box(-w / 2 + r, -h / 2 + r, w / 2 - r, h / 2 - r).buffer(r, quad_segs=_qs(r, max_error)) if w != h else Point(0, 0).buffer(r, quad_segs=_qs(r, max_error))
        elif k == "el":
            g = affinity.scale(Point(0, 0).buffer(1.0, quad_segs=_qs(max(p) / 2, max_error)), p[0] / 2, p[1] / 2)
        elif k == "donut_r":
            g = Point(0, 0).buffer(p[0] / 2, quad_segs=_qs(p[0] / 2, max_error)).difference(Point(0, 0).buffer(p[1] / 2, quad_segs=_qs(p[1] / 2, max_error)))
        elif k in ("ths", "thr"):
            od, idm, ang, n, gap = p[0], p[1], p[2], int(p[3]), p[4]
            outer = Point(0, 0).buffer(od / 2, quad_segs=_qs(od / 2, max_error)) if k == "ths" else box(-od / 2, -od / 2, od / 2, od / 2)
            inner = Point(0, 0).buffer(idm / 2, quad_segs=_qs(idm / 2, max_error)) if k == "ths" else box(-idm / 2, -idm / 2, idm / 2, idm / 2)
            ring = outer.difference(inner)
            spokes = [affinity.rotate(box(-od, -gap / 2, od, gap / 2), ang + i * (360.0 / n), origin=(0, 0)) for i in range(n)]
            g = ring.difference(unary_union(spokes))
        else:
            if self.aperture is None:
                raise ValueError("user symbol without aperture")
            g = _flash_polygon(self.aperture, max_error)
        if self.hole_mm > 0:
            g = g.difference(Point(0, 0).buffer(self.hole_mm / 2, quad_segs=_qs(self.hole_mm / 2, max_error)))
        if self.rotation_deg:
            g = affinity.rotate(g, self.rotation_deg, origin=(0, 0))
        return affinity.translate(g, x, y) if (x or y) else g

    # ---- aperture -------------------------------------------------------------------------
    def to_aperture(self, unit=MM, attrs: tuple | None = None) -> Any:
        """A gerbonara aperture that flashes this symbol. Standard shapes map onto C/R/O; everything
        else becomes an outline macro so the written Gerber needs no vendor extension."""
        p = self.params
        k = self.kind
        hole = self.hole_mm or None
        if k == "r":
            return ap.CircleAperture(diameter=p[0], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "s" and not self.rotation_deg % 90:
            return ap.RectangleAperture(w=p[0], h=p[0], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "rect" and (len(p) < 3 or p[2] <= 0) and not self.rotation_deg % 180:
            return ap.RectangleAperture(w=p[0], h=p[1], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "rect" and (len(p) < 3 or p[2] <= 0) and not (self.rotation_deg - 90) % 180:
            return ap.RectangleAperture(w=p[1], h=p[0], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "oval" and not self.rotation_deg % 180:
            return ap.ObroundAperture(w=p[0], h=p[1], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "oval" and not (self.rotation_deg - 90) % 180:
            return ap.ObroundAperture(w=p[1], h=p[0], hole_dia=hole, unit=unit, attrs=attrs)
        if k == "user" and self.aperture is not None:
            return self.aperture
        return outline_macro_aperture(self.name, self.polygon(), unit=unit, attrs=attrs)


def _qs(r: float, max_error: float) -> int:
    """quad_segs so the chord error stays under max_error (min 8 per quarter)."""
    if r <= 0:
        return 8
    theta = 2 * math.acos(max(1 - max_error / r, -1.0)) if max_error < r else math.pi / 2
    return max(8, math.ceil(math.pi / 2 / max(theta, 1e-6)))


def outline_macro_aperture(name: str, geom: BaseGeometry, unit=MM, attrs: tuple | None = None) -> Any:
    """Any polygon → an aperture macro of Outline primitives (holes as exposure-off outlines)."""
    from gerbonara.aperture_macros import primitive as amp
    from gerbonara.aperture_macros.expression import ConstantExpression, UnitExpression
    from gerbonara.aperture_macros.parse import ApertureMacro

    prims: list[Any] = []
    polys = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    for poly in polys:
        if poly.is_empty:
            continue
        for ring, exposure in [(poly.exterior, 1), *[(i, 0) for i in poly.interiors]]:
            pts = list(ring.coords)
            if len(pts) < 4:
                continue
            coords = tuple(UnitExpression(ConstantExpression(v), unit) for xy in pts for v in xy)
            prims.append(amp.Outline(unit=unit, exposure=ConstantExpression(exposure), length=ConstantExpression(len(pts) - 1), coords=coords))
    safe = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name)
    macro = ApertureMacro(name=f"PCB_{safe}", num_parameters=0, primitives=tuple(prims))
    return ap.ApertureMacroInstance(macro=macro, parameters=(), unit=unit, attrs=attrs)


def _flash_polygon(aperture: Any, max_error: float = DEFAULT_MAX_ERROR_MM) -> BaseGeometry:
    """Polygon of the aperture flashed at the origin, cached *on the aperture object* (an
    ``id()``-keyed dict would hand a recycled address the wrong polygon)."""
    g = getattr(aperture, "_pcb_flash_poly", None)
    if g is None:
        dark, clear = [], []
        for is_dark, poly in iter_object_polygons([go.Flash(0.0, 0.0, aperture, unit=MM)], max_error=max_error):
            (dark if is_dark else clear).append(poly)
        g = unary_union(dark) if dark else Polygon()
        if clear:
            g = g.difference(unary_union(clear))
        try:
            aperture._pcb_flash_poly = g
        except Exception:  # noqa: BLE001, S110 — frozen/slots apertures just recompute next time
            pass
    return g


def _matches(cand: Symbol, actual: BaseGeometry) -> bool:
    if actual.is_empty:
        return False
    g = cand.polygon()
    return g.symmetric_difference(actual).area <= _MATCH_TOL * actual.area


def _rect_fit(actual: BaseGeometry) -> tuple[float, float, float]:
    """(w, h, rotation_deg) of the minimum rotated rectangle; rotation normalised to [0, 180)."""
    if actual.is_empty or actual.area <= 1e-12:
        return (0.0, 0.0, 0.0)
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # degenerate hulls (collinear points) warn inside GEOS
        mrr = actual.minimum_rotated_rectangle
    if mrr.geom_type != "Polygon":
        x0, y0, x1, y1 = actual.bounds
        return (x1 - x0, y1 - y0, 0.0)
    pts = list(mrr.exterior.coords)[:4]
    e1 = math.dist(pts[0], pts[1])
    e2 = math.dist(pts[1], pts[2])
    ang = math.degrees(math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]))
    w, h = (e1, e2)
    if w < h:  # keep w along the reported angle
        w, h = h, w
        ang += 90.0
    ang %= 180.0
    if abs(ang) < 1e-6 or abs(ang - 180) < 1e-6:
        ang = 0.0
    return (w, h, ang)


def symbol_of(aperture: Any, max_error: float = DEFAULT_MAX_ERROR_MM) -> Symbol:
    """Recognise a gerbonara aperture as a standard symbol, else wrap it as ``user``."""
    hole = float(getattr(aperture, "hole_dia", None) or 0.0)
    if isinstance(aperture, ap.CircleAperture):
        return Symbol("r", (float(aperture.diameter),), 0.0, hole)
    if isinstance(aperture, ap.RectangleAperture):
        w, h = float(aperture.w), float(aperture.h)
        return Symbol("s", (w,), 0.0, hole) if math.isclose(w, h, abs_tol=1e-6) else Symbol("rect", (w, h), 0.0, hole)
    if isinstance(aperture, ap.ObroundAperture):
        w, h = float(aperture.w), float(aperture.h)
        return Symbol("r", (w,), 0.0, hole) if math.isclose(w, h, abs_tol=1e-6) else Symbol("oval", (w, h), 0.0, hole)
    actual = _flash_polygon(aperture, max_error)
    if actual.is_empty:
        return Symbol("user", (), macro_name=getattr(getattr(aperture, "macro", None), "name", None), aperture=aperture)
    # 1. thermal macro primitive present → read its parameters straight off
    macro = getattr(aperture, "macro", None)
    if macro is not None:
        try:
            from gerbonara.aperture_macros import primitive as amp

            inst = macro.substitute_params(list(aperture.parameters)) if getattr(aperture, "parameters", None) else macro
            ths = [p for p in inst.primitives if isinstance(p, amp.Thermal)]
            if len(ths) == 1 and len(inst.primitives) == 1:
                t = ths[0]
                cand = Symbol("ths", (float(t.d_outer), float(t.d_inner), float(t.rotation) % 360, 4, float(t.gap_w)), 0.0, hole)
                if _matches(cand, actual):
                    return cand
        except Exception:  # noqa: BLE001, S110 — recognition must never fail a load; fall through to shape matching
            pass
    x0, y0, x1, y1 = actual.bounds
    bw, bh = x1 - x0, y1 - y0
    d = max(bw, bh)
    # 2. circle / donut
    if math.isclose(bw, bh, rel_tol=0.02):
        cand = Symbol("r", (d,), 0.0, hole)
        if _matches(cand, actual):
            return cand
        if len(getattr(actual, "interiors", ())) == 1:
            inner = 2 * math.sqrt(Polygon(actual.interiors[0]).area / math.pi)
            cand = Symbol("donut_r", (d, inner), 0.0, hole)
            if _matches(cand, actual):
                return cand
        if actual.geom_type == "MultiPolygon" and 2 <= len(actual.geoms) <= 8:
            n = len(actual.geoms)
            hole_r = min(Point(0, 0).distance(g.exterior) for g in actual.geoms) if all(g.geom_type == "Polygon" for g in actual.geoms) else 0.0
            # spoke width = gap between neighbouring arcs (spokes have parallel sides)
            gap = min(actual.geoms[i].distance(actual.geoms[j]) for i in range(n) for j in range(i + 1, n))
            g0 = actual.geoms[0].centroid
            ang0 = (math.degrees(math.atan2(g0.y, g0.x)) - 180.0 / n) % (360.0 / n)
            for ang in (ang0, 0.0, 45.0):
                cand = Symbol("ths", (d, 2 * hole_r, round(ang, 1), n, gap), 0.0, hole)
                if _matches(cand, actual):
                    return cand
    # 3. rectangle family (rotated allowed)
    w, h, rot = _rect_fit(actual)
    for cand in (
        Symbol("s", (w,), rot, hole) if math.isclose(w, h, rel_tol=0.01) else Symbol("rect", (w, h), rot, hole),
        Symbol("oval", (w, h), rot, hole),
        Symbol("el", (w, h), rot, hole),
    ):
        if _matches(cand, actual):
            return cand
    # rounded rect: area = w·h − (4 − π)·r²  → r
    missing = w * h - actual.area
    if missing > 0:
        r = math.sqrt(missing / (4 - math.pi))
        if 0 < r < min(w, h) / 2:
            cand = Symbol("rect", (w, h, r), rot, hole)
            if _matches(cand, actual):
                return cand
    return Symbol("user", (), rot, hole, macro_name=getattr(macro, "name", None) if macro is not None else type(aperture).__name__, aperture=aperture)


def parse_symbol(name: str) -> Symbol:
    """``r40`` / ``rect40x20xr5`` / ``ths60x40x45x4x8`` … (mils) → Symbol (mm)."""
    s = name.strip().lower()
    for kind in ("donut_r", "rect", "oval", "ths", "thr", "el", "r", "s"):
        if s.startswith(kind):
            rest = s[len(kind):]
            break
    else:
        raise ValueError(f"unknown symbol {name!r}")
    parts = rest.split("x")
    if kind == "rect" and len(parts) == 3 and parts[2].startswith("r"):
        w, h, r = (float(parts[0]) * MIL, float(parts[1]) * MIL, float(parts[2][1:]) * MIL)
        return Symbol("rect", (w, h, r))
    nums = [float(x) for x in parts if x]
    if kind in ("r", "s"):
        return Symbol(kind, (nums[0] * MIL,))
    if kind in ("rect", "oval", "el", "donut_r"):
        return Symbol(kind, (nums[0] * MIL, nums[1] * MIL))
    return Symbol(kind, (nums[0] * MIL, nums[1] * MIL, nums[2], nums[3], nums[4] * MIL))


def thermal_for_hole(hole_mm: float, *, ring_mm: float, gap_mm: float, spokes: int = 4, angle_deg: float = 45.0, inner_clearance_mm: float | None = None) -> Symbol:
    """p119: 孔边到内圆 ≥8mil、内外圆间 ≥8mil、开口 ≥8mil 且 ≥2 个 → ``ths`` for a hole."""
    inner = hole_mm + 2 * (inner_clearance_mm if inner_clearance_mm is not None else ring_mm)
    outer = inner + 2 * ring_mm
    return Symbol("ths", (outer, inner, angle_deg, max(2, spokes), gap_mm))
