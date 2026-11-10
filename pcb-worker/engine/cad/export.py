"""Board model → Altium-style Gerber set + Excellon drills (what "用 Altium 导出 Gerber" produces).

File naming follows Altium's Protel extensions so the intake classifier and the layer-naming rules
(knowledge/rules/layer_naming.yaml) treat the result exactly like a customer export:
GTL / G1..Gn / GBL, GTO / GBO, GTS / GBS, GTP / GBP, GKO, GM1..GMn, plus ``<stem>.TXT`` (plated) and
``<stem>-NPTH.TXT`` (non-plated) Excellon files and a ``<stem>.DRR`` drill report.

Drawing order per copper layer mirrors Altium: poured regions first (their holes are LPC, so they
must not erase later objects), then fills, tracks, arcs, pads, vias.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from gerbonara import apertures as ap
from gerbonara import graphic_objects as go
from gerbonara.cam import FileSettings
from gerbonara.excellon import ExcellonFile, ExcellonTool
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely import affinity
from shapely.geometry import Polygon

from engine.cad import fonts
from engine.cad.model import (
    BOTTOM,
    BOTTOM_OVERLAY,
    BOTTOM_PASTE,
    BOTTOM_SOLDER,
    KEEPOUT,
    MECH_LAYERS,
    MID_LAYERS,
    MULTI,
    OCTAGON,
    RECT,
    ROUND,
    ROUNDED_RECT,
    TOP,
    TOP_OVERLAY,
    TOP_PASTE,
    TOP_SOLDER,
    Board,
    Pad,
)
from engine.geom.symbols import Symbol, outline_macro_aperture

THIN = 0.01  # mm, line width used to draw board cutout outlines


@dataclass
class ExportOptions:
    origin: tuple[float, float] = (0.0, 0.0)  # subtracted from every coordinate
    mech_layers: list[int] | None = None  # None → every mechanical layer that has content
    include_unconnected_inner_pads: bool = True
    text: bool = True
    number_format: tuple[int, int] = (4, 6)
    cutouts_on_outline: bool = True  # board cutouts → thin closed outlines on the GKO layer
    drr: bool = True


@dataclass
class _Layer:
    objs: list[Any] = field(default_factory=list)

    def flash(self, x: float, y: float, sym: Symbol, dark: bool = True) -> None:
        self.objs.append(go.Flash(x, y, sym.to_aperture(unit=MM), polarity_dark=dark, unit=MM))

    def line(self, x1: float, y1: float, x2: float, y2: float, w: float, dark: bool = True) -> None:
        a = ap.CircleAperture(diameter=max(w, 0.001), unit=MM)
        if math.isclose(x1, x2, abs_tol=1e-9) and math.isclose(y1, y2, abs_tol=1e-9):
            self.objs.append(go.Flash(x1, y1, a, polarity_dark=dark, unit=MM))
        else:
            self.objs.append(go.Line(x1, y1, x2, y2, a, polarity_dark=dark, unit=MM))

    def arc(self, cx: float, cy: float, r: float, sa: float, ea: float, w: float, dark: bool = True) -> None:
        """Altium arc: CCW from start_angle to end_angle (degrees). Written as ≤180° pieces."""
        a = ap.CircleAperture(diameter=max(w, 0.001), unit=MM)
        sa %= 360.0
        sweep = (ea - sa) % 360.0
        if sweep <= 1e-9:
            sweep = 360.0
        n = max(1, math.ceil(sweep / 180.0 - 1e-9))
        step = sweep / n
        for k in range(n):
            a0 = math.radians(sa + k * step)
            a1 = math.radians(sa + (k + 1) * step)
            x1, y1 = cx + r * math.cos(a0), cy + r * math.sin(a0)
            x2, y2 = cx + r * math.cos(a1), cy + r * math.sin(a1)
            self.objs.append(go.Arc(x1, y1, x2, y2, cx - x1, cy - y1, clockwise=False, aperture=a, polarity_dark=dark, unit=MM))

    def region(self, pts: list[tuple[float, float]], dark: bool = True) -> None:
        if len(pts) < 3:
            return
        if pts[0] != pts[-1]:
            pts = [*pts, pts[0]]
        self.objs.append(go.Region(outline=list(pts), unit=MM, polarity_dark=dark))

    def polygon(self, g: Any, dark: bool = True) -> None:
        """A (multi)polygon as regions; holes become cut-in rings of one outline (Gerber spec 4.10.4,
        what Altium itself writes) — never a second region of clear polarity, which would erase
        anything drawn before it and make a pad inside the hole look attached to the pour."""
        from engine.geom.features import cutin_ring

        polys = [g] if g.geom_type == "Polygon" else list(getattr(g, "geoms", []))
        for p in polys:
            if p.geom_type != "Polygon" or p.is_empty or p.area <= 0:
                continue
            if p.interiors:
                self.region(list(cutin_ring(p)), dark)
            else:
                self.region(list(p.exterior.coords), dark)

    def polygon_with_holes(self, outline: list[tuple[float, float]], holes: list[list[tuple[float, float]]], dark: bool = True) -> None:
        if len(outline) < 3:
            return
        if not holes:
            self.region(outline, dark)
            return
        poly = Polygon(outline, [h for h in holes if len(h) >= 3])
        if not poly.is_valid:
            poly = poly.buffer(0)
        self.polygon(poly, dark)


def _pad_symbol(shape: str, w: float, h: float, rot: float, radius_pct: float = 0.0) -> Symbol | None:
    if w <= 0 or h <= 0:
        return None
    if shape == ROUND:
        if math.isclose(w, h, abs_tol=1e-6):
            return Symbol("r", (w,))
        return Symbol("oval", (w, h), rot % 360)
    if shape == RECT:
        return Symbol("s", (w,), rot % 360) if math.isclose(w, h, abs_tol=1e-6) else Symbol("rect", (w, h), rot % 360)
    if shape == ROUNDED_RECT:
        r = min(w, h) / 2 * (radius_pct or 50.0) / 100.0
        return Symbol("rect", (w, h, r), rot % 360)
    if shape == OCTAGON:
        c = min(w, h) * 0.25  # Altium octagon: corner cut = 1/4 of the shorter side
        pts = [(-w / 2 + c, -h / 2), (w / 2 - c, -h / 2), (w / 2, -h / 2 + c), (w / 2, h / 2 - c), (w / 2 - c, h / 2), (-w / 2 + c, h / 2), (-w / 2, h / 2 - c), (-w / 2, -h / 2 + c)]
        g = affinity.rotate(Polygon(pts), rot, origin=(0, 0)) if rot else Polygon(pts)
        return Symbol("user", (), 0.0, 0.0, macro_name=f"oct{w:.3f}x{h:.3f}r{rot:g}", aperture=outline_macro_aperture(f"oct{w:.3f}x{h:.3f}r{rot:g}", g))
    return Symbol("r", (max(w, h),))


def _grown(sym: Symbol, delta: float) -> Symbol:
    """Solder/paste opening: the pad outline grown by ``delta`` on every side."""
    if delta == 0:
        return sym
    return sym.resized(2 * delta)


class _Exporter:
    def __init__(self, board: Board, opt: ExportOptions):
        self.b = board
        self.o = opt
        self.ox, self.oy = opt.origin
        self.layers: dict[str, _Layer] = {}
        self.copper_ext: dict[int, str] = {}
        self.report: dict[str, Any] = {"layers": {}, "skipped": {}, "texts": {"stroke": 0, "truetype": 0, "hidden": 0}}

    def L(self, ext: str) -> _Layer:
        return self.layers.setdefault(ext, _Layer())

    def xy(self, x: float, y: float) -> tuple[float, float]:
        return (x - self.ox, y - self.oy)

    # ---- layer name → Gerber extension -----------------------------------------------------
    def ext_of(self, layer: int) -> str | None:
        if layer in self.copper_ext:
            return self.copper_ext[layer]
        return {
            TOP_OVERLAY: "GTO", BOTTOM_OVERLAY: "GBO", TOP_SOLDER: "GTS", BOTTOM_SOLDER: "GBS",
            TOP_PASTE: "GTP", BOTTOM_PASTE: "GBP", KEEPOUT: "GKO", 73: "GD1", 55: "GG1",
        }.get(layer) or (f"GM{layer - 56}" if layer in MECH_LAYERS else None)  # fmt: skip

    # ---- copper ---------------------------------------------------------------------------------
    def copper(self) -> None:
        b = self.b
        stack = b.copper_layers
        for i, lyr in enumerate(stack):
            if lyr == TOP:
                self.copper_ext[lyr] = "GTL"
            elif lyr == BOTTOM:
                self.copper_ext[lyr] = "GBL"
            elif lyr in MID_LAYERS:
                self.copper_ext[lyr] = f"G{i}"
            else:
                self.copper_ext[lyr] = f"GP{lyr - 38}"
        for lyr in stack:
            L = self.L(self.copper_ext[lyr])
            # 1. poured regions (holes are LPC → first)
            for r in b.regions:
                if r.layer != lyr or r.kind != 0 or r.keepout:
                    continue
                L.polygon_with_holes([self.xy(x, y) for x, y in r.outline], [[self.xy(x, y) for x, y in h] for h in r.holes])
            for f in b.fills:
                if f.layer == lyr and not f.keepout:
                    self.fill(L, f)
            for t in b.tracks:
                if t.layer == lyr and not t.keepout:
                    L.line(*self.xy(t.x1, t.y1), *self.xy(t.x2, t.y2), t.width)
            for a in b.arcs:
                if a.layer == lyr and not a.keepout:
                    L.arc(*self.xy(a.cx, a.cy), a.radius, a.start_angle, a.end_angle, a.width)
            for p in b.pads:
                if p.layer == lyr or p.layer == MULTI:
                    sym = self.pad_sym(p, lyr)
                    if sym is not None:
                        L.flash(*self.xy(p.x, p.y), sym)
            for v in b.vias:
                if self.via_on(v, lyr):
                    L.flash(*self.xy(v.x, v.y), Symbol("r", (v.diameter,)))

    def pad_sym(self, p: Pad, lyr: int) -> Symbol | None:
        shape, w, h = p.size_on(lyr)
        return _pad_symbol(shape, w, h, p.rotation, p.corner_radius_pct)

    def via_on(self, v: Any, lyr: int) -> bool:
        stack = self.b.copper_layers
        try:
            i0, i1 = stack.index(v.start_layer), stack.index(v.end_layer)
        except ValueError:
            return True
        i = stack.index(lyr)
        return min(i0, i1) <= i <= max(i0, i1)

    def fill(self, L: _Layer, f: Any) -> None:
        g = Polygon([(f.x1, f.y1), (f.x2, f.y1), (f.x2, f.y2), (f.x1, f.y2)])
        if f.rotation:
            g = affinity.rotate(g, f.rotation, origin=((f.x1 + f.x2) / 2, (f.y1 + f.y2) / 2))
        L.region([self.xy(x, y) for x, y in g.exterior.coords])

    # ---- mask / paste ---------------------------------------------------------------------------
    def masks(self) -> None:
        b = self.b
        for side, ext, lyr_draw, pad_layer in ((TOP, "GTS", TOP_SOLDER, TOP), (BOTTOM, "GBS", BOTTOM_SOLDER, BOTTOM)):
            L = self.L(ext)
            self.drawn(L, lyr_draw)
            for p in b.pads:
                if p.layer not in (pad_layer, MULTI):
                    continue
                exp = b.mask_expansion if p.mask_expansion is None else p.mask_expansion
                sym = self.pad_sym(p, side)
                if sym is None:
                    continue
                g = _grown(sym, exp)
                if g.size_mm[0] > 0:
                    L.flash(*self.xy(p.x, p.y), g)
            for v in b.vias:
                tented = v.tent_top if side == TOP else v.tent_bottom
                if tented or not self.via_on(v, side):
                    continue
                exp = b.mask_expansion if v.mask_expansion is None else v.mask_expansion
                d = v.diameter + 2 * exp
                if d > 0:
                    L.flash(*self.xy(v.x, v.y), Symbol("r", (d,)))
        for ext, lyr_draw, pad_layer in (("GTP", TOP_PASTE, TOP), ("GBP", BOTTOM_PASTE, BOTTOM)):
            L = self.L(ext)
            self.drawn(L, lyr_draw)
            for p in b.pads:
                if p.layer != pad_layer or p.hole > 0:
                    continue
                exp = b.paste_expansion if p.paste_expansion is None else p.paste_expansion
                sym = self.pad_sym(p, pad_layer)
                if sym is None:
                    continue
                g = _grown(sym, exp)
                if g.size_mm[0] > 0:
                    L.flash(*self.xy(p.x, p.y), g)

    # ---- overlay / mechanical / keepout ---------------------------------------------------------
    def drawn(self, L: _Layer, lyr: int) -> None:
        """Everything drawn directly on a non-copper layer (tracks, arcs, fills, regions, texts)."""
        b = self.b
        for r in b.regions:
            if r.layer == lyr and not r.is_board_cutout:
                L.polygon_with_holes([self.xy(x, y) for x, y in r.outline], [[self.xy(x, y) for x, y in h] for h in r.holes])
        for f in b.fills:
            if f.layer == lyr:
                self.fill(L, f)
        for t in b.tracks:
            if t.layer == lyr:
                L.line(*self.xy(t.x1, t.y1), *self.xy(t.x2, t.y2), t.width)
        for a in b.arcs:
            if a.layer == lyr:
                L.arc(*self.xy(a.cx, a.cy), a.radius, a.start_angle, a.end_angle, a.width)
        for p in b.pads:
            if p.layer == lyr:  # pads placed on a mechanical / overlay layer
                sym = self.pad_sym(p, lyr)
                if sym is not None:
                    L.flash(*self.xy(p.x, p.y), sym)
        if self.o.text:
            for t in b.texts:
                if t.layer == lyr:
                    self.text(L, t)

    def others(self) -> None:
        b = self.b
        used = b.layers_used()
        for lyr in (TOP_OVERLAY, BOTTOM_OVERLAY, KEEPOUT, 73):
            if used.get(lyr):
                self.drawn(self.L(self.ext_of(lyr)), lyr)
        mechs = self.o.mech_layers if self.o.mech_layers is not None else [m for m in MECH_LAYERS if used.get(m)]
        for m in mechs:
            self.drawn(self.L(f"GM{m - 56}"), m)
        # board cutouts (NPTH holes / slots the designer drew as cutouts) → thin outlines on GKO
        if self.o.cutouts_on_outline:
            L = self.L("GKO")
            for r in b.regions:
                if r.is_board_cutout and len(r.outline) >= 3:
                    pts = [self.xy(x, y) for x, y in r.outline]
                    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
                        L.line(x1, y1, x2, y2, THIN)
            # the Board6 board shape as well, if nothing else is on the keep-out layer
            if not used.get(KEEPOUT) and b.outline:
                pts = [self.xy(v.x, v.y) for v in b.outline]
                for (x1, y1), (x2, y2) in itertools.pairwise(pts):
                    L.line(x1, y1, x2, y2, THIN)

    # ---- text -----------------------------------------------------------------------------------
    def text(self, L: _Layer, t: Any) -> None:
        if t.hidden or not t.text.strip():
            self.report["texts"]["hidden"] += 1
            return
        sx = -1.0 if t.mirrored else 1.0
        ang = math.radians(t.rotation)
        ca, sa = math.cos(ang), math.sin(ang)

        def place(x: float, y: float) -> tuple[float, float]:
            x *= sx
            return self.xy(t.x + x * ca - y * sa, t.y + x * sa + y * ca)

        if t.truetype:
            polys, _ = fonts.truetype_text(t.text, t.height, t.font or "Arial", t.bold, t.italic)
            for p in polys:
                L.polygon_with_holes([place(x, y) for x, y in p.exterior.coords], [[place(x, y) for x, y in h.coords] for h in p.interiors])
            self.report["texts"]["truetype"] += 1
        else:
            segs, _ = fonts.stroke_text(t.text, t.height)
            w = t.stroke_width or t.height / 10
            for (x1, y1), (x2, y2) in segs:
                L.line(*place(x1, y1), *place(x2, y2), w)
            self.report["texts"]["stroke"] += 1

    # ---- drills ---------------------------------------------------------------------------------
    def drills(self, out: Path, stem: str) -> list[str]:
        b = self.b
        files: list[str] = []
        pth: list[Any] = []
        npth: list[Any] = []
        tools: dict[tuple[float, bool], ExcellonTool] = {}

        def tool(d: float, plated: bool) -> ExcellonTool:
            key = (round(d, 4), plated)
            if key not in tools:
                tools[key] = ExcellonTool(diameter=key[0], plated=plated, unit=MM)
            return tools[key]

        rows: dict[tuple[float, bool, bool], int] = {}
        for p in b.pads:
            if p.hole <= 0:
                continue
            lst = pth if p.plated else npth
            x, y = self.xy(p.x, p.y)
            if p.hole_shape == "slot" and p.slot_length > p.hole + 1e-6:
                half = (p.slot_length - p.hole) / 2
                a = math.radians(p.hole_rotation + p.rotation)
                dx, dy = half * math.cos(a), half * math.sin(a)
                lst.append(go.Line(x - dx, y - dy, x + dx, y + dy, tool(p.hole, p.plated), unit=MM))
                rows[(round(p.hole, 4), p.plated, True)] = rows.get((round(p.hole, 4), p.plated, True), 0) + 1
            else:
                lst.append(go.Flash(x, y, tool(p.hole, p.plated), unit=MM))
                rows[(round(p.hole, 4), p.plated, False)] = rows.get((round(p.hole, 4), p.plated, False), 0) + 1
        for v in b.vias:
            if v.hole <= 0:
                continue
            x, y = self.xy(v.x, v.y)
            pth.append(go.Flash(x, y, tool(v.hole, True), unit=MM))
            rows[(round(v.hole, 4), True, False)] = rows.get((round(v.hole, 4), True, False), 0) + 1
        for objs, name, plated in ((pth, f"{stem}.TXT", True), (npth, f"{stem}-NPTH.TXT", False)):
            if not objs:
                continue
            ef = ExcellonFile(objects=objs)
            ef.save(out / name, settings=FileSettings(unit=MM, number_format=(3, 3), zeros="leading"))
            # Altium-style header comments: the intake classifier reads ;TYPE=PLATED / NON_PLATED
            text = (out / name).read_text("latin-1")
            text = text.replace("M48\n", f"M48\n;Layer_Color=9474304\n;FILE_FORMAT=3:3\n;TYPE={'PLATED' if plated else 'NON_PLATED'}\n", 1)
            (out / name).write_text(text, encoding="latin-1")
            files.append(name)
        if self.o.drr and rows:
            lines = ["Drill Report (generated by pcb-cam CAD export)", ""]
            for n, ((d, plated, slot), cnt) in enumerate(sorted(rows.items()), 1):
                lines.append(f"T{n:02d}  {d:.3f}mm  {'Slot' if slot else 'Round'}  {cnt}  {'PTH' if plated else 'NPTH'}")
            (out / f"{stem}.DRR").write_text("\n".join(lines) + "\n", encoding="latin-1")
            files.append(f"{stem}.DRR")
        self.report["drill_rows"] = [{"dia_mm": d, "plated": pl, "slot": sl, "count": c} for (d, pl, sl), c in sorted(rows.items())]
        return files

    # ---- write ----------------------------------------------------------------------------------
    def write(self, out: Path, stem: str) -> list[str]:
        out.mkdir(parents=True, exist_ok=True)
        files: list[str] = []
        settings = FileSettings(unit=MM, number_format=self.o.number_format, zeros=None, notation="absolute")
        for ext, L in self.layers.items():
            if not L.objs:
                self.report["skipped"][ext] = "empty"
                continue
            name = f"{stem}.{ext}"
            gf = GerberFile(objects=L.objs, comments=["pcb-cam CAD export", f"Layer: {ext}"])
            gf.save(out / name, settings=settings)
            files.append(name)
            self.report["layers"][ext] = len(L.objs)
        files += self.drills(out, stem)
        return files


def export_board(board: Board, out_dir: Path, stem: str, **options) -> list[str]:
    opt = ExportOptions(**options)
    ex = _Exporter(board, opt)
    ex.copper()
    ex.masks()
    ex.others()
    files = ex.write(Path(out_dir), stem)
    board.notes.append(f"export: {ex.report}")
    export_board.last_report = ex.report  # type: ignore[attr-defined]
    return files
