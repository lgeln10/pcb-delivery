"""B1.6–B1.10: hole-driven ops on copper and mask layers (第6/7/8章).

* NegativePadReshape  p119–120  负片每孔：隔离 PAD 环 ≥10mil；散热 PAD 孔到内圆/内外圆/开口 ≥8mil、≥2 开口
* NpthClearance       p121/p127 NPTH 削铜：孔径 + 2×12mil 的清铜盘（正片负极性、负片正极性）
* BorderClearance     p121/p128 削外围：外形线加大到位复制到各层（正片负极性削、负片正极性）
* SetSmdAttribute     p137      无孔焊盘设 .smd（光学点/BGA 圆 PAD 除外 → 人工）
* MaskDams            p144      NPTH（及 ≥0.6mm 过孔）盖油加挡点
"""

from __future__ import annotations

import dataclasses
import math
from typing import Any

from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from engine.adapters.base import CamOp
from engine.checks.common import load_holes
from engine.geom.features import ChangeSet, FeatureLayer
from engine.geom.symbols import MIL, Symbol, thermal_for_hole
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, NeedsHuman, native_op
from engine.stages.drill import PLUG_OWN_OPENING_ADD_MM, Hole

INNER = "inner_copper"
COPPER_TYPES = ("top_copper", "bottom_copper", "inner_copper")
MASK_TYPES = ("top_mask", "bottom_mask")


def _holes(n: NativeContext) -> list[Hole]:
    lm = n.ctx.layer_map() or {}
    return load_holes(n.ctx, lm)


def _side_cfg(n: NativeContext, e: dict[str, Any]) -> dict[str, Any]:
    return n.cfg["copper"]["inner" if e.get("type") == INNER else "outer"]


def _is_negative(e: dict[str, Any]) -> bool:
    return (e.get("polarity") or "positive") == "negative"


def _copper_layer(n: NativeContext, call: OpCall) -> tuple[FeatureLayer, dict[str, Any]] | None:
    e = n.entry(call.layer)
    if not call.layer or e is None or e.get("type") not in COPPER_TYPES:
        return None
    return n.layer(call.layer), e


# ---- B1.6 NegativePadReshape ---------------------------------------------------------------
@native_op(CamOp.NEGATIVE_PAD_RESHAPE)
def negative_pad_reshape(n: NativeContext, call: OpCall) -> ChangeSet | None:
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if not _is_negative(e):
        return None
    neg = n.cfg["copper"]["inner"]["negative"]
    min_iso = float(neg["isolation_ring_mm"])
    min_th = float(neg.get("thermal_ring_mm", 8 * MIL))
    min_open = float(neg.get("thermal_opening_mm", 8 * MIL))
    min_n = int(neg.get("thermal_min_openings", 2))
    cs = layer.begin(call.op, {"isolation_ring_mm": min_iso, "thermal_ring_mm": min_th, "thermal_opening_mm": min_open, "pages": "119/120"})
    min_npth = float(n.cfg["copper"]["inner"]["npth_clearance_mm"])
    for h in _holes(n):
        if h.slot:
            # a slot on a negative plane gets a clearance surface (no round symbol fits); NPTH slots wider (p121)
            clr = min_npth if h.attribute == "non_plated" else min_iso
            zone = h.geom().buffer(clr)
            dark = unary_union([f.geom for f in layer.query(zone) if f.polarity_dark] or [Polygon()])
            if not dark.contains(zone.buffer(-0.003)):
                layer.add_surface(zone, polarity_dark=True, note=f"slot {h.tool} clearance {clr:.3f} (p120/p121)")
            continue
        if h.attribute == "non_plated":
            # NPTH on a negative film: dark disc = 削铜, ring 12 mil (p121)
            want = h.dia + 2 * min_npth
            zone = Point(h.x, h.y).buffer(want / 2)
            dark = unary_union([f.geom for f in layer.query(zone) if f.polarity_dark] or [Polygon()])
            if not dark.contains(zone.buffer(-0.003)):
                layer.add_pad(h.x, h.y, Symbol("r", (want,)), note=f"NPTH {h.tool} clearance r{want / MIL:.1f} (p121)")
            continue
        c = Point(h.x, h.y)
        disc = c.buffer(h.dia / 2)
        near = [f for f in layer.query(disc.buffer(min_iso * 3)) if f.polarity_dark]
        pads = [f for f in near if f.kind == "pad" and f.geom.contains(c) or (f.kind == "pad" and f.geom.distance(c) < h.dia / 2)]
        thermals = [f for f in pads if f.symbol and f.symbol.kind in ("ths", "thr")]
        if thermals:
            f = thermals[0]
            s = f.symbol
            od, idm, ang, cnt, gap = s.params[0], s.params[1], s.params[2], int(s.params[3]), s.params[4]
            inner_ring = (idm - h.dia) / 2
            ring = (od - idm) / 2
            if inner_ring >= min_th - 0.003 and ring >= min_th - 0.003 and gap >= min_open - 0.003 and cnt >= min_n:
                continue
            new = thermal_for_hole(h.dia, ring_mm=max(ring, min_th), gap_mm=max(gap, min_open), spokes=max(cnt, min_n), angle_deg=ang,
                                   inner_clearance_mm=max(inner_ring, min_th))  # fmt: skip
            layer.set_symbol(f, new, f"thermal {s.name} → {new.name} (p119)")
            continue
        iso = [f for f in pads if f.symbol and f.symbol.kind in ("r", "s", "donut_r")]
        want = h.dia + 2 * min_iso
        if iso:
            f = max(iso, key=lambda x: x.geom.area)
            s = f.symbol
            have = s.params[0]
            if have >= want - 0.003:
                continue
            layer.set_symbol(f, Symbol("r", (want,)), f"isolation {s.name} → r{want / MIL:.1f} (p120)")
            continue
        # no isolation pad at all (or only drawn/odd shapes): make sure a full clearance disc exists
        dark_here = unary_union([f.geom for f in near]) if near else Polygon()
        if dark_here.contains(disc.buffer(min_iso - 0.003)):
            continue
        layer.add_pad(h.x, h.y, Symbol("r", (want,)), note=f"add isolation pad r{want / MIL:.1f} at hole {h.tool} (p120)")
    layer.commit()
    return cs


# ---- B1.7 NpthClearance ----------------------------------------------------------------------
@native_op(CamOp.NPTH_CLEARANCE)
def npth_clearance(n: NativeContext, call: OpCall) -> ChangeSet | None:
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    clr = float(call.params.get("clearance_mm") or _side_cfg(n, e)["npth_clearance_mm"])
    neg = _is_negative(e)
    cs = layer.begin(call.op, {"clearance_mm": clr, "polarity": "positive" if neg else "negative", "pages": "121/127"})
    for h in _holes(n):
        if h.attribute != "non_plated" or h.tool == "VCUT_END":
            continue  # V-cut end holes: the finished pour runs straight past them (3×3 job), no cut-out
        # 清孔圈从**钻孔**尺寸起算（成品孔 + 预大），不是孔的成品尺寸：3×3 板终稿画在外形层的 ⌀2.5 孔
        # 钻 2.55、清 ⌀2.97 = 2.55 + 2×0.21；按成品 2.5 起算每边会少 0.025
        bit = max(h.dia, h.drill_dia or 0.0)
        zone = h.geom().buffer(clr + (bit - h.dia) / 2)
        copper = [f for f in layer.query(zone) if f.polarity_dark]
        if neg:
            # dark on a negative film = clearance: enough dark already?
            dark = unary_union([f.geom for f in copper]) if copper else Polygon()
            if dark.contains(zone.buffer(-0.003)):
                continue
            if h.slot:
                layer.add_surface(zone, polarity_dark=True, note=f"NPTH slot {h.tool} clearance (p121)")
            else:
                layer.add_pad(h.x, h.y, Symbol("r", (bit + 2 * clr,)), polarity_dark=True, note=f"NPTH {h.tool} clearance r{(bit + 2 * clr) / MIL:.1f} (p121)")
        else:
            if not copper or unary_union([f.geom for f in copper]).intersection(zone).area < 1e-6:
                continue  # already clear
            if h.slot:
                layer.add_surface(zone, polarity_dark=False, note=f"NPTH slot {h.tool} cutout (p127)")
            else:
                layer.add_pad(h.x, h.y, Symbol("r", (bit + 2 * clr,)), polarity_dark=False, note=f"NPTH {h.tool} cutout r{(bit + 2 * clr) / MIL:.1f} (p127)")
    layer.commit()
    return cs


# ---- B1.8 BorderClearance --------------------------------------------------------------------
BORDER_PAD_CUT_RATIO = 0.5  # a pad losing more than this share to the trim is "有用物件" (p121) → leave it to a person


@native_op(CamOp.BORDER_CLEARANCE)
def border_clearance(n: NativeContext, call: OpCall) -> ChangeSet | None:
    got = _copper_layer(n, call)
    if got is None or n.profile is None:
        return None
    layer, e = got
    edge = float(call.params.get("clearance_mm") or _side_cfg(n, e)["edge_clearance_mm"])
    prof = n.profile
    band = prof.buffer(2.0).difference(prof.buffer(-edge))  # outside the board + the edge band
    neg = _is_negative(e)
    dark = layer.dark_union()
    hit = dark.intersection(band)
    if neg:
        if band.difference(dark).area < 1e-6:
            return None  # already trimmed (dark = clearance)
        # p121: 对比确认不削掉有用物件 — on a negative film the copper *is* the clear: an explicit
        # clear feature at the edge (drawn copper) or a thermal pad whose spokes the trim would cut
        # (the via loses its plane connection) is deliberate → a person decides
        for f in layer.features:
            if f.geom.is_empty or not f.geom.intersects(band):
                continue
            if not f.polarity_dark and f.geom.intersection(band).area > 1e-4:
                raise NeedsHuman(f"负片板边 {edge:.3f} mm 内有画出的铜（clear 物件 @ {f.xy[0]:.2f},{f.xy[1]:.2f}），削外围会削掉它 (p121)")
            if f.polarity_dark and f.symbol is not None and f.symbol.kind in ("ths", "thr"):
                raise NeedsHuman(f"负片板边 {edge:.3f} mm 内有散热 PAD @ {f.xy[0]:.2f},{f.xy[1]:.2f}，削外围会切断其连接 (p121)")
    else:
        if hit.area < 1e-6:
            return None
        # p121: 对比确认不削掉有用物件 — a pad (connector finger, mounting pad) mostly inside the band is
        # deliberate copper at the edge; trimming traces/pours is routine
        for f in layer.pads():
            if f.polarity_dark and not f.geom.is_empty and f.geom.intersection(band).area > BORDER_PAD_CUT_RATIO * f.geom.area:
                raise NeedsHuman(f"板边 {edge:.3f} mm 内有焊盘 @ {f.xy[0]:.2f},{f.xy[1]:.2f} 会被削掉 {BORDER_PAD_CUT_RATIO:.0%} 以上 (p121/p128)")
    cs = layer.begin(call.op, {"edge_clearance_mm": edge, "polarity": "positive" if neg else "negative", "cut_mm2": round(hit.area, 4), "pages": "121/128"})
    layer.add_surface(band, polarity_dark=neg, note=f"border trim {edge:.3f} mm ({'dark' if neg else 'clear'})")
    layer.commit()
    return cs


# ---- B1.9 SetSmdAttribute --------------------------------------------------------------------
@native_op(CamOp.SET_SMD_ATTRIBUTE)
def set_smd_attribute(n: NativeContext, call: OpCall) -> ChangeSet | None:
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if e.get("type") == INNER:
        return None
    holes = _holes(n)
    hole_u = unary_union([h.geom() for h in holes]) if holes else Polygon()
    cs = layer.begin(call.op, {"erf": "non_drilled", "page": 137})
    for f in list(layer.pads()):
        if not f.polarity_dark or f.geom.is_empty:
            continue
        fn = f.function or ""
        if "SMD" in fn or "Fiducial" in fn or "Test" in fn:
            continue
        if f.symbol is not None and f.symbol.kind == "r":
            continue  # p137: 圆形 PAD 自动设置无效，需手动添加
        if not hole_u.is_empty and hole_u.intersects(f.geom):
            continue
        ap = f.obj.aperture
        attrs = tuple(a for a in (getattr(ap, "attrs", None) or ()) if a[0] != ".AperFunction") + ((".AperFunction", ("SMDPad", "CuDef")),)
        layer.replace_aperture(f, dataclasses.replace(ap, attrs=attrs), "set .smd (SMDPad,CuDef)")
    layer.commit()
    return cs


# ---- B1.10 MaskDams --------------------------------------------------------------------------
@native_op(CamOp.MASK_DAMS)
def mask_dams(n: NativeContext, call: OpCall) -> ChangeSet | None:
    e = n.entry(call.layer)
    if not call.layer or e is None or e.get("type") not in MASK_TYPES:
        return None
    mcfg = n.cfg["mask"]
    dot_over = float(call.params.get("dam_oversize_mm") or mcfg.get("dam_oversize_mm", 0.05))
    via_min = float(mcfg["via_dam_min_mm"])
    layer = n.layer(call.layer)
    openings = layer.dark_union()
    cs = layer.begin(call.op, {"dam_oversize_mm": dot_over, "via_dam_min_mm": via_min, "page": 144})
    covered = 0
    for h in _holes(n):
        if h.slot:
            continue
        if h.attribute in ("via_plug", "via_tent"):
            # 绿油塞孔 / 盖油：塞掉或盖住的过孔 —— 删掉它自己的那个小开窗（大开窗里的过孔本来就不塞）
            disc = Point(h.x, h.y).buffer(h.dia / 2)
            own_max = math.pi * ((h.dia + PLUG_OWN_OPENING_ADD_MM) / 2) ** 2 * 1.6
            for f in list(layer.query(disc)):
                if f.polarity_dark and f.geom.contains(Point(h.x, h.y)) and f.geom.area <= own_max:
                    layer.delete(f, f"cover {'tented' if h.attribute == 'via_tent' else 'plugged'} via {h.tool} (塞孔/盖油, p141)")
                    covered += 1
            continue
        want = (h.attribute == "non_plated" and bool(mcfg.get("npth_dams", True))) or (h.attribute == "via" and h.dia >= via_min - 1e-6)
        if not want:
            continue
        disc = Point(h.x, h.y).buffer(h.dia / 2)
        if not openings.intersects(disc):
            continue  # covered: nothing to dam
        already = [f for f in layer.query(disc) if not f.polarity_dark and f.geom.contains(disc.buffer(-0.003))]
        if already:
            continue
        layer.add_pad(h.x, h.y, Symbol("r", (h.dia + 2 * dot_over,)), polarity_dark=False, note=f"dam dot on {h.attribute} {h.tool} (p144)")
    if covered:
        cs.params["plugged_vias_covered"] = covered
    layer.commit()
    return cs
