"""Stage ``outer``: 第7章 外层（p135–139）检查 + SMD 候选 + 线路补偿候选，只报告。"""

from __future__ import annotations

from engine.checks.copper import run_copper_stage
from engine.model.report import StageReport
from engine.pipeline.context import JobContext


def run_outer(ctx: JobContext) -> StageReport:
    return run_copper_stage(ctx, "outer")
