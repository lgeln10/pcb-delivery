"""GenesisAdapter (M4 skeleton): deliver the generated ``genesis_<job>.csh`` to a Genesis host.

Transport is configuration, not code: ``PCB_GENESIS_DROP_DIR`` (a directory the Genesis host
watches / a mounted share) is the only one implemented — M4 is **dry-run**: the script and a
``.json`` envelope are written there and the op records say ``mode="delivered"``; nothing is
executed and ``applied`` stays False until a result file comes back (M5, on site). With no
drop dir configured the adapter records ``mode="not_configured"`` and does nothing.

Result protocol ``genesis-drop-v1`` (``engine.adapters.genesis_host``): the host agent runs the
script parts, then writes ``<job>.result.json`` next to them with the parsed checkpoints
``ops: [{op, layer, key, status}]`` and any produced files under ``<job>.out/``. ``reconcile``
maps the OK keys back onto ``Fix.applied`` in the persisted stage reports and pulls the
outputs into the job work dir for the gatekeeper (A1.4 / A1.5).

M6e (A4.2 / A5, the parts that need no host): a job is delivered **once**; a PAUSED or FAILED
part is continued with ``resume(job, from_part)`` (the envelope's ``parts_pending`` tells the
agent which parts to run, earlier OK ops are kept across results), ``PCB_GENESIS_MAX_JOBS``
caps the jobs in flight (one per Genesis licence), and every delivery is archived under
``<work>/genesis/archive/<PCB_GENESIS_VERSION>/`` so a script can be matched to the Genesis
build it was verified on.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from engine.adapters.base import CamEngine, CamOp


class GenesisAdapter(CamEngine):
    name = "genesis"

    def __init__(self, drop_dir: str | os.PathLike[str] | None = None, host: str | None = None, max_jobs: int | None = None) -> None:
        d = drop_dir if drop_dir is not None else os.environ.get("PCB_GENESIS_DROP_DIR")
        self.drop_dir = Path(d) if d else None
        self.host = host or os.environ.get("PCB_GENESIS_HOST", "")
        self.version = os.environ.get("PCB_GENESIS_VERSION", "")
        self.max_jobs = int(os.environ.get("PCB_GENESIS_MAX_JOBS", "0") or 0) if max_jobs is None else max_jobs  # 0 = no cap

    @property
    def configured(self) -> bool:
        return self.drop_dir is not None

    def in_dir(self, job: str) -> Path:
        """Where ``deliver`` puts the layer files the script imports (A0)."""
        assert self.drop_dir is not None
        return self.drop_dir / f"{job}.in"

    def host_in_dir(self, job: str) -> str:
        """The same directory as the Genesis host sees it (``PCB_GENESIS_HOST_DROP_DIR`` when the
        drop dir is mounted under another path there; default: the worker's own path)."""
        base = os.environ.get("PCB_GENESIS_HOST_DROP_DIR") or str(self.drop_dir)
        return f"{base.rstrip('/')}/{job}.in"

    def host_out_dir(self, job: str) -> str:
        """Where the script's ``COM output`` writes on the host (``<drop>/<job>.out``, the directory
        the agent lists into the result and the worker pulls back)."""
        base = os.environ.get("PCB_GENESIS_HOST_DROP_DIR") or str(self.drop_dir)
        return f"{base.rstrip('/')}/{job}.out"

    def supports(self, op: CamOp) -> bool:
        return True  # everything is expressible as COM; whether it *works* is verified on site

    # ---- A5: queue / delivery state ---------------------------------------------------------
    def envelope(self, job: str) -> dict[str, Any] | None:
        if not self.configured:
            return None
        assert self.drop_dir is not None
        p = self.drop_dir / f"{job}.json"
        return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None

    def delivered(self, job: str) -> bool:
        return self.envelope(job) is not None

    def in_flight(self) -> list[str]:
        """Jobs the host still owns: an envelope without a result file."""
        if not self.configured or not self.drop_dir.is_dir():
            return []
        out = []
        for env in sorted(self.drop_dir.glob("*.json")):
            if env.name.endswith(".result.json"):
                continue
            job = env.name[:-5]
            if not (self.drop_dir / f"{job}.result.json").is_file():
                out.append(job)
        return out

    def _part_no(self, name: str) -> int:
        """``<job>.part<N>.csh`` 的 N。必须锚在结尾:job id 里出现 "part7" 也会被无锚的正则当段号。"""
        import re

        m = re.search(r"\.part(\d+)\.csh$", name)
        return int(m.group(1)) if m else 0

    def part_names(self, job: str) -> list[str]:
        assert self.drop_dir is not None
        return sorted((p.name for p in self.drop_dir.glob(f"{job}.part*.csh")), key=self._part_no)

    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:
        return {"engine": self.name, "op": op.value, "applied": False, "mode": "delivered" if self.configured else "not_configured", "params": params}

    def deliver(self, job: str, script: str, *, ops: list[dict[str, Any]] | None = None, parts: list[tuple[str, str]] | None = None,
                files: list[tuple[str, Path]] | None = None, archive_dir: Path | None = None) -> dict[str, Any]:
        """Write the script (+ its PAUSE-split parts), the layer files the script imports
        (``<job>.in/<rel>`` — the edit copies, so Genesis starts from what the local engine did) and
        an envelope into the drop dir. Any stale result / log of a previous delivery of the same
        job is removed so the agent re-runs."""
        if not self.configured:
            return {"delivered": False, "reason": "PCB_GENESIS_DROP_DIR not set"}
        assert self.drop_dir is not None
        self.drop_dir.mkdir(parents=True, exist_ok=True)
        busy = [j for j in self.in_flight() if j != job]
        if self.max_jobs and len(busy) >= self.max_jobs:
            return {"delivered": False, "queued": True, "reason": f"Genesis 队列已满（{len(busy)}/{self.max_jobs} 个 job 在主机上）", "in_flight": busy}
        for stale in list(self.drop_dir.glob(f"{job}.part*.csh")) + [self.drop_dir / f"{job}.result.json", self.drop_dir / f"{job}.log"]:
            if stale.is_file():
                stale.unlink()
        script_path = self.drop_dir / f"{job}.csh"
        script_path.write_text(script, encoding="utf-8")
        part_names: list[str] = []
        for name, text in parts or []:
            fname = name if name.startswith(f"{job}.") else f"{job}.part{len(part_names) + 1}.csh"
            (self.drop_dir / fname).write_text(text, encoding="utf-8")
            part_names.append(fname)
        shipped: list[str] = []
        if files:
            import shutil

            ind = self.in_dir(job)
            ind.mkdir(parents=True, exist_ok=True)
            for rel, src in files:
                dst = (ind / rel).resolve()
                if ind.resolve() not in dst.parents:
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
                shipped.append(rel)
        envelope = {
            "job": job, "host": self.host, "genesis_version": self.version, "script": script_path.name, "parts": part_names, "parts_pending": list(part_names),
            "in_dir": f"{job}.in", "out_dir": f"{job}.out", "files": shipped,
            "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "ops": ops or [],
            "protocol": "genesis-drop-v1 (host agent runs parts_pending in order and writes <job>.result.json; outputs under <job>.out/)",
        }  # fmt: skip
        (self.drop_dir / f"{job}.json").write_text(json.dumps(envelope, ensure_ascii=False, indent=1), encoding="utf-8")
        if archive_dir is not None:  # A5: keep what was sent, filed under the Genesis build it targets
            import shutil

            adir = Path(archive_dir) / (self.version or "unknown") / time.strftime("%Y%m%dT%H%M%S")
            adir.mkdir(parents=True, exist_ok=True)
            for f in [script_path, self.drop_dir / f"{job}.json"] + [self.drop_dir / n for n in part_names]:
                shutil.copyfile(f, adir / f.name)
        return {"delivered": True, "script": str(script_path), "parts": part_names, "envelope": str(self.drop_dir / f"{job}.json")}

    def resume(self, job: str, from_part: int) -> dict[str, Any]:
        """A4.2 / A5: continue a paused or failed job from part ``from_part`` (1-based). The stale
        result and log go away so the agent picks the job up again, and the envelope's
        ``parts_pending`` lists only the parts still to run."""
        if not self.configured:
            return {"resumed": False, "reason": "PCB_GENESIS_DROP_DIR not set"}
        assert self.drop_dir is not None
        env = self.envelope(job)
        if env is None:
            return {"resumed": False, "reason": "job 尚未投递"}
        names = self.part_names(job)
        pending = [n for n in names if self._part_no(n) >= from_part]
        if not pending:
            return {"resumed": False, "reason": f"没有第 {from_part} 段及之后的脚本（共 {len(names)} 段）"}
        for stale in (self.drop_dir / f"{job}.result.json", self.drop_dir / f"{job}.log"):
            if stale.is_file():
                stale.unlink()
        env.update({"parts_pending": pending, "resume_from": from_part, "resumed_at": time.strftime("%Y-%m-%dT%H:%M:%S")})
        (self.drop_dir / f"{job}.json").write_text(json.dumps(env, ensure_ascii=False, indent=1), encoding="utf-8")
        return {"resumed": True, "from_part": from_part, "parts": pending}

    def status(self, job: str) -> dict[str, Any]:
        """What the host has done with the job: not delivered / waiting / paused at / failed at / done."""
        env = self.envelope(job)
        if env is None:
            return {"configured": self.configured, "delivered": False, "state": "not_delivered", "in_flight": self.in_flight()}
        res = self.read_result(job)
        out: dict[str, Any] = {"configured": True, "delivered": True, "genesis_version": env.get("genesis_version", ""), "parts": env.get("parts", []),
                               "parts_pending": env.get("parts_pending", []), "submitted_at": env.get("submitted_at"), "resume_from": env.get("resume_from")}  # fmt: skip
        if res is None:
            out["state"] = "waiting"
            return out
        parts = res.get("parts", [])
        failed = next((p for p in parts if p.get("status") == "FAIL"), None)
        paused = next((p for p in parts if p.get("status") == "PAUSED"), None)
        out.update({"ok": bool(res.get("ok")), "result_parts": parts, "finished_at": res.get("finished_at")})
        out["state"] = "failed" if failed else "paused" if paused else "done" if res.get("ok") else "incomplete"
        out["failed_part"] = self._part_no(failed["name"]) if failed else None
        out["paused_part"] = self._part_no(paused["name"]) if paused else None
        return out

    def read_result(self, job: str) -> dict[str, Any] | None:
        if not self.configured:
            return None
        assert self.drop_dir is not None
        p = self.drop_dir / f"{job}.result.json"
        if not p.is_file():
            return None
        return json.loads(p.read_text(encoding="utf-8"))


    def reconcile(self, job: str, work_dir: Path) -> dict[str, Any] | None:
        """A1.4/A1.5: fold ``<job>.result.json`` back into the job. Returns a summary (or None when
        there is no result yet):

        * every persisted stage report gets ``fix.applied=True`` for items whose plan key the host
          reported ``OK`` (idempotent — re-running never un-applies);
        * the result is copied to ``<work>/genesis/result.json``;
        * files under ``<drop>/<job>.out/`` are copied to ``<work>/genesis_out/`` for the gatekeeper.
        """
        res = self.read_result(job)
        if res is None:
            return None
        assert self.drop_dir is not None
        from engine.model.report import StageReport

        gdir = work_dir / "genesis"
        env = self.envelope(job) or {}
        parts = res.get("parts", [])
        # 本次这一跑的结论:失败/暂停只看本次跑的段,不能被上次的 OK 盖掉
        fail = [o for o in res.get("ops", []) if o.get("status") == "FAIL"]
        failed_part = next((self._part_no(p["name"]) for p in parts if p.get("status") == "FAIL"), None)
        paused_part = next((self._part_no(p["name"]) for p in parts if p.get("status") == "PAUSED"), None)
        prev_path = gdir / "result.json"
        # 续投(信封有 resume_from)只跑剩下的段,结果里没有先前段的 op —— 把上次 OK 的并回来,
        # 这样已应用的修复不会被"这次没报告"当成没做。不是续投就不合并:重新投递的计划可能已经变了。
        if env.get("resume_from") and prev_path.is_file():
            try:
                prev = json.loads(prev_path.read_text(encoding="utf-8"))
                merged = {o["key"]: o for o in prev.get("ops", []) if o.get("key") and o.get("status") == "OK"}
                merged.update({o["key"]: o for o in res.get("ops", []) if o.get("key")})
                res = {**res, "ops": list(merged.values())}
            except Exception:  # noqa: BLE001 — a broken old result must not block the new one
                pass
        total = len(env.get("parts", [])) or len(parts)
        ok_keys = {o["key"] for o in res.get("ops", []) if o.get("status") == "OK" and o.get("key")}
        # a PAUSE at the end of the last part is the review checkpoint, not unfinished work
        finished = bool(res.get("ok")) or (not fail and paused_part == total and total > 0 and not any(o.get("status") != "OK" for o in res.get("ops", [])))
        applied_items: list[str] = []
        rdir = work_dir / "reports"
        if rdir.is_dir():
            plan_path = work_dir / "plan" / "plan.json"
            key_items: dict[str, set[str]] = {}
            if plan_path.is_file():
                for c in json.loads(plan_path.read_text(encoding="utf-8")).get("calls", []):
                    key_items[c["key"]] = set(c.get("item_ids", []))
            for f in sorted(rdir.glob("*.json")):
                rep = StageReport.model_validate_json(f.read_text(encoding="utf-8"))
                changed = False
                for it in rep.items:
                    if it.fix and not it.fix.applied and any(it.id in key_items.get(k, ()) for k in ok_keys):
                        it.fix.applied = True
                        changed = True
                        applied_items.append(f"{rep.stage}/{it.id}")
                if changed:
                    f.write_text(rep.model_dump_json(), encoding="utf-8")
        gdir.mkdir(parents=True, exist_ok=True)
        (gdir / "result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        pulled: list[str] = []
        out_src = self.drop_dir / f"{job}.out"
        if out_src.is_dir():
            out_dst = work_dir / "genesis_out"
            out_dst.mkdir(parents=True, exist_ok=True)
            for f in sorted(out_src.rglob("*")):
                if f.is_file():
                    rel = f.relative_to(out_src)
                    (out_dst / rel).parent.mkdir(parents=True, exist_ok=True)
                    (out_dst / rel).write_bytes(f.read_bytes())
                    pulled.append(str(rel))
        return {"ok": finished, "applied": applied_items, "failed": fail, "parts": parts, "outputs": pulled,
                "failed_part": failed_part, "paused_part": None if finished else paused_part, "total_parts": total}  # fmt: skip


def engine_from_env() -> CamEngine:
    """``PCB_CAM_ENGINE`` = native (default) | lite | fake | genesis | hybrid.

    ``genesis`` returns the delivery adapter (scripts to the drop dir). ``native`` / ``hybrid``
    are resolved per job by ``executor_for`` because the native engine needs the job context."""
    from engine.adapters.fake import FakeEngine
    from engine.adapters.lite import LiteEngine

    # B line is the normal candidate generator.  Gatekeeper, not the availability of Genesis,
    # decides whether a factory profile may auto-release a result.
    kind = os.environ.get("PCB_CAM_ENGINE", "native").lower()
    if kind == "fake":
        return FakeEngine()
    if kind in ("genesis", "hybrid"):
        return GenesisAdapter()
    return LiteEngine()


def executor_for(ctx: Any) -> CamEngine | None:
    """The plan executor for this job under ``PCB_CAM_ENGINE`` (None = report-only lite)."""
    from engine.adapters.status import HybridEngine

    kind = os.environ.get("PCB_CAM_ENGINE", "native").lower()
    if kind == "native":
        from engine.native import NativeEngine

        return HybridEngine(native=NativeEngine(ctx))
    if kind == "hybrid":
        from engine.native import NativeEngine

        g = GenesisAdapter()
        return HybridEngine(native=NativeEngine(ctx), genesis=g, genesis_configured=g.configured)
    return None
