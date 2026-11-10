"""第16章 盲孔及 HDI (p202–211) — checks on the drill stage for blind / buried drill files.

Everything here is a *classification* the MI engineer needs (laser vs mechanical, LDI vs film,
stacked vias, teardrop advice); nothing is geometry-modifying.

kinds
* hdi_laser_required    info        盲孔 ≤6mil 或叠孔 → 激光钻孔 (p203)
* hdi_stacked_vias      info + EQ   L1-L2 盲孔与 L2-L3 埋孔叠加 → 激光 + 特殊压合 (p203)
* hdi_mechanical_ok     info        盲孔 ≥0.20mm 可考虑机械钻 (p206)
* hdi_expose_method     info        ≤0.4mm LDI 曝盲孔 / >0.4mm 菲林 (p208)
* hdi_teardrop_advised  warn + EQ   盲孔 PAD 比孔径大 <5mil → 建议加 TEARDROP (p205) → Teardrops draft
* hdi_aspect_ratio      info        L/D（订单给介质厚时）(p207)
"""

from __future__ import annotations

from typing import Any

from shapely.geometry import Point
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.checks.common import aggregate, draft_fix, fmt_mm, loc_of
from engine.model.report import ReportItem
from engine.stages.drill import Hole


def _ring(geom: BaseGeometry | None, h: Hole) -> float | None:
    """Annular ring at the hole on a folded copper layer (None = no pad under the hole)."""
    if geom is None or geom.is_empty:
        return None
    c = Point(h.x, h.y)
    if not geom.contains(c):
        return None
    return max(c.distance(geom.boundary) - h.dia / 2, 0.0)


def run_hdi(
    holes_by_file: dict[str, list[Hole]], entries: list[dict[str, Any]], copper_folds: dict[int, BaseGeometry], n_layers: int,
    cfg: dict[str, Any], order_spec: dict[str, Any] | None, items: list[ReportItem],
) -> dict[str, Any]:
    """``holes_by_file``: drill rel → holes; ``entries``: layer_map drill entries (with ``drill_span``);
    ``copper_folds``: stackup number → folded copper (only the layers the spans start/end on are needed)."""
    spans = {e["file"]: tuple(e.get("drill_span") or (1, n_layers)) for e in entries}
    blind = {rel: hs for rel, hs in holes_by_file.items() if spans.get(rel, (1, n_layers)) != (1, n_layers) and n_layers > 1}
    stats: dict[str, Any] = {"blind_files": len(blind), "laser": 0, "mechanical": 0, "ldi": 0, "film": 0, "stacked": 0}
    if not blind:
        return stats
    laser_max = float(cfg["laser_max_dia_mm"])
    mech_min = float(cfg["mechanical_min_dia_mm"])
    ldi_max = float(cfg["ldi_max_dia_mm"])
    td_ring = float(cfg["teardrop_ring_mm"])
    # stacked: a hole of span (a,b) sitting on a hole of span (b,c)
    stacked: list[ReportItem] = []
    files = list(blind)
    for i, ra in enumerate(files):
        sa = spans[ra]
        for rb in files[i + 1:]:
            sb = spans[rb]
            if sa[1] != sb[0] and sb[1] != sa[0]:
                continue
            tb = unary_union([h.geom() for h in blind[rb]]) if blind[rb] else None
            if tb is None:
                continue
            for h in blind[ra]:
                if tb.intersects(h.geom()):
                    stacked.append(ReportItem(id=f"hdi_stacked_{len(stacked)}", kind="hdi_stacked_vias", severity="warn", layer=ra, location=loc_of(h.geom(), 0.5),
                                              measured=f"L{sa[0]}-L{sa[1]} / L{sb[0]}-L{sb[1]}", message=f"{h.tool} ⌀{h.dia} 叠孔 L{sa[0]}-L{sa[1]} 上有 L{sb[0]}-L{sb[1]}"))  # fmt: skip
    stats["stacked"] = aggregate(items, stacked, kind="hdi_stacked_vias", layer=files[0], severity="warn",
                                 message="盲孔与埋孔叠加（p203 特殊盲埋孔必须激光钻孔，压合流程按 LOT 卡副流程）",
                                 eq_question="叠孔结构需激光钻孔 + 多次压合，请确认本厂能力与客户接受的流程（p203/p210）")  # fmt: skip
    for rel, hs in blind.items():
        s = spans[rel]
        dias = sorted({h.dia for h in hs})
        small = [d for d in dias if d <= laser_max + 1e-6]
        mech = [d for d in dias if d >= mech_min - 1e-6]
        if small or (rel in {i.layer for i in stacked}):
            stats["laser"] += 1
            items.append(ReportItem(id=f"hdi_laser_{rel}", kind="hdi_laser_required", severity="info", layer=rel, measured=", ".join(f"{d}" for d in small) or "叠孔",
                                    message=f"{rel} L{s[0]}-L{s[1]}：{'孔径 ≤' + fmt_mm(laser_max) + ' ' if small else ''}需激光钻孔（p203）；板材需 RCC，激光前蚀出等大 Cu Clearance，定位标记加在 L2/LN-1（p203–204）"))  # fmt: skip
        if mech:
            stats["mechanical"] += 1
            items.append(ReportItem(id=f"hdi_mech_{rel}", kind="hdi_mechanical_ok", severity="info", layer=rel, measured=", ".join(f"{d}" for d in mech),
                                    message=f"{rel} L{s[0]}-L{s[1]}：孔径 ≥{fmt_mm(mech_min)} 可考虑机械钻孔（p206）"))  # fmt: skip
        ldi = [d for d in dias if d <= ldi_max + 1e-6]
        stats["ldi" if ldi else "film"] += 1
        items.append(ReportItem(id=f"hdi_expose_{rel}", kind="hdi_expose_method", severity="info", layer=rel, measured=f"{min(dias)}–{max(dias)}",
                                message=f"{rel}：盲孔 {'≤' + fmt_mm(ldi_max) + ' 用 LDI 曝盲孔' if ldi else '>' + fmt_mm(ldi_max) + ' 用菲林曝盲孔'}（p208）；曝光点直径 = 孔径 − 6mil（p209）"))  # fmt: skip
        # teardrop advice: ring on the span's end layers
        td: list[ReportItem] = []
        for L in (s[0], s[1]):
            geom = copper_folds.get(L)
            if geom is None:
                continue
            for h in hs:
                r = _ring(geom, h)
                if r is not None and r < td_ring - 0.003:
                    td.append(ReportItem(id=f"hdi_td_{len(td)}", kind="hdi_teardrop_advised", severity="warn", layer=rel, location=loc_of(h.geom(), 0.5),
                                         measured=round(r, 4), threshold=td_ring, message=f"L{L} 盲孔 {h.tool} ⌀{h.dia} 焊环 {fmt_mm(r)} < {fmt_mm(td_ring)}"))  # fmt: skip
        aggregate(items, td, kind="hdi_teardrop_advised", layer=rel, severity="warn", threshold=td_ring,
                  message=f"{rel} 盲孔 PAD 比孔径大不足 {fmt_mm(td_ring)}（p205 IPC-6016：允许相切，建议加 TEARDROP）",
                  eq_question="盲孔焊环小于 5mil，建议加泪滴，请确认是否允许（p205）",
                  fix=draft_fix("Teardrops", "blind_via_teardrop", f"# {rel} 盲孔加泪滴：DFM → Yield Improvement → Advanced Teardrops Creation (p126/p205)  【待验证】"))  # fmt: skip
        diel = (order_spec or {}).get("dielectric_mm") or (order_spec or {}).get("hdi_dielectric_mm")
        if diel:
            try:
                L_mm = float(diel)
                worst = max(L_mm / d for d in dias)
                items.append(ReportItem(id=f"hdi_ar_{rel}", kind="hdi_aspect_ratio", severity="info", layer=rel, measured=round(worst, 2), threshold=cfg["aspect_ratio_film"],
                                        message=f"{rel} 盲孔纵横比 L/D 最大 {worst:.2f}（{'≤' if worst <= cfg['aspect_ratio_film'] else '>'}{cfg['aspect_ratio_film']}：{'整板曝光' if worst <= cfg['aspect_ratio_film'] else '需曝点菲林/LDI'}，p207）"))  # fmt: skip
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    return stats
