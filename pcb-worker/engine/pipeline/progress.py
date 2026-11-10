"""Live progress of a running stage (页面「引擎实况流」).

A stage is one blocking ``POST``; while it runs the page only sees a spinner. Every step worth
narrating appends one JSON line to ``<work>/progress.jsonl`` — stage start/end and, from the
native engine, every op with its ``+added −deleted ~modified`` tally — and the page polls
``GET /jobs/{id}/progress?after=<n>``. Kept small (last ``KEEP`` lines) so reading it is cheap.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

FILE = "progress.jsonl"
KEEP = 400


def emit(work_dir: Path, stage: str, event: str, message: str, **extra: Any) -> None:
    """Append one line. Never raises — narration must not fail a stage."""
    try:
        p = work_dir / FILE
        lines = p.read_text(encoding="utf-8").splitlines() if p.is_file() else []
        n = 0
        if lines:
            try:
                n = int(json.loads(lines[-1]).get("n", 0))
            except Exception:  # noqa: BLE001 — a torn last line just restarts the counter
                n = len(lines)
        rec = {"n": n + 1, "ts": round(time.time(), 3), "stage": stage, "event": event, "message": message}
        rec.update({k: v for k, v in extra.items() if v is not None and k not in ("n", "ts")})  # n/ts are the sequence, an op's own number travels as ``call``
        lines.append(json.dumps(rec, ensure_ascii=False, default=str))
        if len(lines) > KEEP:
            lines = lines[-KEEP:]
        p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def read(work_dir: Path, after: int = 0, limit: int = 200) -> list[dict[str, Any]]:
    p = work_dir / FILE
    if not p.is_file():
        return []
    out: list[dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if int(rec.get("n", 0)) > after:
            out.append(rec)
    return out[-limit:]
