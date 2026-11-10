"""LiteEngine: the engine this repo *is*. It never mutates customer geometry; every op returns a
report-only record, except the few zero-risk fixes the stages apply themselves (drill oversize
tool table, silk outside-profile delete) which are recorded as applied."""

from __future__ import annotations

from typing import Any

from engine.adapters.base import OPS, CamEngine, CamOp

LITE_APPLIES = {CamOp.RESIZE_DRILLS, CamOp.DELETE_OUTSIDE_PROFILE, CamOp.EXPORT_EXCELLON, CamOp.EXPORT_GERBER, CamOp.SET_DRILL_ATTRS}


class LiteEngine(CamEngine):
    name = "lite"

    def supports(self, op: CamOp) -> bool:
        return OPS[op].lite in ("implemented", "partial")

    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:
        applied = op in LITE_APPLIES and OPS[op].lite in ("implemented", "partial")
        return {"engine": self.name, "op": op.value, "applied": applied, "mode": "auto" if applied else "report_only", "params": params}
