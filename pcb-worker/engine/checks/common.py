"""Shared helpers for the M2 check modules: hole loading, profile, locations, aggregation."""

from __future__ import annotations

import json
from typing import Any

from shapely import from_wkb
from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry

from engine.ingest.classify import DRILL_TYPES
from engine.model.report import Fix, Location, ReportItem
from engine.pipeline.context import JobContext
from engine.stages.drill import Hole, apply_factory_rules, assign_attributes, parse_drill_layer

MIL = 0.0254
ITEM_CAP = 50
#: Gerber coordinates are quantised (1 µm typical) and mil/mm thresholds round differently
#: (4 mil = 0.1016 mm vs a 0.1 mm design rule, 8 mil = 0.2032 vs 0.2); anything within TOL of
#: the threshold passes.
TOL = 0.005
#: Folded polygons are arc approximations (geom.from_gerbonara DEFAULT_MAX_ERROR_MM); two
#: polygons closer than this are treated as connected, not as a spacing violation.
TOUCH = 0.02


def mm_to_mil(v: float) -> float:
    return v / MIL


def fmt_mm(v: float) -> str:
    return f"{v:.3f} mm ({mm_to_mil(v):.1f} mil)"


def below(measured: float, threshold: float, tol: float = TOL) -> bool:
    return measured < threshold - tol


def load_rows(ctx: JobContext, lm: dict[str, Any]) -> list:
    """Every drill layer's tool rows with attributes and factory rules applied (the drill stage's
    own code path) — rows keep the routed rectangles and the order's per-tool marks."""
    cfg = ctx.profile["drill"]
    rows = []
    for e in lm.get("files", []):
        if e.get("type") not in DRILL_TYPES:
            continue
        try:
            rows.extend(parse_drill_layer(ctx, e))
        except Exception:  # noqa: BLE001  (drill stage already reported the parse error)
            continue
    assign_attributes(rows, cfg, ctx.request.order_spec)
    apply_factory_rules(ctx, lm, rows, cfg, ctx.request.order_spec)  # 塞孔分组 / 订单指定 / 二钻 / 矩形改锣 / 定位孔
    return rows


def load_holes(ctx: JobContext, lm: dict[str, Any]) -> list[Hole]:
    """All holes of every drill layer with plated/npth/via attributes assigned (same code path as
    the drill stage, so inner/outer/mask see exactly what drill reported)."""
    holes = [h for r in load_rows(ctx, lm) for h in r.holes if not r.rect]
    meta = ctx.work_dir / "profile.json"
    if meta.is_file():  # edge notches (open arcs on the outline layer) are routed, not drilled — but the mask opens and copper clears like an NPTH
        try:
            meta_d = json.loads(meta.read_text("utf-8"))
        except (OSError, ValueError):
            meta_d = {}
        file = meta_d.get("file") or ""
        holes += [Hole(x, y, d, False, file, tool="notch", attribute="non_plated", drill_dia=d) for x, y, d in meta_d.get("edge_notches") or []]
        # the outline's own rout paths: their ⌀0.8 end / corner pre-drills and the straight slots themselves
        # count as NPTH for the mask and the copper — the factory opens the mask over a routed slot and its
        # corner holes and keeps copper clear of them (C12 golden gts: the 16 corner windows, the slot windows)
        try:
            from engine.stages.drill import profile_rout_predrill_tools

            for t in profile_rout_predrill_tools(ctx, ctx.profile.get("drill") or {}, (0.0, 0.0)):
                holes += [Hole(x, y, t.diameter_mm, False, file, tool="PREDRILL", attribute="non_plated", drill_dia=t.diameter_mm) for x, y in t.holes]
        except Exception:  # noqa: BLE001 — a profile without rout paths, or a drill config without the pre-drill rules
            pass
        for pts, w in meta_d.get("drawn_slots") or []:
            if len(pts) == 2 and float(w) > 0:
                (x1, y1), (x2, y2) = pts
                holes.append(Hole(float(x1), float(y1), float(w), False, file, slot=True, x2=float(x2), y2=float(y2), tool="SLOT", attribute="non_plated", drill_dia=float(w)))
    return holes


def load_profile(ctx: JobContext) -> BaseGeometry | None:
    p = ctx.work_dir / "profile.wkb"
    return from_wkb(p.read_bytes()) if p.is_file() else None


def loc_of(geom: BaseGeometry | Point, pad_mm: float = 0.0) -> Location:
    c = geom.centroid if not isinstance(geom, Point) else geom
    x0, y0, x1, y1 = geom.bounds
    return Location(
        x=round(c.x, 4), y=round(c.y, 4),
        bbox=(round(x0 - pad_mm, 4), round(y0 - pad_mm, 4), round(x1 + pad_mm, 4), round(y1 + pad_mm, 4)),
    )  # fmt: skip


def aggregate(
    items: list[ReportItem],
    details: list[ReportItem],
    *,
    kind: str,
    layer: str,
    message: str,
    severity: str = "error",
    eq_question: str | None = None,
    fix: Fix | None = None,
    threshold: float | str | None = None,
    unit: str = "mm",
) -> int:
    """One *decision* per (layer, kind); the individual hits are located ``warn`` rows.

    Node turns every ``error`` without an applied fix into an EQ, so a board with 500
    4-mil rings must not produce 500 EQs: the details are demoted to ``warn`` (they keep
    their location for the viewer overlay) and a single summary row carries the severity,
    the count, the worst value and the question. Returns the true hit count.

    ``unit`` says how ``measured`` reads: ``"mm"`` (default, a length), ``"mm2"`` (an area) or
    a bare suffix such as ``":1"`` for a ratio — a ratio printed through ``fmt_mm`` would come
    out as "5.380 mm (211.8 mil)".
    """
    if not details:
        return 0
    worst = None
    for d in details:
        if isinstance(d.measured, (int, float)):
            worst = d.measured if worst is None else min(worst, d.measured)
    for d in details[:ITEM_CAP]:
        if d.severity == "error":
            d.severity = "warn"
        d.eq_question = None
        items.append(d)
    n = len(details)
    extra = f"，仅列出前 {ITEM_CAP} 处" if n > ITEM_CAP else ""
    if isinstance(worst, (int, float)) and threshold is not None:
        if unit == "mm":
            worst_s = f"，最小 {fmt_mm(worst)}"
        elif unit == "mm2":
            worst_s = f"，最小 {worst:.2f} mm²"
        else:
            worst_s = f"，最小 {worst:g}{unit}"
    else:
        worst_s = ""
    items.append(
        ReportItem(
            id=f"{kind}_{layer}_summary", kind=kind, severity=severity, layer=layer,  # type: ignore[arg-type]
            measured=n, threshold=threshold, message=f"{message}：共 {n} 处{worst_s}{extra}",
            eq_question=eq_question, fix=fix or details[0].fix,
        )
    )  # fmt: skip
    return n


def draft_fix(op: str, fix_type: str, script: str, params: dict[str, Any] | None = None) -> Fix:
    """A Genesis-only fix: never auto-applied by the lite engine."""
    return Fix(type=fix_type, op=op, params=params or {}, auto_fixable=False, applied=False, genesis_script=script)
