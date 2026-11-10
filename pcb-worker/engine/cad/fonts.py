"""Text → geometry for the CAD export.

* Stroke text (Altium/Protel "Default" vector font) is drawn with the public-domain Hershey
  ``futural`` (simplex) font — same style, same cap-height convention: the text *height* is the
  capital-letter height, the *stroke width* is the pen diameter.
* TrueType text is rendered from the named font's glyph outlines (fontTools) as filled polygons;
  CJK characters fall back to the first CJK-capable font found on the machine.

Both return geometry in mm in a local frame: baseline on y = 0, text starting at x = 0, reading
left to right. The caller rotates / mirrors / translates.
"""

from __future__ import annotations

import functools
from pathlib import Path

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

# ---- stroke -------------------------------------------------------------------------------------
_HERSHEY_CAP = 21.0  # futural: cap line -12 … base line 9


@functools.lru_cache(maxsize=1)
def _hershey():
    from HersheyFonts import HersheyFonts

    f = HersheyFonts()
    f.load_default_font("futural")
    return f


def stroke_text(text: str, height: float) -> tuple[list[tuple[tuple[float, float], tuple[float, float]]], float]:
    """Line segments ((x1, y1), (x2, y2)) in mm, plus the advance width, baseline at y=0."""
    f = _hershey()
    k = height / _HERSHEY_CAP
    segs: list[tuple[tuple[float, float], tuple[float, float]]] = []
    x = 0.0
    for glyph in f.glyphs_for_text(text):
        for (x1, y1), (x2, y2) in glyph.lines:
            # Hershey y grows downwards; base line is at +9
            segs.append(((x + (x1 - glyph.left_offset) * k, (glyph.base_line - y1) * k), (x + (x2 - glyph.left_offset) * k, (glyph.base_line - y2) * k)))
        x += glyph.char_width * k
    return segs, x


# ---- TrueType -----------------------------------------------------------------------------------
_FONT_DIRS = (
    "/System/Library/Fonts/Supplemental", "/System/Library/Fonts", "/Library/Fonts", "~/Library/Fonts",
    "/usr/share/fonts", "/usr/share/fonts/truetype", "/usr/share/fonts/opentype", "/usr/local/share/fonts", "C:/Windows/Fonts",
)  # fmt: skip
_CJK_CANDIDATES = (
    "SimSun.ttf", "simsun.ttc", "SimHei.ttf", "simhei.ttf", "msyh.ttc", "Hiragino Sans GB.ttc", "PingFang.ttc", "STHeiti Light.ttc",
    "NotoSansCJK-Regular.ttc", "NotoSansCJKsc-Regular.otf", "NotoSansSC-Regular.otf", "wqy-microhei.ttc", "DroidSansFallbackFull.ttf", "Arial Unicode.ttf",
)  # fmt: skip


def _find_file(names: tuple[str, ...]) -> Path | None:
    for d in _FONT_DIRS:
        base = Path(d).expanduser()
        if not base.is_dir():
            continue
        for n in names:
            p = base / n
            if p.is_file():
                return p
    return None


@functools.lru_cache(maxsize=16)
def _ttfont(path: str):
    from fontTools.ttLib import TTFont

    return TTFont(path, fontNumber=0)


def _font_path(name: str, bold: bool, italic: bool) -> Path | None:
    stem = (name or "Arial").strip()
    variants = []
    if bold and italic:
        variants += [f"{stem} Bold Italic.ttf", f"{stem}bi.ttf", f"{stem}-BoldItalic.ttf"]
    elif bold:
        variants += [f"{stem} Bold.ttf", f"{stem}bd.ttf", f"{stem}-Bold.ttf"]
    elif italic:
        variants += [f"{stem} Italic.ttf", f"{stem}i.ttf", f"{stem}-Italic.ttf"]
    variants += [f"{stem}.ttf", f"{stem}.ttc", f"{stem}.otf", f"{stem.lower()}.ttf", f"{stem.replace(' ', '')}.ttf"]
    p = _find_file(tuple(variants))
    if p is None:
        p = _find_file(("Arial.ttf", "arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"))
    return p


@functools.lru_cache(maxsize=1)
def _cjk_path() -> Path | None:
    return _find_file(_CJK_CANDIDATES)


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return 0x2E80 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF or 0x3000 <= o <= 0x303F


def _glyph_polys(font, ch: str, scale: float, x0: float) -> tuple[list[Polygon], float]:
    """Filled outline(s) of one glyph at pen position x0, plus its advance (mm)."""
    from fontTools.pens.recordingPen import RecordingPen

    cmap = font.getBestCmap() or {}
    gname = cmap.get(ord(ch))
    if gname is None:
        return [], 0.0
    gs = font.getGlyphSet()
    if gname not in gs:
        return [], 0.0
    pen = RecordingPen()
    gs[gname].draw(pen)
    adv = gs[gname].width * scale
    rings: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    last = (0.0, 0.0)

    def pt(p):
        return (x0 + p[0] * scale, p[1] * scale)

    for op, args in pen.value:
        if op == "moveTo":
            if len(cur) > 2:
                rings.append(cur)
            cur = [pt(args[0])]
            last = args[0]
        elif op == "lineTo":
            cur.append(pt(args[0]))
            last = args[0]
        elif op == "qCurveTo":
            pts = list(args)
            if pts[-1] is None:  # closed quadratic contour without explicit on-curve point
                pts = pts[:-1] + [pts[0]]
            # implied on-curve points between consecutive off-curve control points
            ctrls = pts[:-1]
            end = pts[-1]
            p0 = last
            for i, c in enumerate(ctrls):
                p2 = end if i == len(ctrls) - 1 else ((c[0] + ctrls[i + 1][0]) / 2, (c[1] + ctrls[i + 1][1]) / 2)
                for t in (0.25, 0.5, 0.75, 1.0):
                    x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p2[0]
                    y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p2[1]
                    cur.append(pt((x, y)))
                p0 = p2
            last = end
        elif op == "curveTo":
            c1, c2, end = args[-3], args[-2], args[-1]
            p0 = last
            for t in (0.2, 0.4, 0.6, 0.8, 1.0):
                x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * c1[0] + 3 * (1 - t) * t * t * c2[0] + t**3 * end[0]
                y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * c1[1] + 3 * (1 - t) * t * t * c2[1] + t**3 * end[1]
                cur.append(pt((x, y)))
            last = end
        elif op in ("closePath", "endPath"):
            if len(cur) > 2:
                rings.append(cur)
            cur = []
    if len(cur) > 2:
        rings.append(cur)
    polys = [Polygon(r) for r in rings if len(r) > 2]
    polys = [p.buffer(0) for p in polys if not p.is_empty]
    if not polys:
        return [], adv
    # even-odd fill: nested contours are holes
    polys.sort(key=lambda p: -p.area)
    result: list[Polygon] = []
    outer: list[tuple[Polygon, list[Polygon]]] = []
    for p in polys:
        containers = [o for o in outer if o[0].contains(p.representative_point())]
        if len(containers) % 2 == 1:
            containers[-1][1].append(p)
        else:
            outer.append((p, []))
    for p, hs in outer:
        g = p.difference(unary_union(hs)) if hs else p
        if g.geom_type == "Polygon":
            result.append(g)
        else:
            result.extend(x for x in getattr(g, "geoms", []) if x.geom_type == "Polygon")
    return result, adv


def truetype_text(text: str, height: float, font: str = "Arial", bold: bool = False, italic: bool = False) -> tuple[list[Polygon], float]:
    """Filled glyph polygons (mm) with the *em size* = ``height``, baseline y=0; plus the advance."""
    path = _font_path(font, bold, italic)
    cjk = _cjk_path()
    if path is None and cjk is None:
        return [], 0.0
    polys: list[Polygon] = []
    x = 0.0
    for ch in text:
        p = cjk if (_is_cjk(ch) and cjk is not None) else (path or cjk)
        if p is None:
            continue
        f = _ttfont(str(p))
        scale = height / f["head"].unitsPerEm
        gp, adv = _glyph_polys(f, ch, scale, x)
        if gp is None:
            continue
        if not gp and adv == 0.0 and cjk is not None and p != cjk:
            f2 = _ttfont(str(cjk))
            gp, adv = _glyph_polys(f2, ch, height / f2["head"].unitsPerEm, x)
        polys.extend(gp)
        x += adv
    return polys, x


def stroke_geometry(text: str, height: float, width: float) -> MultiPolygon | Polygon:
    """Convenience: stroke text as one filled geometry (for previews / tests)."""
    segs, _ = stroke_text(text, height)
    if not segs:
        return Polygon()
    return unary_union([LineString(s).buffer(width / 2) for s in segs])
