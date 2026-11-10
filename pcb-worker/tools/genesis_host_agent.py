#!/usr/bin/env python3
"""Genesis host agent (A1.3): watch the drop dir, run each delivered job's script parts, write
``<job>.result.json`` (protocol genesis-drop-v1, see engine/adapters/genesis_host.py).

Runs on the Genesis host (any Python ≥3.8, no third-party deps — this file is self-contained on
purpose; it imports nothing from the worker). Launch command is a template  【待验证：进场定】:

    python3 genesis_host_agent.py --drop-dir /share/pcb-drop --launch 'csh -f {script}'
    python3 genesis_host_agent.py --drop-dir /share/pcb-drop --launch '$GENESIS_DIR/bin/gateway -x {script}' --watch

Outputs the script leaves under ``<drop>/<job>.out/`` are listed in the result and pulled back by
the worker. A job is picked up when ``<job>.json`` (the envelope) exists and ``<job>.result.json``
does not.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

_LOG_RE = re.compile(r"^(OK|FAIL) (\w+) (\S+) key=(\w+)")


def result_from_log(job, log_text, parts=None, outputs=None):
    ops = []
    for line in log_text.splitlines():
        m = _LOG_RE.match(line.strip())
        if m:
            status, op, layer, key = m.groups()
            ops.append({"op": op, "layer": None if layer in ("-", "_") else layer, "key": key, "status": status})
    failed = any(o["status"] == "FAIL" for o in ops)
    paused = any(p.get("status") == "PAUSED" for p in (parts or []))
    done = log_text.rstrip().rsplit("\n", 1)[-1].startswith("DONE ")
    return {"protocol": "genesis-drop-v1", "job": job, "ok": not failed and not paused and done, "parts": parts or [],
            "ops": ops, "log": log_text, "outputs": outputs or [], "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S")}


def part_files(drop, job):
    """The envelope's ``parts_pending`` when present (a resumed job lists only the parts still to
    run), else every part in order, else the single script."""
    env_path = drop / f"{job}.json"
    if env_path.is_file():
        try:
            names = json.loads(env_path.read_text(encoding="utf-8")).get("parts_pending")
            if names:
                return [drop / n for n in names]
        except Exception:
            pass
    parts = sorted(drop.glob(f"{job}.part*.csh"), key=lambda p: int(re.search(r"part(\d+)", p.name).group(1)))
    return parts or [drop / f"{job}.csh"]


def run_job(drop, job, launch, timeout_s):
    env = dict(os.environ)
    env.setdefault("JOB", job)
    log_path = drop / f"{job}.log"
    log_path.write_text("", encoding="utf-8")
    done = []
    for p in part_files(drop, job):
        cmd = shlex.split(launch.format(script=str(p)))
        try:
            proc = subprocess.run(cmd, cwd=str(drop), capture_output=True, text=True, timeout=timeout_s, env=env, check=False)
            st = "OK" if proc.returncode == 0 else "FAIL"
            if proc.stdout or proc.stderr:
                (drop / f"{job}.{p.stem}.stdout").write_text(proc.stdout + "\n--- stderr ---\n" + proc.stderr, encoding="utf-8")
        except subprocess.TimeoutExpired:
            st = "FAIL"
            with log_path.open("a", encoding="utf-8") as log:
                log.write(f"FAIL timeout {p.name}\n")
        done.append({"name": p.name, "status": st})
        if st != "OK":
            break
    out_dir = drop / f"{job}.out"
    outputs = sorted(str(f.relative_to(out_dir)) for f in out_dir.rglob("*") if f.is_file()) if out_dir.is_dir() else []
    res = result_from_log(job, log_path.read_text(encoding="utf-8"), parts=done, outputs=outputs)
    (drop / f"{job}.result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res


def pending_jobs(drop):
    for env in sorted(drop.glob("*.json")):
        if env.name.endswith(".result.json"):
            continue
        job = env.name[:-5]
        if not (drop / f"{job}.result.json").is_file() and (drop / f"{job}.csh").is_file():
            yield job


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--drop-dir", required=True)
    ap.add_argument("--launch", default="csh -f {script}", help="command template, {script} = part file")
    ap.add_argument("--timeout", type=float, default=3600.0, help="seconds per part")
    ap.add_argument("--watch", action="store_true", help="keep polling instead of one pass")
    ap.add_argument("--interval", type=float, default=10.0)
    a = ap.parse_args(argv)
    drop = Path(a.drop_dir)
    if not drop.is_dir():
        print(f"drop dir not found: {drop}", file=sys.stderr)
        return 2
    while True:
        for job in list(pending_jobs(drop)):
            print(f"[{time.strftime('%H:%M:%S')}] run {job}", flush=True)
            res = run_job(drop, job, a.launch, a.timeout)
            print(f"[{time.strftime('%H:%M:%S')}] {job}: ok={res['ok']} parts={[p['status'] for p in res['parts']]} ops={len(res['ops'])}", flush=True)
        if not a.watch:
            return 0
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
