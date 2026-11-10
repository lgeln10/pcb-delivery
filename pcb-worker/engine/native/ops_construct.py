"""B2 constructive ops (第6/7/9章): geometry is added or removed, not just re-parameterised.

* NfpRemoval       p123/p134  inner positive: delete pads nothing on this layer connects to
* SliverFill       p127/p138  fill gaps narrower than the spacing rule between same-net copper
* Teardrops        p125       pad↔trace junction of small-ring holes gets a teardrop
* SilkClearByMask  p146 步骤4 silk is cut by the (enlarged) mask openings

Every op keeps the two invariants the book insists on: never bridge two nets, never touch a
hole. Where the geometry cannot prove that, the piece is skipped and counted, not guessed.
"""

from __future__ import annotations

import math
from fnmatch import fnmatch
from itertools import pairwise
from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.adapters.base import CamOp
from engine.geom.features import ChangeSet, Feature
from engine.geom.symbols import MIL, Symbol
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, native_op
from engine.native.ops_copper import (
    COPPER_TYPES,
    INNER,
    _copper_layer,
    _holes,
    _is_negative,
    _side_cfg,
)

TOUCH = 0.02  # engine.checks.common.TOUCH: closer than this = connected
TOL = 0.003  # engine.checks.common.TOL: arc approximation / rounding slack


def _pieces(g: BaseGeometry) -> list[Polygon]:
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    return [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon" and not p.is_empty]


def _hole_union(n: NativeContext) -> BaseGeometry:
    hs = _holes(n)
    return unary_union([h.geom() for h in hs]) if hs else Polygon()


# ---- B2.1 NfpRemoval -------------------------------------------------------------------------
@native_op(CamOp.NFP_REMOVAL)
def nfp_removal(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Delete every dark pad whose same-layer component holds pads only (no trace, no plane
    reaches it): a non-functional pad, drilled or not (p134 delete_isolated=yes). Covered pads
    (inside a plane) are kept unless ``delete_covered`` is asked for."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if e.get("type") != INNER or _is_negative(e):
        return None  # p134: inner positive only (validate() refuses the call before we get here)
    ccfg = _side_cfg(n, e)
    if str(ccfg.get("nfp_removal", True)).lower() in ("false", "off"):
        return None  # this factory keeps non-functional pads (profile copper.inner.nfp_removal: false / off; ask = do it, then a person signs it off)
    delete_covered = bool(call.params.get("delete_covered", False))
    # the first real job's engineer removed the component-hole NFPs but left every via its inner pad
    keep_vias = bool(call.params.get("keep_vias", ccfg.get("nfp_keep_vias", False)))
    keep_big = float(ccfg.get("nfp_keep_pad_min_mm", 0) or 0)  # …and the big pads (work/: the 9 mm squares on the 6.75 holes, the 5.5 press-fit pads stayed)
    keep_connected = bool(ccfg.get("nfp_keep_connected_pads", False))  # 「完全独立的删，多焊盘相连的不删」(the engineer, C09 sheet 五-3)
    comps = layer.components(touch=TOUCH)
    by_comp: dict[int, list[Feature]] = {}
    for f in layer.features:
        if f.polarity_dark and not f.geom.is_empty and f.fid in comps:
            by_comp.setdefault(comps[f.fid], []).append(f)
    hs = _holes(n)
    hole_u = unary_union([h.geom() for h in hs]) if hs else Polygon()
    via_u = unary_union([h.geom() for h in hs if h.attribute in ("via", "via_plug", "via_tent")]) if keep_vias and hs else Polygon()
    # a pad on a slot is a component pad, never an NFP: the 6-layer job's engineer kept the ⌀3.1 pads on
    # every ⌀1.6 slot on all six inner layers while deleting the isolated round pads next to them
    keep_slots = bool(ccfg.get("nfp_keep_slot_pads", False))  # C09 终稿：12 个长圆槽上的盘删了、⌀1.6 短槽上的圆盘留着 —— 规律没定，默认照删
    slot_u = unary_union([h.geom() for h in hs if h.slot]) if keep_slots and any(h.slot for h in hs) else Polygon()
    cs = layer.begin(call.op, {"delete_isolated": True, "delete_covered": delete_covered, "keep_vias": keep_vias, "pages": "123/134"})
    kept_vias = kept_slots = 0
    for members in by_comp.values():
        if any(f.kind != "pad" for f in members):
            continue  # a trace or a plane is attached: functional
        if keep_connected and len(members) > 1:
            continue  # pads touching each other are kept as a group; only a pad standing alone is an NFP
        for f in members:
            fn = f.function or ""
            if "Fiducial" in fn or "Test" in fn:
                continue
            if keep_vias and not via_u.is_empty and via_u.intersects(f.geom):
                kept_vias += 1
                continue
            if not slot_u.is_empty and slot_u.intersects(f.geom):
                kept_slots += 1
                continue
            if keep_big > 0 and f.symbol is not None and max(f.symbol.size_mm) >= keep_big - 1e-9:
                continue
            drilled = not hole_u.is_empty and hole_u.intersects(f.geom)
            layer.delete(f, f"NFP: 独立 PAD（{'有孔' if drilled else '无孔'}，本层无连接）")
    if kept_vias:
        cs.params["via_pads_kept"] = kept_vias
    if kept_slots:
        cs.params["slot_pads_kept"] = kept_slots
    layer.commit()
    return cs


# ---- VcutClearance (工厂标准：V-cut 线两侧退铜) --------------------------------------------------
@native_op(CamOp.VCUT_CLEARANCE)
def vcut_clearance(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Copper pulled back from every V-cut / score line (``copper.vcut_clearance_mm``): pours and
    lines within the clearance band of a rail line are clipped, pads are left alone (the 3×3 job's
    set/: the customer's pour ran 0.13 mm from the unit edge, the factory cut it back to 0.36–0.40
    on every layer; the rail side keeps its own ``rail_fill.vcut_gap_mm``)."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if _is_negative(e):
        return None
    clr = float(call.params.get("clearance_mm") or n.cfg["copper"].get("vcut_clearance_mm", 0) or 0)
    lines = _rail_lines(n)
    if clr <= 0 or not lines:
        return None
    band = unary_union([LineString(ln).buffer(clr, cap_style=2) for ln in lines if len(ln) >= 2])
    if band.is_empty:
        return None
    cs = layer.begin(call.op, {"clearance_mm": clr, "lines": len(lines)})
    clipped = deleted = pads = 0
    for f in list(layer.query(band)):
        if not f.polarity_dark or f.geom.is_empty:
            continue
        if f.attrs.get(".string") == "vcut_coupon":
            continue  # the coupon's trace crosses the score line on purpose (2×2 job: the engineer's 1.0 trace runs 94.6..98.6 straight through y=96.6)
        rest = f.geom.difference(band)
        if rest.is_empty or rest.area < 1e-4:
            layer.delete(f, f"copper within {clr} mm of a V-cut line (factory standard)")
            deleted += 1
            continue
        if rest.area >= f.geom.area - 1e-6:
            continue
        # pads too: the 3×3 job's engineer clipped the via pads that poked past the pulled-back pour
        # edge flush with it (C11 gtl/gbl: 42 half-discs left standing when only pours/lines were cut)
        if f.kind == "pad":
            pads += 1
        layer.replace_surface(f, rest, f"{'pad' if f.kind == 'pad' else 'copper'} kept back {clr} mm from the V-cut line (factory standard)")
        clipped += 1
    cs.params.update({"clipped": clipped, "deleted": deleted, "pads_clipped": pads})
    layer.commit()
    return cs


# ---- RailFill (工厂标准：工艺边铺铜) --------------------------------------------------------
def _rails(n: NativeContext) -> list[Polygon]:
    from shapely import from_wkb

    p = n.ctx.work_dir / "rails.wkb"
    if not p.is_file():
        return []
    return _pieces(from_wkb(p.read_bytes()))


def _outline_files(n: NativeContext) -> list[str]:
    """The board outline drawing(s) the router actually cuts to —— align 选中的那一张（``profile.json``
    的 ``file``）。Altium 导出常把 GM1 之类的机械层也认成 outline，上面画的是尺寸线和注记，
    工程师的铜带根本不让它们（3×3 板：按全部 outline 层算会在 x 22.55 / 57.15 / 106.70 多挖三个口）。"""
    picked = None
    try:
        from engine.stages.align import chosen_outline

        picked = chosen_outline(n.ctx)
    except Exception:  # noqa: BLE001 — 没有 profile.json 就退回「所有 outline 层」
        picked = None
    rels = [x["file"] for x in n.entries() if x.get("type") == "outline"]
    return [picked] if picked and picked in rels else rels


def _drawing_union(n: NativeContext, rel: str) -> BaseGeometry:
    try:
        return n.layer(rel).dark_union()
    except Exception:  # noqa: BLE001 — an unreadable drawing layer just adds no keep-out
        return Polygon()


@native_op(CamOp.RAIL_FILL)
def rail_fill(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Copper on the rails (工艺边铺铜, ``copper.rail_fill``): every copper layer gets a solid pour on
    each rail the Profile absorbed, inset from the panel edge, kept back from the V-cut line, and
    clear of holes, of the customer's own copper on the rail and of keep-out drawings. What the
    first real job's engineer did on all six layers (work/: 0.58 mm from the edge, 0.75 mm from
    the score line, 1 mm rings round the tooling holes, the GM7 keep-out boxes left empty)."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if _is_negative(e):
        return None
    rcfg = n.cfg["copper"].get("rail_fill") or {}
    if not rcfg.get("enabled"):
        return None
    rails = _rails(n)
    if not rails:
        return None
    inner = e.get("type") == INNER
    inset = float(call.params.get("inset_mm") or rcfg.get("inner_inset_mm" if inner else "inset_mm", 0.6))
    gap = float(rcfg.get("vcut_gap_mm", 0.75))
    hole_clr = float(rcfg.get("hole_clearance_mm", 0.5))
    cu_clr = float(rcfg.get("copper_clearance_mm", 0.9))
    rad = float(rcfg.get("corner_radius_mm", 0.5))
    round_late = bool(rcfg.get("corner_radius_after_cuts", False))
    coupon_clr = float((n.cfg["copper"].get("vcut_coupon") or {}).get("band_clearance_mm", 0.38))
    rail_u = unary_union(rails)
    board = n.profile.difference(rail_u) if n.profile is not None else Polygon()
    # keep-out marks: anything the customer drew on the named layers *inside* a rail (a box on GM7,
    # a short line on the rail edge on GM6) clears the rail across its whole width for that span;
    # ``keepout_shrink_mm`` narrows the span (work/: 10 mm marks → 8.7 mm gaps)
    marks: list[BaseGeometry] = []
    for pat in rcfg.get("keepout_layers") or []:
        for x in n.entries():
            if fnmatch(str(x.get("file", "")), str(pat)):
                marks += _pieces(_drawing_union(n, x["file"]).buffer(0.01))
    shrink = float(rcfg.get("keepout_shrink_mm", 0) or 0)
    keep = Polygon()
    for r in rails:
        x0, y0, x1, y1 = r.bounds
        horizontal = (x1 - x0) >= (y1 - y0)
        for m in marks:
            if not r.buffer(0.5).contains(m):
                continue
            mx0, my0, mx1, my1 = m.bounds
            band = box(mx0 + shrink, y0 - 1, mx1 - shrink, y1 + 1) if horizontal else box(x0 - 1, my0 + shrink, x1 + 1, my1 - shrink)
            if not band.is_empty and band.area > 0:
                keep = keep.union(band)
    # gaps measured on the finished job (``gaps_mm``): {x: [x0, x1]} clears every *horizontal* rail across
    # its width for that span, {y: [y0, y1]} every vertical one (6-layer job: two 8.7 / 7.4 mm gaps on both
    # long rails, all six layers; 2×2 job: 3.3 mm at the centre of each unit on all three vertical rails)
    # ``gaps_mm`` is written in the output frame (measured on the finished Gerbers); the rails are in
    # the Profile frame (2×2 job: y 49.745 on the output is 252.135 here — the gap never landed)
    from engine.stages.drill import origin_shift

    sx, sy = origin_shift(n.ctx)
    for g in rcfg.get("gaps_mm") or []:
        for r in rails:
            x0, y0, x1, y1 = r.bounds
            horizontal = (x1 - x0) >= (y1 - y0)
            if horizontal and g.get("x"):
                keep = keep.union(box(float(g["x"][0]) - sx, y0 - 1, float(g["x"][1]) - sx, y1 + 1))
            elif not horizontal and g.get("y"):
                keep = keep.union(box(x0 - 1, float(g["y"][0]) - sy, x1 + 1, float(g["y"][1]) - sy))
    # ``outline_clearance_mm``: the copper keeps that far from every *short* stroke of the customer's outline
    # drawing that lies **inside a rail** (the U notches, the tabs and the rout lines he drew through the
    #工艺边; the long rail edges and the V-cut lines are handled by inset/gap). Like a keep-out mark, such
    # a stroke breaks the band across its **whole width** for that span — not just a local bite out of the
    # band's edge (3×3 job, bottom rail, read off the finished job: the strokes run x 42.494…52.556 and the
    # band stops at 42.038 / resumes at 53.017, i.e. 0.447 / 0.461 clear of them, over the full band height;
    # the same at all three columns and at the panel's right end, 141.147 = 141.594 − 0.447). The local
    # buffer we used before never reached the band at all: the strokes sit at y≈3.0, the band ends at 2.398.
    oclr = float(rcfg.get("outline_clearance_mm", 0) or 0)
    if oclr > 0:
        omax = float(rcfg.get("outline_segment_max_mm", 10.0))
        short = []
        for rel in _outline_files(n):
            for f in n.layer(rel).features:
                if f.kind in ("line", "arc") and not f.geom.is_empty:
                    bx0, by0, bx1, by1 = f.geom.bounds
                    if max(bx1 - bx0, by1 - by0) < omax:
                        short.append(f.geom)
        for r in rails:
            x0, y0, x1, y1 = r.bounds
            horizontal = (x1 - x0) >= (y1 - y0)
            near = [g for g in short if r.buffer(0.5).contains(g)]
            if not near:
                continue
            for g in _pieces(unary_union(near).buffer(oclr)):
                gx0, gy0, gx1, gy1 = g.bounds
                keep = keep.union(box(gx0, y0 - 1, gx1, y1 + 1) if horizontal else box(x0 - 1, gy0, x1 + 1, gy1))
    # ``channel_gap_max_mm``: a gap between two neighbouring units narrower than this is a rout channel,
    # not a rail — the band on the outer rails stops ``outline_clearance_mm`` short of it (3×3 job: the
    # 6 mm channels between the columns are routed down into the rail strip, the engineer's band ends
    # 0.45 before each channel wall). 0 = off (2×2 job: its 8.8 mm middle strip is a real rail)
    outline_cuts = bool(_outline_files(n))
    chan_max = float(rcfg.get("channel_gap_max_mm", 0) or 0)
    if chan_max > 0 and not board.is_empty:
        units = sorted(_pieces(board), key=lambda u: u.bounds[0])
        drawn = unary_union([f.geom for rel in _outline_files(n)
                             for f in n.layer(rel).features if not f.geom.is_empty]) if outline_cuts else None
        for axis in (0, 1):
            spans = sorted((u.bounds[axis], u.bounds[axis + 2]) for u in units)
            merged: list[list[float]] = []
            for a, b in spans:
                if merged and a <= merged[-1][1] + 1e-6:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            for (_, e0), (s1, _) in pairwise(merged):
                if not 0 < s1 - e0 <= chan_max:
                    continue
                lo, hi = e0 - oclr, s1 + oclr
                for r in rails:
                    x0, y0, x1, y1 = r.bounds
                    cut = box(lo, y0, hi, y1) if axis == 0 else box(x0, lo, x1, hi)
                    # 通道只断开它**真的锣过去**的那条工艺边：客户在外形层上把通道的边画到了铜带身上，就断；
                    # 没画就是通道到单元边为止，工艺边是连着的（3×3 板：下边的通道线 x 49.55 从 y −0.004 画到
                    # 5.996，穿过铜带 0.674..2.398 → 终稿铜带在那里断开；上工艺边一条竖线都没有 → 终稿铜带
                    # 34.476…50.913 整条跨过通道。原来两条边一律断，上边就多挖了一个 2.9 mm 的口）。
                    # 比的是**铜带那一圈**（rail 按 inset 内缩）不是整条工艺边 —— 客户画在单元边上的那条长线
                    # 正好压在工艺边的内沿上，按整条工艺边比就又一律断了
                    probe = cut.intersection(r.buffer(-inset, join_style=2))
                    if drawn is not None and (probe.is_empty or not drawn.intersects(probe)):
                        continue
                    keep = keep.union(cut)
    hs = _holes(n)
    hole_raw = [Point(h.x, h.y).buffer(max(h.dia, h.drill_dia) / 2) if not h.slot else h.geom() for h in hs]
    # ``cut_round_mm``: a morphological opening by R (erode, dilate) of the band *around its cut-outs*:
    # slivers thinner than 2R next to a hole / ring vanish, the band's ends there get R fillets, wider
    # bridges keep their exact width (2×2 job, read off the finished rails: split clean at each fiducial
    # — the 0.04 mm strips beside the ⌀3.75 cut-out gone, fillet centres 0.24 inside the band edge — yet
    # the 0.537 bridges beside the ⌀2.76 tooling-hole cut-out kept, the gap ends and outer corners square)
    cut_r = float(rcfg.get("cut_round_mm", 0) or 0)
    fill_ratio = float(rcfg.get("customer_fill_min_ratio", 0) or 0)
    # The band is one drawing copied to every layer: the three real jobs' finished rails are identical
    # on all copper layers except for what only exists outside (fiducial ring + pad, the coupons) —
    # the cut-outs round those are on the inner layers too. So an inner layer takes the outer layer's
    # copper on the rail as its obstacles as well (``inner_follow_outer``); the inner stage runs before
    # the outer one, so the coupons are computed here, not read from the outer layer.
    follow = bool(rcfg.get("inner_follow_outer", True))
    outer_src = None
    if inner and follow:
        top = next((x for x in n.entries() if x.get("type") == "top_copper"), None)
        outer_src = n.layer(top["file"]) if top and top["file"] != layer.rel else None
    coupon_geoms = _coupon_copper(n) if e.get("type") in ("top_copper", "bottom_copper") or follow else []

    def _obstacles(src, r):
        return [f for f in src.query(r) if f.polarity_dark and not f.geom.is_empty and f.attrs.get(".string") not in ("vcut_coupon", "rail_fill")]

    cs = layer.begin(call.op, {"inset_mm": inset, "vcut_gap_mm": gap, "hole_clearance_mm": hole_clr, "copper_clearance_mm": cu_clr, "keepout_layers": list(rcfg.get("keepout_layers") or []), "customer_fill_min_ratio": fill_ratio, **({"follows": outer_src.rel} if outer_src is not None else {})})
    added = skipped = 0
    for r in rails:
        core: BaseGeometry = r.buffer(-inset, join_style=2)
        if not board.is_empty:
            core = core.difference(board.buffer(gap, join_style=2))
        if rad > 0 and not round_late:
            core = core.buffer(-rad, join_style=2).buffer(rad)  # 6-layer job: outline corners rounded, gap / hole cuts square
        mine = _obstacles(layer, r)
        # the V-cut coupon keeps its own, tighter clearance from the band (2×2 job: 0.38 round pads
        # and trace, while the tooling-hole rings get 0.25); on the outer layers VcutCoupon has drawn
        # it already (tagged), the inner layers get the same cut-out from the computed shapes
        coup = [f.geom for f in layer.query(r) if f.polarity_dark and f.attrs.get(".string") == "vcut_coupon"] or [g for g in coupon_geoms if g.intersects(r)]
        cuts: list[tuple[BaseGeometry, float]] = []
        if coup:
            cuts.append((unary_union(coup), coupon_clr))
        if mine:
            own_u = unary_union([f.geom for f in mine])
            if fill_ratio > 0 and own_u.intersection(r).area >= fill_ratio * r.area:
                skipped += 1  # 「客户有铺铜的按客户资料」: this rail already carries the customer's own pour
                continue
        obst = list(mine)
        if outer_src is not None:
            # not the outer layer's own band (a big surface inside the rail) if it has been poured already
            obst += [f for f in _obstacles(outer_src, r) if not (f.kind == "surface" and f.geom.area >= 1.0 and r.contains(f.geom))]
        if obst:
            # a ring (the fiducial's) counts as the disc it encloses: the engineer leaves the inside
            # empty, we used to pour an annulus of band copper between the ring and its centre pad
            cuts.append((unary_union([Polygon(p.exterior) for p in _pieces(unary_union([f.geom for f in obst]))]), cu_clr))
        near_holes = [g for g in hole_raw if g.intersects(r.buffer(hole_clr + cut_r))]
        if near_holes:
            cuts.append((unary_union(near_holes), hole_clr))
        if cuts:
            cut_u = unary_union([g.buffer(c) for g, c in cuts])
            core = core.difference(cut_u)
            if cut_r > 0:
                opened = core.buffer(-cut_r).buffer(cut_r)
                core = core.difference(core.difference(opened).intersection(cut_u.buffer(2 * cut_r)))
        if not keep.is_empty:
            core = core.difference(keep)
        if rad > 0 and round_late:
            # rounded corners *after* every cut-out: the band's ends round the holes / channels get the
            # same R as its corners (3×3 job: concave hole arcs with R 0.3 corners)
            core = core.buffer(-rad, join_style=2).buffer(rad)
        for piece in _pieces(core):
            if piece.area < 1.0:
                continue
            layer.add_surface(piece, polarity_dark=True, attrs={".string": "rail_fill"}, note="rail copper fill (工艺边铺铜, 工厂标准)")
            added += 1
    cs.params["pieces"] = added
    if skipped:
        cs.params["rails_customer_filled"] = skipped
    layer.commit()
    return cs


# ---- VcutCoupon（工厂标准：V-cut 线上的防 V-cut 测试点）-----------------------------------------
def clear_stretches(rail: Polygon, obstacles: list[BaseGeometry], axis: int, keep: float) -> list[tuple[float, float]]:
    """The rail's free spans along ``axis`` (0 = x): what is left of the rail's extent once every
    obstacle (holes, the customer's own copper, marks) is projected onto it and widened by ``keep``."""
    lo, hi = rail.bounds[axis], rail.bounds[axis + 2]
    spans: list[list[float]] = []
    for g in obstacles:
        if g.is_empty or not g.intersects(rail):
            continue
        b = g.bounds
        a, z = b[axis] - keep, b[axis + 2] + keep
        if z > lo and a < hi:
            spans.append([a, z])
    spans.sort()
    merged: list[list[float]] = []
    for a, z in spans:
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], z)
        else:
            merged.append([a, z])
    out, prev = [], lo
    for a, z in merged:
        if a > prev:
            out.append((prev, min(a, hi)))
        prev = max(prev, z)
    if prev < hi:
        out.append((prev, hi))
    return [(a, b) for a, b in out if b > a]


def coupon_spots(lines: list[list[tuple[float, float]]], rails: list[Polygon], at: list[dict[str, Any]] | str, obstacles: list[BaseGeometry] | None = None, need: float = 0.0, keep: float = 0.0) -> list[tuple[float, float, tuple[float, float], tuple[float, float], str]]:
    """Where a coupon goes: one per V-cut line — (x, y) on the line, the unit vector along it, the
    unit normal pointing into the rail, and the kind: ``"lambda"`` (rail on one side only: two pads
    on the rail joined by a Λ trace touching the line) or ``"straight"`` (rail on both sides: a pad
    either side joined by a trace across the line — the 2×2 job's middle V-cut and the row V-cut
    where it crosses the left rail). ``at`` pins the position along a line ({x:, y:}: one coordinate
    names the line, the other the position); otherwise the midpoint. ``at: "auto"`` places it by rule
    instead: the middle of the longest stretch of rail beside that line that is clear of ``obstacles``
    (holes, the customer's copper, marks) by ``keep`` and at least ``need`` long — checked against the
    finished panels: 3×3 job 72.302 vs the engineer's 72.330, 2×2 job 124.879 vs 124.570, 6-layer job
    88.1 vs 53.03 (that one is either his free choice or a rule we have not found, 问单 C31).
    Rail on neither side there → none."""
    out = []
    pins = at if isinstance(at, list) else []
    for ln in lines:
        (ax, ay), (bx, by) = ln[0], ln[-1]
        L = math.hypot(bx - ax, by - ay)
        if L < 1e-6:
            continue
        d = ((bx - ax) / L, (by - ay) / L)
        nrm = (-d[1], d[0])
        mx, my = (ax + bx) / 2, (ay + by) / 2
        horizontal = abs(d[0]) >= abs(d[1])
        cx, cy = mx, my
        if at == "auto" and obstacles is not None:
            axis = 0 if horizontal else 1
            beside = [r for r in rails if r.buffer(0.01).intersects(LineString(ln))]
            spans = [sp for r in beside for sp in clear_stretches(r, obstacles, axis, keep) if sp[1] - sp[0] >= need]
            # the middle of the line is where the score depth is most representative, so of the
            # stretches that can hold a coupon take the one whose middle is nearest the line's
            # (3×3 job: the rule lands on 72.325, the engineer drew 72.330)
            mid = mx if horizontal else my
            if spans:
                lo_, hi_ = min(spans, key=lambda t: abs((t[0] + t[1]) / 2 - mid))
                if horizontal:
                    cx = (lo_ + hi_) / 2
                else:
                    cy = (lo_ + hi_) / 2
        for a in pins:
            if horizontal and a.get("y") is not None and abs(float(a["y"]) - my) < 0.5 and a.get("x") is not None:
                cx = float(a["x"])
            elif not horizontal and a.get("x") is not None and abs(float(a["x"]) - mx) < 0.5 and a.get("y") is not None:
                cy = float(a["y"])
        sides = [s_ for s_ in (1.0, -1.0) if any(r.contains(Point(cx + nrm[0] * s_, cy + nrm[1] * s_)) for r in rails)]
        if not sides:
            continue
        if len(sides) == 2:
            out.append((cx, cy, d, nrm, "straight"))
        else:
            out.append((cx, cy, d, (nrm[0] * sides[0], nrm[1] * sides[0]), "lambda"))
    return out


def coupon_shapes(cx: float, cy: float, d: tuple[float, float], into: tuple[float, float], pad: float, pitch: float, off: float, apex: float) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Two pad centres ``off`` into the rail, ``pitch`` apart along the line, and the trace polyline
    pad → apex on the line → apex → pad (the Λ the engineer draws: 3×3 and 6-layer jobs both ⌀1.05
    pads 1.779 apart, 1.415 from the score line, 0.35 trace whose apex sits on the line)."""
    p1 = (cx - d[0] * pitch / 2 + into[0] * off, cy - d[1] * pitch / 2 + into[1] * off)
    p2 = (cx + d[0] * pitch / 2 + into[0] * off, cy + d[1] * pitch / 2 + into[1] * off)
    a1 = (cx - d[0] * apex, cy - d[1] * apex)
    a2 = (cx + d[0] * apex, cy + d[1] * apex)
    return [p1, p2], [p1, a1, a2, p2]


def _coupon_layout(n: NativeContext) -> list[dict[str, Any]]:
    """Every coupon the profile asks for, laid out in the Profile frame: ``{"kind", "pads": [(x, y)],
    "pad_mm", "trace": [(x, y), ...], "trace_mm", "opening_mm"}``. ``at`` is written in the output
    frame (what one measures on the finished Gerbers) — the 6-layer job's rails sit at y −11..0 here
    and 0..11 in the output."""
    from engine.stages.drill import origin_shift

    ccfg = n.cfg["copper"].get("vcut_coupon") or {}
    if not ccfg.get("enabled"):
        return []
    lines, rails = _rail_lines(n), _rails(n)
    sx, sy = origin_shift(n.ctx)
    pad = float(ccfg.get("pad_mm", 1.05))
    pitch = float(ccfg.get("pitch_mm", 1.779))
    raw = ccfg.get("at")
    at: list[dict[str, Any]] | str
    if isinstance(raw, str) and raw.strip().lower() == "auto":
        at = "auto"
    else:  # a hand-written list pins the position — that is copying the finished job, kept only for old profiles
        at = [{**a, **({"x": float(a["x"]) - sx} if a.get("x") is not None else {}), **({"y": float(a["y"]) - sy} if a.get("y") is not None else {})} for a in (raw or [])]
    # what the coupon keeps clear of on the rail: every hole and any copper the customer drew there
    # (tooling-hole rings, fiducials, marks) — the same things the band keeps away from
    rcfg = n.cfg["copper"].get("rail_fill") or {}
    keep = float(ccfg.get("keep_clear_mm", rcfg.get("hole_clearance_mm", 0.5)) or 0.5)
    obst: list[BaseGeometry] = [Point(h.x, h.y).buffer(max(h.dia, h.drill_dia) / 2) if not h.slot else h.geom() for h in _holes(n)]
    rail_u = unary_union(rails) if rails else Polygon()
    if not rail_u.is_empty:
        cu = next((e for e in n.entries() if e.get("type") in ("top_copper", "bottom_copper")), None)
        if cu is not None:
            obst += [g for g in _pieces(_drawing_union(n, cu["file"])) if rail_u.contains(g.centroid)]
    spots = coupon_spots(lines, rails, at, obst, need=pitch + pad + 2 * keep, keep=keep)
    off = float(ccfg.get("from_line_mm", 1.415))
    tw = float(ccfg.get("trace_mm", 0.35))
    apex = float(ccfg.get("apex_half_mm", 0.23))
    opening = float(ccfg.get("opening_mm", 1.30))
    st = ccfg.get("straight") or {}  # the across-the-line variant (2×2 job): ⌀1.0 pads 1.5 either side, 1.0 trace, ⌀1.254 windows
    s_pad, s_half, s_tw, s_open = float(st.get("pad_mm", 1.0)), float(st.get("half_gap_mm", 1.5)), float(st.get("trace_mm", 1.0)), float(st.get("opening_mm", 1.254))
    out: list[dict[str, Any]] = []
    for cx, cy, d, into, kind in spots:
        if kind == "straight":
            p1 = (cx + into[0] * s_half, cy + into[1] * s_half)
            p2 = (cx - into[0] * s_half, cy - into[1] * s_half)
            out.append({"kind": kind, "pads": [p1, p2], "pad_mm": s_pad, "trace": [p1, p2], "trace_mm": s_tw, "opening_mm": s_open})
            continue
        pads, poly = coupon_shapes(cx, cy, d, into, pad, pitch, off, apex)
        out.append({"kind": kind, "pads": list(pads), "pad_mm": pad, "trace": list(poly), "trace_mm": tw, "opening_mm": opening})
    return out


def _coupon_copper(n: NativeContext) -> list[BaseGeometry]:
    """The coupons' copper (pads + trace) as geometry — what RailFill keeps its band away from."""
    out: list[BaseGeometry] = []
    for c in _coupon_layout(n):
        out += [Point(x, y).buffer(c["pad_mm"] / 2) for x, y in c["pads"]]
        if len(c["trace"]) >= 2:
            out.append(LineString(c["trace"]).buffer(c["trace_mm"] / 2))
    return out


@native_op(CamOp.VCUT_COUPON)
def vcut_coupon(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """防 V-cut 测试点 (``copper.vcut_coupon``): on each outer layer, at every V-cut line that borders a
    rail, two round pads joined by a trace whose apex touches the score line — after scoring the
    trace tells whether the cut went too deep. The same side's mask gets a window on each pad. Both
    real jobs of this factory carry one per rail line (p135 only asks whether one is wanted)."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if e.get("type") not in ("top_copper", "bottom_copper"):
        return None
    ccfg = n.cfg["copper"].get("vcut_coupon") or {}
    coupons = _coupon_layout(n)
    if not coupons:
        return None
    opening = float(ccfg.get("opening_mm", 1.30))
    cs = layer.begin(call.op, {"pad_mm": float(ccfg.get("pad_mm", 1.05)), "pitch_mm": float(ccfg.get("pitch_mm", 1.779)), "from_line_mm": float(ccfg.get("from_line_mm", 1.415)), "trace_mm": float(ccfg.get("trace_mm", 0.35)), "opening_mm": opening, "coupons": len(coupons)})
    pads_all: list[tuple[float, float, float]] = []
    for c in coupons:
        tag = "（跨线）" if c["kind"] == "straight" else ""
        trace_ap = Symbol("r", (c["trace_mm"],)).to_aperture(unit=MM)
        for px, py in c["pads"]:
            layer.add_pad(px, py, Symbol("r", (c["pad_mm"],)), attrs={".string": "vcut_coupon"}, note=f"防 V-cut 测试点 pad{tag}")
        for (x1, y1), (x2, y2) in zip(c["trace"], c["trace"][1:]):
            layer.add(go.Line(x1, y1, x2, y2, trace_ap, unit=MM, polarity_dark=True, attrs={".string": "vcut_coupon"}), note=f"防 V-cut 测试点 线{tag}")
        pads_all += [(px, py, c["opening_mm"]) for px, py in c["pads"]]
    layer.commit()
    side = "top" if e["type"] == "top_copper" else "bottom"
    m = next((x for x in n.entries() if x.get("type") == f"{side}_mask"), None)
    if m is not None:
        ml = n.layer(m["file"])
        ml.begin(call.op, {"opening_mm": opening, "pads": len(pads_all)})
        for px, py, od in pads_all:
            ml.add_pad(px, py, Symbol("r", (od,)), note="防 V-cut 测试点 开窗")
        ml.commit()
        n.save_layer(m["file"])  # the engine only saves the call's own layer
        cs.params["mask_layer"] = m["file"]
    return cs


# ---- B2.4 SliverFill ----------------------------------------------------------------------
@native_op(CamOp.SLIVER_FILL)
def sliver_fill(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Morphological closing of the copper by half the spacing rule: what it adds are the gaps
    narrower than that rule. Each gap piece is filled only when every feature it touches is in
    one same-layer component (and, when nets are known, one net) and it stays off every hole."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if _is_negative(e):
        return None
    ccfg = _side_cfg(n, e)
    s = float(call.params.get("max_sliver_mm") or ccfg.get("min_spacing_mm", 4 * MIL))
    dark = [f for f in layer.features if f.polarity_dark and not f.geom.is_empty]
    if not dark:
        return None
    u = unary_union([f.geom for f in dark])
    gaps = u.buffer(s / 2 + 1e-3).buffer(-(s / 2 + 1e-3)).difference(u)
    hole_u = _hole_union(n)
    comps = layer.components(touch=TOUCH)
    cs = layer.begin(call.op, {"max_sliver_mm": s, "pages": "127/138"})
    skipped = 0
    for piece in _pieces(gaps):
        if piece.area < s * s:
            continue  # cap crescents / arc noise, not a sliver (a real one is ≥ s wide × a few s long)
        touching = [g for g in layer.query(piece.buffer(TOUCH)) if g.polarity_dark and not g.geom.is_empty]
        if not touching:
            continue
        nets = {g.net for g in touching if g.net}
        if len({comps.get(g.fid) for g in touching}) > 1 or len(nets) > 1:
            skipped += 1  # would bridge two nets
            continue
        if not hole_u.is_empty and piece.intersects(hole_u.buffer(TOUCH)):
            skipped += 1
            continue
        layer.add_surface(piece, polarity_dark=True, note=f"sliver fill < {s:.4f} mm (p127)")
    if skipped:
        cs.params["skipped_would_bridge_or_hole"] = skipped
    layer.commit()
    return cs


# ---- B2.5 Teardrops -----------------------------------------------------------------------
@native_op(CamOp.TEARDROPS)
def teardrops(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """For every plated hole whose pad ring is at or under ``teardrop_ar_max_mm`` (Genesis
    adv_teardrops ar_min), each straight trace leaving the pad gets a straight teardrop: the
    convex hull of the pad and a trace-width disc placed one pad radius further along the trace.
    Only the part not already copper is added; a teardrop that would come closer than the
    spacing rule to another component's copper, or touch another hole, is skipped."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if _is_negative(e):
        return None
    ccfg = _side_cfg(n, e)
    ar_max = float(call.params.get("ar_max_mm") or ccfg.get("teardrop_ar_max_mm", 9 * MIL))
    spacing = float(call.params.get("spacing_mm") or ccfg.get("min_spacing_mm", 4 * MIL))
    holes = [h for h in _holes(n) if not h.slot and h.attribute in ("plated", "via", "via_plug", "via_tent", "unknown")]
    if not holes:
        return None
    hole_u = unary_union([h.geom() for h in holes])
    comps = layer.components(touch=TOUCH)
    dark_u = layer.dark_union()
    cs = layer.begin(call.op, {"ar_max_mm": ar_max, "spacing_mm": spacing, "page": 125})
    skipped = 0
    done: set[tuple[int, int]] = set()
    for h in holes:
        c = Point(h.x, h.y)
        pads = [f for f in layer.query(c.buffer(h.dia / 2)) if f.polarity_dark and f.kind == "pad" and f.geom.contains(c)]
        if not pads:
            continue
        pad = min(pads, key=lambda f: f.geom.area)
        radius = pad.geom.exterior.distance(c)
        if radius - h.dia / 2 > ar_max + 1e-6:
            continue
        for ln in layer.query(pad.geom.buffer(TOUCH)):
            if ln.kind != "line" or not ln.polarity_dark or ln.geom.is_empty or (pad.fid, ln.fid) in done:
                continue
            w = ln.width_mm or 0.0
            if w <= 0 or w >= 2 * radius:
                continue
            done.add((pad.fid, ln.fid))
            o = ln.obj
            p1, p2 = (float(o.x1), float(o.y1)), (float(o.x2), float(o.y2))
            far = p2 if c.distance(Point(p1)) <= c.distance(Point(p2)) else p1
            dx, dy = far[0] - c.x, far[1] - c.y
            length = math.hypot(dx, dy)
            if length < 1e-6:
                continue
            reach = min(length, 2.0 * radius)
            tip = Point(c.x + dx / length * reach, c.y + dy / length * reach)
            td = unary_union([pad.geom, tip.buffer(w / 2)]).convex_hull
            extra = td.difference(dark_u)
            if extra.area < 1e-4:
                continue
            others = [g for g in layer.query(extra.buffer(spacing)) if g.polarity_dark and not g.geom.is_empty and comps.get(g.fid) != comps.get(pad.fid)]
            if others or extra.intersects(hole_u.difference(h.geom()).buffer(TOUCH)):
                skipped += 1
                continue
            layer.add_surface(extra, polarity_dark=True, note=f"teardrop {h.tool} pad→trace w={w:.3f} (p125)")
            dark_u = dark_u.union(extra)
    if skipped:
        cs.params["skipped_spacing_or_hole"] = skipped
    layer.commit()
    return cs


# ---- B2.6 SilkClearByMask -----------------------------------------------------------------
@native_op(CamOp.SILK_CLEAR_BY_MASK)
def silk_clear_by_mask(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """p146 步骤4: copy the mask, enlarge its openings by the silk-to-opening clearance and use it
    as a negative on the silk — silk inside an opening disappears, silk crossing one is clipped
    (the remainder becomes a surface)."""
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None or e.get("type") not in ("top_silk", "bottom_silk"):
        return None
    side = "bottom" if e["type"].startswith("bottom") else "top"
    mask = next((x for x in n.entries() if x.get("type") == f"{side}_mask"), None)
    if mask is None:
        return None
    clr = float(call.params.get("clearance_mm") or n.cfg["silk"]["clearance_to_opening_mm"])
    openings = n.layer(mask["file"]).dark_union().buffer(clr)
    # p147 字符不能压板边：silk within ``silk.edge_delete_mm`` of the Profile edge (and its V-cut lines)
    # goes the same way (the first real job's engineer deleted every stroke drawn on the board edge)
    edge = float(n.cfg["silk"].get("edge_delete_mm", 0) or 0)
    band = Polygon()
    if edge > 0 and n.profile is not None:
        band = n.profile.boundary.buffer(edge)
        for ln in _rail_lines(n):
            band = band.union(LineString(ln).buffer(edge))
    cut = openings.union(band) if not band.is_empty else openings
    if cut.is_empty:
        return None
    layer = n.layer(rel)
    cs = layer.begin(call.op, {"clearance_mm": clr, "mask": mask["file"], "edge_delete_mm": edge, "page": 146})
    at_edge = 0
    for f in list(layer.query(cut)):
        if not f.polarity_dark or f.geom.is_empty:
            continue
        rest = f.geom.difference(cut)
        on_edge = not band.is_empty and f.geom.intersects(band)
        at_edge += int(on_edge)
        why = "silk on the board edge (p147)" if on_edge else "silk inside mask opening (p146)"
        if rest.is_empty or rest.area < 1e-4:
            layer.delete(f, why)
            continue
        if rest.area >= f.geom.area - 1e-6:
            continue
        layer.replace_surface(f, rest, why.replace("inside", "clipped by") + f" → remainder outside opening + {clr:.4f} mm / edge band")
    if at_edge:
        cs.params["at_edge"] = at_edge
    layer.commit()
    return cs


def _rail_lines(n: NativeContext) -> list[list[tuple[float, float]]]:
    import json

    p = n.ctx.work_dir / "profile.json"
    if not p.is_file():
        return []
    try:
        return [[tuple(pt) for pt in ln] for ln in json.loads(p.read_text("utf-8")).get("rail_lines") or [] if len(ln) >= 2]
    except Exception:  # noqa: BLE001
        return []


# ---- B2.2 Contourize -----------------------------------------------------------------------
@native_op(CamOp.CONTOURIZE)
def contourize(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Painted copper → surface (p123/p137). A "drawn" pour is a connected group of strokes that
    overlap each other heavily (painting); a trace merely attached to it is left as a line —
    the book's warning (p137 不要把不是铜皮的物件也选进来) is enforced by only converting strokes
    that other strokes already cover for ``COVERED`` of their area. The union keeps its holes.
    Copper already drawn as regions (every EDA export today) needs nothing."""
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    min_area = float(call.params.get("min_area_mm2") or 2.0)
    min_strokes = int(call.params.get("min_strokes") or 6)
    strokes = [f for f in layer.lines() if f.polarity_dark and not f.geom.is_empty]
    if len(strokes) < min_strokes:
        return None
    comps = layer.components(strokes)
    groups: dict[int, list[Feature]] = {}
    for f in strokes:
        groups.setdefault(comps.get(f.fid, f.fid), []).append(f)
    cs = layer.begin(call.op, {"min_area_mm2": min_area, "min_strokes": min_strokes, "pages": "123/137"})
    for members in groups.values():
        if len(members) < min_strokes:
            continue
        from shapely import STRtree

        tree = STRtree([f.geom for f in members])
        covered: list[Feature] = []
        for i, f in enumerate(members):
            others = [members[j].geom for j in tree.query(f.geom, predicate="intersects") if j != i]
            if not others:
                continue
            if f.geom.intersection(unary_union(others)).area >= COVERED * f.geom.area:
                covered.append(f)
        if len(covered) < min_strokes:
            continue
        # the outermost strokes of a painted area have only one neighbour: pull them in when the
        # paint already covers a good part of them (a trace attached by its end tip does not qualify)
        paint = unary_union([f.geom for f in covered])
        seen = {f.fid for f in covered}
        for f in members:
            if f.fid not in seen and f.geom.intersection(paint).area >= EDGE_COVERED * f.geom.area:
                covered.append(f)
        pour = unary_union([f.geom for f in covered])
        if pour.area < min_area:
            continue
        # the pour takes the place of the earliest stroke in the painting order: appended at the end it
        # would paint over every clear object drawn after the strokes (C09 L5: the plane's cut-outs filled)
        first = min(covered, key=lambda f: f.fid)
        for f in covered:
            if f is not first:
                layer.delete(f, "drawn copper stroke → surface (p123)")
        layer.replace_surface(first, pour, f"contourized pour from {len(covered)} strokes (p123/p137)")
    layer.commit()
    return cs


COVERED = 0.6  # a stroke ≥ 60 % under its neighbours is paint, not a trace
EDGE_COVERED = 0.3  # …and a stroke ≥ 30 % under the paint is its rim


# ---- B2.3 MaskConstructPads ---------------------------------------------------------------
@native_op(CamOp.MASK_CONSTRUCT_PADS)
def mask_construct_pads(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """p135–136/p141: the mask of one side is rebuilt against its copper pads —

    * a drawn opening (lines/regions) sitting on exactly one copper pad becomes that pad's
      symbol enlarged to the drawn size (转绿油 PAD, construct_pads_by_ref);
    * a copper pad with no opening (vias excepted, p144 注意1; fiducial/test excepted) gets one:
      pad symbol + 2×coverage (p143 Missing → by reference).

    The call may name the copper layer (skeleton, stage outer) or the mask layer (finding)."""
    e = n.entry(call.layer)
    if not call.layer or e is None:
        return None
    t = str(e.get("type", ""))
    if t not in ("top_copper", "bottom_copper", "top_mask", "bottom_mask"):
        return None
    side = t.split("_", 1)[0]
    mask_e = next((x for x in n.entries() if x.get("type") == f"{side}_mask"), None)
    cu_e = next((x for x in n.entries() if x.get("type") == f"{side}_copper"), None)
    if mask_e is None or cu_e is None:
        return None
    mask, cu = n.layer(mask_e["file"]), n.layer(cu_e["file"])
    cov = float(call.params.get("coverage_mm") or n.cfg["mask"].get("coverage_mm", 2 * MIL))
    holes = _holes(n)
    via_u = unary_union([h.geom() for h in holes if h.attribute in ("via", "via_plug", "via_tent")]) if holes else Polygon()
    cs = mask.begin(call.op, {"coverage_mm": cov, "copper": cu_e["file"], "pages": "135/136/141/143"})
    skipped = 0
    # 1. drawn openings → pads by reference
    drawn = [f for f in mask.features if f.polarity_dark and f.kind != "pad" and not f.geom.is_empty]
    if drawn:
        comps = mask.components(drawn)
        groups: dict[int, list[Feature]] = {}
        for f in drawn:
            groups.setdefault(comps.get(f.fid, f.fid), []).append(f)
        for members in groups.values():
            u = unary_union([f.geom for f in members])
            pads = [p for p in cu.query(u) if p.polarity_dark and p.kind == "pad" and p.symbol and p.symbol.kind != "user" and u.contains(p.geom.centroid)]
            if len(pads) != 1 or u.area > 3 * pads[0].geom.area + 1.0:
                skipped += 1  # no single pad under it (a big drawn opening / gold-finger block): leave it
                continue
            pad = pads[0]
            x0, y0, x1, y1 = u.bounds
            pw, ph = pad.symbol.size_mm
            delta = max(2 * cov, (x1 - x0) - pw, (y1 - y0) - ph)
            for f in members:
                mask.delete(f, "drawn opening → pad by reference (p141 步骤2)")
            mask.add_pad(pad.xy[0], pad.xy[1], pad.symbol.resized(delta), note=f"opening = {pad.symbol.name} + {delta:.4f} (by reference)")
    # 2. 转线路 PAD (p136 construct_pads_auto): a flash opening whose copper underneath is drawn
    #    (lines/regions, no flash pad) and fits the opening → one flash pad of the opening's symbol
    #    shrunk by 2×coverage, on the copper layer
    cu_cs = cu.begin(call.op, {"reference": mask_e["file"], "coverage_mm": cov, "page": 136})
    for op_ in [f for f in mask.pads() if f.polarity_dark and f.symbol and f.symbol.kind != "user" and not f.geom.is_empty]:
        under = [g for g in cu.query(op_.geom) if g.polarity_dark and not g.geom.is_empty and g.geom.intersects(op_.geom)]
        if not under or any(g.kind == "pad" for g in under):
            continue
        u = unary_union([g.geom for g in under])
        inner = op_.geom.buffer(-cov)
        if inner.is_empty or not op_.geom.buffer(0.01).contains(u) or u.area < 0.8 * inner.area:
            continue  # a trace passing through, or a drawn shape unlike the opening: not a pad
        for g in under:
            cu.delete(g, "drawn pad → flash by mask reference (p136)")
        cu.add_pad(op_.xy[0], op_.xy[1], op_.symbol.resized(-2 * cov), note=f"pad = opening {op_.symbol.name} − {cov:.4f}/side (p136)")
    cu.commit()
    if len(cu_cs):
        n.save_layer(cu_e["file"])
        cs.params["copper_pads_constructed"] = cu_cs.n_added
    # 3. missing openings
    openings = mask.dark_union()
    for p in cu.pads():
        if not p.polarity_dark or p.geom.is_empty or p.symbol is None or p.symbol.kind == "user":
            continue
        fn = p.function or ""
        if "Fiducial" in fn or "Test" in fn:
            continue
        if not via_u.is_empty and via_u.intersects(p.geom):
            continue
        if openings.intersects(p.geom):
            continue
        mask.add_pad(p.xy[0], p.xy[1], p.symbol.resized(2 * cov), note=f"missing opening for {p.symbol.name} (p143 Missing)")
    if skipped:
        cs.params["skipped_no_reference"] = skipped
    mask.commit()
    return cs


# ---- B2.7 CopperCutout ---------------------------------------------------------------------
GOLD_FINGER_KINDS = ("gold_finger_inner_copper", "gold_finger_copper_nearby")


@native_op(CamOp.COPPER_CUTOUT)
def copper_cutout(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Two book uses of the same op:

    * ``gold_finger_*`` findings — p161 金手指位内层削铜: every inner layer is cleared
      ``inner_cut_mm`` around each finger row (negative film: a dark block; positive: the copper
      is cut back). A trace that only partly runs through the cut region would be opened →
      NeedsHuman. The outer-layer case (表层不铺铜到手指位) moves pads/vias — a person's call.
    * everything else — p131–134 线路掏铜 / p138: a pour is cut back to the spacing rule from
      every pad / trace that is not connected to it, and to the drill-isolation rule from every
      hole whose pad it does not own. Only surfaces change; lines and pads are never touched.
    """
    from engine.native.engine import NeedsHuman

    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if call.kind in GOLD_FINGER_KINDS:
        return _finger_cutout(n, layer, e, call, NeedsHuman)
    if call.kind == "half_hole_copper_cut":
        return _half_hole_cut(n, layer, e, call)
    return _pour_clearance(n, layer, e, call)


def _half_hole_cut(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall) -> ChangeSet | None:
    """p178 线路层半孔部分掏单边 0.1mm: copper on the part of a half hole that the router removes
    (outside the finished edge) is cut back by ``cut`` so the bit does not tear the foil."""
    prof = n.profile
    if prof is None:
        return None
    cut = float(call.params.get("cut_mm") or n.cfg["edge_plating"].get("copper_cut_per_side_mm", 0.1))
    half = [h for h in _holes(n) if not h.slot and h.attribute in ("plated", "via", "via_plug", "via_tent", "unknown") and h.geom().intersects(prof.boundary)]
    if not half:
        return None
    region = unary_union([h.geom().buffer(cut) for h in half]).difference(prof.buffer(-cut))
    cs = layer.begin(call.op, {"cut_mm": cut, "half_holes": len(half), "page": 178})
    for f in list(layer.query(region)):
        if not f.polarity_dark or f.geom.is_empty or not f.geom.intersects(region):
            continue
        rest = f.geom.difference(region)
        layer.replace_surface(f, rest if rest.area > 1e-4 else Polygon(), f"half-hole copper cut-back {cut:.3f} mm (p178)")
    layer.commit()
    return cs


def _finger_cutout(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, NeedsHuman) -> ChangeSet | None:
    if e.get("type") != INNER:
        raise NeedsHuman("外层金手指旁的铜要移开或削掉，属设计更改，请工程师/客户确认 (p161)")
    zones = _finger_zones(n)
    if not zones:
        return None
    cut = float(call.params.get("cut_mm") or n.cfg.get("gold_finger", {}).get("inner_cut_mm", 3.0))
    neg = _is_negative(e)
    cs = layer.begin(call.op, {"cut_mm": cut, "polarity": "negative" if neg else "positive", "page": 161})
    for z in zones:
        region = z.hull.buffer(cut)
        if neg:
            if layer.dark_union().buffer(0.003).contains(region):
                continue
            layer.add_surface(region, polarity_dark=True, note="gold-finger inner clearance block (p161)")
            continue
        for f in list(layer.query(region)):
            if not f.polarity_dark or f.geom.is_empty or not f.geom.intersects(region):
                continue
            if f.geom.within(region.buffer(0.003)):
                layer.delete(f, "inside gold-finger clearance (p161)")
            elif f.kind == "surface":
                layer.replace_surface(f, f.geom.difference(region), "cut by gold-finger clearance (p161)")
            else:
                raise NeedsHuman(f"金手指削铜区内有穿过的线/PAD @ {f.xy[0]:.2f},{f.xy[1]:.2f}，削铜会断网，请确认 (p161)")
    layer.commit()
    return cs


def _pour_clearance(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall) -> ChangeSet | None:
    if _is_negative(e):
        return None  # a negative plane's clearances are its isolation pads (NegativePadReshape)
    ccfg = _side_cfg(n, e)
    spacing = float(call.params.get("spacing_mm") or ccfg.get("min_spacing_mm", 4 * MIL))
    iso = float(call.params.get("drill_isolation_mm") or ccfg.get("drill_isolation_mm", 0.254))
    surfaces = [f for f in layer.surfaces() if f.polarity_dark and not f.geom.is_empty]
    if not surfaces:
        return None
    comps = layer.components(touch=TOUCH)
    holes = [h for h in _holes(n) if h.attribute != "non_plated"]  # NPTH clearance is NpthClearance's job
    cs = layer.begin(call.op, {"spacing_mm": spacing, "drill_isolation_mm": iso, "pages": "131/134/138"})
    for f in surfaces:
        mine = comps.get(f.fid)
        cuts = []
        for g in layer.query(f.geom.buffer(spacing + TOUCH)):
            if g.fid == f.fid or not g.polarity_dark or g.geom.is_empty or comps.get(g.fid) == mine:
                continue
            if f.geom.distance(g.geom) < spacing - TOL:
                cuts.append(g.geom.buffer(spacing))
        for h in holes:
            hg = h.geom()
            if not hg.buffer(iso).intersects(f.geom):
                continue
            owner = [p for p in layer.query(hg) if p.polarity_dark and p.kind == "pad" and p.geom.contains(h.center())]
            if any(comps.get(p.fid) == mine for p in owner):
                continue  # the pour owns this hole's pad: connected, nothing to isolate
            if f.geom.distance(hg) < iso - TOL:
                cuts.append(hg.buffer(iso))
        if not cuts:
            continue
        # in place: a plane re-added at the end paints over the LPC cut-outs drawn after it (C09 L5 2026-09-20:
        # 9 700 mm² of antipads and terminal cut-outs filled solid the first time this branch ran on it)
        layer.replace_surface(f, f.geom.difference(unary_union(cuts)), f"pour cut back {len(cuts)} places → clearance {spacing:.3f} / hole {iso:.3f} mm (p131–134 线路掏铜)")
    layer.commit()
    return cs


def _finger_zones(n: NativeContext) -> list:
    from engine.checks.gold_finger import zones_from_layer_map

    return zones_from_layer_map(n.ctx, n.ctx.layer_map() or {})


# ---- TerminalPad（工厂标准，第一块真板看图反推） --------------------------------------------
@native_op(CamOp.TERMINAL_PAD)
def terminal_pad(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """``copper.terminal_pad``: the pads of ≥ min_hole_width_mm wide routed terminals (relay tabs,
    busbar slots) grow ``grow_mm`` on every copper layer — the engineer resized them 14×7 → 17×10
    on all six layers and let the mask follow the pad (per_pad). Holes the order marks
    ``outer_pad_mm`` (压接/压铆孔, 5.5 → 6.05) get exactly that round pad on the outer layers."""
    from shapely.geometry import Point

    from engine.checks.common import load_rows
    from engine.geom.symbols import Symbol

    e = n.entry(call.layer)
    if not call.layer or e is None or e.get("type") not in COPPER_TYPES:
        return None
    layer = n.layer(call.layer)
    tcfg = n.cfg["copper"].get("terminal_pad") or {}
    grow_on = bool(tcfg.get("enabled"))  # the terminal growth is the factory option; the order's outer_pad_mm always applies
    min_w = float(call.params.get("min_hole_width_mm") or tcfg.get("min_hole_width_mm", 0) or 0) if grow_on else 0.0
    grow = float(call.params.get("grow_mm") or tcfg.get("grow_mm", 0) or 0) if grow_on else 0.0
    outer = e.get("type") in ("top_copper", "bottom_copper")
    rows = load_rows(n.ctx, n.ctx.layer_map() or {})
    if not grow_on and not (outer and any(r.outer_pad_mm > 0 and not r.slot for r in rows)):
        return None
    cs = layer.begin(call.op, {"min_hole_width_mm": min_w, "grow_mm": grow, "terminal_grow": grow_on, "page": 138})

    def pad_at(pt):  # the smallest flash holding the point: the terminal's own pad, not a pour over it
        best = None
        for f in layer.query(pt):
            if f.kind == "pad" and f.polarity_dark and f.symbol and f.symbol.kind != "user" and f.geom.contains(pt) and (best is None or f.geom.area < best.geom.area):
                best = f
        return best

    done: set[int] = set()
    grown = fixed = 0
    for r in rows:
        if r.slot and min_w > 0 and grow > 0 and r.dia_mm >= min_w - 1e-9:
            for h in r.holes:
                f = pad_at(h.center())
                if f is None or f.fid in done:
                    continue
                done.add(f.fid)
                layer.set_symbol(f, f.symbol.resized(grow), f"terminal pad {f.symbol.name} +{grow:.2f} mm (工厂标准：大端子焊盘)")
                grown += 1
        if outer and r.outer_pad_mm > 0 and not r.slot:
            for h in r.holes:
                f = pad_at(Point(h.x, h.y))
                if f is None or f.fid in done or f.symbol.kind not in ("r", "s") or max(f.symbol.size_mm) >= r.outer_pad_mm - 1e-6:
                    continue
                done.add(f.fid)
                layer.set_symbol(f, Symbol("r", (r.outer_pad_mm,)), f"pad {f.symbol.name} → r{r.outer_pad_mm:g} (订单指定 outer_pad_mm)")
                fixed += 1
    cs.params.update({"pads_grown": grown, "order_pads": fixed})
    layer.commit()
    return cs
