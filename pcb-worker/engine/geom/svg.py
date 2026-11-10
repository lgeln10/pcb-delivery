"""Render folded layer geometry to SVG (mm viewBox, y flipped, one <path> per polygon)."""

from __future__ import annotations

from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

LAYER_COLORS = {
    "top_copper": "#c8322b",
    "bottom_copper": "#2b5fc8",
    "inner_copper": "#b07a2b",
    "top_mask": "#7a2bb0",
    "bottom_mask": "#2bb0a0",
    "top_silk": "#e6c800",
    "bottom_silk": "#a0a000",
    "top_paste": "#888888",
    "bottom_paste": "#666666",
    "outline": "#000000",
    "drill_pth": "#111111",
    "drill_npth": "#444444",
    "drill_unknown": "#444444",
    "drill_blind": "#333333",
}


def _fmt(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def _ring_path(coords) -> str:
    pts = list(coords)
    if not pts:
        return ""
    d = "M" + " L".join(f"{_fmt(x)},{_fmt(y)}" for x, y in pts[:-1] if True)
    return d + " Z"


def polygon_path(poly: Polygon) -> str:
    parts = [_ring_path(poly.exterior.coords)]
    parts.extend(_ring_path(r.coords) for r in poly.interiors)
    return " ".join(parts)


def iter_polygons(geom: BaseGeometry):
    if geom.is_empty:
        return
    if isinstance(geom, Polygon):
        yield geom
    elif isinstance(geom, MultiPolygon):
        yield from geom.geoms
    else:
        for g in getattr(geom, "geoms", []):
            yield from iter_polygons(g)


def geometry_to_svg(
    geom: BaseGeometry,
    layer_name: str,
    layer_type: str = "unknown",
    margin_mm: float = 1.0,
    frame: tuple[float, float, float, float] | None = None,
) -> str:
    """``frame`` fixes the viewBox to a shared bbox (the board outline) instead of this layer's own
    extent — required to stack several layers on top of each other: each layer's own bounds differ,
    so without it the overlay is misaligned."""
    if frame is not None:
        x0, y0, x1, y1 = frame
    elif geom.is_empty:
        x0 = y0 = 0.0
        x1 = y1 = 10.0
    else:
        x0, y0, x1, y1 = geom.bounds
    x0 -= margin_mm
    y0 -= margin_mm
    x1 += margin_mm
    y1 += margin_mm
    w, h = x1 - x0, y1 - y0
    color = LAYER_COLORS.get(layer_type, "#333333")
    # viewBox is in mm with y up: flip via a group transform, viewBox y0 becomes -y1
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_fmt(x0)} {_fmt(-y1)} {_fmt(w)} {_fmt(h)}" '
        f'width="{_fmt(w)}mm" height="{_fmt(h)}mm" data-layer="{layer_name}" data-type="{layer_type}">\n'
        f'<g transform="scale(1,-1)" fill="{color}" fill-rule="evenodd" stroke="none">\n'
    )
    body = []
    for i, poly in enumerate(iter_polygons(geom)):
        body.append(f'<path data-id="{layer_name}:{i}" d="{polygon_path(poly)}"/>')
    return head + "\n".join(body) + "\n</g>\n</svg>\n"
