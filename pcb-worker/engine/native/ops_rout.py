"""B3.4 RoutDesign (第13章 p170–174) + the 第14章 rout layers, natively.

* the board outline → rout chains (bit from the profile, right compensation, start on the
  longest edge, interior cut-outs wider than the bit); on a working panel every unit is routed
  (the panel frame is not);
* half holes (p177) → GKO1: one chain per row of half holes along the board edge, bit 1.6 mm,
  centred on the edge (the edge line *is* the drill-centre line);
* edge-plating slots (p183) → GKO2: one chain per plated edge slot along its centre line,
  bit 1.6 / 2.0 mm, cut before plating.

The program is written as ``steps/<step>/rout.txt`` and published as a ``rout`` artifact under
the factory's file name (第11章 p158: same Excellon parameters as the drill tape).
"""

from __future__ import annotations

import json
from typing import Any

from shapely.geometry import LineString, Point
from shapely.geometry.base import BaseGeometry

from engine.adapters.base import CamOp
from engine.geom.features import ChangeSet
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, NeedsHuman, native_op
from engine.native.ops_copper import _holes
from engine.native.ops_panel import PANEL_STEP, _manual_cs, _meta, panel_dir
from engine.output.rout_writer import RoutChain, chain_length_mm, outline_chains, write_rout


def _edge_holes(n: NativeContext, prof: BaseGeometry):
    plated = [h for h in _holes(n) if h.attribute in ("plated", "via", "via_plug", "via_tent", "unknown")]
    half = [h for h in plated if not h.slot and h.geom().intersects(prof.boundary)]
    slots = [h for h in plated if h.slot and h.geom().intersects(prof.boundary)]
    return half, slots


def _half_hole_chains(half, prof: BaseGeometry, tool_mm: float) -> list[RoutChain]:
    """Group half holes by the straight edge they sit on; one chain per group from the first to
    the last hole centre, extended half a bit beyond each end so the slot clears the holes."""
    if not half:
        return []
    boundary = prof.boundary
    segs: list[LineString] = []
    for ring in ([prof.exterior] if prof.geom_type == "Polygon" else [g.exterior for g in prof.geoms]):
        pts = list(ring.coords)
        segs += [LineString([pts[i], pts[i + 1]]) for i in range(len(pts) - 1)]
    groups: dict[int, list] = {}
    for h in half:
        c = Point(h.x, h.y)
        k = min(range(len(segs)), key=lambda i: segs[i].distance(c))
        groups.setdefault(k, []).append(h)
    out = []
    for k, hs in groups.items():
        seg = segs[k]
        ts = sorted((seg.project(Point(h.x, h.y)), h) for h in hs)
        ext = max(h.dia for h in hs) / 2 + tool_mm / 2
        a = seg.interpolate(max(0.0, ts[0][0] - ext))
        b = seg.interpolate(min(seg.length, ts[-1][0] + ext))
        out.append(RoutChain(tool_mm, [(a.x, a.y), (b.x, b.y)], False, "none", f"half-hole GKO1 edge {k + 1} ({len(hs)} holes)"))
    _ = boundary
    return out


def _edge_slot_chains(slots, tool_mm: float) -> list[RoutChain]:
    out = []
    for i, h in enumerate(slots):
        if h.x2 is None:
            continue
        out.append(RoutChain(tool_mm, [(h.x, h.y), (h.x2, h.y2)], False, "none", f"edge-plating GKO2 slot {i + 1} {h.tool}"))
    return out


@native_op(CamOp.ROUT_DESIGN)
def rout_design(n: NativeContext, call: OpCall) -> ChangeSet | None:
    from engine.panel.plan import unit_placements
    from engine.stages.output import output_name

    prof = n.profile
    if prof is None:
        raise NeedsHuman("没有 Profile，无法出锣带（先跑 align）")
    rcfg = n.cfg.get("rout") or {}
    tool = float(call.params.get("tool_mm") or rcfg.get("tool_mm", 2.0))
    ecfg = n.cfg.get("edge_plating") or {}
    half, slots = _edge_holes(n, prof)
    unit_chains = outline_chains(prof, tool) + _half_hole_chains(half, prof, float(ecfg.get("half_hole_rout_tool_mm", 1.6))) + _edge_slot_chains(slots, float(ecfg.get("rout_tool_mm", 1.6)))
    if not unit_chains:
        raise NeedsHuman("Profile 出不了锣带路径（外形太小或不闭合）")
    meta = _meta(n)
    chains: list[RoutChain] = []
    step = "edit"
    if meta:  # working panel: every unit, at its placement (rotation via unit_placements' own math)
        step = PANEL_STEP
        from engine.panel.plan import Candidate

        c = Candidate(**{k: v for k, v in meta["candidate"].items()})
        placements = unit_placements(c, prof)
        x0, y0, _, _ = prof.bounds
        for k, poly in enumerate(placements):
            dx, dy = poly.bounds[0] - x0, poly.bounds[1] - y0
            if c.rotation % 360:  # unit_placements already rotated *and* placed the outline
                chains += [RoutChain(ch.tool_mm, ch.points, ch.closed, ch.comp, f"unit {k + 1} {ch.name}") for ch in outline_chains(poly, tool)]
            else:
                chains += [RoutChain(ch.tool_mm, [(x + dx, y + dy) for x, y in ch.points], ch.closed, ch.comp, f"unit {k + 1} {ch.name}") for ch in unit_chains]
    else:
        chains = unit_chains
    xcfg = n.cfg["excellon"]
    text = write_rout(chains, unit=xcfg["unit"], zeros=xcfg["zeros"], fmt=tuple(xcfg["format"]),
                      comments=[f"job={n.ctx.job_id} step={step}", f"bit={tool}mm comp=right start=longest edge (p173)", f"chains={len(chains)} length={sum(chain_length_mm(ch) for ch in chains):.1f}mm"])  # fmt: skip
    out_dir = panel_dir(n) if meta else (n.ctx.work_dir / "steps" / "edit")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "rout.txt").write_text(text, encoding="utf-8")
    (out_dir / "rout.json").write_text(json.dumps({"step": step, "tool_mm": tool, "chains": [{"name": ch.name, "tool_mm": ch.tool_mm, "comp": ch.comp, "closed": ch.closed, "points": len(ch.points), "length_mm": round(chain_length_mm(ch), 2)} for ch in chains]}, ensure_ascii=False, indent=1), encoding="utf-8")
    cfg = n.cfg["output"]
    spec = n.ctx.request.order_spec or {}
    stem = cfg["stem"].format(job=n.ctx.job_id, order=spec.get("order_no") or n.ctx.job_id)
    name = output_name(cfg, {"type": "rout"}, stem + ("_panel" if meta else ""))
    n.artifacts.append(("rout", name, text.encode("utf-8")))
    params: dict[str, Any] = {"step": step, "tool_mm": tool, "chains": len(chains), "half_hole_chains": len(_half_hole_chains(half, prof, 1.6)), "edge_slot_chains": len(slots), "pages": "170/174/177/183"}
    return _manual_cs(call.op, "rout", params, [f"{name}: {len(chains)} chains"] + [ch.name for ch in chains[:12]])
