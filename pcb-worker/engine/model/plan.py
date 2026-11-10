"""OpPlan: the explicit, validated operation sequence of a job (docs/PLAN_TWO_TRACKS.md §0 S0).

Every stage report carries ``Fix.op`` drafts; the plan is what an *executor* consumes — the
Genesis script translator (A line) or the native geometry engine (B line) — so both see one
ordered, de-duplicated, guard-checked list instead of re-deriving it from report items.

* order: report stage order first, then the book's order inside a stage (``CANON_ORDER``)
* guards (docs/genesis_op_mapping.md 附 C 第 5 条): MaskOptimize ≤1 per layer (p142), NfpRemoval
  only on inner positive layers (p134), SignalLayerOptimize runs two passes 0.1 → 4 (p124),
  ExportExcellon after PanelBuild (p118), NetlistCompare twice — normal + reduced copper (p130)
* ``key`` = sha1(op, layer, params, script) is the idempotency handle: an executor that already
  applied a key must not apply it again on a re-run
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from engine.adapters.base import OPS, CamOp
from engine.model.report import StageReport

#: Ops whose result a person (or the AI judge) must look at before the flow continues.
HUMAN_JUDGEMENT_OPS: frozenset[CamOp] = frozenset({
    CamOp.ALIGN_TO_DRILL, CamOp.BORDER_CLEARANCE, CamOp.CONTOURIZE, CamOp.COPPER_CUTOUT,
    CamOp.SIGNAL_LAYER_OPTIMIZE, CamOp.SIGNAL_LAYER_CHECKS, CamOp.MASK_CHECKS, CamOp.MASK_OPTIMIZE,
    CamOp.NETLIST_COMPARE, CamOp.ROUT_DESIGN, CamOp.SET_SMD_ATTRIBUTE,
    CamOp.DRILL_CHECKS, CamOp.SILK_CHECKS,  # Genesis-side re-checks: someone reads the report before the flow goes on
    CamOp.ADD_HOLES_FROM_DRAWING, CamOp.ADD_TEXT,  # what to add is the customer's / engineer's call
})  # fmt: skip

#: The book's order of operations across the whole flow (第 4–13 章). Inside one report stage
#: calls are sorted by this; across stages the stage order wins (a silk-stage
#: DeleteOutsideProfile stays in silk).
CANON_ORDER: tuple[CamOp, ...] = (
    # 第4章 p110–112
    CamOp.IMPORT_FILES, CamOp.SET_LAYER_TYPES, CamOp.ALIGN_TO_DRILL, CamOp.SET_PROFILE,
    CamOp.DELETE_OUTSIDE_PROFILE, CamOp.COPY_STEP,
    # 第5章 p113–117
    CamOp.ADD_HOLES_FROM_DRAWING, CamOp.SET_DRILL_ATTRS, CamOp.RESIZE_DRILLS, CamOp.DRILL_CHECKS,
    # 第6章负片 p119–121 → 第7章外层前置 p135–137 → 第6/7章正片 p123–129, p138
    CamOp.NEGATIVE_PAD_RESHAPE, CamOp.NFP_REMOVAL, CamOp.MASK_CONSTRUCT_PADS, CamOp.SET_SMD_ATTRIBUTE,
    CamOp.CONTOURIZE, CamOp.LINE_COMPENSATION, CamOp.TERMINAL_PAD, CamOp.COPPER_CUTOUT, CamOp.SIGNAL_LAYER_OPTIMIZE,
    CamOp.TEARDROPS, CamOp.NPTH_CLEARANCE, CamOp.SLIVER_FILL, CamOp.VCUT_COUPON, CamOp.RAIL_FILL, CamOp.VCUT_CLEARANCE, CamOp.BORDER_CLEARANCE,
    CamOp.SIGNAL_LAYER_CHECKS,
    # 第8章 p141–144
    CamOp.MASK_RESIZE, CamOp.MASK_OPTIMIZE, CamOp.MASK_CHECKS, CamOp.MASK_DAMS,
    # 第9章 p145–146
    CamOp.SILK_TRANSFORM, CamOp.SILK_CHECKS, CamOp.SILK_CLEAR_BY_MASK, CamOp.ADD_TEXT,
    # 第6章收尾 p130
    CamOp.NETLIST_EXTRACT, CamOp.NETLIST_COMPARE,
    # 第10/13章 p148–155, p170–174
    CamOp.STEP_REPEAT, CamOp.PANEL_BUILD, CamOp.PATTERN_FILL, CamOp.ADD_TOOLING, CamOp.ROUT_DESIGN,
    # 第11章 p156–158
    CamOp.EXPORT_EXCELLON, CamOp.EXPORT_GERBER,
)
assert set(CANON_ORDER) == set(CamOp), "CANON_ORDER must list every op exactly once"
_CANON_IDX = {op: i for i, op in enumerate(CANON_ORDER)}

#: p124: run SLO first with a tiny spacing so pads grow as much as possible, then with the real one.
SLO_PASSES: tuple[dict[str, Any], ...] = ({"spacing_mil": 0.1, "note": "第一遍：让 PAD 尽量加大 (p124)"}, {"spacing_mil": 4, "note": "第二遍：正常间距 (p124)"})

ExecMode = Literal["already_applied", "native", "delivered", "simulated", "report_only", "skipped"]


class OpCall(BaseModel):
    n: int
    stage: str
    op: str
    layer: str | None = None
    layer_type: str | None = None
    polarity: str | None = None
    step: str = "edit"
    params: dict[str, Any] = Field(default_factory=dict)
    kind: str
    item_ids: list[str] = Field(default_factory=list)
    needs_human: bool = False
    applied: bool = False
    script: str | None = None
    pages: tuple[int, ...] = ()
    key: str

    @property
    def cam_op(self) -> CamOp | None:
        try:
            return CamOp(self.op)
        except ValueError:
            return None


class OpPlan(BaseModel):
    job: str
    stages: list[str] = Field(default_factory=list)
    calls: list[OpCall] = Field(default_factory=list)
    problems: list[str] = Field(default_factory=list)  # hard guard violations: do not execute
    notes: list[str] = Field(default_factory=list)  # collapsed duplicates, injected mandatory ops

    @property
    def ok(self) -> bool:
        return not self.problems

    def by_op(self, op: CamOp) -> list[OpCall]:
        return [c for c in self.calls if c.op == op.value]


class ExecResult(BaseModel):
    """What an executor did with one ``OpCall``; maps back onto ``Fix.applied`` by ``key``."""

    n: int
    op: str
    layer: str | None = None
    key: str
    engine: str
    mode: ExecMode
    applied: bool
    detail: str = ""


def _key(op: str, layer: str | None, params: dict[str, Any], script: str | None) -> str:
    raw = json.dumps([op, layer, params, (script or "").strip()], sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _layer_info(layer_map: dict[str, Any] | None, rel: str | None) -> tuple[str | None, str | None]:
    if not layer_map or not rel:
        return None, None
    for e in layer_map.get("files", []):
        if e.get("file") == rel:
            return e.get("type"), e.get("polarity") or ("positive" if e.get("type") else None)
    return None, None


def build_plan(
    job: str, reports: dict[str, StageReport], layer_map: dict[str, Any] | None = None, *,
    cfg: dict[str, Any] | None = None, applied_keys: set[str] | None = None, skeleton: bool = True, data: dict[str, Any] | None = None,
) -> OpPlan:
    """Collect every ``Fix.op`` of every report into one ordered plan, add the book's mandatory
    skeleton for the stages that ran (``engine.model.skeleton``; findings win over the skeleton
    on the same op+layer), mark calls whose key an executor already applied, then validate."""
    from engine.pipeline.registry import STAGE_NAMES

    calls: list[OpCall] = []
    seen: dict[str, OpCall] = {}
    done = applied_keys or set()
    stages = [s for s in STAGE_NAMES if s in reports]
    for stage in stages:
        for item in reports[stage].items:
            fix = item.fix
            if not fix or not fix.op:
                continue
            params = dict(fix.params)
            if fix.op == CamOp.SIGNAL_LAYER_OPTIMIZE.value and "passes" not in params:
                params["passes"] = [dict(p) for p in SLO_PASSES]
            key = _key(fix.op, item.layer, params, fix.genesis_script)
            if key in seen:
                seen[key].item_ids.append(item.id)
                seen[key].applied = seen[key].applied or fix.applied
                seen[key].needs_human = seen[key].needs_human or bool(item.eq_question)
                continue
            ltype, pol = _layer_info(layer_map, item.layer)
            spec = OPS.get(CamOp(fix.op)) if fix.op in {o.value for o in CamOp} else None
            call = OpCall(
                n=0, stage=stage, op=fix.op, layer=item.layer, layer_type=ltype, polarity=pol,
                params=params, kind=item.kind, item_ids=[item.id],
                needs_human=(spec is not None and spec.op in HUMAN_JUDGEMENT_OPS) or bool(item.eq_question),
                applied=bool(fix.applied) or key in done, script=fix.genesis_script, pages=spec.pages if spec else (), key=key,
            )  # fmt: skip
            seen[key] = call
            calls.append(call)

    plan = OpPlan(job=job, stages=stages, calls=calls)
    if skeleton:
        _inject_skeleton(plan, layer_map, cfg, done, data)
    _inject_mandatory(plan)
    _order(plan)
    _collapse_once_only(plan)
    _order(plan)
    plan.problems = validate(plan)
    return plan


def _inject_skeleton(plan: OpPlan, layer_map: dict[str, Any] | None, cfg: dict[str, Any] | None, done: set[str], data: dict[str, Any] | None = None) -> None:
    """The per-stage / per-layer mandatory ops (docs/PLAN_TWO_TRACKS.md 回顾 ③ 补漏 1): a finding
    that already produced the same op on the same layer wins — the skeleton only fills the gaps."""
    from engine.model.skeleton import skeleton_calls

    # a finding occupies the skeleton slot only for the same step: the drill/output stages' review
    # exports (edit step, applied by lite) must not swallow the panel-step exports
    have = {(c.op, c.layer, c.params.get("step")) for c in plan.calls}
    for d in skeleton_calls(plan.stages, layer_map, cfg, data):
        if (d["op"], d["layer"], d["params"].get("step")) in have:
            continue
        params = dict(d["params"])
        if d["op"] == CamOp.SIGNAL_LAYER_OPTIMIZE.value:
            params["passes"] = [dict(p) for p in SLO_PASSES]
        ltype, pol = _layer_info(layer_map, d["layer"])
        key = _key(d["op"], d["layer"], params, d["script"])
        # a skeleton call is layer-wide: applied once on this layer (by key or by op@layer token) = done
        applied = key in done or f"{d['op']}@{d['layer'] or '-'}" in done
        plan.calls.append(OpCall(
            n=0, stage=d["stage"], op=d["op"], layer=d["layer"], layer_type=ltype, polarity=pol, params=params, kind=d["kind"],
            needs_human=CamOp(d["op"]) in HUMAN_JUDGEMENT_OPS, applied=applied, script=d["script"], pages=d["pages"], key=key,
        ))  # fmt: skip
        have.add((d["op"], d["layer"], params.get("step")))
        plan.notes.append(f"补入必做的 {d['op']} {d['layer'] or '-'}：{d['note']}")


def _inject_mandatory(plan: OpPlan) -> None:
    """Ops the book requires regardless of findings: NetlistCompare twice (p130)."""
    if "net_compare" not in plan.stages:
        return
    have = plan.by_op(CamOp.NETLIST_COMPARE)
    modes = {c.params.get("mode") for c in have}
    for mode, extra in (("normal", {}), ("reduced_copper", {"shrink_mm": 0.15})):
        if mode in modes:
            continue
        params = {"mode": mode, **extra}
        script = (
            "# 网络比较（p130）：Actions → Netlist Analyzer，edit 对 net 比较  【待验证】\n"
            f"COM netlist_compare,job=<job>,step1=net,step2=edit,mode={mode}  【待验证】"
        )
        plan.calls.append(OpCall(
            n=0, stage="net_compare", op=CamOp.NETLIST_COMPARE.value, params=params, kind="netlist_compare_required",
            needs_human=True, script=script, pages=OPS[CamOp.NETLIST_COMPARE].pages,
            key=_key(CamOp.NETLIST_COMPARE.value, None, params, script),
        ))  # fmt: skip
        plan.notes.append(f"补入必做的 NetlistCompare mode={mode}（p130 要求两次）")


def _order(plan: OpPlan) -> None:
    from engine.pipeline.registry import STAGE_NAMES

    sidx = {s: i for i, s in enumerate(STAGE_NAMES)}

    def k(c: OpCall) -> tuple:
        op = c.cam_op
        return (sidx.get(c.stage, 99), _CANON_IDX.get(op, 99) if op else 99, c.layer or "", c.n)

    plan.calls.sort(key=k)
    for i, c in enumerate(plan.calls, 1):
        c.n = i


def _collapse_once_only(plan: OpPlan) -> None:
    """MaskOptimize at most once per layer (p142): later calls fold into the first one."""
    first: dict[str | None, OpCall] = {}
    keep: list[OpCall] = []
    for c in plan.calls:
        if c.op == CamOp.MASK_OPTIMIZE.value:
            if c.layer in first:
                f = first[c.layer]
                f.item_ids.extend(c.item_ids)
                f.needs_human = f.needs_human or c.needs_human
                plan.notes.append(f"MaskOptimize {c.layer or '-'} 第 {c.n} 块并入第 {f.n} 块（p142 只优化一次）")
                continue
            first[c.layer] = c
        keep.append(c)
    plan.calls = keep


def validate(plan: OpPlan) -> list[str]:
    """Hard guards. A non-empty result means: do not translate / execute this plan."""
    problems: list[str] = []
    for c in plan.calls:
        if c.op == CamOp.NFP_REMOVAL.value:
            if c.layer_type is not None and c.layer_type != "inner_copper":
                problems.append(f"[{c.n}] NfpRemoval 只允许内层正片 (p134)，{c.layer} 是 {c.layer_type}")
            if c.polarity == "negative":
                problems.append(f"[{c.n}] NfpRemoval 不能用于负片 (p134)，{c.layer} 是负片")
        if c.op == CamOp.SIGNAL_LAYER_OPTIMIZE.value and len(c.params.get("passes") or []) != 2:
            problems.append(f"[{c.n}] SignalLayerOptimize 必须两遍 0.1 → 4 (p124)，现有 {len(c.params.get('passes') or [])} 遍")
    by_layer: dict[str | None, int] = {}
    for c in plan.by_op(CamOp.MASK_OPTIMIZE):
        by_layer[c.layer] = by_layer.get(c.layer, 0) + 1
    problems += [f"MaskOptimize {ly or '-'} 出现 {n} 次，只允许一次 (p142)" for ly, n in by_layer.items() if n > 1]
    pb = plan.by_op(CamOp.PANEL_BUILD)
    if pb:
        first_panel = min(c.n for c in pb)
        early = [c.n for c in plan.by_op(CamOp.EXPORT_EXCELLON) if c.n < first_panel and c.stage == "output"]
        problems += [f"[{n}] ExportExcellon 必须在 PanelBuild 之后 (p118)" for n in early]
    if "net_compare" in plan.stages:
        modes = {c.params.get("mode") for c in plan.by_op(CamOp.NETLIST_COMPARE)}
        if not {"normal", "reduced_copper"} <= modes:
            problems.append("NetlistCompare 必须两次：normal + reduced_copper (p130)")
    return problems
