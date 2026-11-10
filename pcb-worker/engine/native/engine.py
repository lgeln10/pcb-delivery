"""NativeEngine (B line): execute ``OpPlan`` calls on the job's layers in Python.

Each op is a function ``(NativeContext, OpCall) -> ChangeSet | None`` registered in ``NATIVE_OPS``
(``engine/native/ops_*.py``). The engine loads the layer the call names (edit copy if one exists),
runs the op inside a ``FeatureLayer`` transaction, and — when something changed — writes the
layer to ``steps/edit/<rel>`` (第4章 p111: orig 不动、edit 改) plus a ``ChangeSet`` summary to
``edit_log/``. Every stage after that reads the edit copy through ``JobContext.layer_path``.

Idempotency: a call whose ``key`` is already in ``edit_log/applied.json`` is not applied again.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shapely import from_wkb
from shapely.geometry.base import BaseGeometry

from engine.adapters.base import CamEngine, CamOp
from engine.geom.features import ChangeSet, FeatureLayer
from engine.model.plan import ExecResult, OpCall, OpPlan
from engine.model.report import ReportItem, StageReport
from engine.pipeline import progress
from engine.pipeline.context import JobContext


class NeedsHuman(Exception):
    """An op that *could* run decided it must not (p121: 不要削掉有用物件; p137: 不要把不是铜皮的物件
    选进来). The engine reports it as skipped + an EQ instead of "applied, no change"."""


#: Ops whose call is scoped by the finding kind (one layer may carry several distinct calls)
#: rather than being layer-wide.
ITEM_ROUTED_OPS: frozenset[CamOp] = frozenset({CamOp.MASK_RESIZE})

OpFn = Callable[["NativeContext", OpCall], ChangeSet | None]


def layer_token(op: str, layer: str | None) -> str:
    return f"{op}@{layer or '-'}"
NATIVE_OPS: dict[CamOp, OpFn] = {}


def native_op(op: CamOp) -> Callable[[OpFn], OpFn]:
    def deco(fn: OpFn) -> OpFn:
        NATIVE_OPS[op] = fn
        return fn

    return deco


@dataclass
class NativeContext:
    ctx: JobContext
    _layers: dict[str, FeatureLayer] = field(default_factory=dict)
    _profile: BaseGeometry | None | bool = False
    #: (kind, filename, data) an op wants published as stage artifacts (panel exports)
    artifacts: list[tuple[str, str, bytes]] = field(default_factory=list)

    # ---- data -----------------------------------------------------------------------------
    @property
    def profile(self) -> BaseGeometry | None:
        if self._profile is False:
            p = self.ctx.work_dir / "profile.wkb"
            self._profile = from_wkb(p.read_bytes()) if p.is_file() else None
        return self._profile  # type: ignore[return-value]

    @property
    def cfg(self) -> dict[str, Any]:
        return self.ctx.profile

    def entries(self) -> list[dict[str, Any]]:
        lm = self.ctx.layer_map() or {}
        return list(lm.get("files", []))

    def entry(self, rel: str | None) -> dict[str, Any] | None:
        return next((e for e in self.entries() if e.get("file") == rel), None)

    def layer(self, rel: str) -> FeatureLayer:
        if rel not in self._layers:
            e = self.entry(rel) or {}
            self._layers[rel] = FeatureLayer.load(self.ctx.layer_path(rel), rel, e.get("type", ""))
        return self._layers[rel]

    def orig_layer(self, rel: str) -> FeatureLayer:
        e = self.entry(rel) or {}
        return FeatureLayer.load(self.ctx.orig_path(rel), rel, e.get("type", ""))

    def details(self, call: OpCall) -> list[ReportItem]:
        """The located detail rows behind a call: this stage's persisted report items with the
        call's kind + layer (``aggregate()`` demotes them to warn but keeps their location)."""
        p = self.ctx.work_dir / "reports" / f"{call.stage}.json"
        if not p.is_file():
            return []
        rep = StageReport.model_validate_json(p.read_text(encoding="utf-8"))
        # mask/silk checks locate their hits on the *copper* pad (same side) — accept those too
        side = self._side(call.layer)
        ok = {call.layer} | ({e["file"] for e in self.entries() if self._side(e.get("file")) == side} if side else set())
        return [i for i in rep.items if i.kind == call.kind and i.layer in ok and i.location is not None and not i.id.endswith("_summary")]

    def _side(self, rel: str | None) -> str | None:
        t = str((self.entry(rel) or {}).get("type", ""))
        return t.split("_", 1)[0] if t.startswith(("top_", "bottom_")) else None

    # ---- bookkeeping ----------------------------------------------------------------------
    @property
    def log_dir(self) -> Path:
        d = self.ctx.work_dir / "edit_log"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def applied_keys(self) -> set[str]:
        p = self.log_dir / "applied.json"
        return set(json.loads(p.read_text(encoding="utf-8"))) if p.is_file() else set()

    def mark_applied(self, key: str, op: str | None = None, layer: str | None = None) -> None:
        """Record the call key and — every native op is layer-wide — an ``op@layer`` token, so the
        same op reaching the plan later under another key (a finding fixed → the mandatory
        skeleton takes its slot) is not applied a second time."""
        keys = self.applied_keys()
        keys.add(key)
        if op:
            keys.add(layer_token(op, layer))
        (self.log_dir / "applied.json").write_text(json.dumps(sorted(keys)), encoding="utf-8")

    def rollback_open(self) -> list[str]:
        """Revert any transaction an op left open when it raised, so the next op on that layer
        does not fail with "transaction already open" and the layer holds no half-applied edit."""
        rolled = []
        for rel, layer in self._layers.items():
            if getattr(layer, "_cs", None) is not None:
                layer.revert()
                rolled.append(rel)
        return rolled

    def save_layer(self, rel: str) -> Path:
        layer = self._layers[rel]
        out = self.ctx.edit_path(rel)
        layer.save(out)
        return out

    def write_changes(self, call: OpCall, cs: ChangeSet) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in (call.layer or "-"))
        p = self.log_dir / f"{call.n:03d}_{call.op}_{safe}.json"
        doc = cs.summary()
        doc.update({"n": call.n, "key": call.key, "stage": call.stage, "kind": call.kind})
        p.write_text(json.dumps(doc, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        return p


class NativeEngine(CamEngine):
    name = "native"

    def __init__(self, ctx: JobContext) -> None:
        self.nctx = NativeContext(ctx)
        self.changes: list[tuple[OpCall, ChangeSet, Path]] = []
        self._ran: set[tuple[str, str | None, str | None]] = set()  # (op, layer[, kind]) run by this engine instance (= this stage run)

    def supports(self, op: CamOp) -> bool:
        return op in NATIVE_OPS

    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:  # pragma: no cover - plan path is execute()
        return {"engine": self.name, "op": op.value, "applied": False, "mode": "report_only", "params": params}

    def execute(self, plan: OpPlan) -> list[ExecResult]:
        out: list[ExecResult] = []
        done = self.nctx.applied_keys()
        ran = self._ran  # every native op is layer-wide: one run per (op, layer), across execute() calls
        for c in plan.calls:
            op = c.cam_op
            if c.applied or c.key in done or (c.kind.startswith("mandatory_") and layer_token(c.op, c.layer) in done):
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="already_applied", applied=True))
                continue
            fn = NATIVE_OPS.get(op) if op else None
            if fn is None:
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="report_only", applied=False))
                continue
            ran_key = (c.op, c.layer, c.kind if op in ITEM_ROUTED_OPS else None)
            if ran_key in ran:
                self.nctx.mark_applied(c.key, c.op, c.layer)
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="native", applied=True, detail="covered by the same op on this layer"))
                continue
            ran.add(ran_key)
            t0 = time.perf_counter()
            work = self.nctx.ctx.work_dir
            progress.emit(work, c.stage, "op_start", f"{c.op} {c.layer or ''}", call=c.n, op=c.op, layer=c.layer, kind=c.kind)
            try:
                cs = fn(self.nctx, c)
            except NeedsHuman as e:
                ran.discard(ran_key)  # a refused call must not "cover" a sibling call of the same op on this layer
                self.nctx.rollback_open()
                progress.emit(work, c.stage, "op_skip", f"{c.op} {c.layer or ''}：需人工确认（{e}）", call=c.n, op=c.op, layer=c.layer)
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="skipped", applied=False, detail=f"needs human: {e}"))
                continue
            except Exception as e:  # noqa: BLE001 — one failing op must not kill the stage
                ran.discard(ran_key)
                self.nctx.rollback_open()
                progress.emit(work, c.stage, "op_fail", f"{c.op} {c.layer or ''}：{type(e).__name__}: {e}", call=c.n, op=c.op, layer=c.layer)
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="report_only", applied=False,
                                      detail=f"native op failed: {type(e).__name__}: {e}"))  # fmt: skip
                continue
            ms = int((time.perf_counter() - t0) * 1000)  # the stage's duration_ms stops before the ops run: this is where the minutes go
            if cs is None or len(cs) == 0:
                self.nctx.mark_applied(c.key, c.op, c.layer)  # nothing to change = the op's post-condition already holds
                progress.emit(work, c.stage, "op_end", f"{c.op} {c.layer or ''}：无需改动", call=c.n, op=c.op, layer=c.layer, ms=ms, added=0, deleted=0, modified=0)
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="native", applied=True, detail=f"no change needed ({ms} ms)"))
                continue
            cs.params["duration_ms"] = ms
            progress.emit(work, c.stage, "op_end", f"{c.op} {c.layer or ''}：+{cs.n_added} −{cs.n_deleted} ~{cs.n_modified}", call=c.n, op=c.op, layer=c.layer,
                          ms=ms, added=cs.n_added, deleted=cs.n_deleted, modified=cs.n_modified)  # fmt: skip
            for rel in {cs.layer, *(c.layer and [c.layer] or [])}:
                if rel in self.nctx._layers:
                    self.nctx.save_layer(rel)
            p = self.nctx.write_changes(c, cs)
            self.nctx.mark_applied(c.key, c.op, c.layer)
            self.changes.append((c, cs, p))
            out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode="native", applied=True,
                                  detail=f"+{cs.n_added} −{cs.n_deleted} ~{cs.n_modified} ({ms} ms)"))  # fmt: skip
        return out


# register the op modules
from engine.native import (  # noqa: F401
    ops_basic,
    ops_construct,
    ops_copper,
    ops_optimize,
    ops_panel,
    ops_rout,
)
