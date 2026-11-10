"""Stage ``mask``: 第8章 阻焊（p140–144）检查，只报告。"""

from __future__ import annotations

from engine.checks.mask import run_mask_stage
from engine.model.report import StageReport
from engine.pipeline.context import JobContext


def run_mask(ctx: JobContext) -> StageReport:
    return run_mask_stage(ctx)
