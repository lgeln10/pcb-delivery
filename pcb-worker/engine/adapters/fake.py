"""FakeEngine: pretends every op succeeded. For tests and for demoing the Genesis path without a
Genesis host (``PCB_CAM_ENGINE=fake``). Records the call log so tests can assert sequences."""

from __future__ import annotations

from typing import Any

from engine.adapters.base import CamEngine, CamOp


class FakeEngine(CamEngine):
    name = "fake"

    def __init__(self) -> None:
        self.calls: list[tuple[CamOp, dict[str, Any]]] = []

    def supports(self, op: CamOp) -> bool:
        return True

    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((op, dict(params)))
        return {"engine": self.name, "op": op.value, "applied": True, "mode": "simulated", "params": params}
