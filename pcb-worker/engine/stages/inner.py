"""Stage ``inner``: 第6章 内层（负片 p119–121 / 正片 p122–129）检查，只报告。"""

from __future__ import annotations

from engine.checks.copper import run_copper_stage
from engine.model.report import StageReport
from engine.pipeline.context import JobContext


def run_inner(ctx: JobContext) -> StageReport:
    return run_copper_stage(ctx, "inner")
