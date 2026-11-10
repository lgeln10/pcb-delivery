"""Solder-mask DFM checks (第8章 p140–144).

Mask Gerbers are *negative images*: dark = opening. After folding, ``geom`` is the set of
openings. The same-side outer copper layer supplies the pads (flashes) and the copper.

* opening_not_pad        p141 步骤1 开窗对应线路是否为 PAD           → MaskConstructPads
* mask_not_pad_objects   p141 步骤2 绿油层是否全为 PAD（线/面画的开窗）→ MaskConstructPads
* opening_smaller_than_pad / mask_expansion  p141 步骤3 开窗比 PAD 大 / 要求1 ≥2mil → MaskResize
* mask_coverage          p143 #3 Coverage（别的铜太靠近开窗）           → MaskOptimize
* missing_opening        p143 #5 Missing                               → MaskConstructPads
* mask_sliver            p143 #4/#6/#7 Spacing/Bridge/Sliver（桥宽按油色 p141 要求5）→ MaskOptimize
* npth_opening_small / npth_covered   p141 要求1 NPTH 开窗单边 +0.1 / p144 #6 挡点 → MaskResize / MaskDams
* via_dam_needed / via_plug_too_large p141 要求2 ≥0.6 挡点、塞孔 ≤0.5               → MaskDams
* mask_to_profile        p143 #8 Rout                                   → 报告

Report only; one decision per (layer, kind) via ``common.aggregate``.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import Any

from shapely import shortest_line
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from engine.checks.common import (
    TOL,
    TOUCH,
    aggregate,
    below,
    draft_fix,
    fmt_mm,
    load_holes,
    load_profile,
)
from engine.checks.copper import CopperLayer, _flashes, _item
from engine.geom.layers import fold_many, open_camfile
from engine.geom.svg import iter_polygons
from engine.model.report import ReportItem, StageReport, derive_status, summarize
from engine.pipeline.context import JobContext
from engine.stages.drill import Hole

MASK_TYPES = ("top_mask", "bottom_mask")
_SIDE_COPPER = {"top_mask": "top_copper", "bottom_mask": "bottom_copper"}
_SIDE_PASTE = {"top_mask": "top_paste", "bottom_mask": "bottom_paste"}
_MIL = 0.0254


@dataclass
class MaskLayer:
    rel: str
    layer_type: str
    geom: BaseGeometry  # openings
    objects: list[Any]
    copper: CopperLayer | None
    polys: list[Polygon] = field(default_factory=list)
    tree: STRtree | None = None

    def __post_init__(self) -> None:
        self.polys = list(iter_polygons(self.geom))
        self.tree = STRtree(self.polys) if self.polys else None

    @property
    def name(self) -> str:
        return self.rel

    def openings_at(self, g) -> list[int]:
        if self.tree is None:
            return []
        return [int(i) for i in self.tree.query(g, predicate="intersects")]


def bridge_min_for(color: str | None, cfg: dict[str, float]) -> float:
    c = (color or "").lower()
    if any(k in c for k in ("白", "黑", "white", "black")):
        return cfg["white_black"]
    if any(k in c for k in ("绿", "green")) or not c:
        return cfg["green"]
    return cfg["other"]


# ---------------------------------------------------------------------------------------------
def check_pads_vs_openings(m: MaskLayer, holes: list[Hole], thr: dict[str, float], items: list[ReportItem]) -> dict[str, int]:
    """Steps 1/3/5 + coverage: every pad should sit inside an opening that is ≥ coverage bigger."""
    cov = thr["coverage_mm"]
    smaller: list[ReportItem] = []
    larger: list[ReportItem] = []
    expansion: list[ReportItem] = []
    missing: list[ReportItem] = []
    coverage: list[ReportItem] = []
    regen = bool(thr.get("regenerate_openings", False))
    not_pad: list[ReportItem] = []
    if m.copper is None:
        return {"opening_smaller_than_pad": 0, "mask_expansion": 0, "missing_opening": 0, "mask_coverage": 0, "opening_not_pad": 0}
    htree = STRtree([h.center() for h in holes]) if holes else None
    via_idx = {i for i, h in enumerate(holes) if h.attribute in ("via", "via_plug", "via_tent")}
    pads = _flashes(m.copper)
    covered_openings: set[int] = set()
    for o, pad, fn in pads:
        is_via = False
        if htree is not None:
            hit = [int(i) for i in htree.query(pad, predicate="intersects")]
            is_via = bool(hit) and all(i in via_idx for i in hit)
        if "Fiducial" in fn or "Test" in fn:
            continue
        idx = m.openings_at(pad)
        if not idx:
            if is_via:
                continue  # covered via: normal (p144 注意 1)
            missing.append(_item(m.copper, "missing_opening", len(missing), pad, 0.3, 0, None,
                                 f"{m.name} 焊盘无开窗 {type(o.aperture).__name__}{'/' + fn if fn else ''}", None))  # fmt: skip
            continue
        covered_openings.update(idx)
        if is_via:
            continue  # via opening sizes are not a book rule; a tented via touching a pad's opening is normal
        best_open = max((m.polys[i] for i in idx), key=lambda p: p.intersection(pad).area)
        uncovered = pad.difference(best_open.buffer(TOL))
        if uncovered.area > 0.002:  # > arc-approximation noise between two same-size circles
            d = uncovered.area
            smaller.append(_item(m.copper, "opening_smaller_than_pad", len(smaller), pad, 0.3, round(d, 3), None,
                                 f"{m.name} 开窗小于焊盘（露铜 {d:.3f} mm²）", None))  # fmt: skip
            continue
        exp = best_open.boundary.distance(pad)
        if below(exp, cov):
            expansion.append(_item(m.copper, "mask_expansion", len(expansion), pad, 0.3, round(exp, 4), cov,
                                   f"{m.name} 开窗只比焊盘大 {fmt_mm(exp)} < {fmt_mm(cov)}", None))  # fmt: skip
        elif regen and exp > cov + 0.01:
            # this factory remakes every pad opening as the final pad + coverage (set/: the customer's
            # 4 mil Altium openings came back as 2 mil); only a pad's own flash is touched
            larger.append(_item(m.copper, "opening_larger_than_pad", len(larger), pad, 0.3, round(exp, 4), cov,
                                f"{m.name} 开窗比焊盘大 {fmt_mm(exp)} > {fmt_mm(cov)}（厂规：开窗 = 焊盘 + {fmt_mm(cov)}）", None))  # fmt: skip
    # coverage: other copper (not the pad's own polygon) closer than cov to an opening
    if m.copper.tree is not None and m.tree is not None:
        for oi, opening in enumerate(m.polys):
            owners = {int(i) for i in m.copper.tree.query(opening, predicate="intersects")}
            for ci in m.copper.tree.query(opening, predicate="dwithin", distance=cov):
                ci = int(ci)
                if ci in owners:
                    continue
                d = m.copper.polys[ci].distance(opening)
                if below(d, cov):
                    seg = shortest_line(m.copper.polys[ci], opening)
                    coverage.append(_item(m.copper, "mask_coverage", len(coverage), seg, 0.3, round(d, 4), cov,
                                          f"{m.name} 铜距开窗 {fmt_mm(d)} < {fmt_mm(cov)}（盖线位不足）", None))  # fmt: skip
                    break
    # openings that sit on copper but on no pad (drawn opening over a trace)
    for oi, opening in enumerate(m.polys):
        if oi in covered_openings:
            continue
        on_copper = opening.intersects(m.copper.geom)
        on_hole = htree is not None and len(htree.query(opening, predicate="intersects")) > 0
        if on_copper and not on_hole:
            not_pad.append(_item(m.copper, "opening_not_pad", len(not_pad), opening, 0.3, round(opening.area, 3), None,
                                 f"{m.name} 开窗对应线路不是 PAD（开在线/铜皮上）", None))  # fmt: skip
    L = m.rel
    return {
        "opening_smaller_than_pad": aggregate(items, smaller, kind="opening_smaller_than_pad", layer=L,
            message=f"{m.name} 开窗小于焊盘（p141 步骤3）",
            eq_question=f"{m.name} 有开窗小于对应焊盘，请客户确认按焊盘加大开窗",
            fix=draft_fix("MaskResize", "resize_opening", f"# {L}: Edit → Resize → Global 加大开窗到 ≥ 焊盘 + 2×{cov:.3f}mm (p141)\nCOM sel_resize,size=<mil>  【待验证】")),
        "opening_larger_than_pad": aggregate(items, larger, kind="opening_larger_than_pad", layer=L, severity="info", threshold=cov,
            message=f"{m.name} 开窗按厂规重做为焊盘 + {fmt_mm(cov)}（缩小）",
            fix=draft_fix("MaskResize", "resize_opening_down", f"# {L}: 焊盘自己的开窗 Change Symbol 到 焊盘 + 2×{cov:.4f}mm（工厂标准：阻焊按最终焊盘重做）  【待验证】")),
        "mask_expansion": aggregate(items, expansion, kind="mask_expansion", layer=L, severity="warn", threshold=cov,
            message=f"{m.name} 开窗比焊盘大 < {fmt_mm(cov)}（p141 要求1）",
            fix=draft_fix("MaskResize", "resize_opening", f"# {L}: Edit → Resize → Global，整层加大 (p141 步骤3)\nCOM affected_layer,name={L},mode=single,affected=yes\nCOM sel_resize,size={2 * cov / _MIL:.0f}  【待验证】")),
        "missing_opening": aggregate(items, missing, kind="missing_opening", layer=L,
            message=f"{m.name} 焊盘无开窗（p143 Missing）",
            eq_question=f"{m.name} 有元件/贴片焊盘没有阻焊开窗，请客户确认是否需要开窗",
            fix=draft_fix("MaskConstructPads", "add_opening", f"# {L}: 以线路 PAD 为参考补开窗 DFM → Cleanup → Construct Pads by Reference (p141)  【待验证】")),
        "mask_coverage": aggregate(items, coverage, kind="mask_coverage", layer=L, severity="warn", threshold=cov,
            message=f"{m.name} 盖线位 < {fmt_mm(cov)}（p143 Coverage）",
            fix=draft_fix("MaskOptimize", "optimize_mask", f"# {L}: DFM → Optimization → Solder Mask Optimization（只跑一次 p142）  【待验证】")),
        "opening_not_pad": aggregate(items, not_pad, kind="opening_not_pad", layer=L, severity="warn",
            message=f"{m.name} 开窗对应线路不是 PAD（p141 步骤1）",
            eq_question=f"{m.name} 有开窗开在线路/铜皮上而不是焊盘上，请客户确认是否为测试点/散热开窗",
            fix=draft_fix("MaskConstructPads", "construct_pads", f"# 外层线路：DFM → Cleanup → Construct Pads (Auto) 参考 {L} (p136)  【待验证】")),
    }  # fmt: skip


def report_fiducials(m: MaskLayer, items: list[ReportItem]) -> int:
    """p144 注意：客户设计光标点阻焊开窗很大（上大铜皮），一般不要缩小开窗按原稿制作。
    Fiducial pads (aperture function or a round pad whose opening is ≥ 2× the pad) are listed as info so
    MaskOptimize / MaskResize do not shrink them; nothing to decide."""
    if m.copper is None or m.tree is None:
        return 0
    found: list[ReportItem] = []
    for o, pad, fn in _flashes(m.copper):
        idx = m.openings_at(pad)
        if not idx:
            continue
        opening = max((m.polys[i] for i in idx), key=lambda p: p.intersection(pad).area)
        is_fid = "Fiducial" in fn
        if not is_fid:
            circ = 4 * math.pi * pad.area / max(pad.length ** 2, 1e-9)  # 1 = circle
            is_fid = circ > 0.9 and opening.area >= 2.0 * pad.area and opening.contains(pad)
        if not is_fid:
            continue
        it = _item(m.copper, "fiducial_opening", len(found), opening, 0.3, round(opening.area / max(pad.area, 1e-9), 2), None,
                   f"{m.name} 光标点开窗为焊盘的 {opening.area / max(pad.area, 1e-9):.1f} 倍{'（' + fn + '）' if fn else ''}，按原稿保留，优化时不缩小", None)  # fmt: skip
        it.severity = "info"
        found.append(it)
    return aggregate(items, found, kind="fiducial_opening", layer=m.rel, severity="info",
                     message=f"{m.name} 光标点开窗按原稿保留（p144 注意）",
                     fix=draft_fix("MaskOptimize", "keep_fiducial", f"# {m.rel}: 阻焊优化前把光标点开窗移出/加 .fiducial 属性，优化后移回 (p144)  【待验证】"))  # fmt: skip


def check_paste_vs_openings(m: MaskLayer, paste: BaseGeometry | None, items: list[ReportItem]) -> int:
    """p144 注意 4：客户提供有贴片层的一定要对，看阻焊是否都有开窗。Every paste pad needs an opening."""
    if paste is None or paste.is_empty:
        return 0
    found: list[ReportItem] = []
    for pp in iter_polygons(paste):
        if pp.area < 0.01:
            continue
        idx = m.openings_at(pp)
        covered = any(m.polys[i].intersection(pp).area > 0.5 * pp.area for i in idx)
        if not covered:
            found.append(_item(m.copper or _dummy(m.rel), "paste_without_opening", len(found), pp, 0.3, round(pp.area, 3), None,
                               f"{m.name} 贴片层焊盘处阻焊无开窗/开窗不足（{pp.area:.2f} mm²）", None))  # fmt: skip
    return aggregate(items, found, kind="paste_without_opening", layer=m.rel,
                     message=f"{m.name} 贴片层焊盘无阻焊开窗（p144 注意 4）",
                     eq_question=f"{m.name} 有贴片层（钢网）焊盘位置没有阻焊开窗，与贴片层不一致，请客户确认以哪个为准",
                     fix=draft_fix("MaskConstructPads", "add_opening", f"# {m.rel}: 按贴片层补开窗 DFM → Cleanup → Construct Pads by Reference (p141)  【待验证】"))  # fmt: skip


def check_holes(m: MaskLayer, holes: list[Hole], thr: dict[str, float], via_plugging: str | None, items: list[ReportItem]) -> dict[str, int]:
    npth_small: list[ReportItem] = []
    npth_cov: list[ReportItem] = []
    dam: list[ReportItem] = []
    plug_big: list[ReportItem] = []
    n_via_open = n_via_cover = 0
    ovs = thr["npth_opening_oversize_mm"]
    L = m.rel
    for h in holes:
        if h.tool == "notch":
            continue  # a hole breaking through the edge is routed: outlined on the mask like the profile, not opened
        disc = h.geom()
        idx = m.openings_at(disc)
        if h.attribute == "non_plated":
            if not idx:
                npth_cov.append(_item(m.copper or _dummy(L), "npth_covered", len(npth_cov), disc, 0.4, 0, ovs,
                                      f"{m.name} NPTH {h.tool} ⌀{h.dia} 无开窗（盖油需加挡点 p144）", None))  # fmt: skip
                continue
            opening = max((m.polys[i] for i in idx), key=lambda p: p.intersection(disc).area)
            exp = opening.boundary.distance(disc) if opening.contains(disc) else 0.0
            if below(exp, ovs):
                npth_small.append(_item(m.copper or _dummy(L), "npth_opening_small", len(npth_small), disc, 0.4, round(exp, 4), ovs,
                                        f"{m.name} NPTH {h.tool} ⌀{h.dia} 开窗只比孔大 {fmt_mm(exp)} < {fmt_mm(ovs)}", None))  # fmt: skip
            continue
        if h.attribute not in ("via", "via_plug", "via_tent"):
            continue
        if idx:
            n_via_open += 1
        else:
            n_via_cover += 1
            if h.dia >= thr["via_dam_min_mm"] - 1e-6:
                dam.append(_item(m.copper or _dummy(L), "via_dam_needed", len(dam), disc, 0.4, h.dia, thr["via_dam_min_mm"],
                                 f"{m.name} 盖油过孔 {h.tool} ⌀{h.dia} ≥ {thr['via_dam_min_mm']} 需加挡点", None))  # fmt: skip
        if via_plugging in ("resin", "solder_mask") and h.dia > thr["via_plug_max_mm"] + 1e-6:
            plug_big.append(_item(m.copper or _dummy(L), "via_plug_too_large", len(plug_big), disc, 0.4, h.dia, thr["via_plug_max_mm"],
                                  f"{m.name} 塞孔过孔 {h.tool} ⌀{h.dia} > {thr['via_plug_max_mm']}", None))  # fmt: skip
    if n_via_open or n_via_cover:
        items.append(ReportItem(id=f"via_mask_{L}", kind="via_mask_summary", severity="info", layer=L, measured=n_via_open,
                                message=f"{m.name} 过孔开窗 {n_via_open}、盖油 {n_via_cover}（客户提供 Gerber 按 Gerber 做 p144 注意1）"))  # fmt: skip
    n_plug_open = sum(1 for h in holes if h.attribute in ("via_plug", "via_tent") and m.openings_at(h.geom()))
    cover_mode = str(thr.get("via_opening_delete") or "auto").lower()  # auto | ask | off (the engineer: 「不能直接删除过孔开窗…可以设置一个选项」)
    if n_plug_open and cover_mode == "off":
        items.append(ReportItem(id=f"via_plug_cover_{L}", kind="via_plug_cover", severity="info", layer=L, measured=n_plug_open,
                                message=f"{m.name} 塞孔/盖油过孔仍有开窗 {n_plug_open} 处，按厂 profile 不自动删（mask.via_opening_delete: off），留人工挑选"))  # fmt: skip
    elif n_plug_open:
        # the cover lives in MaskDams: schedule it even when no dam is needed (the 3×3 / 2×2 1oz jobs:
        # npth_dams off, no via ≥ dam size → the op never ran and 1 467 plugged vias stayed open)
        items.append(ReportItem(id=f"via_plug_cover_{L}", kind="via_plug_cover", severity="info", layer=L, measured=n_plug_open,
                                message=f"{m.name} 塞孔/盖油过孔的开窗删掉：共 {n_plug_open} 处（p141）",
                                fix=draft_fix("MaskDams", "cover_plugged_vias", f"# {L}: 钻孔层选 via_plug/via_tent → 删掉其自己的小开窗（塞孔/盖油 p141）  【待验证】")))  # fmt: skip
    return {
        "npth_opening_small": aggregate(items, npth_small, kind="npth_opening_small", layer=L, severity="warn", threshold=ovs,
            message=f"{m.name} NPTH 开窗单边 < {fmt_mm(ovs)}（p141 要求1）",
            fix=draft_fix("MaskResize", "resize_npth_opening", f"# {L}: 选中 NPTH 开窗 → Change Symbol 到 孔径+2×{ovs}mm (p141)  【待验证】")),
        "npth_covered": aggregate(items, npth_cov, kind="npth_covered", layer=L, severity="info",
            message=f"{m.name} NPTH 无开窗：" + (f"按厂规开窗 孔 + {fmt_mm(ovs)}/边（含外形层画的孔）" if thr.get("npth_open_covered") else "盖油需加挡点（p144 #6）"),
            fix=(draft_fix("MaskResize", "open_npth", f"# {L}: 每个无开窗的 NPTH 加 r(孔径+2×{ovs}mm) 的开窗（工厂标准）  【待验证】") if thr.get("npth_open_covered")
                 else draft_fix("MaskDams", "add_npth_dam", f"# 钻孔层选 NPTH → Copy Other Layer 到 {L}（挡点尺寸按工厂标准） (p144)  【待验证】"))),
        "via_dam_needed": aggregate(items, dam, kind="via_dam_needed", layer=L, severity="info", threshold=thr["via_dam_min_mm"],
            message=f"{m.name} ≥{thr['via_dam_min_mm']}mm 盖油过孔需加挡点（p141 要求2）",
            fix=draft_fix("MaskDams", "add_via_dam", f"# 钻孔层选 via ≥{thr['via_dam_min_mm']}mm → Copy Other Layer 到 {L} (p141/p144)  【待验证】")),
        "via_plug_too_large": aggregate(items, plug_big, kind="via_plug_too_large", layer=L, threshold=thr["via_plug_max_mm"],
            message=f"{m.name} 塞孔过孔 > {thr['via_plug_max_mm']}mm（p141 要求2）",
            eq_question=f"订单要求塞孔（{via_plugging}），但有过孔孔径大于 {thr['via_plug_max_mm']}mm 无法塞孔，请客户确认",
            fix=draft_fix("MaskDams", "plug_review", "# 无法塞孔：改为盖油/开窗需客户确认")),
    }  # fmt: skip


def check_slivers(m: MaskLayer, bridge: float, items: list[ReportItem]) -> int:
    if m.tree is None or len(m.polys) < 2:
        return 0
    pairs = m.tree.query(m.polys, predicate="dwithin", distance=bridge)
    seen: set[tuple[int, int]] = set()
    new: list[ReportItem] = []
    for a, b in zip(pairs[0].tolist(), pairs[1].tolist()):
        if a >= b or (a, b) in seen:
            continue
        seen.add((a, b))
        seg = shortest_line(m.polys[a], m.polys[b])
        d = seg.length
        if d < TOUCH or not below(d, bridge):
            continue
        new.append(_item(m.copper or _dummy(m.rel), "mask_sliver", len(new), seg, 0.3, round(d, 4), bridge,
                         f"{m.name} 开窗间阻焊桥 {fmt_mm(d)} < {fmt_mm(bridge)}", None))  # fmt: skip
    return aggregate(items, new, kind="mask_sliver", layer=m.rel, threshold=bridge,
        message=f"{m.name} 阻焊桥宽 < {fmt_mm(bridge)}（p141 要求5 / p143 Bridge·Sliver）",
        eq_question=f"{m.name} 有 IC 引脚间阻焊桥低于该油色可做最小值 {fmt_mm(bridge)}，请客户确认是否合并开窗（不做桥）",
        fix=draft_fix("MaskOptimize", "optimize_mask", f"# {m.rel}: Solder Mask Optimization 阻焊桥参数 = {bridge / _MIL:.0f}mil，不够则削开窗或合并 (p142)  【待验证】"))  # fmt: skip


def check_profile(m: MaskLayer, profile: BaseGeometry | None, min_d: float, items: list[ReportItem]) -> int:
    if profile is None or m.tree is None:
        return 0
    boundary = profile.boundary
    new: list[ReportItem] = []
    for i in m.tree.query(boundary, predicate="dwithin", distance=min_d):
        p = m.polys[int(i)]
        d = p.distance(boundary)
        if not below(d, min_d):
            continue
        new.append(_item(m.copper or _dummy(m.rel), "mask_to_profile", len(new), shortest_line(p, boundary), 0.3, round(d, 4), min_d,
                         f"{m.name} 开窗距板边 {fmt_mm(d)} < {fmt_mm(min_d)}", None))  # fmt: skip
    return aggregate(items, new, kind="mask_to_profile", layer=m.rel, severity="warn", threshold=min_d,
        message=f"{m.name} 开窗距板边 < {fmt_mm(min_d)}（p143 Rout）",
        fix=draft_fix("MaskChecks", "review", "# 金手指/金属包边位开通窗属正常，其余需确认"))  # fmt: skip


def report_non_pad_objects(m: MaskLayer, items: list[ReportItem]) -> int:
    from gerbonara import graphic_objects as go

    n = sum(1 for o in m.objects if not isinstance(o, go.Flash))
    if n:
        items.append(ReportItem(
            id=f"mask_not_pad_{m.rel}", kind="mask_not_pad_objects", severity="info", layer=m.rel, measured=n,
            message=f"{m.name} 有 {n} 个非 PAD 物件（线/面画的开窗），Genesis 需转 PAD（p141 步骤2）",
            fix=draft_fix("MaskConstructPads", "construct_pads", f"# {m.rel}: Features Histogram 选非 PAD 物件 → DFM → Cleanup → Construct Pads by Reference (p141)  【待验证】", {"count": n}),
        ))  # fmt: skip
    return n


def _dummy(rel: str) -> CopperLayer:
    return CopperLayer(rel=rel, layer_type="top_copper", polarity="positive", geom=Polygon(), objects=[])


# ---------------------------------------------------------------------------------------------
def run_mask_stage(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="mask", status="failed", summary="no layer_map (run intake first)")
    files = lm.get("files", [])
    masks = [e for e in files if e.get("type") in MASK_TYPES]
    if not masks:
        return StageReport(stage="mask", status="ok", summary="无阻焊层")
    thr = ctx.profile["mask"]
    spec = ctx.request.order_spec or {}
    bridge = bridge_min_for(spec.get("solder_mask_color"), thr["bridge_min_mm"])
    holes = load_holes(ctx, lm)
    profile = load_profile(ctx)
    coppers = {e["type"]: e for e in files if e.get("type") in ("top_copper", "bottom_copper")}
    pastes = {e["type"]: e for e in files if e.get("type") in ("top_paste", "bottom_paste")}
    to_fold = [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in masks + list(coppers.values()) + list(pastes.values())]
    folded = fold_many(ctx.cache_dir, to_fold)
    from engine.checks import gold_finger as gfc
    zones = gfc.zones_from_layer_map(ctx, lm)
    stats: dict[str, Any] = {"layers": {}, "bridge_min_mm": bridge, "via_plugging": spec.get("via_plugging"), "gold_finger_zones": len(zones)}
    for e in masks:
        rel = e["file"]
        res = folded.get(rel)
        if isinstance(res, Exception) or res is None:
            items.append(ReportItem(id=f"parse_{rel}", kind="layer_parse_error", severity="error", layer=rel,
                                    message=f"无法解析 {rel}: {res}", eq_question=f"文件 {rel} 无法解析，请客户重新导出"))  # fmt: skip
            continue
        cu_entry = coppers.get(_SIDE_COPPER[e["type"]])
        copper = None
        if cu_entry and not isinstance(folded.get(cu_entry["file"]), Exception) and folded.get(cu_entry["file"]) is not None:
            copper = CopperLayer(rel=cu_entry["file"], layer_type=cu_entry["type"], polarity="positive",
                                 geom=folded[cu_entry["file"]], objects=list(open_camfile(ctx.layer_path(cu_entry["file"]), cu_entry["type"]).objects))  # fmt: skip
        m = MaskLayer(rel=rel, layer_type=e["type"], geom=res, objects=list(open_camfile(ctx.layer_path(rel), e["type"]).objects), copper=copper)
        s: dict[str, Any] = {"openings": len(m.polys), "copper": cu_entry["file"] if cu_entry else None}
        if copper is None:
            items.append(ReportItem(id=f"no_copper_{rel}", kind="mask_no_copper", severity="warn", layer=rel,
                                    message=f"{rel} 找不到同面外层线路，只做孔/桥/板边检查"))  # fmt: skip
        s.update(check_pads_vs_openings(m, holes, thr, items))
        s.update(check_holes(m, holes, thr, spec.get("via_plugging"), items))
        s["mask_sliver"] = check_slivers(m, bridge, items)
        s["mask_to_profile"] = check_profile(m, profile, thr["opening_to_profile_mm"], items)
        s["not_pad_objects"] = report_non_pad_objects(m, items)
        s["fiducial_opening"] = report_fiducials(m, items)
        s["gold_finger_mask_not_full"] = gfc.check_mask(rel, m.name, m.geom, [z for z in zones if z.side == _SIDE_COPPER[e["type"]]], items)
        p_entry = pastes.get(_SIDE_PASTE[e["type"]])
        paste_geom = folded.get(p_entry["file"]) if p_entry else None
        s["paste_without_opening"] = check_paste_vs_openings(m, None if isinstance(paste_geom, Exception) else paste_geom, items)
        stats["layers"][rel] = s
    artifacts = [ctx.write_artifact("check_summary", "mask_checks.json", json.dumps(stats, ensure_ascii=False, indent=1).encode())]
    return StageReport(stage="mask", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)
