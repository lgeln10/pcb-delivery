"""The Genesis 2000 script protocol, spoken by a process that Genesis itself launched.

Reverse-engineered from three independent open-source clients (docs/PLAN_TWO_TRACKS.md §回顾 2 —
chudi1245/genesis2000 VB.NET, guobbs/genesis2000 Rust, genesis-py); none of them is copied here,
only the wire format:

* Genesis starts the script with ``GENESIS_DIR`` / ``GENESIS_EDIR`` / ``JOB`` / ``STEP`` in the
  environment and connects its stdin/stdout to the script.
* The script writes one line per command: ``@%#%@<TYPE> <command>`` where TYPE is ``COM``
  (edit command), ``AUX`` (auxiliary), ``PAUSE`` (modal prompt), ``MOUSE r`` (pick), ``VOF`` /
  ``VON`` (verbose off/on) and ``SU_ON`` / ``SU_OFF``.
* Genesis answers ``COM`` / ``AUX`` with two lines: ``STATUS`` (0 = ok) then ``COMANS`` (the
  answer text, e.g. the count for ``get_select_count``). ``PAUSE`` and ``MOUSE`` answer with
  three lines; ``VOF`` / ``VON`` / ``SU_*`` answer nothing.
* ``info`` queries are ``COM info,out_file=<tmp>,write_mode=replace,args=-t <type> -e <path>
  -d <data>``; Genesis writes csh ``set`` lines into ``<tmp>`` which the client parses.

This module is used by ``tools/genesis_host_agent.py`` (A1.3) when the agent itself runs as the
Genesis script, and by ``FakeGenesisHost`` in tests, which implements the other side.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any

PREFIX = "@%#%@"
_SET_RE = re.compile(r"^set\s+(\w+)\s*=\s*(.*)$")


@dataclass
class Reply:
    status: int
    ans: str = ""
    extra: str = ""

    @property
    def ok(self) -> bool:
        return self.status == 0


@dataclass
class GenesisPipe:
    """Client side: send commands, read replies. ``inp``/``out`` default to this process' stdio."""

    inp: IO[str] = field(default_factory=lambda: sys.stdin)
    out: IO[str] = field(default_factory=lambda: sys.stdout)
    log: list[tuple[str, Reply | None]] = field(default_factory=list)

    # ---- environment Genesis gives the script -------------------------------------------
    @property
    def genesis_dir(self) -> str:
        return os.environ.get("GENESIS_DIR", "")

    @property
    def job(self) -> str:
        return os.environ.get("JOB", "")

    @property
    def step(self) -> str:
        return os.environ.get("STEP", "")

    # ---- wire ---------------------------------------------------------------------------
    def _send(self, kind: str, command: str = "") -> None:
        cmd = command.replace("\r", " ").replace("\n", " ").strip()
        self.out.write(f"{PREFIX}{kind}{(' ' + cmd) if cmd else ''}\n")
        self.out.flush()

    def _read(self) -> str:
        line = self.inp.readline()
        if line == "":
            raise EOFError("Genesis closed the pipe")
        return line.rstrip("\r\n")

    def _reply(self, n: int) -> Reply:
        lines = [self._read() for _ in range(n)]
        try:
            status = int(lines[0].strip() or "0")
        except ValueError:
            status = 1
        return Reply(status=status, ans=lines[1] if n > 1 else "", extra=lines[2] if n > 2 else "")

    def com(self, command: str) -> Reply:
        self._send("COM", command)
        r = self._reply(2)
        self.log.append((f"COM {command}", r))
        return r

    def aux(self, command: str) -> Reply:
        self._send("AUX", command)
        r = self._reply(2)
        self.log.append((f"AUX {command}", r))
        return r

    def pause(self, message: str = "") -> Reply:
        self._send("PAUSE", message)
        r = self._reply(3)
        self.log.append((f"PAUSE {message}", r))
        return r

    def mouse(self) -> Reply:
        self._send("MOUSE r")
        r = self._reply(3)
        self.log.append(("MOUSE r", r))
        return r

    def vof(self) -> None:
        self._send("VOF")
        self.log.append(("VOF", None))

    def von(self) -> None:
        self._send("VON")
        self.log.append(("VON", None))

    # ---- info ---------------------------------------------------------------------------
    def info(self, *, entity_type: str, entity_path: str, data_type: str, tmp_dir: str | os.PathLike[str] | None = None, **opts: str) -> dict[str, Any]:
        """``COM info`` → parse the csh ``set`` file Genesis writes. Values that look like csh
        lists ``(a b c)`` come back as Python lists."""
        tmp = Path(tmp_dir or os.environ.get("TMPDIR", "/tmp")) / f"info_{os.getpid()}_{len(self.log)}.csh"
        args = f"-t {entity_type} -e {entity_path} -d {data_type}"
        for k, v in opts.items():
            args += f" -{k[0]} {v}"
        r = self.com(f"info,out_file={tmp},write_mode=replace,args={args}")
        if not r.ok or not tmp.is_file():
            return {}
        try:
            return parse_info_file(tmp.read_text(encoding="utf-8", errors="replace"))
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass


def parse_info_file(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in text.splitlines():
        m = _SET_RE.match(line.strip())
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if v.startswith("(") and v.endswith(")"):
            out[k] = [x.strip("'\"") for x in v[1:-1].split()]
        else:
            out[k] = v.strip("'\"")
    return out
