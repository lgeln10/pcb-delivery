"""Host side of the A line: run the job's script parts on (or as if on) a Genesis host and turn
the ``<job>.log`` checkpoints into ``<job>.result.json`` (docs/PLAN_TWO_TRACKS.md A1.3 / A1.4).

Two implementations of the same contract:

* ``FakeGenesisHost`` — no Genesis: interprets the generated csh well enough to honour the
  checkpoints (``# ---- [n] <op>`` headers, ``COM`` → STATUS, ``echo … >> <job>.log``, ``PAUSE``).
  Used by tests and by ``PCB_CAM_ENGINE=fake`` demos.
* ``tools/genesis_host_agent.py`` — the real agent that runs on the Genesis host; it uses
  ``run_parts`` below with a configurable launch command (``gateway`` / ``csh -f``) and the same
  ``result_from_log`` so the worker never sees a difference.

Result file (protocol ``genesis-drop-v1``)::

    {"job": "...", "ok": true, "parts": [{"name": "…part1.csh", "status": "OK|FAIL|PAUSED"}],
     "ops": [{"n": 3, "op": "LineCompensation", "layer": "gtl", "key": "…", "status": "OK|FAIL"}],
     "log": "...", "outputs": ["<file>", ...]}
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_LOG_RE = re.compile(r"^(OK|FAIL) (\w+) (\S+) key=(\w+)")
_HEAD_RE = re.compile(r"^# ---- \[(\d+)\] (\w+)\s+p[\d/?]+\s+layer=(\S+)")
_ECHO_RE = re.compile(r'^\s*echo "(.*)" >> (\S+\.log)')

PROTOCOL = "genesis-drop-v1"


def result_from_log(job: str, log_text: str, *, parts: list[dict[str, str]] | None = None, outputs: list[str] | None = None) -> dict[str, Any]:
    """Parse the checkpoint lines the script appended to ``<job>.log``."""
    ops: list[dict[str, Any]] = []
    for line in log_text.splitlines():
        m = _LOG_RE.match(line.strip())
        if not m:
            continue
        status, op, layer, key = m.groups()
        ops.append({"op": op, "layer": None if layer in ("-", "_") else layer, "key": key, "status": status})
    failed = [o for o in ops if o["status"] == "FAIL"]
    paused = any(p.get("status") == "PAUSED" for p in (parts or []))
    last = log_text.rstrip().rsplit("\n", 1)[-1]
    return {
        "protocol": PROTOCOL, "job": job, "ok": not failed and not paused and last.startswith("DONE "),
        "parts": parts or [], "ops": ops, "log": log_text, "outputs": outputs or [],
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }  # fmt: skip


@dataclass
class FakeGenesisHost:
    """Interpret a generated script: every COM succeeds unless its block's op is in ``fail_ops``;
    ``PAUSE`` stops the part with status PAUSED unless ``auto_continue``."""

    drop_dir: Path
    fail_ops: set[str] = field(default_factory=set)
    auto_continue: bool = True
    com_log: list[str] = field(default_factory=list)

    def run_script(self, text: str, log_path: Path) -> str:
        status = 0
        op = "-"
        lines = text.splitlines()
        i = 0
        with log_path.open("a", encoding="utf-8") as log:
            while i < len(lines):
                ln = lines[i]
                s = ln.strip()
                h = _HEAD_RE.match(s)
                if h:
                    op = h.group(2)
                elif s.startswith(("COM ", "AUX ")):
                    self.com_log.append(s.split("#", 1)[0].strip())
                    status = 1 if op in self.fail_ops else 0
                elif s.startswith("if ($STATUS != 0) then"):
                    # the next line is the FAIL echo + exit; the one after is `endif`
                    if status != 0:
                        m = _ECHO_RE.match(lines[i + 1])
                        if m:
                            log.write(m.group(1).replace("$STATUS", str(status)) + "\n")
                        return "FAIL"
                    i += 3
                    continue
                elif s.startswith("PAUSE"):
                    if not self.auto_continue:
                        return "PAUSED"
                elif s == "exit 1":
                    return "FAIL"
                else:
                    m = _ECHO_RE.match(ln)
                    if m:
                        log.write(m.group(1) + "\n")
                i += 1
        return "OK"

    def run_job(self, job: str) -> dict[str, Any]:
        """Run every ``<job>.partN.csh`` in order (or ``<job>.csh`` if there are no parts), write
        ``<job>.result.json`` the way the real agent does."""
        parts = pending_parts(self.drop_dir, job)
        log_path = self.drop_dir / f"{job}.log"
        log_path.write_text("", encoding="utf-8")
        done: list[dict[str, str]] = []
        for p in parts:
            st = self.run_script(p.read_text(encoding="utf-8"), log_path)
            done.append({"name": p.name, "status": st})
            if st != "OK":
                break
        res = result_from_log(job, log_path.read_text(encoding="utf-8"), parts=done)
        (self.drop_dir / f"{job}.result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        return res


def pending_parts(drop_dir: Path, job: str) -> list[Path]:
    """The parts to run: the envelope's ``parts_pending`` (a resume lists only the rest), else
    every ``<job>.partN.csh`` in order, else the single ``<job>.csh``."""
    env_path = drop_dir / f"{job}.json"
    if env_path.is_file():
        try:
            names = json.loads(env_path.read_text(encoding="utf-8")).get("parts_pending")
            if names:
                return [drop_dir / n for n in names]
        except Exception:  # noqa: BLE001 — fall back to the glob
            pass
    parts = sorted(drop_dir.glob(f"{job}.part*.csh"), key=lambda p: int(re.search(r"part(\d+)", p.name).group(1)))  # type: ignore[union-attr]
    return parts or [drop_dir / f"{job}.csh"]


def run_parts(job: str, drop_dir: Path, *, launch: str, timeout_s: float = 3600, outputs_dir: Path | None = None) -> dict[str, Any]:
    """Real host: run each part through ``launch`` (a template with ``{script}``), e.g.
    ``csh -f {script}`` or ``$GENESIS_DIR/bin/gateway … {script}``  【待验证：进场定】."""
    parts = pending_parts(drop_dir, job)
    log_path = drop_dir / f"{job}.log"
    log_path.write_text("", encoding="utf-8")
    done: list[dict[str, str]] = []
    for p in parts:
        cmd = shlex.split(launch.format(script=str(p)))
        try:
            proc = subprocess.run(cmd, cwd=str(drop_dir), capture_output=True, text=True, timeout=timeout_s, check=False)
            st = "OK" if proc.returncode == 0 else "FAIL"
            if proc.stdout or proc.stderr:
                (drop_dir / f"{job}.{p.stem}.stdout").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr, encoding="utf-8")
        except subprocess.TimeoutExpired:
            st = "FAIL"
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"FAIL timeout {p.name}\n")
        done.append({"name": p.name, "status": st})
        if st != "OK":
            break
    outputs = sorted(str(f.relative_to(outputs_dir)) for f in outputs_dir.rglob("*") if f.is_file()) if outputs_dir and outputs_dir.is_dir() else []
    res = result_from_log(job, log_path.read_text(encoding="utf-8"), parts=done, outputs=outputs)
    (drop_dir / f"{job}.result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res
