"""order_spec stage — deterministic cross-checks of the AIOS-side spec candidate (第1章 p4 MI 审单).

The LLM (AIOS ``core/llm`` scene ``pcb_cam``) reads the customer's 制作要求 attachments into a
candidate JSON; this stage never touches an LLM. It compares the candidate with what the Gerber /
Excellon package itself says (layer count, blind/buried drills, gold finger, impedance) and with the
factory profile (minimum line / space), and hands the candidate back with a ``_checks`` list the
engineer sees in the confirmation panel. Nothing here is an EQ: the job is already parked at the
「规格确认」stop, the engineer edits the JSON and confirms. The drill table itself is compared in the
``drill`` stage (p113), hole by hole.
"""

from __future__ import annotations

from typing import Any

from engine.model.report import ReportItem, StageReport, summarize
from engine.pipeline.context import JobContext

COPPER_TYPES = ("top_copper", "inner_copper", "bottom_copper")
_MIL = 0.0254
REQUIRED = (("layers", "层数"), ("board_thickness_mm", "板厚"), ("surface_finish", "表面处理"), ("copper_oz.outer", "外层铜厚"))


def _get(d: dict[str, Any], path: str) -> Any:
    cur: Any = d
    for k in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _num(v: Any) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _has(special: Any, *words: str) -> bool:
    text = " ".join(str(s) for s in (special or []) if s is not None)
    return any(w in text for w in words)


def cross_check(candidate: dict[str, Any], layer_map: dict[str, Any] | None, profile: dict[str, Any]) -> tuple[list[dict[str, str]], list[ReportItem]]:
    """Pure: candidate × layer_map × profile → (_checks, report items). Levels: warn = conflict, info = note."""
    checks: list[dict[str, str]] = []
    items: list[ReportItem] = []

    def add(level: str, kind: str, message: str) -> None:
        checks.append({"level": level, "message": message})
        items.append(ReportItem(id=f"{kind}_{len(items)}", kind=kind, severity="warn" if level == "warn" else "info", message=message))

    files = list((layer_map or {}).get("files") or [])
    n_copper = sum(1 for f in files if f.get("type") in COPPER_TYPES)
    blind_files = [f for f in files if f.get("type") == "drill_blind"]
    special = candidate.get("special_process") or []

    # 1. layer count vs Gerber (p4 检查客户资料完整性)
    layers = _num(candidate.get("layers"))
    if layers is not None and n_copper and int(layers) != n_copper:
        add("warn", "order_spec_layers_mismatch", f"附件写 {int(layers)} 层，Gerber 识别到 {n_copper} 个铜层，请核对层数（以 Gerber 为准还是问客户）")
    if layers is None and n_copper:
        add("info", "order_spec_filled_from_gerber", f"附件未写层数，按 Gerber 识别为 {n_copper} 层")
        candidate.setdefault("layers", n_copper)

    # 2. blind / buried vs drill spans (第16章 p202 按客户提供的钻层对应)
    if blind_files and not _has(special, "盲", "埋", "HDI"):
        spans = ", ".join(f"L{f['drill_span'][0]}-L{f['drill_span'][1]}" for f in blind_files if f.get("drill_span"))
        add("warn", "order_spec_blind_unstated", f"钻带含盲/埋孔（{spans or len(blind_files)} 套），附件未写盲埋孔工艺，请与客户确认叠层与钻孔对应")
    if not blind_files and _has(special, "盲", "埋", "HDI"):
        add("warn", "order_spec_blind_missing_drill", "附件要求盲埋孔，但资料包只有通孔钻带，请客户补盲埋孔钻带")

    # 3. inner copper on a two-layer board
    if n_copper == 2 and _num(_get(candidate, "copper_oz.inner")) is not None:
        add("info", "order_spec_inner_copper_on_2l", "双面板附件却给了内层铜厚，忽略该值")

    # 4. customer minimum line / space vs factory capability (第6/7章 profile copper.outer)
    outer = (profile.get("copper") or {}).get("outer") or {}
    for key, cfg_key, label in (("trace", "min_line_width_mm", "线宽"), ("space", "min_spacing_mm", "线距")):
        v_mil = _num(_get(candidate, f"min_trace_space_mil.{key}"))
        cap = _num(outer.get(cfg_key))
        if v_mil is not None and cap is not None and v_mil * _MIL < cap - 1e-6:
            add("warn", "order_spec_below_capability", f"客户最小{label} {v_mil:g} mil 低于工厂标准 {cap / _MIL:.1f} mil，需评审能否制作")

    # 5. special processes implied by other fields (第12/15章)
    if candidate.get("impedance") and not _has(special, "阻抗"):
        add("info", "order_spec_special_implied", "附件有阻抗要求但 special_process 未列「阻抗」，已按有阻抗处理（流程单需阻抗测试条）")
        special = [*special, "阻抗"]
    gf = candidate.get("gold_finger")
    if gf and not _has(special, "金手指"):
        add("info", "order_spec_special_implied", "附件有金手指参数但 special_process 未列「金手指」，已补上")
        special = [*special, "金手指"]
    if _has(special, "金手指") and not (isinstance(gf, dict) and _num(gf.get("bevel_deg")) is not None):
        add("info", "order_spec_gold_finger_bevel", "金手指未写倒角角度（一般 30/45/60°，p160 设计中没有倒角则有问题），请与客户确认")
    if special is not candidate.get("special_process"):
        candidate["special_process"] = special

    # 6. required fields still empty → engineer must fill by hand
    missing = [label for path, label in REQUIRED if _get(candidate, path) in (None, "")]
    if missing:
        add("info", "order_spec_missing", "附件未给出：" + "、".join(missing) + "（请工程师按客户要求手填）")
    return checks, items


def run_order_spec(ctx: JobContext) -> StageReport:
    candidate = dict(ctx.request.order_spec or {})
    checks, items = cross_check(candidate, ctx.layer_map(), ctx.profile)
    candidate["_checks"] = checks
    n_warn = sum(1 for c in checks if c["level"] == "warn")
    summary = f"候选与资料包/工厂标准交叉核对：{n_warn} 处冲突，{len(checks) - n_warn} 条提示；{summarize(items)}"
    return StageReport(stage="order_spec", status="ok", summary=summary, items=items, order_spec_candidate=candidate)
