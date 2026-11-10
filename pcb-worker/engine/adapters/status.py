"""The per-op routing table (``status.yaml``) and the ``HybridEngine`` that follows it."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml

from engine.adapters.base import CamEngine, CamOp
from engine.model.plan import ExecResult, OpCall, OpPlan

GenesisStatus = Literal["unverified", "verified", "failed"]
NativeStatus = Literal["none", "in_stage", "partial", "verified"]
GENESIS_STATES: tuple[str, ...] = ("unverified", "verified", "failed")
NATIVE_STATES: tuple[str, ...] = ("none", "in_stage", "partial", "verified")
STATUS_FILE = Path(__file__).with_name("status.yaml")


@dataclass(frozen=True)
class OpStatus:
    op: CamOp
    genesis: str
    native: str


@lru_cache(maxsize=1)
def load_status(path: Path = STATUS_FILE) -> dict[CamOp, OpStatus]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rows = doc.get("ops") or {}
    out: dict[CamOp, OpStatus] = {}
    for op in CamOp:
        row = rows.get(op.value)
        if row is None:
            raise ValueError(f"status.yaml: missing row for {op.value}")
        g, n = row.get("genesis"), row.get("native")
        if g not in GENESIS_STATES or n not in NATIVE_STATES:
            raise ValueError(f"status.yaml: bad values for {op.value}: {row}")
        out[op] = OpStatus(op, g, n)
    extra = set(rows) - {o.value for o in CamOp}
    if extra:
        raise ValueError(f"status.yaml: unknown ops {sorted(extra)}")
    return out


Route = Literal["already_applied", "native", "genesis", "report_only"]


def route(call: OpCall, *, native: CamEngine | None, genesis_configured: bool) -> Route:
    if call.applied:
        return "already_applied"
    op = call.cam_op
    if op is None:
        return "report_only"
    st = load_status()[op]
    if st.native == "verified" and native is not None and native.supports(op):
        return "native"
    if genesis_configured:
        return "genesis"
    return "report_only"


class HybridEngine(CamEngine):
    """Execute a plan op by op, each through the executor the routing table trusts for it.

    ``native`` is the B-line engine (may be None until B1 lands), ``genesis`` the A-line adapter
    (delivery only; execution results come back asynchronously via ``read_result``).
    """

    name = "hybrid"

    def __init__(self, *, native: CamEngine | None = None, genesis: CamEngine | None = None, genesis_configured: bool = False) -> None:
        self.native = native
        self.genesis = genesis
        self.genesis_configured = genesis_configured and genesis is not None

    def supports(self, op: CamOp) -> bool:
        return True

    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:
        return {"engine": self.name, "op": op.value, "applied": False, "mode": "report_only", "params": params}

    def execute(self, plan: OpPlan) -> list[ExecResult]:
        if not plan.ok:
            return [ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="skipped", applied=False,
                               detail="plan invalid: " + "; ".join(plan.problems)) for c in plan.calls]  # fmt: skip
        out: list[ExecResult] = []
        for c in plan.calls:
            r = route(c, native=self.native, genesis_configured=self.genesis_configured)
            if r == "already_applied":
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine="lite", mode="already_applied", applied=True))
            elif r == "native":
                assert self.native is not None
                out.extend(self.native.execute(OpPlan(job=plan.job, stages=plan.stages, calls=[c])))
            elif r == "genesis":
                assert self.genesis is not None
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.genesis.name, mode="delivered", applied=False,
                                      detail="awaiting Genesis result"))  # fmt: skip
            else:
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="report_only", applied=False))
        return out
