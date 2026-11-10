"""Gold finger checks (第12章 金手指板制作 p159–169).

Customer Gerber carries no "finger" attribute, so fingers are *detected*: a row of ≥ ``min_pads``
equal-width rectangular pads whose long axis points at a profile edge they sit within
``edge_distance_mm`` of. The zone (hull of the row) drives four book rules:

* outer:  bevel / hard gold must be stated (p160 设计中没有倒角则有问题; p159 电镀硬金) → one EQ
* outer:  no other copper within ``pad_to_finger_mm`` of the fingers (p161 焊盘距离手指位 1mm 以上;
          表层不要铺铜) → EQ
* inner:  copper must be cut back ``inner_cut_mm`` from the zone (p161 内层所有层面削铜 3mm) → EQ + CopperCutout
* mask:   the whole row is one opening (p162 整块阻焊开窗) → EQ + MaskResize

Detection is geometric and heuristic → every finding says 「识别到」 and asks; nothing is auto-fixed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shapely.geometry import Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.checks.common import TOL, aggregate, draft_fix, fmt_mm, loc_of
from engine.model.report import ReportItem


@dataclass
class FingerZone:
    side: str  # top | bottom (copper layer type)
    edge: str  # left | right | bottom | top (profile edge the fingers point at)
    pads: list[Polygon]
    hull: Polygon  # bbox of the row

    @property
    def n(self) -> int:
        return len(self.pads)


def _rect_like(p: Polygon) -> tuple[float, float, float, float, float] | None:
    x0, y0, x1, y1 = p.bounds
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    if p.area / (w * h) < 0.9:  # not a solid rectangle
        return None
    return x0, y0, x1, y1, p.area


def detect_fingers(polys: list[Polygon], side: str, profile: BaseGeometry | None, cfg: dict[str, Any]) -> list[FingerZone]:
    """Rows of equal-width rectangular pads along a profile edge. ``polys`` = the layer's copper polygons."""
    if profile is None or profile.is_empty:
        return []
    px0, py0, px1, py1 = profile.bounds
    reach = float(cfg.get("edge_distance_mm", 3.0))
    min_pads = int(cfg.get("min_pads", 4))
    max_area = float(cfg.get("max_pad_area_mm2", 40.0))
    cands: dict[str, list[tuple[float, float, float, float, Polygon]]] = {"left": [], "right": [], "bottom": [], "top": []}
    for p in polys:
        r = _rect_like(p)
        if r is None or r[4] > max_area or r[4] < 0.2:
            continue
        x0, y0, x1, y1, _ = r
        w, h = x1 - x0, y1 - y0
        if h >= 1.5 * w:  # vertical finger → bottom or top edge
            if y0 - py0 <= reach:
                cands["bottom"].append((x0, y0, x1, y1, p))
            elif py1 - y1 <= reach:
                cands["top"].append((x0, y0, x1, y1, p))
        elif w >= 1.5 * h:  # horizontal finger → left or right edge
            if x0 - px0 <= reach:
                cands["left"].append((x0, y0, x1, y1, p))
            elif px1 - x1 <= reach:
                cands["right"].append((x0, y0, x1, y1, p))
    zones: list[FingerZone] = []
    for edge, lst in cands.items():
        if len(lst) < min_pads:
            continue
        along = (lambda r: r[0]) if edge in ("bottom", "top") else (lambda r: r[1])
        width = (lambda r: r[2] - r[0]) if edge in ("bottom", "top") else (lambda r: r[3] - r[1])
        lst.sort(key=along)
        # split into rows: same width (±TOL·4) and gap < 3× width
        row: list[tuple[float, float, float, float, Polygon]] = []
        def flush() -> None:
            if len(row) >= min_pads:
                pads = [r[4] for r in row]
                x0 = min(r[0] for r in row); y0 = min(r[1] for r in row); x1 = max(r[2] for r in row); y1 = max(r[3] for r in row)
                zones.append(FingerZone(side=side, edge=edge, pads=pads, hull=box(x0, y0, x1, y1)))
        for r in lst:
            if row and (abs(width(r) - width(row[-1])) > 4 * TOL or along(r) - along(row[-1]) > 3 * width(r) + width(r)):
                flush()
                row = []
            row.append(r)
        flush()
    return zones


def _zone_item(layer_rel: str, kind: str, n: int, geom, measured, threshold, message: str) -> ReportItem:
    return ReportItem(id=f"{kind}_{layer_rel}_{n}", kind=kind, severity="error", layer=layer_rel, location=loc_of(geom, 0.5),
                      measured=measured, threshold=threshold, message=message)  # fmt: skip


def check_outer(layer_rel: str, layer_name: str, polys: list[Polygon], zones: list[FingerZone], order_spec: dict[str, Any] | None,
                cfg: dict[str, Any], items: list[ReportItem]) -> dict[str, int]:
    """Outer layer that carries the fingers: bevel/hard-gold EQ + no copper within pad_to_finger_mm."""
    if not zones:
        return {"gold_finger_spec": 0, "gold_finger_copper_nearby": 0}
    spec_new: list[ReportItem] = []
    near_new: list[ReportItem] = []
    clr = float(cfg.get("pad_to_finger_mm", 1.0))
    gf = (order_spec or {}).get("gold_finger") if isinstance(order_spec, dict) else None
    bevel = gf.get("bevel_deg") if isinstance(gf, dict) else None
    hard = gf.get("hard_gold_uin") if isinstance(gf, dict) else None
    for z in zones:
        finger_union = unary_union(z.pads)
        it = _zone_item(layer_rel, "gold_finger_spec", len(spec_new), z.hull, z.n, None,
                        f"{layer_name} 识别到 {z.n} 只金手指（{z.edge} 边）；倒角 {bevel if bevel else '未写明'}，硬金 {str(hard) + 'u\"' if hard else '未写明'}")  # fmt: skip
        it.severity = "warn" if (bevel and hard) else "error"
        spec_new.append(it)
        probe = z.hull.buffer(clr)
        for p in polys:
            if any(p.equals(f) or p.intersects(f) for f in z.pads):
                continue
            if p.intersects(probe):
                d = finger_union.distance(p)
                near_new.append(_zone_item(layer_rel, "gold_finger_copper_nearby", len(near_new), p.intersection(probe.buffer(0.5)), round(d, 4), clr,
                                           f"{layer_name} 金手指旁 {fmt_mm(d)} 内有其他铜（焊盘/铜皮/过孔），要求 ≥ {fmt_mm(clr)}"))  # fmt: skip
    return {
        "gold_finger_spec": aggregate(items, spec_new, kind="gold_finger_spec", layer=layer_rel, severity="warn" if (bevel and hard) else "error",
            message=f"{layer_name} 识别到金手指（p159）",
            eq_question=None if (bevel and hard) else f"{layer_name} 识别到板边金手指，制作要求未写明倒角角度（一般 30/45/60°，p160）和电镀硬金厚度（p159），请客户确认；金手指位阻焊需整块开窗（p162）",
            fix=draft_fix("RoutDesign", "gold_finger_bevel", "# 金手指倒角：成型后斜边机加工，角度按客户（30/45/60°）；MI 流程单走整版电金/局部电金 (p163)")),
        "gold_finger_copper_nearby": aggregate(items, near_new, kind="gold_finger_copper_nearby", layer=layer_rel, threshold=clr,
            message=f"{layer_name} 金手指 {fmt_mm(clr)} 内有其他铜（p161）",
            eq_question=f"{layer_name} 金手指旁 {fmt_mm(clr)} 内有焊盘/铜皮/过孔（表层不应铺铜到手指位，p161），请客户确认可否移开或削铜",
            fix=draft_fix("CopperCutout", "cut_near_fingers", f"# {layer_rel}: 金手指区外扩 {clr:.1f}mm 掏铜 / 移开焊盘 (p161)\nCOM sel_copy_other,dest=layer_name,target_layer={layer_rel},invert=yes,size={clr * 2 / 0.0254:.0f}  【待验证】")),
    }  # fmt: skip


def check_inner(layer_rel: str, layer_name: str, geom: BaseGeometry, polarity: str, zones: list[FingerZone], cfg: dict[str, Any], items: list[ReportItem]) -> int:
    """p161 金手指内层所有层面需要做削铜处理，通常削铜宽度 3mm. On a negative film dark = clearance, so the
    zone must be *covered* by dark; on a positive film it must be *free* of copper."""
    if not zones:
        return 0
    cut = float(cfg.get("inner_cut_mm", 3.0))
    found: list[ReportItem] = []
    for z in zones:
        region = z.hull.buffer(cut)
        if polarity == "negative":
            bad = region.difference(geom)  # not cleared
            what = "未削铜（负片无隔离）"
        else:
            bad = region.intersection(geom)
            what = "有铜"
        if bad.area > 0.05:
            found.append(_zone_item(layer_rel, "gold_finger_inner_copper", len(found), bad, round(bad.area, 2), cut,
                                    f"{layer_name} 金手指区外扩 {fmt_mm(cut)} 内{what} {bad.area:.1f} mm²（p161 内层需削铜 3mm）"))  # fmt: skip
    return aggregate(items, found, kind="gold_finger_inner_copper", layer=layer_rel, threshold=cut, unit="mm2",
                     message=f"{layer_name} 金手指位内层未削铜 {fmt_mm(cut)}（p161）",
                     eq_question=f"{layer_name} 金手指位内层铜未按 {fmt_mm(cut)} 削铜，请确认可否削铜（影响接地/电源平面时问客户）",
                     fix=draft_fix("CopperCutout", "inner_finger_cut", f"# {layer_rel}: 金手指区外扩 {cut:.0f}mm 掏铜（负片加正性块 / 正片减铜） (p161)\nCOM sel_copy_other,dest=layer_name,target_layer={layer_rel},invert={'no' if polarity == 'negative' else 'yes'},size={cut * 2 / 0.0254:.0f}  【待验证】"))  # fmt: skip


def check_mask(mask_rel: str, mask_name: str, openings: BaseGeometry, zones: list[FingerZone], items: list[ReportItem]) -> int:
    """p162 金手指需要做整块阻焊开窗处理：the finger row hull must be inside one opening."""
    if not zones:
        return 0
    found: list[ReportItem] = []
    for z in zones:
        covered = openings.intersection(z.hull).area / max(z.hull.area, 1e-9)
        if covered < 0.98:
            found.append(_zone_item(mask_rel, "gold_finger_mask_not_full", len(found), z.hull, round(covered, 3), 0.98,
                                    f"{mask_name} 金手指位未整块开窗（覆盖 {covered * 100:.0f}%）"))  # fmt: skip
    return aggregate(items, found, kind="gold_finger_mask_not_full", layer=mask_rel,
                     message=f"{mask_name} 金手指位阻焊未整块开窗（p162）",
                     eq_question=f"{mask_name} 金手指位阻焊按单只焊盘开窗，工厂一般整块开窗（p162），请客户确认",
                     fix=draft_fix("MaskResize", "finger_full_open", f"# {mask_rel}: 金手指区画一个整块开窗替换单只开窗 (p162)  【待验证】"))  # fmt: skip


def zones_from_layer_map(ctx, lm: dict[str, Any]) -> list[FingerZone]:
    """Detect fingers on both outer copper layers (fold cache makes this cheap when called from several stages)."""
    from engine.checks.common import load_profile
    from engine.geom.layers import fold_many
    from engine.geom.svg import iter_polygons

    cfg = ctx.profile.get("gold_finger") or {}
    if not cfg.get("enabled", True):
        return []
    outers = [e for e in lm.get("files", []) if e.get("type") in ("top_copper", "bottom_copper")]
    if not outers:
        return []
    profile = load_profile(ctx)
    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in outers])
    zones: list[FingerZone] = []
    for e in outers:
        g = folded.get(e["file"])
        if g is None or isinstance(g, Exception):
            continue
        zones.extend(detect_fingers(list(iter_polygons(g)), e["type"], profile, cfg))
    return zones
