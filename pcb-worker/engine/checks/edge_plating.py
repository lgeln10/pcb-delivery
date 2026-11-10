"""第14章 半孔板及金属包边 (p176–184) — checks on the outer stage.

Customer Gerbers carry no "half hole" attribute: a half hole is a plated hole/slot that the
profile cuts through (its disc crosses the board edge). Edge plating (金属包边) is normally
stated in the 制作要求; when ``order_spec.edge_plating`` is set the p182 rules are checked,
otherwise plated slots lying *on* the edge are reported as a suspected 包边 for confirmation.

kinds
* half_hole            info  + EQ  半孔工艺（锣边 / 二钻）需确认 (p176–180)
* half_hole_min_dia    error + EQ  半孔 <0.5mm (p181)
* half_hole_gap        error + EQ  半孔孔边间距 <0.4mm (p181)
* half_hole_copper_cut warn        线路层半孔部分需掏单边 0.1mm (p178) → CopperCutout draft
* edge_plating_suspect info  + EQ  板边上的镀槽疑似金属包边 (p182)
* edge_plating_ring    error + EQ  包边焊环 <10mil (p182)
* edge_plating_to_pad  error + EQ  焊盘距包边 <8mil (p182)
* edge_plating_mask    warn        包边槽阻焊须完整开窗 (p183) → MaskResize draft
"""

from __future__ import annotations

from typing import Any

from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.checks.common import aggregate, below, draft_fix, fmt_mm, loc_of
from engine.model.report import ReportItem
from engine.stages.drill import Hole


def _on_edge(h: Hole, profile: BaseGeometry) -> bool:
    g = h.geom()
    return g.intersects(profile.boundary)


def _it(kind: str, n: int, layer: str, geom: BaseGeometry, measured: Any, threshold: Any, msg: str) -> ReportItem:
    return ReportItem(id=f"{kind}_{n}", kind=kind, severity="warn", layer=layer, location=loc_of(geom, 0.5), measured=measured, threshold=threshold, message=msg)


def run_edge_plating(
    holes: list[Hole], profile: BaseGeometry | None, cfg: dict[str, Any], order_spec: dict[str, Any] | None,
    outer_layers: dict[str, BaseGeometry], mask_layers: dict[str, BaseGeometry], items: list[ReportItem],
) -> dict[str, int]:
    if profile is None or not holes:
        return {"half_holes": 0, "edge_plating": 0}
    plated = [h for h in holes if h.attribute in ("plated", "via", "via_plug", "via_tent", "unknown")]
    half = [h for h in plated if not h.slot and _on_edge(h, profile)]
    edge_slots = [h for h in plated if h.slot and _on_edge(h, profile)]
    stats = {"half_holes": len(half), "edge_slots": len(edge_slots), "edge_plating": 0}
    layer0 = next(iter(outer_layers), "")

    # ---- half holes ------------------------------------------------------------------------
    if half:
        u = unary_union([h.geom() for h in half])
        items.append(ReportItem(
            id="half_hole", kind="half_hole", severity="info", layer=layer0, location=loc_of(u, 1.0), measured=len(half),
            message=f"板边有 {len(half)} 个被外形切开的镀孔（半孔，p176）；需按半孔工艺做：锣边（外形层 GKO1 只做半孔部分，槽宽 1.6mm p177）或二钻（两端加孔 p180）",
            eq_question="板边镀孔按半孔处理？请确认工艺（锣半孔 / 二钻）及最终保留的孔壁位置",
            fix=draft_fix("RoutDesign", "half_hole_rout", "# 半孔：建 GKO1 外形层只做半孔部分，槽宽 1.6mm；线路层半孔部分掏单边 0.1mm，钻孔加挡点比孔整体小 0.1mm (p177–178)  【待验证】"),
        ))  # fmt: skip
        small = [_it("half_hole_min_dia", i, layer0, h.geom(), h.dia, cfg["half_hole_min_dia_mm"], f"半孔 {h.tool} ⌀{h.dia} < {fmt_mm(cfg['half_hole_min_dia_mm'])}")
                 for i, h in enumerate(half) if below(h.dia, cfg["half_hole_min_dia_mm"])]  # fmt: skip
        aggregate(items, small, kind="half_hole_min_dia", layer=layer0, threshold=cfg["half_hole_min_dia_mm"],
                  message=f"半孔孔径 < {fmt_mm(cfg['half_hole_min_dia_mm'])}（p181 最小半孔 0.5mm）",
                  eq_question="半孔孔径小于 0.5mm 无法保证孔壁铜，请客户确认加大或改设计")  # fmt: skip
        gaps: list[ReportItem] = []
        for i, a in enumerate(half):
            for b in half[i + 1:]:
                gap = a.geom().distance(b.geom())
                if below(gap, cfg["half_hole_min_gap_mm"]):
                    gaps.append(_it("half_hole_gap", len(gaps), layer0, unary_union([a.geom(), b.geom()]), round(gap, 4), cfg["half_hole_min_gap_mm"],
                                    f"半孔 {a.tool}/{b.tool} 孔边间距 {fmt_mm(gap)} < {fmt_mm(cfg['half_hole_min_gap_mm'])}"))  # fmt: skip
        aggregate(items, gaps, kind="half_hole_gap", layer=layer0, threshold=cfg["half_hole_min_gap_mm"],
                  message=f"半孔孔边间距 < {fmt_mm(cfg['half_hole_min_gap_mm'])}（p181）",
                  eq_question="半孔之间间距不足 0.4mm，成型时孔壁铜易翘起，请客户确认")  # fmt: skip
        # the mask must stay open over the half hole (p179/p180 挡点/开窗 比孔单边大 0.1MM 防止油墨入半孔)
        ovs = float(cfg["mask_dam_oversize_mm"])
        for rel, geom in mask_layers.items():
            uncovered = [h for h in half if not geom.buffer(0.003).contains(h.geom().buffer(ovs).intersection(profile))]
            if uncovered:
                items.append(ReportItem(
                    id=f"half_hole_mask_{rel}", kind="half_hole_mask", severity="warn", layer=rel, measured=len(uncovered), threshold=ovs,
                    location=loc_of(unary_union([h.geom() for h in uncovered]), 0.5),
                    message=f"{rel} 半孔位阻焊须开窗（比孔单边大 {fmt_mm(ovs)}，p179/p180 防止油墨入半孔）：{len(uncovered)} 个",
                    fix=draft_fix("MaskResize", "half_hole_open", f"# {rel}: 半孔位阻焊开窗 = 孔 + {ovs}mm/边 (p179)  【待验证】", {"holes": len(uncovered), "oversize_mm": ovs}),
                ))  # fmt: skip
        # copper cut-back on the outer layers (p178)
        cut = float(cfg["copper_cut_per_side_mm"])
        for rel, geom in outer_layers.items():
            touching = [h for h in half if geom.intersects(h.geom().buffer(cut))]
            if touching:
                items.append(ReportItem(
                    id=f"half_hole_cut_{rel}", kind="half_hole_copper_cut", severity="warn", layer=rel, measured=len(touching), threshold=cut,
                    location=loc_of(unary_union([h.geom() for h in touching]), 1.0),
                    message=f"{rel} 半孔部分线路需掏单边 {fmt_mm(cut)}，并用钻孔加挡点比孔整体小 {fmt_mm(cut)}（p178）",
                    fix=draft_fix("CopperCutout", "half_hole_cut", f"# {rel}: 半孔位铜皮/焊盘掏单边 {cut}mm (p178)  【待验证】", {"holes": len(touching), "cut_mm": cut}),
                ))  # fmt: skip

    # ---- edge plating ------------------------------------------------------------------------
    spec_flag = bool((order_spec or {}).get("edge_plating"))
    if edge_slots and not spec_flag:
        u = unary_union([h.geom() for h in edge_slots])
        items.append(ReportItem(
            id="edge_plating_suspect", kind="edge_plating_suspect", severity="info", layer=layer0, location=loc_of(u, 1.0), measured=len(edge_slots),
            message=f"板边上有 {len(edge_slots)} 条镀槽，疑似金属包边（p182 包边信息通常在制作要求里）",
            eq_question="板边镀槽是否为金属包边？请确认包边范围及层间连接方式（p182）",
        ))  # fmt: skip
    if spec_flag:
        stats["edge_plating"] = 1
        ring_min, pad_min = float(cfg["annular_ring_mm"]), float(cfg["to_pad_mm"])
        band = profile.boundary.buffer(pad_min)
        for rel, geom in outer_layers.items():
            # p182 焊环 ≥10mil：copper must cover the edge band on the plated edge (we take every edge slot as plated)
            for i, h in enumerate(edge_slots):
                need = h.geom().buffer(ring_min).intersection(profile)
                if not geom.buffer(0.003).contains(need):
                    items.append(_it("edge_plating_ring", i, rel, h.geom(), 0, ring_min, f"{rel} 包边槽 {h.tool} 焊环不足 {fmt_mm(ring_min)}（p182）"))
            near = geom.intersection(band)
            if not near.is_empty and not any(h.geom().buffer(ring_min + 0.01).contains(near) for h in edge_slots):
                items.append(_it("edge_plating_to_pad", 0, rel, near, round(near.area, 3), pad_min, f"{rel} 有铜/焊盘距包边 < {fmt_mm(pad_min)}（p182）"))
        for rel, geom in mask_layers.items():
            for i, h in enumerate(edge_slots):
                if not geom.buffer(0.003).contains(h.geom().intersection(profile)):
                    items.append(ReportItem(
                        id=f"edge_plating_mask_{rel}_{i}", kind="edge_plating_mask", severity="warn", layer=rel, location=loc_of(h.geom(), 0.5),
                        message=f"{rel} 金属包边槽 {h.tool} 阻焊须完整开窗（p183）",
                        fix=draft_fix("MaskResize", "edge_plating_open", f"# {rel}: 包边槽位阻焊整体开窗 (p183)  【待验证】"),
                    ))  # fmt: skip
        ring_items = [i for i in items if i.kind == "edge_plating_ring"]
        pad_items = [i for i in items if i.kind == "edge_plating_to_pad"]
        for lst, kind, msg, q in (
            (ring_items, "edge_plating_ring", f"包边焊环 < {fmt_mm(ring_min)}（p182 防碎膜）", "包边焊环不足 10mil，请客户确认加大焊环"),
            (pad_items, "edge_plating_to_pad", f"焊盘距包边 < {fmt_mm(pad_min)}（p182）", "焊盘离包边太近，请客户确认移动或缩小"),
        ):
            if lst:
                for x in lst:
                    items.remove(x)
                aggregate(items, lst, kind=kind, layer=lst[0].layer or layer0, threshold=lst[0].threshold, message=msg, eq_question=q)
    return stats
