"""Local shared-volume storage (demo mode).

Two roots, both overridable by environment:

- ``PCB_STORAGE_ROOT`` (default ``./data/storage``): mirrors Node's ``core/storage`` local
  mode, which puts an object with key ``k`` at ``<UPLOAD_DIR>/<k>``. The worker reads job
  inputs and writes artifacts under this root; ``Artifact.path`` is the *key*.
- ``PCB_WORK_ROOT`` (default ``./data/work``): ``<root>/<job_id>/`` holds extracted sources,
  layer caches (wkb), ``layer_map.json`` and ``progress.json``.

Every key/name is validated against path traversal before it touches the filesystem.
"""

from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$")


class UnsafeKeyError(ValueError):
    pass


def validate_key(key: str) -> str:
    """Reject keys that could escape the storage root."""
    if not key or key.startswith(("/", "\\")):
        raise UnsafeKeyError(f"key must be relative: {key!r}")
    if "\\" in key or "\x00" in key:
        raise UnsafeKeyError(f"illegal character in key: {key!r}")
    parts = key.split("/")
    for p in parts:
        if p in ("", ".", ".."):
            raise UnsafeKeyError(f"illegal path segment in key: {key!r}")
    return key


def validate_id(value: str, what: str = "id") -> str:
    """job_id / tenant_id / layer names become directory or file names: keep them plain."""
    if not _SAFE_SEGMENT.match(value or "") or value in (".", ".."):
        raise UnsafeKeyError(f"unsafe {what}: {value!r}")
    return value


def safe_relpath(rel: str) -> str:
    """Normalise an archive member path: forward slashes, no absolute/parent components."""
    rel = rel.replace("\\", "/")
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    if not parts:
        raise UnsafeKeyError(f"empty archive member path: {rel!r}")
    return "/".join(parts)


@dataclass
class Storage:
    storage_root: Path = field(
        default_factory=lambda: Path(os.environ.get("PCB_STORAGE_ROOT", "./data/storage"))
    )
    work_root: Path = field(
        default_factory=lambda: Path(os.environ.get("PCB_WORK_ROOT", "./data/work"))
    )

    def __post_init__(self) -> None:
        self.storage_root = Path(self.storage_root).resolve()
        self.work_root = Path(self.work_root).resolve()

    # ---- object storage -------------------------------------------------------
    def object_path(self, key: str) -> Path:
        validate_key(key)
        p = (self.storage_root / key).resolve()
        if self.storage_root not in p.parents and p != self.storage_root:
            raise UnsafeKeyError(f"key escapes storage root: {key!r}")
        return p

    def read_object(self, key: str) -> bytes:
        return self.object_path(key).read_bytes()

    def object_exists(self, key: str) -> bool:
        return self.object_path(key).is_file()

    def write_object(self, key: str, data: bytes | str) -> Path:
        p = self.object_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            data = data.encode("utf-8")
        p.write_bytes(data)
        return p

    def put_file(self, key: str, src: Path) -> Path:
        p = self.object_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, p)
        return p

    # ---- work dir ---------------------------------------------------------------
    def work_dir(self, job_id: str, create: bool = True) -> Path:
        validate_id(job_id, "job_id")
        p = self.work_root / job_id
        if create:
            p.mkdir(parents=True, exist_ok=True)
        return p

    def write_json(self, job_id: str, name: str, payload: Any) -> Path:
        p = self.work_dir(job_id) / validate_id(name, "file name")
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), "utf-8")
        return p

    def read_json(self, job_id: str, name: str) -> Any | None:
        p = self.work_dir(job_id, create=False) / validate_id(name, "file name")
        if not p.is_file():
            return None
        return json.loads(p.read_text("utf-8"))

    def update_progress(self, job_id: str, stage: str, **extra: Any) -> None:
        prog = self.read_json(job_id, "progress.json") or {"stages": {}}
        prog["stages"][stage] = extra
        prog["last_stage"] = stage
        self.write_json(job_id, "progress.json", prog)


def artifact_key(output_prefix: str, filename: str) -> str:
    """``artifacts[].path`` convention: ``output_prefix + filename``."""
    validate_key(output_prefix.rstrip("/") or "x")
    validate_id(filename, "artifact filename")
    prefix = output_prefix if output_prefix.endswith("/") else output_prefix + "/"
    return prefix + filename
