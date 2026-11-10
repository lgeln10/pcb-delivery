"""B1 parameter-type ops (第4/6/7/8/9章): change a symbol, resize, delete, copy — one step each.

Every op reads the layer named by the call, edits inside a transaction and returns the
``ChangeSet`` (``None``/empty = post-condition already holds). Rules cite PDF pages.
"""

from __future__ import annotations

from shapely.geometry import LineString, Point
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from engine.adapters.base import CamOp
from engine.geom.features import ChangeSet, Feature, FeatureLayer
from engine.geom.symbols import MIL, Symbol
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, NeedsHuman, native_op

OUTLINE_TYPES = ("outline",)


def _profile_buffer(n: NativeContext, tol: float | None = None) -> BaseGeometry | None:
    prof = n.profile
    if prof is None:
        return None
    t = tol if tol is not None else float(n.cfg["layer"]["outside_profile_tolerance_mm"])
    return prof.buffer(t)


# ---- B1.1 DeleteOutsideProfile (p112 删板外物 / p147 板外字符) -----------------------------
@native_op(CamOp.DELETE_OUTSIDE_PROFILE)
def delete_outside_profile(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Delete every feature that lies entirely outside the (tolerance-buffered) Profile. Features
    that *cross* the board edge are kept — the book wants a human to decide those (p147)."""
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None or e.get("type") in OUTLINE_TYPES:
        return None  # the outline layer's stray segments are an EQ (slot or delete), never auto
    buf = _profile_buffer(n)
    if buf is None:
        return None
    layer = n.layer(rel)
    cs = layer.begin(call.op, {"tolerance_mm": n.cfg["layer"]["outside_profile_tolerance_mm"], "pages": "112/147"})
    for f in list(layer.features):
        g = f.geom
        if g.is_empty:
            continue
        if not g.intersects(buf):
            layer.delete(f, "outside profile")
    layer.commit()
    return cs


# ---- B1.2 SetProfile (p111 外形线统一改为 0.15mm) --------------------------------------------
@native_op(CamOp.SET_PROFILE)
def set_profile_line_width(n: NativeContext, call: OpCall) -> ChangeSet | None:
    rel = call.layer or call.params.get("layer")
    e = n.entry(rel)
    if not rel or e is None or e.get("type") not in OUTLINE_TYPES:
        return None
    target = float(call.params.get("to") or n.cfg["align"]["profile_line_width_mm"])
    layer = n.layer(rel)
    cs = layer.begin(call.op, {"width_mm": target, "page": 111})
    sym = Symbol("r", (target,))
    for f in list(layer.lines()):
        w = f.width_mm
        if w is None or abs(w - target) > 0.005:
            layer.set_symbol(f, sym, f"outline stroke {w if w is not None else '?'} → {target} mm")
    layer.commit()
    return cs


# ---- B1.3 LineCompensation (p124 <15mil +1mil; p138 外层同; 电金板不预大) -----------------------
@native_op(CamOp.LINE_COMPENSATION)
def line_compensation(n: NativeContext, call: OpCall) -> ChangeSet | None:
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None:
        return None
    side = "inner" if e.get("type") == "inner_copper" else "outer"
    ccfg = n.cfg["copper"][side]
    spec = n.ctx.request.order_spec or {}
    finish = str(spec.get("surface_finish") or "").lower()
    if side == "outer" and any(k in finish for k in ("hard gold", "electro", "电金", "镀金", "电镀金")):
        return None  # p138: 电金板线路不预大
    if call.params.get("impedance"):
        raise NeedsHuman(f"阻抗线补偿值要按阻抗计算给出（{call.params.get('widths_mil')} mil），不能套 +1mil (p122/第15章)")
    from engine.checks.impedance import impedance_entries, is_impedance_width

    imp = impedance_entries(spec, e.get("index"))
    from engine.checks.copper import compensation_for

    table_comp, table_below, scope = compensation_for(n.cfg.get("copper"), ccfg, spec, side)
    comp = float(call.params.get("add_mm") or call.params.get("compensation_mm") or table_comp)
    below = float(call.params.get("below_mm") or table_below)
    if call.params.get("scope") == "all":
        scope, below = "all", float("inf")
    min_w = float(call.params.get("min_width_mm") or 0.0)
    layer = n.layer(rel)
    touch = 0.02  # engine.checks.common.TOUCH: closer than this = connected
    # 「会不会短路」按**真的碰上别的网**判：整层补偿本来就会吃掉 comp 的间距，工厂照做
    # （Genesis sel_all_feat + sel_resize），间距不够是后面 SignalLayerChecks 的事（移线/缩 PAD）。
    # 原来用 comp/2 + touch 当门槛，3×3 真板上 27 段线因为旁边 0.029–0.033 处有铜面就没补偿，
    # 终稿那 27 段全是补偿过的（0.254 → 0.284）。
    # 网名不知道就**不许**当短路跳过（六层板 gbl 上 25 段 0.5 线因此没补偿，终稿 1197 段全是 0.6；
    # 其中 x 222.842..226.786 和 226.810..229.250 根本是同一条走线首尾差 0.024 的两段）。
    # 判不了就照补、记一笔，让 SignalLayerChecks 去看 —— 少补一段线是我们自己造的差异。
    short = 1e-3

    def _would_short(f, grown):
        """补完真的压到**已知是别的网**的铜上才算短路；网名未知的记进 ``grown_unknown_net``。"""
        near = [g for g in layer.query(grown) if g.fid != f.fid and g.polarity_dark and not g.geom.is_empty
                and not g.geom.intersects(f.geom.buffer(touch))]  # fmt: skip
        if not near:
            return False, False
        known = [g for g in near if g.net is not None and f.net is not None and g.net != f.net]
        return bool(known), not known
    cs = layer.begin(call.op, {"compensation_mm": comp, "below_mm": below if below != float("inf") else "all", "scope": scope, "min_width_mm": min_w, "pages": "124/138"})
    skipped = 0
    skipped_imp = 0
    unknown_net = 0
    for f in list(layer.lines()):
        if not f.polarity_dark:
            continue
        s = f.symbol
        w = f.width_mm
        if s is None or w is None or w <= 0 or s.kind == "user":
            continue
        if is_impedance_width(w, imp):
            skipped_imp += 1  # 阻抗线依照设计值加大 (p122): not ours to touch
            continue
        if w < below - 0.0005:
            new_w = max(w + comp, min_w)
            # never create a short: growing must not bring the line onto copper it did not already touch
            bad, unknown = _would_short(f, f.geom.buffer((new_w - w) / 2 - short))
            if bad:
                skipped += 1
                continue
            unknown_net += unknown
            layer.set_symbol(f, s.resized(new_w - w), f"line {w:.4f} → {new_w:.4f} mm")
    # p138 步骤5 加大线路和 SMD PAD: pads carrying the .smd attribute grow by the same amount, with the
    # same no-short guard (an SMD pad is undrilled → no ring to worry about)
    # 厚铜蚀刻补偿 (compensation_scope: all): every pad grows too, drilled ones included (the ring
    # that PadUp/焊环 wants is measured after this step)
    smd = 0
    for f in list(layer.pads()):
        if not f.polarity_dark or f.geom.is_empty or f.symbol is None or f.symbol.kind == "user":
            continue
        if scope != "all" and "SMD" not in (f.function or ""):
            continue
        bad, unknown = _would_short(f, f.geom.buffer(comp / 2 - short))
        if bad:
            skipped += 1
            continue
        unknown_net += unknown
        layer.set_symbol(f, f.symbol.resized(comp), f"SMD pad +{comp:.4f} mm (p138)")
        smd += 1
    # 厚铜蚀刻补偿是整层 Resize：面（铜皮/区域）也长，每边长 comp/2 —— 与线/PAD 的直径 +comp 同一回事
    # (Genesis sel_resize 对 surface 的语义；第一块真板 work/ 的铺铜每边正好 +0.05 = 0.1/2)
    surfaces = 0
    if scope == "all" and comp > 0:
        for f in list(layer.surfaces()):
            if not f.polarity_dark or f.geom.is_empty:
                continue
            grown = f.geom.buffer(comp / 2, join_style=2)
            bad, unknown = _would_short(f, grown.buffer(-short))
            if bad:
                skipped += 1
                continue
            unknown_net += unknown
            layer.replace_surface(f, grown, f"surface +{comp / 2:.4f} mm/side (etch compensation)")
            surfaces += 1
    if smd:
        cs.params["smd_pads_grown"] = smd
    if surfaces:
        cs.params["surfaces_grown"] = surfaces
    if skipped:
        cs.params["skipped_would_short"] = skipped
    if unknown_net:
        cs.params["grown_unknown_net"] = unknown_net   # 补完压到了网名未知的铜上：照补，留给 SignalLayerChecks
    if skipped_imp:
        cs.params["skipped_impedance"] = skipped_imp
    layer.commit()
    return cs


# ---- B1.4 MaskResize (p141: 整层 Resize / 单个开窗 Change Symbol / 整块开窗) ---------------------
MASK_TYPES = ("top_mask", "bottom_mask")


@native_op(CamOp.MASK_RESIZE)
def mask_resize(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """Routed by the finding that asked for it — the book has three different edits behind
    "resize the mask":

    * ``mask_expansion``            p141 步骤3  whole layer: Edit → Resize → Global by 2×coverage
    * ``opening_smaller_than_pad``  p141        that opening only: symbol = its pad's + 2×coverage
    * ``npth_opening_small``        p141 要求1  that NPTH opening only: r(hole + 2×0.1)
    * ``edge_plating_mask``         p183        one full opening over the plated edge slot
    * ``gold_finger_mask_not_full`` p162        one block opening replacing the per-finger ones
    """
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None or e.get("type") not in MASK_TYPES:
        return None
    mcfg = n.cfg["mask"]
    cov = float(call.params.get("coverage_mm") or mcfg.get("coverage_mm", 2 * MIL))
    layer = n.layer(rel)
    handler = {
        "mask_expansion": _mask_resize_global, "opening_smaller_than_pad": _mask_open_to_pad, "opening_larger_than_pad": _mask_open_to_pad,
        "npth_opening_small": _mask_npth_openings, "npth_covered": _mask_npth_openings,
        "edge_plating_mask": _mask_open_edge_slots, "half_hole_mask": _mask_open_edge_slots, "gold_finger_mask_not_full": _mask_finger_full_open,
    }.get(call.kind)  # fmt: skip
    if handler is None:
        raise NeedsHuman(f"MaskResize 没有 {call.kind} 这类发现的本地做法")
    return handler(n, layer, e, call, cov)


def _pad_openings(layer: FeatureLayer, cu: FeatureLayer, via_u=None):
    """(copper pad, its dark openings) for every pad that should have an opening (p141): report
    rows are capped at 50 by ``aggregate``, so the engine derives the set from geometry."""
    out = []
    for pad in cu.pads():
        if not pad.polarity_dark or pad.geom.is_empty or pad.symbol is None:
            continue
        fn = pad.function or ""
        if "Fiducial" in fn or "Test" in fn:
            continue
        if via_u is not None and not via_u.is_empty and via_u.intersects(pad.geom):
            continue
        openings = [f for f in layer.query(pad.geom) if f.polarity_dark and not f.geom.is_empty and f.geom.intersects(pad.geom)]
        out.append((pad, openings))
    return out


def _mask_resize_global(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, cov: float) -> ChangeSet:
    """p141 步骤3 整层 Resize: grow every opening (flashes and drawn ones) by enough that the
    *worst* covered pad reaches the coverage rule. Pads may have grown since the openings were
    drawn (p138 加大 SMD PAD), so "+2 mil" is a floor, not the amount."""
    from shapely.ops import unary_union

    cu = _copper_of(n, e)
    worst = None
    if cu is not None:
        for pad, ops in _pad_openings(layer, cu):
            if not ops:
                continue
            u = unary_union([f.geom for f in ops])
            if not u.buffer(0.003).contains(pad.geom):
                continue  # too small: _mask_open_to_pad's job
            exp = u.boundary.distance(pad.geom)
            worst = exp if worst is None else min(worst, exp)
    if worst is None:
        worst = min((float(d.measured) for d in n.details(call) if isinstance(d.measured, (int, float))), default=None)
    need = 2 * (cov - worst) if worst is not None and worst < cov - 1e-6 else 0.0
    delta = float(call.params.get("resize_mm") or need)
    mode = str(call.params.get("mode") or n.cfg["mask"].get("resize_mode", "global"))
    if mode == "per_opening" and cu is not None:
        return _mask_resize_per_opening(layer, cu, call, cov, worst)
    cs = layer.begin(call.op, {"resize_mm": round(delta, 4), "worst_expansion_mm": None if worst is None else round(worst, 4), "mode": "global", "pages": "140/141"})
    if delta <= 0:
        layer.commit()
        return cs
    for f in list(layer.pads()):
        s = f.symbol
        if s is None or not f.polarity_dark:
            continue
        layer.set_symbol(f, s.resized(delta), f"opening +{delta:.4f} mm")
    for f in list(layer.surfaces()):  # drawn openings grow too (mitred, corners stay corners), in place
        if not f.polarity_dark or f.geom.is_empty:
            continue
        layer.replace_surface(f, f.geom.buffer(delta / 2, join_style=2), f"drawn opening +{delta:.4f} mm")
    layer.commit()
    return cs


def _mask_resize_per_opening(layer: FeatureLayer, cu: FeatureLayer, call: OpCall, cov: float, worst: float | None) -> ChangeSet:
    """``mask.resize_mode: per_opening``: only the openings that fall short of the coverage rule
    grow, each to its own pad + cov per side; the rest stay as designed. This is what the first
    real job's engineer did (work/: 0.05 mm everywhere the pads had grown into their openings,
    the well-cleared openings untouched) — a global resize would over-open the whole layer."""
    from shapely.ops import unary_union

    cs = layer.begin(call.op, {"coverage_mm": cov, "worst_expansion_mm": None if worst is None else round(worst, 4), "mode": "per_opening", "pages": "140/141"})
    grown = 0
    # one drawn opening can span several pads: the snapshot from _pad_openings goes stale as
    # earlier pads merge/delete it, so every pad reads the *current* feature behind each fid
    live = {f.fid: f for f in layer.features}
    for pad, snap in _pad_openings(layer, cu):
        ops = [live[f.fid] for f in snap if f.fid in live]
        if not ops:
            continue
        u = unary_union([f.geom for f in ops])
        if not u.buffer(0.003).contains(pad.geom):
            continue  # too small: _mask_open_to_pad's job
        exp = u.boundary.distance(pad.geom)
        if exp >= cov - 1e-6:
            continue
        want = pad.geom.buffer(cov, join_style=2 if (pad.symbol and pad.symbol.kind in ("rect", "sq")) else 1)
        c = pad.geom.centroid
        flashes = sorted((f for f in ops if f.kind == "pad" and f.symbol and f.symbol.kind != "user"), key=lambda f: c.distance(Point(*f.xy)))
        one = flashes[0] if flashes and c.distance(Point(*flashes[0].xy)) < 0.05 and len(ops) == 1 else None
        if one is not None:
            nf = layer.set_symbol(one, one.symbol.resized(2 * (cov - exp)), f"opening +{cov - exp:.4f}/side → pad + {cov:.4f} (p141)")
            live[nf.fid] = nf
        else:
            keep = ops[0]
            for f in ops[1:]:
                if f.geom.within(want.buffer(0.01)):
                    layer.delete(f, "merged into the pad + coverage opening")
                    live.pop(f.fid, None)
            for nf in layer.replace_surface(keep, u.union(want), f"opening grown to pad + {cov:.4f}/side (p141)"):
                live[nf.fid] = nf
        grown += 1
    cs.params["openings_grown"] = grown
    layer.commit()
    return cs


def _copper_of(n: NativeContext, e: dict) -> FeatureLayer | None:
    side = "bottom" if str(e.get("type", "")).startswith("bottom") else "top"
    cu = next((x for x in n.entries() if x.get("type") == f"{side}_copper"), None)
    return n.layer(cu["file"]) if cu else None


def _mask_open_to_pad(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, cov: float) -> ChangeSet:
    from shapely.ops import unary_union

    cu = _copper_of(n, e)
    if cu is None:
        raise NeedsHuman("找不到同面的线路层，无法按焊盘加大开窗")
    shrink = call.kind == "opening_larger_than_pad"  # factory standard: every pad opening remade as pad + coverage
    # The engineer's coverage rule (C09 sheet 五-2): an opening that sits entirely on a large copper area
    # gets pad + 1 mil a side, any other pad + 2 mil. "On copper" = the ring round the pad is almost
    # all copper (mask.coverage_on_pour). Measured on the C11 golden once the comparator rendered
    # rectangle-aperture draws correctly (ROADMAP §M6m): 0.98 → 1.031 on the pour, 1.082 off it.
    pour = n.cfg["mask"].get("coverage_on_pour") or {}
    cu_union = cu.dark_union() if pour else None
    # the pour rule asks this for *every* pad (5.6k a side on the six-layer job): overlaying each ring
    # against the whole-layer union rebuilds GEOS's index per call (>20 min in the mask stage) —
    # query a tree of the union's pieces and overlay only the pieces the ring touches
    cu_pieces = list(getattr(cu_union, "geoms", [cu_union])) if cu_union is not None and not cu_union.is_empty else []
    cu_tree = STRtree(cu_pieces) if cu_pieces else None

    def pour_coverage(pad) -> float:
        ring = pad.geom.buffer(float(pour.get("ring_mm", 0.2))).difference(pad.geom.buffer(0.03))
        if ring.area <= 0 or cu_tree is None:
            return 1.0
        near = [cu_pieces[int(i)] for i in cu_tree.query(ring, predicate="intersects")]
        return sum(ring.intersection(p).area for p in near) / ring.area if near else 0.0
    cs = layer.begin(call.op, {"coverage_mm": cov, "mode": "regenerate" if shrink else "per_pad", "page": 141, **({"coverage_on_pour": pour} if pour else {})})
    pairs = _pad_openings(layer, cu)
    # an opening several pads share belongs to the pad it overlaps most: a QFN's thermal window with
    # five vias in it is the thermal pad's, and the vias' turn must not remake it as a via-sized dot
    # (C11 gts 2026-09-20: nine thermal pads ended up covered — the dots were then deleted as plugged).
    # ★按重叠面积、不是按盘的大小：C09 排针旁边的 oval5.6×21.9 大盘和 25 个 ⌀1.0 小窗各压一半，
    # 按「最大的盘」会把小窗全认领走，小盘就永远长不大（gts 第 3 轮 0.25% → 4.01%）
    # ★但一个 flash 窗的圆心就在某个盘的圆心上，它就是那个盘的（C09 排针旁的 ⌀1.2 塞孔过孔：⌀2 的窗一半压在
    # 端子大窗上，按重叠面积会归给大盘、被并进大窗的面里，MaskDams 后面就删不掉它了 —— 终稿这些窗全删了）
    owner: dict[int, Feature] = {}
    share: dict[int, tuple[float, float, float]] = {}
    for pad, ops in pairs:
        for f in ops:
            centred = 1.0 if f.kind == "pad" and f.xy is not None and pad.xy is not None and Point(*f.xy).distance(Point(*pad.xy)) < 0.05 else 0.0
            try:
                key = (centred, f.geom.intersection(pad.geom).area, pad.geom.area)
            except Exception:  # noqa: BLE001 - 拓扑异常时退回按盘的大小
                key = (centred, 0.0, pad.geom.area)
            if f.fid not in owner or key > share[f.fid]:
                owner[f.fid], share[f.fid] = pad, key
    fid_step = float(n.cfg["mask"].get("fiducial_opening_shrink_mm", 0) or 0)
    fid_clear = float(n.cfg["mask"].get("fiducial_opening_min_clear_mm", 3 * MIL))
    for pad, openings in pairs:
        if getattr(pad.obj, "attrs", None) and pad.obj.attrs.get(".string") == "vcut_coupon":
            continue  # 防 V-cut 测试点的窗是 VcutCoupon 按厂规开的（盘 + 5 mil），不按 pad + coverage 重做
        openings = [f for f in openings if owner.get(f.fid) is pad]
        if not openings:
            continue  # no opening of its own → MaskConstructPads (p143 Missing), or it sits inside a bigger pad's window
        if shrink and fid_step > 0 and _fiducial_window_shrink(layer, cu, pad, openings, fid_step, fid_clear):
            continue  # p144 exception: a fiducial's big window that runs onto its ring is shrunk clear of the ring
        if not shrink and unary_union([f.geom for f in openings]).buffer(0.003).contains(pad.geom):
            continue  # covers the pad: expansion is the global resize's business
        pad_cov = cov
        if pour and pour_coverage(pad) >= float(pour.get("pour_coverage_min", 0.9)):
            pad_cov = float(pour.get("coverage_mm", cov))  # flush in a pour: the tighter margin
        want = pad.geom.buffer(pad_cov)
        # the pad's own opening: the flash whose centre is nearest the pad's (a neighbour's opening
        # may overlap once pads have grown — it is not this pad's and must not trigger a surface)
        c = pad.geom.centroid
        flashes = sorted((f for f in openings if f.kind == "pad" and f.symbol and f.symbol.kind != "user"), key=lambda f: c.distance(Point(*f.xy)))
        one = flashes[0] if flashes and c.distance(Point(*flashes[0].xy)) < max(pad.symbol.size_mm) / 2 + cov else None
        if one is not None and pad.symbol and pad.symbol.kind != "user":
            target = pad.symbol.resized(2 * pad_cov)
            if shrink and one.symbol is not None and all(abs(a - b) <= 1e-6 for a, b in zip(one.symbol.size_mm, target.size_mm)):
                continue  # already exactly pad + coverage
            # ★「大的缩小的放大」（profile 注释里就是这么写的）：原来写成「比目标小的也跳过」，
            # 焊盘被 PadUp/补偿撑大之后开窗就永远跟不上（C09 gts 排针 1.003 vs 终稿 1.27）
            layer.set_symbol(one, target, f"opening = pad {pad.symbol.name} + {pad_cov:.4f}/side ({'on pour (factory rule)' if pad_cov != cov else 'factory standard' if shrink else 'p141'})")
            dx, dy = pad.xy[0] - one.xy[0], pad.xy[1] - one.xy[1]
            if abs(dx) > 1e-4 or abs(dy) > 1e-4:
                layer.move(one, dx, dy, "centre opening on its pad")
            continue
        if shrink:
            continue  # drawn / merged openings are left alone when remaking
        for f in openings:  # drawn / macro openings: replace what sits inside the new one
            if f.geom.within(want.buffer(0.01)):
                layer.delete(f, "replaced by pad-sized opening")
        layer.add_surface(want, polarity_dark=True, note=f"opening = pad + {pad_cov:.4f}/side ({'on pour (factory rule)' if pad_cov != cov else 'p141'})")
    layer.commit()
    return cs


def _fiducial_window_shrink(layer: FeatureLayer, cu: FeatureLayer, pad: Feature, openings: list[Feature], step: float, clear: float) -> bool:
    """p144 光标点开窗: the big window is kept as drawn *unless* it is tangent to / runs onto copper
    (the fiducial's ring) — then it is shrunk until it clears that copper. The 2×2 job's engineer took
    the customer's ⌀2.6 disc (its ring's inner edge is ⌀2.57 once compensated) down one 4 mil/side
    step to ⌀2.3968, 3 mil clear of the ring; the unit fiducials of the 3×3 job (window inside the
    ring) were left to the pad + coverage rule. Returns True when it took the case."""
    from shapely import minimum_bounding_circle, minimum_bounding_radius
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    drawn = [f for f in openings if f.kind != "pad" or (f.symbol is not None and f.symbol.kind == "user")]
    if not drawn:
        return False
    u = unary_union([f.geom for f in openings])
    if u.is_empty or not hasattr(u, "exterior"):
        return False
    disc = Polygon(u.exterior)  # the window as one filled shape (the customer may have drawn it as a thick arc ring)
    if disc.area < 2 * pad.geom.area or disc.area < 0.9 * minimum_bounding_circle(disc).area:
        return False  # not a big round window round the pad
    c = disc.centroid
    if c.distance(pad.geom.centroid) > 0.1:
        return False
    others = [f.geom for f in cu.query(disc) if f.fid != pad.fid and f.polarity_dark and not f.geom.is_empty and f.geom.intersects(disc)]
    if not others:
        return False  # clear of every other copper: p144 main rule, keep it as drawn
    ou = unary_union(others)
    r = float(minimum_bounding_radius(disc))  # the drawn circle's true radius (the polygon's vertices sit on it; its area falls short)
    for _ in range(12):
        r -= step
        d = Point(c.x, c.y).buffer(r)
        if not d.contains(pad.geom):
            return False  # would eat into the pad's own window: leave it to the engineer
        if d.distance(ou) >= clear - 1e-6:
            for f in openings:
                layer.delete(f, "fiducial window remade")
            layer.add_pad(c.x, c.y, Symbol("r", (round(2 * r, 4),)), note=f"光标点开窗缩到离铜皮 ≥{clear:.4f}（{step:.4f}/边一档，p144 例外）")
            return True
    return False


def _mask_npth_openings(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, cov: float) -> ChangeSet:
    from shapely.geometry import Point

    from engine.native.ops_copper import _holes

    from shapely.ops import unary_union

    ovs = float(call.params.get("oversize_mm") or n.cfg["mask"].get("npth_opening_oversize_mm", 0.1))
    holes = [h for h in _holes(n) if h.attribute == "non_plated" and not h.slot and h.tool != "notch"]
    open_covered = bool(n.cfg["mask"].get("npth_open_covered", False))
    cs = layer.begin(call.op, {"npth_opening_oversize_mm": ovs, "mode": "per_npth", "page": 141, "open_covered": open_covered})
    # ★全集从几何来，不是从问题点来：report 行被 aggregate 截到 50 条，第 51 个 NPTH 就漏了
    #  （C12 的 per_npth「加 50」，矩形挖空四角的 ⌀0.8 预钻孔一个窗都没开）
    for h in holes:
        disc = Point(h.x, h.y).buffer(h.dia / 2)
        got = [f for f in layer.query(disc) if f.polarity_dark and not f.geom.is_empty and f.geom.intersects(disc)]
        if not got:
            if not open_covered:
                continue  # 没窗的 NPTH 要不要开是厂规（mask.npth_open_covered）
        elif unary_union([f.geom for f in got]).contains(disc.buffer(ovs - 0.003)):
            continue  # 已经够大
        sym = Symbol("r", (h.dia + 2 * ovs,))
        openings = [f for f in layer.query(disc) if f.polarity_dark and not f.geom.is_empty]
        one = openings[0] if len(openings) == 1 else None
        if one is not None and one.kind == "pad" and one.symbol and one.symbol.kind != "user":
            layer.set_symbol(one, sym, f"NPTH {h.tool} opening → {sym.name} (p141)")
            dx, dy = h.x - one.xy[0], h.y - one.xy[1]
            if abs(dx) > 1e-4 or abs(dy) > 1e-4:
                layer.move(one, dx, dy, "centre opening on the hole")
            continue
        for f in openings:
            if f.geom.within(disc.buffer(ovs + 0.2)):
                layer.delete(f, "replaced by hole-sized opening")
        layer.add_pad(h.x, h.y, sym, polarity_dark=True, note=f"NPTH {h.tool} opening {sym.name} (p141)")
    layer.commit()
    return cs


def _mask_open_edge_slots(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, cov: float) -> ChangeSet:
    from shapely.geometry import Point

    from engine.native.ops_copper import _holes

    ovs = float(n.cfg.get("edge_plating", {}).get("mask_dam_oversize_mm", 0.1))
    prof = n.profile
    cs = layer.begin(call.op, {"oversize_mm": ovs, "mode": "edge_slot_full_open", "page": 183})
    for d in n.details(call):
        pt = Point(d.location.x, d.location.y)
        edge = [h for h in _holes(n) if h.slot or (prof is not None and h.geom().intersects(prof.boundary))]  # slots and half holes
        h = min(edge, key=lambda h: pt.distance(h.geom()), default=None)
        if h is None or pt.distance(h.geom()) > 0.5:
            continue
        want = h.geom().buffer(ovs)
        if prof is not None:
            want = want.intersection(prof.buffer(ovs))
        if layer.dark_union().buffer(0.003).contains(want):
            continue
        layer.add_surface(want, polarity_dark=True, note=f"edge-plating slot {h.tool} full opening (p183)")
    layer.commit()
    return cs


def _mask_finger_full_open(n: NativeContext, layer: FeatureLayer, e: dict, call: OpCall, cov: float) -> ChangeSet:
    from shapely.geometry import box

    cs = layer.begin(call.op, {"coverage_mm": cov, "mode": "finger_block_opening", "page": 162})
    for d in n.details(call):
        if d.location.bbox is None:
            continue
        x0, y0, x1, y1 = d.location.bbox
        want = box(x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5).buffer(cov)  # loc_of() padded the hull by 0.5
        for f in list(layer.query(want)):
            if f.polarity_dark and f.kind == "pad" and f.geom.within(want.buffer(0.01)):
                layer.delete(f, "per-finger opening replaced by the block opening (p162)")
        layer.add_surface(want, polarity_dark=True, note="gold-finger block opening (p162)")
    layer.commit()
    return cs


# ---- B1.5 SilkTransform (p145–146 字高 ≥30mil：Anchor + Scale) ------------------------------
@native_op(CamOp.SILK_TRANSFORM)
def silk_transform(n: NativeContext, call: OpCall) -> ChangeSet | None:
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None or e.get("type") not in ("top_silk", "bottom_silk"):
        return None
    min_h = float(call.params.get("min_height_mm") or n.cfg["silk"]["min_height_mm"])
    min_w = float(call.params.get("min_line_width_mm") or n.cfg["silk"]["min_line_width_mm"])
    layer = n.layer(rel)
    dark = [f for f in layer.features if f.polarity_dark and not f.geom.is_empty]
    cs = layer.begin(call.op, {"min_height_mm": min_h, "min_line_width_mm": min_w, "pages": "145/146"})
    # p146 步骤1: 物件查看器选出线宽不达标的线 → Change Symbol 到最小字宽
    for f in list(layer.lines()):
        w = f.width_mm
        if f.polarity_dark and w is not None and 0 < w < min_w - 0.003 and f.symbol and f.symbol.kind != "user":
            layer.set_symbol(f, Symbol("r", (min_w,)), f"silk stroke {w:.4f} → {min_w:.4f} mm (p145 字宽≥5mil)")
    dark = [f for f in layer.features if f.polarity_dark and not f.geom.is_empty]
    for run in _text_runs(layer, dark):
        feats, h, cx, cy = run
        if h >= min_h - 0.005 or h <= 0:
            continue
        k = min_h / h
        for f in feats:
            _scale_feature(layer, f, k, cx, cy)
    _mount_hole_rings(n, layer, cs)
    layer.commit()
    return cs


def _mount_hole_rings(n: NativeContext, layer: FeatureLayer, cs: ChangeSet) -> None:
    """``silk.mount_hole_ring`` (first real job, read off the rendered work/ vs 原稿): the ring the
    customer draws round each screw hole becomes one ⌀dia circle of width_mm — twelve ⌀4.2 holes
    had ⌀9.3 rings, all became ⌀10 / 0.25; holes without a ring get none."""
    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM
    from shapely.geometry import Point
    from shapely.ops import unary_union

    from engine.native.ops_copper import _holes

    rc = n.cfg["silk"].get("mount_hole_ring") or {}
    target = float(rc.get("dia_mm", 0) or 0)
    if target <= 0:
        return
    lo, hi, width = float(rc.get("min_hole_mm", 4.0)), float(rc.get("max_hole_mm", 4.5)), float(rc.get("width_mm", 0.25))
    done = 0
    for h in _holes(n):
        if h.slot or not (lo - 1e-6 <= h.dia <= hi + 1e-6):
            continue
        c = Point(h.x, h.y)
        ann = c.buffer(target / 2 + 0.6).difference(c.buffer(h.dia / 2 + 0.3))
        feats = [f for f in layer.query(ann) if f.polarity_dark and f.kind in ("line", "arc") and f.geom.within(ann)]
        if not feats:
            continue
        x0, y0, x1, y1 = unary_union([f.geom for f in feats]).bounds
        size = max(x1 - x0, y1 - y0)
        # only a ring centred on the hole, smaller than the target, is normalised
        if size >= target - 0.05 or abs((x0 + x1) / 2 - h.x) > 0.3 or abs((y0 + y1) / 2 - h.y) > 0.3 or abs((x1 - x0) - (y1 - y0)) > 0.3:
            continue
        for f in feats:
            layer.delete(f, f"ring ⌀{size:.2f} → ⌀{target} (工厂标准 mount_hole_ring)")
        layer.add(go.Arc.from_circle(h.x, h.y, target / 2, Symbol("r", (width,)).to_aperture(unit=MM), unit=MM), f"mount-hole ring ⌀{target} / {width}")
        done += 1
    cs.params["mount_hole_rings"] = done


def _text_runs(layer: FeatureLayer, dark: list[Feature]) -> list[tuple[list[Feature], float, float, float]]:
    """Cluster small dark strokes into text runs the way ``engine.checks.silk.text_runs`` does,
    but on features so they can be scaled together. Returns (features, height, anchor x, anchor y)."""
    from shapely import STRtree

    small = [f for f in dark if max(f.geom.bounds[2] - f.geom.bounds[0], f.geom.bounds[3] - f.geom.bounds[1]) <= 6.0]
    if not small:
        return []
    tree = STRtree([f.geom for f in small])
    parent = list(range(len(small)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for i, f in enumerate(small):  # strokes that touch → one glyph
        for j in tree.query(f.geom.buffer(0.02), predicate="intersects"):
            if j != i:
                parent[find(i)] = find(j)
    glyphs: dict[int, list[Feature]] = {}
    for i, f in enumerate(small):
        glyphs.setdefault(find(i), []).append(f)
    boxes = [(gid, _bounds([f.geom for f in fs]), fs) for gid, fs in glyphs.items()]
    # glyphs on one baseline within one glyph-height of each other → a run (≥3 glyphs, p145 字高)
    runs: list[tuple[list[Feature], float, float, float]] = []
    used: set[int] = set()
    for gid, (x0, y0, x1, y1), fs in boxes:
        if gid in used:
            continue
        h = y1 - y0
        w = x1 - x0
        vertical = h > 2.5 * w
        members = [(gid, (x0, y0, x1, y1), fs)]
        used.add(gid)
        for gid2, b2, fs2 in boxes:
            if gid2 in used:
                continue
            bx0, by0, bx1, by1 = b2
            if vertical:
                same = abs((bx0 + bx1) / 2 - (x0 + x1) / 2) < 0.6 * w and min(abs(by0 - y1), abs(y0 - by1)) < 1.5 * h
            else:
                same = abs((by0 + by1) / 2 - (y0 + y1) / 2) < 0.6 * h and min(abs(bx0 - x1), abs(x0 - bx1)) < 1.5 * h
            if same:
                members.append((gid2, b2, fs2))
                used.add(gid2)
        if len(members) < 3:
            continue
        feats = [f for _, _, fs in members for f in fs]
        mx0, my0, mx1, my1 = _bounds([f.geom for f in feats])
        height = (mx1 - mx0) if vertical else (my1 - my0)
        runs.append((feats, height, (mx0 + mx1) / 2, (my0 + my1) / 2))
    return runs


def _bounds(geoms: list[BaseGeometry]) -> tuple[float, float, float, float]:
    xs0, ys0, xs1, ys1 = zip(*(g.bounds for g in geoms))
    return (min(xs0), min(ys0), max(xs1), max(ys1))


def _scale_feature(layer: FeatureLayer, f: Feature, k: float, cx: float, cy: float) -> None:
    from gerbonara import graphic_objects as go

    o = f.obj

    def sx(x: float) -> float:
        return cx + (float(x) - cx) * k

    def sy(y: float) -> float:
        return cy + (float(y) - cy) * k

    if isinstance(o, go.Flash):
        s = f.symbol
        ap = s.resized(s.size_mm[0] * (k - 1)).to_aperture(attrs=getattr(o.aperture, "attrs", None)) if s and s.kind != "user" else o.aperture
        new = go.Flash(sx(o.x), sy(o.y), ap, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
    elif isinstance(o, go.Line):
        new = go.Line(sx(o.x1), sy(o.y1), sx(o.x2), sy(o.y2), o.aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
    elif isinstance(o, go.Arc):
        new = go.Arc(sx(o.x1), sy(o.y1), sx(o.x2), sy(o.y2), sx(o.cx), sy(o.cy), o.clockwise, o.aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
    else:
        new = go.Region([(sx(x), sy(y)) for x, y in o.outline], list(o.arc_centers) if o.arc_centers else None, unit=o.unit, polarity_dark=o.polarity_dark)
    layer.replace(f, new, f"scale ×{k:.3f} about ({cx:.3f}, {cy:.3f})")
