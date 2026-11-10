"""Stage ``silk``: 第9章 字符（p145–147）检查 + 板外字符自动删除。"""

from __future__ import annotations

from engine.checks.silk import run_silk_stage
from engine.model.report import StageReport
from engine.pipeline.context import JobContext


def run_silk(ctx: JobContext) -> StageReport:
    return run_silk_stage(ctx)
