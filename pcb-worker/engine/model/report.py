"""StageReport: the unified output schema every pipeline stage emits.

Field shapes mirror the zod schema on the Node side (``modules/pcb-cam/worker-client.ts``);
keep them in sync. Node turns an item into a human EQ when ``eq_question`` is set or when
``severity == "error"`` and its fix was not auto-applied.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Status = Literal["ok", "needs_review", "blocked", "failed"]
Severity = Literal["error", "warn", "info"]

BBoxT = tuple[float, float, float, float]  # [x0, y0, x1, y1] in mm


class Location(BaseModel):
    x: float
    y: float
    bbox: BBoxT | None = None


class Fix(BaseModel):
    type: str
    op: str | None = None  # engine.adapters.CamOp value this fix belongs to (M2+ always set)
    params: dict[str, Any] = Field(default_factory=dict)
    auto_fixable: bool = False
    applied: bool = False
    # 厂规开关的 ask 档：引擎照做了（applied），但这类改动工程师要求必须有人点过 —— 报告项照样进 EQ
    # （洲旭 2026-09-16 回复 C09 确认单：内层删独立 PAD、删塞孔过孔开窗、塞孔分组、过孔预大、相交小孔删除、公差孔）
    confirm: bool = False
    genesis_script: str | None = None


class ReportItem(BaseModel):
    id: str
    kind: str
    severity: Severity
    layer: str | None = None
    location: Location | None = None
    measured: float | str | None = None
    threshold: float | str | None = None
    message: str
    fix: Fix | None = None
    eq_question: str | None = None

    @property
    def needs_decision(self) -> bool:
        """Mirror of the Node-side EQ rule (aios modules/pcb-cam/logic.ts): a fix an executor
        already applied leaves nothing to decide, even when the finding carried an EQ text —
        the person sees it as 已自动 in the report instead of a pending question."""
        if self.fix and self.fix.applied and not self.fix.confirm:
            return False
        return bool(self.eq_question) or self.severity == "error"


class Artifact(BaseModel):
    kind: str
    path: str
    filename: str | None = None
    size: int | None = None
    content_type: str | None = None


class StageReport(BaseModel):
    stage: str
    status: Status
    summary: str = ""
    items: list[ReportItem] = Field(default_factory=list)
    artifacts: list[Artifact] = Field(default_factory=list)
    layer_map: dict[str, Any] | None = None
    order_spec_candidate: dict[str, Any] | None = None
    duration_ms: int | None = None

    @property
    def has_errors(self) -> bool:
        return any(i.severity == "error" for i in self.items)

    @property
    def eq_items(self) -> list[ReportItem]:
        return [i for i in self.items if i.needs_decision]


def derive_status(items: list[ReportItem], *, blocked: bool = False) -> Status:
    """Default status policy: blocked > needs_review (any EQ-worthy item) > ok."""
    if blocked:
        return "blocked"
    if any(i.needs_decision for i in items):
        return "needs_review"
    return "ok"


def summarize(items: list[ReportItem]) -> str:
    n_err = sum(1 for i in items if i.severity == "error")
    n_warn = sum(1 for i in items if i.severity == "warn")
    n_info = sum(1 for i in items if i.severity == "info")
    n_eq = sum(1 for i in items if i.needs_decision)
    return f"{n_err} error, {n_warn} warn, {n_info} info; {n_eq} need decision"
