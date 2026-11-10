"""Stage ``panel``: 第10章 拼板方案计算 + 预览 + StepRepeat/PanelBuild COM 草稿（方案需人 review）。"""

from __future__ import annotations

import json

from engine.checks.common import draft_fix, load_profile
from engine.model.report import Fix, ReportItem, StageReport, derive_status, summarize
from engine.panel.plan import com_draft, panel_svg, parse_panelization, plan_candidates, set_size
from engine.pipeline.context import JobContext


def run_panel(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    profile = load_profile(ctx)
    if profile is None:
        items.append(ReportItem(id="no_profile", kind="panel_no_profile", severity="error", message="没有 Profile（align 未闭合外形），无法计算拼板",
                                eq_question="外形未闭合，无法拼板；请先解决外形问题"))  # fmt: skip
        return StageReport(stage="panel", status=derive_status(items), summary=summarize(items), items=items)
    cfg = ctx.profile["panel"]
    spec = ctx.request.order_spec or {}
    x0, y0, x1, y1 = profile.bounds
    # p148–151 customer SET: when the sentence parses (N×M, 间距, 工艺边) the working panel is planned
    # from the SET block, not the single unit; otherwise a person lays the SET out (EQ below)
    parsed = parse_panelization(spec.get("panelization"))
    unit = profile
    if parsed:
        from shapely.geometry import box

        sw, sh = set_size(parsed, x1 - x0, y1 - y0)
        unit = box(0, 0, sw, sh)
        parsed = {**parsed, "set_w": round(sw, 3), "set_h": round(sh, 3), "unit_w": round(x1 - x0, 3), "unit_h": round(y1 - y0, 3)}
    cands = plan_candidates(unit, cfg)
    if not cands:
        items.append(ReportItem(id="no_fit", kind="panel_no_fit", severity="error", measured=f"{x1 - x0:.1f}×{y1 - y0:.1f}",
                                message=f"单只 {x1 - x0:.1f}×{y1 - y0:.1f} mm 放不进任何工作板 {cfg['working_panels_mm']}（板边 {cfg['rail_mm']}）",
                                eq_question="单只尺寸超过工厂工作板，请确认是否分板或换开料尺寸"))  # fmt: skip
        return StageReport(stage="panel", status=derive_status(items), summary=summarize(items), items=items)
    best = cands[0]
    svg = panel_svg(best, unit)
    (ctx.work_dir / "cache").mkdir(parents=True, exist_ok=True)
    (ctx.work_dir / "cache" / "_panel.svg").write_text(svg, encoding="utf-8")
    plan = {
        "unit_mm": [round(x1 - x0, 3), round(y1 - y0, 3)], "unit_area_mm2": round(profile.area, 2),
        "chosen": best.public(), "candidates": [c.public() for c in cands[:8]],
        "customer_panelization": spec.get("panelization"), "rail_mm": cfg["rail_mm"], "gap_mm": cfg["gap_mm"], "set": parsed,
    }  # fmt: skip
    artifacts = [
        ctx.write_artifact("dfm_report", "panel.json", json.dumps(plan, ensure_ascii=False, indent=1).encode()),
        ctx.write_artifact("preview_svg", "panel.svg", svg.encode("utf-8")),
    ]
    script = com_draft(ctx.job_id, best, unit)
    what = f"SET {parsed['nx']}×{parsed['ny']}（{parsed['set_w']}×{parsed['set_h']} mm）" if parsed else "单只"
    items.append(ReportItem(
        id="panel_plan", kind="panel_plan", severity="info", measured=best.count, threshold=round(best.utilization * 100, 1),
        message=f"拼板方案：工作板 {best.panel_w}×{best.panel_h} mm，{what} {best.nx}×{best.ny}={best.count} 块，旋转 {best.rotation}°，利用率 {best.utilization * 100:.1f}%（候选 {len(cands)} 个，见 panel.json；预览 _panel）",
        fix=Fix(type="panel_build", op="PanelBuild", params={"nx": best.nx, "ny": best.ny, "panel": [best.panel_w, best.panel_h], "rotation": best.rotation, "set": parsed}, auto_fixable=False, applied=False, genesis_script=script),
    ))  # fmt: skip
    if parsed:
        dx, dy = parsed["unit_w"] + parsed["gap_mm"], parsed["unit_h"] + parsed["gap_mm"]
        rail = parsed["rail_mm"]
        ox = rail if parsed["rails"] in ("lr", "all") else 0.0
        oy = rail if parsed["rails"] in ("tb", "all") else 0.0
        items.append(ReportItem(
            id="panel_customer", kind="panel_customer_spec", severity="warn", measured=str(spec["panelization"])[:120],
            message=f"客户拼板要求已解析：{parsed['nx']}×{parsed['ny']}，间距 {parsed['gap_mm']} mm，工艺边 {rail} mm（{parsed['rails']}）{'，V-CUT' if parsed['vcut'] else ''}{'，邮票孔' if parsed['stamp'] else ''} → SET {parsed['set_w']}×{parsed['set_h']} mm；请与前版本核对工艺边（p151）",
            eq_question=f"客户拼板要求已按 {parsed['nx']}×{parsed['ny']}、间距 {parsed['gap_mm']} mm、工艺边 {rail} mm 排 SET，请工程师核对工艺边/V-CUT 与前版本一致（p151），不一致请改 SET",
            fix=Fix(type="step_repeat", op="StepRepeat", params={"customer": spec["panelization"], **{k: parsed[k] for k in ("nx", "ny", "gap_mm", "rail_mm", "rails", "vcut")}}, auto_fixable=False, applied=False,
                    genesis_script=f"# SET 成品拼板（p149）：{parsed['nx']}×{parsed['ny']}，间距 {parsed['gap_mm']}，工艺边 {rail}\nCOM create_entity,job=<job>,name=set,type=step  【待验证】\nCOM open_entity,job=<job>,type=step,name=set  【待验证】\nCOM sr_tab_reset  【待验证】\nCOM sr_tab_add,line=1,step=edit,x={ox:.3f},y={oy:.3f},nx={parsed['nx']},ny={parsed['ny']},dx={dx:.3f},dy={dy:.3f},angle=0,mirror=no,flip=no  【待验证】\nCOM profile_rect,x1=0,y1=0,x2={parsed['set_w']:.3f},y2={parsed['set_h']:.3f}  【待验证】\nCOM set_step_datum,x=0,y=0  【待验证】"),
        ))  # fmt: skip
    elif spec.get("panelization"):
        items.append(ReportItem(
            id="panel_customer", kind="panel_customer_spec", severity="warn", measured=str(spec["panelization"])[:120],
            message=f"客户拼板要求：「{str(spec['panelization'])[:120]}」—— 无法自动解析，需工程师排 SET 后与上面方案核对（p151 工艺边参考前版本须一致）",
            eq_question="客户资料给了拼板/工艺边要求，请工程师确认按客户要求做 SET（成品拼板），生产 panel 按工厂方案",
            fix=Fix(type="step_repeat", op="StepRepeat", params={"customer": spec["panelization"]}, auto_fixable=False, applied=False,
                    genesis_script="# SET 成品拼板按客户要求：Step → Panelization → Step Repeat Table (p149)，镜像 No  【待验证】"),
        ))  # fmt: skip
    report_punch(ctx, spec, profile, items)
    if len(cands) > 1 and cands[1].count == best.count:
        items.append(ReportItem(id="panel_tie", kind="panel_alternatives", severity="info", measured=cands[1].count,
                                message=f"另有同产量方案：{cands[1].panel_w}×{cands[1].panel_h} 旋转 {cands[1].rotation}° 利用率 {cands[1].utilization * 100:.1f}%"))  # fmt: skip
    return StageReport(stage="panel", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)


PUNCH_HINTS = ("模冲", "冲板", "冲压", "punch", "die")


def report_punch(ctx: JobContext, spec: dict, profile, items: list[ReportItem]) -> int:
    """第13章 p174 模冲: when the order asks for a punched outline, list the four NPTH holes best
    placed as die locators (largest, nearest the corners), remind about 防爆孔 at slot ends /
    corners and the punch direction — the die drawing itself is the tooling shop's."""
    text = " ".join(str(v) for v in (spec.get("special_process") or [])) + " " + " ".join(str(v) for v in (spec.get("customer_notes") or []))
    if not any(k in text.lower() for k in PUNCH_HINTS):
        return 0
    from engine.checks.common import load_holes

    lm = ctx.layer_map() or {}
    npth = [h for h in load_holes(ctx, lm) if h.attribute == "non_plated" and not h.slot]
    x0, y0, x1, y1 = profile.bounds
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    picks = []
    for cx, cy in corners:
        cand = [h for h in npth if h.dia >= 1.4 and h not in picks]
        if cand:
            picks.append(min(cand, key=lambda h: (h.x - cx) ** 2 + (h.y - cy) ** 2))
    loc = "、".join(f"{h.tool} ⌀{h.dia} @({h.x:.1f},{h.y:.1f})" for h in picks) or "板上没有 ≥1.5mm 的 NPTH 孔可作定位孔"
    items.append(ReportItem(
        id="punch_design", kind="punch_design", severity="warn", measured=len(picks), threshold=4,
        message=f"模冲板（p174）：候选定位孔 {loc}；拐角/槽两端需加防爆孔；模冲图要标数并注明进板方向（倒扣拼板）",
        eq_question="模冲：请确认 4 个定位孔（一般 3.0/2.0/1.5mm 非金属孔）、防爆孔位置与模冲进板方向，外形标数用 CAD 出图 (p174)",
        fix=draft_fix("RoutDesign", "punch_design", "# 模冲：外形 → AutoCAD 标数；定位孔/防爆孔按工厂模具要求  【待验证】", {"locators": [[h.x, h.y, h.dia] for h in picks]}),
    ))  # fmt: skip
    return len(picks)
