"""B3 optimisers and the last "in-stage" ops done natively.

* SignalLayerOptimize  p124–125/p138  PadUp: every drilled pad grows toward the ring target as
                       far as the spacing / drill-isolation rules allow. The book's two passes
                       (spacing 0.1 mil first, then the real spacing) are the same fixed point
                       computed in one go: grow = min(needed, allowed by spacing). Shaving other
                       copper is not done here — what cannot be reached stays a finding.
* MaskOptimize         p142–143       coverage: an opening too close to foreign copper shrinks
                       (never below pad + clearance_min); bridge: two openings closer than the
                       bridge rule merge into one when their pads share a net (IC pins of
                       different nets keep their EQ — the book wants a person there). Once per
                       layer (plan guard).
* AlignToDrill         p111           translate a layer onto the drill reference when the
                       finding's offset is a clean shift (same extents), else a person.
* AddHolesFromDrawing  p113           holes the drill table / drill drawing has and the Excellon
                       lacks are copied from the drawing layer; slots drawn on the outline layer
                       become slots in the NPTH tape.
"""

from __future__ import annotations

from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.apertures import ExcellonTool
from gerbonara.excellon import ExcellonFile
from gerbonara.utils import MM
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree

from engine.adapters.base import CamOp
from engine.geom.features import ChangeSet, Feature
from engine.geom.symbols import MIL
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, NeedsHuman, native_op
from engine.native.ops_construct import TOL, TOUCH
from engine.native.ops_copper import _copper_layer, _holes, _is_negative, _side_cfg
from engine.native.ops_panel import _manual_cs


# ---- B3.1 SignalLayerOptimize (PadUp) --------------------------------------------------------
@native_op(CamOp.SIGNAL_LAYER_OPTIMIZE)
def signal_layer_optimize(n: NativeContext, call: OpCall) -> ChangeSet | None:
    got = _copper_layer(n, call)
    if got is None:
        return None
    layer, e = got
    if _is_negative(e):
        return None
    ccfg = _side_cfg(n, e)
    target = float(call.params.get("ar_opt_mm") or ccfg.get("min_annular_ring_mm", 0.2))
    via_target = float(call.params.get("via_ar_opt_mm") or ccfg.get("via_annular_ring_mm") or target)
    # vias left open on a plugged/tented board (inside a pad opening) may need a bigger ring (set/: 8 vs 6 mil)
    via_open_target = float(ccfg.get("via_open_annular_ring_mm") or 0) or via_target
    # a via pad standing alone on the layer (no trace, no plane: its own component) gets the *optimal*
    # ring, the rest stay at the minimum — p124 SLO read off the 6-layer job: gbl 3193 vias at 10 mil
    # are in a pour or on a trace, 169 at 12 mil are free-standing (167/169; gtl 213, one exception)
    via_isolated_target = float(ccfg.get("via_isolated_annular_ring_mm") or 0) or 0.0
    # the ring is measured from the finished hole (book) or from the bit that drills it (Genesis SLO on
    # an oversized drill layer; the first real job's engineer: PTH ring 14 mil, via 12 mil on the bit)
    on_drill = str(ccfg.get("pad_up_base", "finished")) == "drill"
    spacing = float(call.params.get("spacing_mm") or ccfg.get("min_spacing_mm", 4 * MIL))
    iso = float(call.params.get("drill_isolation_mm") or ccfg.get("drill_isolation_mm", 0.254))
    limit = float(call.params.get("enlarge_limit_mm") or ccfg.get("pad_enlarge_limit_mm", 0.3))
    holes = [h for h in _holes(n) if not h.slot and h.attribute in ("plated", "via", "via_plug", "via_tent", "unknown")]
    if not holes:
        return None
    comps = layer.components(touch=TOUCH)
    # 7 500 holes on the first real 6-layer board: unioning every disc and differencing it per hole
    # was O(n²) (8 min per layer). Neighbouring holes come from a tree instead.
    hole_geoms = [h.geom() for h in holes]
    hole_tree = STRtree(hole_geoms)
    # each hole's own pad on this layer (the smallest flash holding its centre) and the net it sits on:
    # drill isolation is kept only to holes of *another* net. On the first real board 451 via pads in
    # same-net via fields at 1.0 mm pitch stayed 0.9 because the neighbouring holes "blocked" them —
    # the engineer's PadUp took them all to 1.158 (the pads simply merge).
    hole_pad: list[Feature | None] = []
    for hh in holes:
        cc = Point(hh.x, hh.y)
        ps = [f for f in layer.query(cc.buffer(hh.dia / 2)) if f.polarity_dark and f.kind == "pad" and f.symbol and f.symbol.kind != "user" and f.geom.contains(cc)]
        hole_pad.append(min(ps, key=lambda f: f.geom.area) if ps else None)
    hole_comp = [comps.get(pf.fid) if pf is not None else None for pf in hole_pad]
    comp_size: dict[int, int] = {}
    for cid in comps.values():
        comp_size[cid] = comp_size.get(cid, 0) + 1
    plane_comps = {comps[f.fid] for f in layer.surfaces() if f.polarity_dark and f.fid in comps}
    cs = layer.begin(call.op, {"ar_opt_mm": target, "via_ar_opt_mm": via_target, **({"via_isolated_ar_mm": via_isolated_target} if via_isolated_target else {}), "ring_base": "drill" if on_drill else "finished", "spacing_mm": spacing, "drill_isolation_mm": iso, "enlarge_limit_mm": limit, "passes": "0.1 → spacing (p124), one fixed point", "pages": "124/125/138"})
    grown = short = 0
    for hi, h in enumerate(holes):
        c = Point(h.x, h.y)
        pad = hole_pad[hi]
        if pad is None:
            continue
        d = h.drill_dia if on_drill and h.drill_dia > 0 else h.dia
        ring = pad.geom.exterior.distance(c) - d / 2
        mine = comps.get(pad.fid)
        want = {"via": via_open_target, "via_plug": via_target, "via_tent": via_target}.get(h.attribute, target)
        if via_isolated_target and h.attribute in ("via", "via_plug", "via_tent") and comp_size.get(mine, 0) == 1 and mine not in plane_comps:
            want = via_isolated_target
        need = 2 * (want - ring)
        if need <= TOL:
            continue
        room = limit
        for g in layer.query(pad.geom.buffer(target + spacing + 0.01)):
            if g.fid == pad.fid or not g.polarity_dark or g.geom.is_empty or comps.get(g.fid) == mine:
                continue
            # the copper that is really there: a plane erased around the pad by a later clear region
            # is not in the way (C09 l5: 21 island pads stayed 0.9 while every other layer got 1.16)
            gg = layer.painted_geom(g)
            if gg.is_empty:
                continue
            room = min(room, 2 * (pad.geom.distance(gg) - spacing))
        zone = pad.geom.buffer(target + iso + 0.01)
        near_holes = [hole_geoms[int(i)] for i in hole_tree.query(zone, predicate="intersects")
                      if holes[int(i)] is not h and (hole_comp[int(i)] is None or hole_comp[int(i)] != mine)]  # fmt: skip
        if near_holes:
            others = unary_union(near_holes)
            room = min(room, 2 * (pad.geom.distance(others) - iso))
        delta = min(need, room)
        if delta <= TOL:
            short += 1
            continue
        layer.set_symbol(pad, pad.symbol.resized(delta), f"PadUp {h.tool} ring {ring:.4f} → {ring + delta / 2:.4f} mm (p124)")
        grown += 1
    cs.params["pads_grown"] = grown
    if short:
        cs.params["ring_still_short"] = short  # spacing does not allow the target: stays a finding for SLC / a person
    layer.commit()
    return cs


# ---- B3.2 MaskOptimize ----------------------------------------------------------------------
@native_op(CamOp.MASK_OPTIMIZE)
def mask_optimize(n: NativeContext, call: OpCall) -> ChangeSet | None:
    from engine.checks.mask import bridge_min_for
    from engine.native.ops_basic import MASK_TYPES, _copper_of

    e = n.entry(call.layer)
    if not call.layer or e is None or e.get("type") not in MASK_TYPES:
        return None
    mcfg = n.cfg["mask"]
    cov = float(call.params.get("coverage_mm") or mcfg.get("coverage_mm", 2 * MIL))
    clr_min = float(call.params.get("clearance_min_mm") or mcfg.get("clearance_min_mm", 1 * MIL))
    spec = n.ctx.request.order_spec or {}
    bridge = float(call.params.get("bridge_mm") or bridge_min_for(spec.get("solder_mask_color"), mcfg["bridge_min_mm"]))
    layer = n.layer(call.layer)
    cu = _copper_of(n, e)
    cs = layer.begin(call.op, {"coverage_mm": cov, "clearance_min_mm": clr_min, "bridge_mm": bridge, "pages": "142/143"})
    shrunk = merged = kept = 0
    comps = cu.components(touch=TOUCH) if cu is not None else {}

    def pads_under(g) -> list[Feature]:
        return [p for p in cu.query(g) if p.polarity_dark and p.kind == "pad" and p.geom.intersects(g)] if cu is not None else []

    # 1. coverage (p143 #3): foreign copper closer than cov to an opening → shrink the opening
    if cu is not None:
        for op_ in list(layer.pads()):
            if not op_.polarity_dark or op_.geom.is_empty or op_.symbol is None or op_.symbol.kind == "user":
                continue
            own = pads_under(op_.geom)
            own_comps = {comps.get(p.fid) for p in own}
            foreign = [g for g in cu.query(op_.geom.buffer(cov)) if g.polarity_dark and not g.geom.is_empty and comps.get(g.fid) not in own_comps and g.geom.distance(op_.geom) < cov - TOL]
            if not foreign:
                continue
            d = min(g.geom.distance(op_.geom) for g in foreign)
            want = 2 * (cov - d)
            floor = 0.0
            if own:
                pw, ph = max(p.symbol.size_mm[0] for p in own if p.symbol), max(p.symbol.size_mm[1] for p in own if p.symbol)
                ow, oh = op_.symbol.size_mm
                floor = min(ow - (pw + 2 * clr_min), oh - (ph + 2 * clr_min))  # how much the opening may lose before clearance_min
            delta = min(want, max(floor, 0.0))
            if delta <= TOL:
                kept += 1
                continue
            layer.set_symbol(op_, op_.symbol.resized(-delta), f"coverage: opening −{delta:.4f} mm (foreign copper {d:.4f} < {cov:.4f}, p143)")
            shrunk += 1
    # 2. bridge / sliver (p141 要求5, p143 #6/#7): openings closer than the bridge rule
    feats = [f for f in layer.features if f.polarity_dark and not f.geom.is_empty]
    done: set[int] = set()
    for i, a in enumerate(feats):
        if a.fid in done:
            continue
        for b in layer.query(a.geom.buffer(bridge)):
            if b.fid == a.fid or b.fid in done or not b.polarity_dark or b.geom.is_empty:
                continue
            d = a.geom.distance(b.geom)
            if d < TOUCH or d >= bridge - TOL:
                continue
            na = {p.net for p in pads_under(a.geom) if p.net}
            nb = {p.net for p in pads_under(b.geom) if p.net}
            if not na or not nb or na != nb:
                kept += 1  # different / unknown nets: an IC bridge the customer must rule on (EQ stays)
                continue
            u = unary_union([a.geom, b.geom]).buffer(bridge / 2 + TOL).buffer(-(bridge / 2 + TOL))
            layer.delete(a, "merged opening (same net, bridge too thin, p141)")
            layer.delete(b, "merged opening (same net, bridge too thin, p141)")
            layer.add_surface(u, polarity_dark=True, note=f"merged openings, gap {d:.4f} < bridge {bridge:.4f} (p141 要求5)")
            done.update({a.fid, b.fid})
            merged += 1
            break
    cs.params.update({"openings_shrunk": shrunk, "openings_merged": merged, "left_for_review": kept})
    layer.commit()
    return cs


# ---- AlignToDrill (p111) --------------------------------------------------------------------
@native_op(CamOp.ALIGN_TO_DRILL)
def align_to_drill(n: NativeContext, call: OpCall) -> ChangeSet | None:
    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None:
        return None
    dx, dy = float(call.params.get("dx") or 0.0), float(call.params.get("dy") or 0.0)
    if abs(dx) < TOL and abs(dy) < TOL:
        return None
    if not call.params.get("clean_shift"):
        raise NeedsHuman(f"{rel} 相对钻孔层的偏移 ({dx:.3f}, {dy:.3f}) 不是整层平移（外框尺寸不同），请工程师核对后手工对齐 (p111)")
    layer = n.layer(rel)
    cs = layer.begin(call.op, {"dx": dx, "dy": dy, "page": 111})
    for f in list(layer.features):
        layer.move(f, dx, dy, "align to drill")
    layer.commit()
    return cs


# ---- AddHolesFromDrawing (p113) -------------------------------------------------------------
def _drill_entries(n: NativeContext) -> list[dict[str, Any]]:
    return [x for x in n.entries() if str(x.get("type", "")).startswith("drill")]


def _save_drill(n: NativeContext, rel: str, xf: ExcellonFile) -> None:
    out = n.ctx.edit_path(rel)
    out.parent.mkdir(parents=True, exist_ok=True)
    xf.save(out, settings=xf.import_settings)


@native_op(CamOp.ADD_HOLES_FROM_DRAWING)
def add_holes_from_drawing(n: NativeContext, call: OpCall) -> ChangeSet | None:
    drills = _drill_entries(n)
    if not drills:
        return None
    if call.kind == "outline_stray_segment":
        return _outline_slots_to_drill(n, call, drills)
    dia = float(call.params.get("dia_mm") or 0)
    if dia <= 0:
        return None
    want_slot = bool(call.params.get("slot"))
    plated = call.params.get("plated")
    tol = float(n.cfg["drill"].get("table_dia_tolerance_mm", 0.02))
    found: list[tuple[float, float]] = []
    src_layers = [x for x in n.entries() if x.get("type") in ("drawing", "outline")]
    for x in src_layers:
        try:
            lay = n.layer(x["file"])
        except Exception:  # noqa: BLE001, S112 — a drawing that does not parse is simply not a source
            continue
        for f in lay.pads():
            if not f.polarity_dark or f.symbol is None or f.symbol.kind != "r":
                continue
            if abs(f.symbol.params[0] - dia) <= tol:
                found.append(f.xy)
    if want_slot or not found:
        raise NeedsHuman(f"钻孔表有 ⌀{dia}{'槽' if want_slot else ''} 而 Excellon 没有，分孔图/外形层上也没找到同径圆 → 请客户确认以哪个为准 (p113)")
    target = next((x for x in drills if (x["type"] == "drill_npth") == (plated is False)), drills[0])
    xf = ExcellonFile.open(n.ctx.layer_path(target["file"]))
    have: set[tuple[float, float]] = set()  # a hole already in *any* drill file is not missing
    for d in drills:
        have |= {(round(float(o.x), 3), round(float(o.y), 3)) for o in ExcellonFile.open(n.ctx.layer_path(d["file"])).objects if isinstance(o, go.Flash)}
    known = {getattr(o.tool, "plated", None) for o in xf.objects if isinstance(o, go.Flash)}
    # gerbonara sorts tools by plating on write: follow the file's convention (None everywhere, or explicit)
    explicit = bool(plated) if plated is not None else target["type"] != "drill_npth"
    tool = ExcellonTool(diameter=dia, plated=(explicit if (known - {None}) else None), unit=MM)
    added = [(x, y) for x, y in found if (round(x, 3), round(y, 3)) not in have]
    if not added:
        return None
    for x, y in added:
        xf.objects.append(go.Flash(x, y, tool, unit=MM))
    _save_drill(n, target["file"], xf)
    return _manual_cs(call.op, target["file"], {"dia_mm": dia, "source": [x["file"] for x in src_layers], "page": 113}, [f"hole ⌀{dia} @ ({x:.3f}, {y:.3f}) from drawing" for x, y in added])


def _outline_slots_to_drill(n: NativeContext, call: OpCall, drills: list[dict[str, Any]]) -> ChangeSet | None:
    """Stray outline strokes wide enough to be a routed slot become G85 slots in the NPTH tape
    and leave the outline layer; thin strays (an unclosed 0.15 mm line) are a person's call."""
    rel = call.layer
    e = n.entry(rel)
    prof = n.profile
    if not rel or e is None or e.get("type") != "outline" or prof is None:
        return None
    min_slot = float(n.cfg["drill"].get("min_slot_width_mm", 0.5))
    layer = n.layer(rel)
    ring = prof.boundary.buffer(0.3)
    stray = [f for f in layer.lines() if f.polarity_dark and not f.geom.is_empty and not ring.contains(f.geom)]
    if not stray:
        return None
    thin = [f for f in stray if (f.width_mm or 0) < min_slot]
    if thin:
        raise NeedsHuman(f"外形层有 {len(thin)} 段线宽 < {min_slot} mm 的悬空线，不像槽：是多余线（删）还是槽（请给槽宽）？(p112/p113)")
    target = next((x for x in drills if x["type"] == "drill_npth"), drills[0])
    xf = ExcellonFile.open(n.ctx.layer_path(target["file"]))
    tools: dict[float, ExcellonTool] = {}
    cs = layer.begin(call.op, {"target": target["file"], "page": 113})
    notes = []
    for f in stray:
        if f.kind != "line":
            continue
        o = f.obj
        w = round(float(f.width_mm), 3)
        tool = tools.setdefault(w, ExcellonTool(diameter=w, plated=False, unit=MM))
        xf.objects.append(go.Line(float(o.x1), float(o.y1), float(o.x2), float(o.y2), tool, unit=MM))
        layer.delete(f, f"slot ⌀{w} moved to {target['file']} (p113)")
        notes.append(f"slot ⌀{w} {LineString([(o.x1, o.y1), (o.x2, o.y2)]).length:.2f} mm")
    layer.commit()
    if notes:
        _save_drill(n, target["file"], xf)
        cs.params["slots"] = notes
    return cs
