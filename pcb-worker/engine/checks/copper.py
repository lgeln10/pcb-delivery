"""Copper-layer DFM checks (第6章 内层 p119–129, 第7章 外层 p135–139).

Inner and outer layers share the geometry checks; the thresholds and a few rules differ:

* line width / spacing            (p122 线距≥4mil; p135 间距是否做够)
* annular ring of plated holes    (p135 VIA/PTH 的 RING 环; inner pos 无数值 → profile)
* hole-to-copper clearance        (p122 孔到线 8mil / 钻孔隔离 10mil)
* NPTH copper clearance / NPTH sitting in a pad (p122 NPTH 单边≥12mil; p135 非金属孔是否需要削铜)
* copper-to-profile               (p122 削外围 单边15mil; p135 孔距外形是否足够)
* isolated pads  — inner positive only (p122 检查独立PAD是否完全删除) → NfpRemoval
* SMD candidates — outer only          (p137 Set SMD Attribute)            → SetSmdAttribute
* line compensation candidates         (p122/p138 <15mil 加大 1mil)         → LineCompensation
* negative film: isolation ring / partition line width / border trim (p119–121)

Everything is *report only* (lite engine). One decision (EQ) per layer and kind — the
individual hits are located ``warn`` rows (see ``common.aggregate``). Every fix carries
``Fix.op`` so the UI and the script translator know which Genesis operation applies.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely import shortest_line
from shapely.geometry import Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from engine.checks.common import (
    ITEM_CAP,
    TOUCH,
    aggregate,
    below,
    draft_fix,
    fmt_mm,
    load_holes,
    load_profile,
    loc_of,
)
from engine.geom.from_gerbonara import primitive_to_polygon
from engine.geom.layers import fold_many, open_camfile
from engine.geom.svg import iter_polygons
from engine.model.report import ReportItem, StageReport, derive_status, summarize
from engine.pipeline.context import JobContext
from engine.stages.drill import Hole

INNER_TYPES = ("inner_copper",)
OUTER_TYPES = ("top_copper", "bottom_copper")
_MIL = 0.0254


@dataclass
class CopperLayer:
    rel: str
    layer_type: str
    polarity: str  # positive | negative
    geom: BaseGeometry
    objects: list[Any]
    index: int | None = None
    polys: list[Polygon] = field(default_factory=list)
    tree: STRtree | None = None

    def __post_init__(self) -> None:
        self.polys = list(iter_polygons(self.geom))
        self.tree = STRtree(self.polys) if self.polys else None

    @property
    def is_inner(self) -> bool:
        return self.layer_type in INNER_TYPES

    @property
    def name(self) -> str:
        return f"{self.rel}{f' (L{self.index})' if self.index else ''}"


# ---------------------------------------------------------------------------------------------
# object helpers
# ---------------------------------------------------------------------------------------------
def _aper_function(ap) -> str:
    for name, vals in getattr(ap, "attrs", ()) or ():
        if name == ".AperFunction":
            return ",".join(vals)
    return ""


def _bbox(o) -> tuple[float, float, float, float] | None:
    try:
        (x0, y0), (x1, y1) = o.bounding_box(unit=MM)
    except Exception:  # noqa: BLE001
        return None
    return (x0, y0, x1, y1)


def _width(o) -> float | None:
    ap = getattr(o, "aperture", None)
    if ap is None:
        return None
    try:
        return float(ap.equivalent_width(unit=MM))
    except Exception:  # noqa: BLE001
        return None


def _flash_polygon(o: go.Flash) -> Polygon | None:
    parts = [p for prim in o.to_primitives(unit=MM) if (p := primitive_to_polygon(prim)) is not None]
    if not parts:
        return None
    u = unary_union(parts)
    return u if isinstance(u, Polygon) else max(iter_polygons(u), key=lambda p: p.area, default=None)


def _containing(layer: CopperLayer, pt: Point) -> Polygon | None:
    if layer.tree is None:
        return None
    for i in layer.tree.query(pt, predicate="within"):
        return layer.polys[int(i)]
    return None


def _item(layer: CopperLayer, kind: str, n: int, geom, pad: float, measured, threshold, message: str, fix) -> ReportItem:
    return ReportItem(
        id=f"{kind}_{layer.rel}_{n}", kind=kind, severity="error", layer=layer.rel,
        location=loc_of(geom, pad), measured=measured, threshold=threshold, message=message, fix=fix,
    )  # fmt: skip


# ---------------------------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------------------------
def check_line_width(layer: CopperLayer, min_w: float, items: list[ReportItem], *, kind: str = "line_width") -> int:
    new: list[ReportItem] = []
    for o in layer.objects:
        if not isinstance(o, (go.Line, go.Arc)) or not o.polarity_dark:
            continue
        w = _width(o)
        if w is None or not below(w, min_w):
            continue
        fn = _aper_function(o.aperture)
        if "Profile" in fn or "NonConductor" in fn:
            continue
        bb = _bbox(o)
        if bb is None:
            continue
        new.append(_item(layer, kind, len(new), Polygon.from_bounds(*bb), 0.2, round(w, 4), min_w,
                         f"{layer.name} 线宽 {fmt_mm(w)} < {fmt_mm(min_w)}", None))  # fmt: skip
    return aggregate(
        items, new, kind=kind, layer=layer.rel, threshold=min_w,
        message=f"{layer.name} 线宽 < {fmt_mm(min_w)}",
        eq_question=f"{layer.name} 有线路线宽低于工厂最小线宽 {fmt_mm(min_w)}，请客户确认可否加大或按现状生产",
        fix=draft_fix("LineCompensation", "resize_line", f"# {layer.rel}: 选中线宽<{min_w:.3f}mm 的线后整体加大\nCOM sel_resize,size=<mil>  # 在原来基础上加大 (p124/p138)  【待验证】"),
    )  # fmt: skip


def check_spacing(layer: CopperLayer, min_s: float, items: list[ReportItem], *, kind: str = "spacing") -> int:
    if layer.tree is None or len(layer.polys) < 2:
        return 0
    pairs = layer.tree.query(layer.polys, predicate="dwithin", distance=min_s)
    seen: set[tuple[int, int]] = set()
    new: list[ReportItem] = []
    for a, b in zip(pairs[0].tolist(), pairs[1].tolist()):
        if a >= b or (a, b) in seen:
            continue
        seen.add((a, b))
        seg = shortest_line(layer.polys[a], layer.polys[b])
        d = seg.length
        if d < TOUCH or not below(d, min_s):
            continue  # touching / arc-approximation gaps are one net, not a spacing violation
        new.append(_item(layer, kind, len(new), seg, 0.2, round(d, 4), min_s,
                         f"{layer.name} 铜间距 {fmt_mm(d)} < {fmt_mm(min_s)}", None))  # fmt: skip
    return aggregate(
        items, new, kind=kind, layer=layer.rel, threshold=min_s,
        message=f"{layer.name} 铜间距 < {fmt_mm(min_s)}",
        eq_question=f"{layer.name} 有铜间距低于工厂最小间距 {fmt_mm(min_s)}，请客户确认",
        fix=draft_fix("SignalLayerChecks", "spacing", "# 间距不足只能改设计或在 Genesis 手工移线；SLC 报告项 Spacing (p128)"),
    )  # fmt: skip


def check_holes_positive(layer: CopperLayer, holes: list[Hole], thr: dict[str, float], items: list[ReportItem]) -> dict[str, int]:
    """Annular ring / hole-to-copper / NPTH clearance / NPTH-in-pad on a positive copper layer."""
    ring_new: list[ReportItem] = []
    clr_new: list[ReportItem] = []
    npth_new: list[ReportItem] = []
    inpad_new: list[ReportItem] = []
    iso_new: list[ReportItem] = []
    keys = ("annular_ring", "hole_to_copper", "npth_clearance", "npth_in_pad", "drill_isolation")
    if layer.tree is None:
        return dict.fromkeys(keys, 0)
    min_ring = thr["min_annular_ring_mm"]
    min_clr = thr["hole_clearance_mm"]
    min_npth = thr["npth_clearance_mm"]
    min_drill_iso = thr.get("drill_isolation_mm")
    for h in holes:
        disc = h.geom()
        c = h.center()
        r = h.dia / 2
        near = [int(i) for i in layer.tree.query(disc, predicate="dwithin", distance=max(min_clr, min_npth, min_drill_iso or 0))]
        if h.attribute == "non_plated":
            owner = _containing(layer, c)
            if owner is not None:
                inpad_new.append(_item(layer, "npth_in_pad", len(inpad_new), disc, 0.3, 0.0, min_npth,
                                       f"{layer.name} NPTH {h.tool} ⌀{h.dia} 落在铜/焊盘内", None))  # fmt: skip
                continue
            best = min((layer.polys[i].distance(disc) for i in near), default=None)
            if best is not None and below(best, min_npth):
                npth_new.append(_item(layer, "npth_clearance", len(npth_new), disc, min_npth, round(best, 4), min_npth,
                                      f"{layer.name} NPTH {h.tool} ⌀{h.dia} 到铜 {fmt_mm(best)} < {fmt_mm(min_npth)}", None))  # fmt: skip
            continue
        owner = _containing(layer, c)
        if owner is not None:
            ring = owner.boundary.distance(c) - r
            if below(ring, min_ring):
                ring_new.append(_item(layer, "annular_ring", len(ring_new), disc, max(min_ring, 0.2), round(max(ring, 0.0), 4), min_ring,
                                      f"{layer.name} {h.attribute} {h.tool} ⌀{h.dia} 环宽 {fmt_mm(max(ring, 0))} < {fmt_mm(min_ring)}", None))  # fmt: skip
            others = [i for i in near if layer.polys[i] is not owner]
        else:
            others = near
        best = min((layer.polys[i].distance(disc) for i in others), default=None)
        if best is not None and below(best, min_clr):
            clr_new.append(_item(layer, "hole_to_copper", len(clr_new), disc, min_clr, round(best, 4), min_clr,
                                 f"{layer.name} 孔 {h.tool} ⌀{h.dia} 到其他铜 {fmt_mm(best)} < {fmt_mm(min_clr)}", None))  # fmt: skip
        elif best is not None and min_drill_iso is not None and below(best, min_drill_iso):
            # p122 钻孔隔离 10mil / p124 SLO "Drill to Cu 10": above the hard 8 mil but below the
            # optimisation target → info only, the optimiser will shave/move it
            it = _item(layer, "drill_isolation", len(iso_new), disc, min_drill_iso, round(best, 4), min_drill_iso,
                       f"{layer.name} 孔 {h.tool} ⌀{h.dia} 到其他铜 {fmt_mm(best)} < 钻孔隔离 {fmt_mm(min_drill_iso)}（优化处理）", None)  # fmt: skip
            it.severity = "info"
            iso_new.append(it)
    return {
        "drill_isolation": aggregate(
            items, iso_new, kind="drill_isolation", layer=layer.rel, threshold=min_drill_iso, severity="info",
            message=f"{layer.name} 孔到铜在 {fmt_mm(min_clr)}–{fmt_mm(min_drill_iso or min_clr)} 之间，SLO Drill to Cu 优化可处理",
            fix=draft_fix("SignalLayerOptimize", "drill_to_cu", f"# SLO Drill to Cu {((min_drill_iso or min_clr) / _MIL):.0f}，Modification PadUp+Shave (p124)"),
        ) if min_drill_iso is not None else 0,
        "annular_ring": aggregate(
            items, ring_new, kind="annular_ring", layer=layer.rel, threshold=min_ring,
            message=f"{layer.name} 环宽 < {fmt_mm(min_ring)}",
            eq_question=f"{layer.name} 有焊盘环宽低于 {fmt_mm(min_ring)}，请客户确认可否加大焊盘（优化）或按现状生产",
            fix=draft_fix("SignalLayerOptimize", "enlarge_pad", "# 优化加大 PAD：DFM → Optimization → Signal Layer Optimization (p124/p138)"),
        ),
        "hole_to_copper": aggregate(
            items, clr_new, kind="hole_to_copper", layer=layer.rel, threshold=min_clr,
            message=f"{layer.name} 孔到铜 < {fmt_mm(min_clr)}",
            eq_question=f"{layer.name} 有孔到其他铜距离低于 {fmt_mm(min_clr)}，请客户确认可否移线/缩 PAD",
            fix=draft_fix("SignalLayerChecks", "hole_clearance", "# SLC 报告项 Drill to Copper；需移线或缩 PAD (p128)"),
        ),
        "npth_clearance": aggregate(
            items, npth_new, kind="npth_clearance", layer=layer.rel, threshold=min_npth,
            message=f"{layer.name} NPTH 削铜 < {fmt_mm(min_npth)}",
            eq_question=f"{layer.name} 有非金属孔到铜距离不足 {fmt_mm(min_npth)}，请客户确认是否允许削铜",
            fix=draft_fix("NpthClearance", "npth_clearance", f"# NPTH 用正的加大后复制到 {layer.rel} 削铜 (p121/p127)\nCOM sel_copy_other,dest=layer_name,target_layer={layer.rel},invert=no,size={min_npth * 2 / _MIL:.1f}  【待验证】"),
        ),
        "npth_in_pad": aggregate(
            items, inpad_new, kind="npth_in_pad", layer=layer.rel, threshold=min_npth, severity="info",
            message=f"{layer.name} 非金属孔落在焊盘内 → 按 NPTH 削铜（工厂标准 copper.npth_in_pad: clear）",
            fix=draft_fix("NpthClearance", "npth_in_pad_clear", f"# NPTH 落在焊盘内：按非金属孔处理，用孔径+{2 * min_npth / _MIL:.0f}mil 的正片复制到 {layer.rel} 削掉焊盘 (p121/p127)\nCOM sel_copy_other,dest=layer_name,target_layer={layer.rel},invert=no,size={min_npth * 2 / _MIL:.1f}  【待验证】", {"clearance_mm": min_npth}),
        ) if thr.get("npth_in_pad_policy") == "clear" else aggregate(
            items, inpad_new, kind="npth_in_pad", layer=layer.rel, threshold=min_npth, severity="error",
            message=f"{layer.name} 非金属孔落在焊盘内",
            eq_question=f"{layer.name} 有标为非金属化的孔落在焊盘/铜皮内，请客户确认这些孔是否应为金属化孔（PTH）",
            fix=draft_fix("SetDrillAttrs", "set_plated", "# 若客户确认为 PTH：钻孔层 Edit → Attributes → change → .drill = plated (p114)"),
        ),
    }  # fmt: skip


def _clearance_arcs(layer: CopperLayer, c: Point, r: float, reach: float) -> list[tuple[Polygon, float, float]]:
    """Dark (clearance) pieces around a hole centre on a negative film that do *not* contain it:
    the arcs of a thermal pad (ring cut by spokes, p119) or a full isolation annulus.
    Returns ``(piece, inner_radius, outer_radius)`` measured from the hole centre."""
    if layer.tree is None:
        return []
    out: list[tuple[Polygon, float, float]] = []
    for i in layer.tree.query(c.buffer(reach), predicate="intersects"):
        p = layer.polys[int(i)]
        if p.contains(c):
            continue
        d0 = p.distance(c)
        if d0 < r * 0.5 or d0 > reach:
            continue
        d1 = max(Point(x, y).distance(c) for x, y in p.exterior.coords)
        out.append((p, d0, d1))
    return out


def check_holes_negative(layer: CopperLayer, holes: list[Hole], thr: dict[str, float], items: list[ReportItem]) -> dict[str, int]:
    """On a negative film dark = clearance. Every hole needs an isolation pad or a thermal pad.

    * isolation pad (p120): dark disc around the hole, ring = disc radius − hole radius ≥ 10 mil;
      a dark annulus with copper inside counts too (ring = annulus width)
    * thermal pad (p119): dark ring cut by spokes → ≥ 2 arcs around the hole. Checked:
      hole edge → inner circle ≥ 8 mil, inner → outer circle ≥ 8 mil, opening length ≥ 8 mil,
      at least two openings (``thermal_min_openings``)
    """
    iso_new: list[ReportItem] = []
    none_new: list[ReportItem] = []
    ring_new: list[ReportItem] = []
    open_new: list[ReportItem] = []
    min_iso = thr["isolation_ring_mm"]
    min_th = thr.get("thermal_ring_mm", 0.2032)
    min_open = thr.get("thermal_opening_mm", 0.2032)
    min_n = int(thr.get("thermal_min_openings", 2))
    for h in holes:
        disc = h.geom()
        c = h.center()
        r = h.dia / 2
        min_req = thr["npth_clearance_mm"] if h.attribute == "non_plated" else min_iso
        owner = _containing(layer, c)
        if owner is not None:
            iso = owner.boundary.distance(c) - r
            if below(iso, min_req):
                iso_new.append(_item(layer, "isolation_ring", len(iso_new), disc, max(min_req, 0.2), round(max(iso, 0.0), 4), min_req,
                                     f"{layer.name}（负片）孔 {h.tool} ⌀{h.dia} 隔离环 {fmt_mm(max(iso, 0))} < {fmt_mm(min_req)}", None))  # fmt: skip
            continue
        arcs = _clearance_arcs(layer, c, r, r + max(3.0, 6 * min_th))
        if arcs:
            d0 = min(a[1] for a in arcs)
            d1 = max(a[2] for a in arcs)
            ann_area = math.pi * (d1 * d1 - d0 * d0)
            covered = sum(a[0].area for a in arcs) / ann_area if ann_area > 0 else 0.0
        else:
            covered = 0.0
        if not arcs or covered < 0.5:
            none_new.append(_item(layer, "negative_no_clearance", len(none_new), disc, 0.5, 0, min_req,
                                  f"{layer.name}（负片）孔 {h.tool} ⌀{h.dia} 无隔离/散热 PAD，直接连铜面", None))  # fmt: skip
            continue
        if len(arcs) == 1:
            # full annulus with a copper land inside: an isolation pad whose ring is the annulus width
            ring = d1 - d0
            if below(ring, min_req):
                iso_new.append(_item(layer, "isolation_ring", len(iso_new), disc, max(min_req, 0.2), round(ring, 4), min_req,
                                     f"{layer.name}（负片）孔 {h.tool} ⌀{h.dia} 隔离环（环形）{fmt_mm(ring)} < {fmt_mm(min_req)}", None))  # fmt: skip
            continue
        # thermal pad: arcs = ring pieces between spokes
        hole_to_inner = d0 - r
        inner_to_outer = min(a[2] - a[1] for a in arcs)
        n_open = len(arcs)
        gap_area = max(ann_area * (1.0 - covered), 0.0)
        opening = gap_area / n_open / max(inner_to_outer, 1e-6)
        worst = min(hole_to_inner, inner_to_outer)
        if below(worst, min_th):
            ring_new.append(_item(layer, "thermal_ring", len(ring_new), disc, max(d1, 0.5), round(max(worst, 0.0), 4), min_th,
                                  f"{layer.name}（负片）孔 {h.tool} ⌀{h.dia} 散热 PAD 孔到内环 {fmt_mm(max(hole_to_inner, 0))} / 内环到外环 {fmt_mm(inner_to_outer)}，要求 ≥ {fmt_mm(min_th)}", None))  # fmt: skip
        if n_open < min_n or below(opening, min_open):
            open_new.append(_item(layer, "thermal_opening", len(open_new), disc, max(d1, 0.5), round(opening, 4), min_open,
                                  f"{layer.name}（负片）孔 {h.tool} ⌀{h.dia} 散热 PAD {n_open} 个开口，开口长 {fmt_mm(opening)}，要求 ≥{min_n} 个且 ≥ {fmt_mm(min_open)}", None))  # fmt: skip
    return {
        "isolation_ring": aggregate(
            items, iso_new, kind="isolation_ring", layer=layer.rel, threshold=min_iso,
            message=f"{layer.name}（负片）隔离环 < {fmt_mm(min_iso)}",
            eq_question=f"{layer.name} 为负片，有隔离环低于 {fmt_mm(min_iso)}，请确认可否加大隔离 PAD",
            fix=draft_fix("NegativePadReshape", "reshape_isolation_pad", f"# 负片 {layer.rel}: Features Histogram → Pad List 逐类 Change Symbol 到 r<孔径+2×{min_iso:.3f}mm> (p120)\nCOM sel_change_sym,symbol=r<mil>  【待验证】"),
        ),
        "negative_no_clearance": aggregate(
            items, none_new, kind="negative_no_clearance", layer=layer.rel, threshold=min_iso, severity="warn",
            message=f"{layer.name}（负片）孔无隔离 PAD",
            eq_question=f"{layer.name} 为负片，有孔位没有隔离/散热 PAD，会直接连到铜面，请客户确认设计意图",
            fix=draft_fix("NegativePadReshape", "add_isolation_pad", f"# 负片 {layer.rel}: 在孔位加隔离 PAD r<孔径+2×{min_iso:.3f}mm> (p120)\nCOM add_pad,x=<x>,y=<y>,symbol=r<mil>,polarity=positive  【待验证】"),
        ),
        "thermal_ring": aggregate(
            items, ring_new, kind="thermal_ring", layer=layer.rel, threshold=min_th,
            message=f"{layer.name}（负片）散热 PAD 环宽 < {fmt_mm(min_th)}",
            eq_question=f"{layer.name} 为负片，有散热 PAD 的孔到内环/内环到外环低于 {fmt_mm(min_th)}，请确认可否按 ths/thr 标准改大（p119）",
            fix=draft_fix("NegativePadReshape", "reshape_thermal", f"# 负片 {layer.rel}: Pad List 中 ths/thr 逐类 Change Symbol，修正内径外径 (p119–120)\nCOM sel_change_sym,symbol=thr<外径>x<内径>x<角度>x<开口数>x<开口长>  【待验证】"),
        ),
        "thermal_opening": aggregate(
            items, open_new, kind="thermal_opening", layer=layer.rel, threshold=min_open,
            message=f"{layer.name}（负片）散热 PAD 开口不足",
            eq_question=f"{layer.name} 为负片，有散热 PAD 开口少于 {min_n} 个或开口长低于 {fmt_mm(min_open)}，请确认可否改为标准散热 PAD（p119）",
            fix=draft_fix("NegativePadReshape", "reshape_thermal", f"# 负片 {layer.rel}: Change Symbol 到 thr…x{min_n}x{min_open / _MIL:.0f} (p119–120)\nCOM sel_change_sym,symbol=thr<外径>x<内径>x<角度>x{min_n}x<开口长>  【待验证】"),
        ),
    }  # fmt: skip


def check_edge(layer: CopperLayer, profile: BaseGeometry | None, min_d: float, items: list[ReportItem]) -> int:
    if profile is None:
        return 0
    boundary = profile.boundary
    new: list[ReportItem] = []
    if layer.polarity == "negative":
        band = boundary.buffer(min_d).intersection(profile)
        uncovered = band.difference(layer.geom)
        for p in iter_polygons(uncovered):
            if p.area < 0.01:
                continue
            new.append(_item(layer, "copper_to_edge", len(new), p, 0.2, round(p.area, 3), min_d,
                             f"{layer.name}（负片）板边 {fmt_mm(min_d)} 内未削外围", None))  # fmt: skip
        return aggregate(
            items, new, kind="copper_to_edge", layer=layer.rel, threshold=min_d, severity="warn",
            message=f"{layer.name}（负片）未削外围",
            fix=draft_fix("BorderClearance", "border_trim", f"# 负片削外围：外围线 Change Symbol r{2 * min_d / _MIL:.0f} → Copy Other Layer invert=no 到 {layer.rel} (p121)\nCOM sel_change_sym,symbol=r{2 * min_d / _MIL:.0f}\nCOM sel_copy_other,dest=layer_name,target_layer={layer.rel},invert=no  【待验证】"),
        )  # fmt: skip
    if layer.tree is None:
        return 0
    for i in layer.tree.query(boundary, predicate="dwithin", distance=min_d):
        p = layer.polys[int(i)]
        d = p.distance(boundary)
        if not below(d, min_d) or not p.intersects(profile):
            continue
        seg = shortest_line(p, boundary)
        new.append(_item(layer, "copper_to_edge", len(new), seg, 0.3, round(d, 4), min_d,
                         f"{layer.name} 铜到板边 {fmt_mm(d)} < {fmt_mm(min_d)}", None))  # fmt: skip
    return aggregate(
        items, new, kind="copper_to_edge", layer=layer.rel, threshold=min_d, severity="warn",
        message=f"{layer.name} 铜到板边 < {fmt_mm(min_d)}",
        eq_question=f"{layer.name} 有铜距板边不足 {fmt_mm(min_d)}（金手指/接地边除外），削外围会削到，请客户确认",
        fix=draft_fix("BorderClearance", "border_trim", f"# 削外围：外围线 Change Symbol r{2 * min_d / _MIL:.0f} → Copy Other Layer invert=yes 到 {layer.rel} (p128)\nCOM sel_change_sym,symbol=r{2 * min_d / _MIL:.0f}\nCOM sel_copy_other,dest=layer_name,target_layer={layer.rel},invert=yes  【待验证】"),
    )  # fmt: skip


def _flashes(layer: CopperLayer) -> list[tuple[go.Flash, Polygon, str]]:
    out = []
    for o in layer.objects:
        if not isinstance(o, go.Flash) or not o.polarity_dark:
            continue
        poly = _flash_polygon(o)
        if poly is None or poly.is_empty:
            continue
        out.append((o, poly, _aper_function(o.aperture)))
    return out


def _hole_tree(holes: list[Hole]) -> STRtree | None:
    return STRtree([h.center() for h in holes]) if holes else None


def check_isolated_pads(layer: CopperLayer, holes: list[Hole], items: list[ReportItem]) -> int:
    """Inner positive: a flash that is its own folded polygon (nothing attached) and has no hole."""
    if layer.tree is None:
        return 0
    htree = _hole_tree(holes)
    new: list[ReportItem] = []
    for o, poly, fn in _flashes(layer):
        if "Fiducial" in fn or "Test" in fn:
            continue
        owner = _containing(layer, poly.centroid)
        if owner is None or owner.area > poly.area * 1.05:
            continue  # attached to a trace / plane
        if htree is not None and len(htree.query(poly, predicate="intersects")):
            continue  # has a hole: normal through-hole pad
        new.append(_item(layer, "isolated_pad", len(new), poly, 0.2, round(poly.area, 3), None,
                         f"{layer.name} 独立 PAD（无孔、无连线）{type(o.aperture).__name__}", None))  # fmt: skip
    return aggregate(
        items, new, kind="isolated_pad", layer=layer.rel, severity="warn",
        message=f"{layer.name} 独立 PAD（内层正片应删除，p122）",
        fix=draft_fix("NfpRemoval", "delete_nfp", f"# {layer.rel} 内层正片独立 PAD：DFM → Redundancy Cleanup → NFP Removal (p123/p134)\nCOM chklist_single,action=nfp_removal,layer={layer.rel}  【待验证】"),
    )  # fmt: skip


def report_smd_candidates(layer: CopperLayer, holes: list[Hole], items: list[ReportItem]) -> dict[str, int]:
    """Outer: flashes without a hole are SMD pads (p137). Round ones need the manual path."""
    htree = _hole_tree(holes)
    n_smd = n_round = n_explicit = 0
    for o, poly, fn in _flashes(layer):
        if htree is not None and len(htree.query(poly, predicate="intersects")):
            continue
        if "Fiducial" in fn or "Test" in fn:
            continue
        n_smd += 1
        if "SMD" in fn:
            n_explicit += 1
        if type(o.aperture).__name__ == "CircleAperture":
            n_round += 1
    if n_smd:
        items.append(
            ReportItem(
                id=f"smd_{layer.rel}", kind="smd_pads", severity="info", layer=layer.rel, measured=n_smd,
                message=f"{layer.name} 无孔焊盘 {n_smd} 个（属性已标 SMD {n_explicit}，圆形需手动加属性 {n_round}）",
                fix=draft_fix("SetSmdAttribute", "set_smd", f"COM affected_layer,name={layer.rel},mode=single,affected=yes\nCOM chklist_single,action=set_smd_attr,params=(erf=non_drilled)(layer=.affected)  【待验证】\n# 圆形 PAD {n_round} 个：Edit → Attributes → Change → .SMD → Add (p137)", {"smd": n_smd, "round": n_round, "explicit": n_explicit}),
            )
        )  # fmt: skip
    return {"smd": n_smd, "round": n_round, "explicit": n_explicit}


def compensation_for(copper_cfg: dict[str, Any] | None, thr: dict[str, Any], order_spec: dict[str, Any] | None, side: str) -> tuple[float, float, str]:
    """(add_mm, below_mm, scope) for etch compensation on ``side`` (inner|outer).

    The book's rule is +1 mil on lines under 15 mil (p122/p138). Thick-copper shops compensate by
    copper weight and on every feature: ``copper.compensation_by_oz`` [{oz, add_mm}] is looked up
    with the order's copper_inner_um / copper_outer_um (35 µm = 1 oz; the closest table row at or
    below the weight wins, the heaviest row above it otherwise), and ``compensation_scope: all``
    lifts the width limit. First real job: 105 µm both sides → +0.1 mm on lines and pads."""
    limit = float(thr.get("compensation_threshold_mm", 0.381))
    comp = float(thr.get("line_compensation_mm", 0.0254))
    scope = str((copper_cfg or {}).get("compensation_scope", "thin_lines"))
    table = [t for t in ((copper_cfg or {}).get("compensation_by_oz") or []) if isinstance(t, dict) and t.get("oz") and t.get("add_mm") is not None]
    spec = order_spec or {}
    um = spec.get("copper_outer_um" if side == "outer" else "copper_inner_um") or spec.get("copper_um")
    # 订单没写铜箔厚度（2×2 板的「6.铜箔厚度」栏客户就是空的）时不要悄悄退回教材的 +1 mil ——
    # 补偿量完全由铜厚决定，退回去等于按 1 mil 做一块 1oz 的板（终稿是 +0.03）。厂 profile 写明
    # 自己的默认档 (compensation_default_oz) 就按那一档做，报告里说明是按默认做的。
    fallback_oz = (copper_cfg or {}).get("compensation_default_oz")
    if table and not um and fallback_oz:
        um = float(fallback_oz) * 35.0
    if table and um:
        try:
            oz = float(um) / 35.0
        except (TypeError, ValueError):
            oz = None
        if oz:
            at_or_below = [t for t in table if float(t["oz"]) <= oz + 0.1]
            row = max(at_or_below, key=lambda t: float(t["oz"])) if at_or_below else min(table, key=lambda t: float(t["oz"]))
            comp = float(row["add_mm"])
    if scope == "all":
        limit = float("inf")
    return comp, limit, scope


def report_line_compensation(layer: CopperLayer, thr: dict[str, float], items: list[ReportItem], order_spec: dict[str, Any] | None = None, copper_cfg: dict[str, Any] | None = None) -> int:
    """Lines narrower than 15 mil get +1 mil (p122/p138). One info row per layer. Impedance lines
    (order_spec.impedance widths, 第15章) are excluded and raised as their own EQ: they are
    compensated by the impedance calculation, not the blanket +1 mil (p122 阻抗线依照设计值加大).
    With ``copper.compensation_scope: all`` every line and pad is counted (厚铜蚀刻补偿)."""
    from engine.checks.impedance import describe, impedance_entries, is_impedance_width

    comp, limit, scope = compensation_for(copper_cfg, thr, order_spec, "inner" if layer.is_inner else "outer")
    entries = impedance_entries(order_spec, layer.index)
    n = n_imp = 0
    for o in layer.objects:
        if isinstance(o, (go.Line, go.Arc)) and o.polarity_dark:
            w = _width(o)
            if is_impedance_width(w, entries):
                n_imp += 1
            elif w is not None and w < limit:
                n += 1
        elif scope == "all" and isinstance(o, go.Flash) and o.polarity_dark:
            n += 1
    if n_imp:
        widths = sorted({float(r["trace_mil"]) for r in entries})
        items.append(ReportItem(
            id=f"impedance_{layer.rel}", kind="impedance_line", severity="warn", layer=layer.rel, measured=n_imp,
            message=f"{layer.name} 有 {n_imp} 段阻抗线（{describe(entries)}），不做统一 +{fmt_mm(comp)} 补偿，按阻抗计算结果加大（p122/第15章）",
            eq_question=f"{layer.name} 阻抗线 {', '.join(f'{w:g}mil' for w in widths)} 的补偿值需按阻抗计算（Polar SI9000）给出，请工程师提供加大值后再改线宽",
            fix=draft_fix("LineCompensation", "impedance_resize", f"# {layer.rel}: 阻抗线 {', '.join(f'{w:g}mil' for w in widths)} 按阻抗计算值单独 Resize（不并入 +1mil）\nCOM sel_resize,size=<impedance_mil>  【待验证】",
                          {"impedance": True, "widths_mil": widths, "count": n_imp}),
        ))  # fmt: skip
    spec_um = (order_spec or {}).get("copper_outer_um" if not layer.is_inner else "copper_inner_um") or (order_spec or {}).get("copper_um")
    by_default = "" if spec_um else f"，订单未给铜箔厚度，按厂默认 {(copper_cfg or {}).get('compensation_default_oz')} oz" if (copper_cfg or {}).get("compensation_default_oz") else ""
    if n and scope == "all":
        items.append(
            ReportItem(
                id=f"line_comp_{layer.rel}", kind="line_compensation", severity="info", layer=layer.rel, measured=n, threshold=comp,
                message=f"{layer.name} 全部 {n} 段线/焊盘按铜厚蚀刻补偿 +{fmt_mm(comp)}（工厂标准 compensation_by_oz{by_default}）",
                fix=draft_fix("LineCompensation", "resize_all", f"COM affected_layer,name={layer.rel},mode=single,affected=yes\nCOM filter_set,filter_name=popup,update_popup=no,feat_types=line\\;pad\\;arc\nCOM sel_all_feat\nCOM sel_resize,size={comp / _MIL:.1f}  # mil，整层加大（厚铜蚀刻补偿）  【待验证】", {"count": n, "add_mm": comp, "scope": "all"}),
            )
        )  # fmt: skip
    elif n:
        items.append(
            ReportItem(
                id=f"line_comp_{layer.rel}", kind="line_compensation", severity="info", layer=layer.rel, measured=n, threshold=limit,
                message=f"{layer.name} 有 {n} 段线宽 < {fmt_mm(limit)}，需补偿 +{fmt_mm(comp)}（Genesis 做）",
                fix=draft_fix("LineCompensation", "resize_line", f"COM affected_layer,name={layer.rel},mode=single,affected=yes\nCOM filter_set,filter_name=popup,update_popup=no,feat_types=line\\;arc\nCOM filter_set,filter_name=popup,update_popup=no,slct_syms=r0-r{limit / _MIL:.0f}  【待验证：按线宽选】\nCOM sel_resize,size={comp / _MIL:.0f}  # mil，在原来基础上加大 (p124/p138)  【待验证】", {"count": n, "add_mm": comp, "below_mm": limit}),
            )
        )  # fmt: skip
    return n


# ---------------------------------------------------------------------------------------------
# stage driver (shared by inner / outer)
# ---------------------------------------------------------------------------------------------
def run_copper_stage(ctx: JobContext, stage: str) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage=stage, status="failed", summary="no layer_map (run intake first)")
    types = INNER_TYPES if stage == "inner" else OUTER_TYPES
    entries = [e for e in lm.get("files", []) if e.get("type") in types]
    if not entries:
        return StageReport(stage=stage, status="ok", summary="无内层（双面板）" if stage == "inner" else "无外层")
    ccfg = ctx.profile["copper"]
    thr = dict(ccfg["inner" if stage == "inner" else "outer"])
    thr["npth_in_pad_policy"] = str(ccfg.get("npth_in_pad", "ask"))  # ask = EQ 问客户；clear = 按 NPTH 削铜
    neg = dict(ccfg["inner"].get("negative", {}))
    neg.setdefault("npth_clearance_mm", thr["npth_clearance_mm"])
    holes = load_holes(ctx, lm)
    profile = load_profile(ctx)

    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in entries])
    from engine.checks import gold_finger as gfc
    zones = gfc.zones_from_layer_map(ctx, lm)
    gcfg = ctx.profile.get("gold_finger") or {}
    stats: dict[str, Any] = {"layers": {}, "holes": len(holes), "gold_finger_zones": [{"side": z.side, "edge": z.edge, "pads": z.n} for z in zones]}
    for e in entries:
        rel = e["file"]
        res = folded.get(rel)
        if isinstance(res, Exception) or res is None:
            items.append(
                ReportItem(
                    id=f"parse_{rel}", kind="layer_parse_error", severity="error", layer=rel,
                    message=f"无法解析 {rel}: {res}", eq_question=f"文件 {rel} 无法解析，请客户重新导出",
                )
            )  # fmt: skip
            continue
        objects = list(open_camfile(ctx.layer_path(rel), e["type"]).objects)
        layer = CopperLayer(rel=rel, layer_type=e["type"], polarity=e.get("polarity") or "positive", geom=res, objects=objects, index=e.get("index"))
        s: dict[str, Any] = {"polarity": layer.polarity, "polygons": len(layer.polys)}
        if layer.polarity == "negative":
            s["partition_line_width"] = check_line_width(layer, neg["partition_line_width_mm"], items, kind="partition_line_width")
            s.update(check_holes_negative(layer, holes, neg, items))
            s["copper_to_edge"] = check_edge(layer, profile, thr["edge_clearance_mm"], items)
            s["gold_finger_inner_copper"] = gfc.check_inner(rel, layer.name, layer.geom, "negative", zones, gcfg, items)
        else:
            s["line_width"] = check_line_width(layer, thr["min_line_width_mm"], items)
            s["spacing"] = check_spacing(layer, thr["min_spacing_mm"], items)
            s.update(check_holes_positive(layer, holes, thr, items))
            s["copper_to_edge"] = check_edge(layer, profile, thr["edge_clearance_mm"], items)
            s["line_compensation"] = report_line_compensation(layer, thr, items, ctx.request.order_spec, ctx.profile.get("copper"))
            if layer.is_inner:
                s["isolated_pad"] = check_isolated_pads(layer, holes, items)
                s["gold_finger_inner_copper"] = gfc.check_inner(rel, layer.name, layer.geom, "positive", zones, gcfg, items)
            else:
                s.update(report_smd_candidates(layer, holes, items))
                s.update(gfc.check_outer(rel, layer.name, layer.polys, [z for z in zones if z.side == e["type"]], ctx.request.order_spec, gcfg, items))
        stats["layers"][rel] = s
    if stage == "outer":  # 第14章 半孔 / 金属包边 (p176–184)
        from engine.checks.edge_plating import run_edge_plating

        masks = [e for e in lm.get("files", []) if e.get("type") in ("top_mask", "bottom_mask")]
        mask_folds = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in masks])
        stats["edge_plating"] = run_edge_plating(
            holes, load_profile(ctx), ctx.profile["edge_plating"], ctx.request.order_spec,
            {e["file"]: g for e in entries if isinstance(g := folded.get(e["file"]), BaseGeometry)},
            {e["file"]: g for e in masks if isinstance(g := mask_folds.get(e["file"]), BaseGeometry)}, items,
        )  # fmt: skip

    artifacts = [ctx.write_artifact("check_summary", f"{stage}_checks.json", json.dumps(stats, ensure_ascii=False, indent=1).encode())]
    return StageReport(stage=stage, status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)


_ = ITEM_CAP
