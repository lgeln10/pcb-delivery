"""Shared fixtures: an isolated storage/work root and a lazily-run intake -> align -> drill
pipeline per sample board (session-scoped, because folding the Altium board is expensive)."""

from __future__ import annotations

import os
import uuid
import zipfile
from pathlib import Path

import pytest

from engine.model.report import StageReport
from engine.pipeline.context import JobContext, StageRequest
from engine.pipeline.registry import run_stage
from engine.storage import Storage

FIXTURES = Path(__file__).parent / "fixtures"
BOARDS = ["kicad-x2ap", "eagle-newer", "altium-limesdr"]
TENANT = "t1"


def zip_fixture(board: str, dest: Path, top_folder: str | None = None) -> None:
    root = FIXTURES / board
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(root.rglob("*")):
            if p.is_file():
                rel = p.relative_to(root).as_posix()
                zf.write(p, f"{top_folder}/{rel}" if top_folder else rel)


class Pipeline:
    def __init__(self, storage: Storage):
        self.storage = storage
        self.reports: dict[tuple[str, str], StageReport] = {}
        self.jobs: dict[str, str] = {}
        self.storage_keys: dict[str, list[str]] = {}

    def job_id(self, board: str) -> str:
        if board not in self.jobs:
            self.jobs[board] = f"job-{board}-{uuid.uuid4().hex[:6]}"
        return self.jobs[board]

    def input_key(self, board: str) -> str:
        job = self.job_id(board)
        key = f"pcb-cam/{TENANT}/{job}/input/{uuid.uuid4()}-board.zip"
        if not self.storage.object_exists(key):
            zip_fixture(board, self.storage.object_path(key), top_folder=board)
        return key

    def run(self, board: str, stage: str, **overrides) -> StageReport:
        job = self.job_id(board)
        if (board, stage) in self.reports and not overrides:
            return self.reports[(board, stage)]
        order = ["intake", "align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output", "gatekeeper"]
        if stage in order:
            for prev in order[: order.index(stage)]:
                if (board, prev) not in self.reports:
                    self.run(board, prev)
        keys = self.storage_keys.setdefault(board, [self.input_key(board)])
        req = StageRequest(
            tenant_id=TENANT,
            attempt=overrides.pop("attempt", 1),
            input_keys=keys,
            output_prefix=f"pcb-cam/{TENANT}/{job}/output/{stage}/",
            **overrides,
        )
        rep = run_stage(JobContext(job_id=job, stage=stage, request=req, storage=self.storage))
        if not overrides:
            self.reports[(board, stage)] = rep
        return rep


@pytest.fixture(scope="session")
def session_roots(tmp_path_factory) -> tuple[Path, Path]:
    base = tmp_path_factory.mktemp("worker")
    return base / "storage", base / "work"


@pytest.fixture(scope="session")
def pipeline(session_roots) -> Pipeline:
    storage_root, work_root = session_roots
    return Pipeline(Storage(storage_root=storage_root, work_root=work_root))


@pytest.fixture
def worker_env(session_roots, monkeypatch) -> Storage:
    """Point ``Storage()`` (as constructed inside the API) at the session roots."""
    storage_root, work_root = session_roots
    monkeypatch.setenv("PCB_STORAGE_ROOT", str(storage_root))
    monkeypatch.setenv("PCB_WORK_ROOT", str(work_root))
    return Storage()


@pytest.fixture(autouse=True, scope="session")
def _fold_workers():
    os.environ.setdefault("PCB_FOLD_WORKERS", str(min(8, os.cpu_count() or 1)))
