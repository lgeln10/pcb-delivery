"""Per-request job context handed to every stage function."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from engine.model.report import Artifact
from engine.profiles import load_profile
from engine.storage import Storage, artifact_key, validate_id

CONTENT_TYPES = {
    ".json": "application/json",
    ".drl": "text/plain",
    ".txt": "text/plain",
    ".svg": "image/svg+xml",
    ".csh": "text/plain",
    ".html": "text/html",
    ".gbr": "text/plain",
    ".wkb": "application/octet-stream",
}


class StageRequest(BaseModel):
    """Body of ``POST /jobs/{job_id}/stages/{stage}`` (mirrors worker-client.ts)."""

    tenant_id: str
    attempt: int = 1
    input_keys: list[str] = Field(default_factory=list)
    layer_map: dict[str, Any] | None = None
    order_spec: dict[str, Any] | None = None
    profile_yaml: str | None = None
    output_prefix: str


@dataclass
class JobContext:
    job_id: str
    stage: str
    request: StageRequest
    storage: Storage = field(default_factory=Storage)
    _profile: dict[str, Any] | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        validate_id(self.job_id, "job_id")

    # ---- convenience -------------------------------------------------------------
    @property
    def work_dir(self) -> Path:
        return self.storage.work_dir(self.job_id)

    @property
    def src_dir(self) -> Path:
        p = self.work_dir / "src"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cache_dir(self) -> Path:
        p = self.work_dir / "cache"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def profile(self) -> dict[str, Any]:
        if self._profile is None:
            self._profile = load_profile(self.request.profile_yaml)
        return self._profile

    def layer_map(self) -> dict[str, Any] | None:
        """Request layer_map (human-confirmed) wins over the one intake persisted."""
        if self.request.layer_map:
            return self.request.layer_map
        return self.storage.read_json(self.job_id, "layer_map.json")

    def src_path(self, rel: str) -> Path:
        p = (self.src_dir / rel).resolve()
        if self.src_dir.resolve() not in p.parents:
            raise ValueError(f"layer file escapes src dir: {rel!r}")
        return p

    # ---- the three copies (第4章 p111): orig = as received, edit = what the B line modifies ----
    def edit_path(self, rel: str) -> Path:
        """Where a natively edited layer lives (``steps/edit/<rel>``); may not exist yet."""
        base = (self.work_dir / "steps" / "edit").resolve()
        p = (base / rel).resolve()
        if base not in p.parents:
            raise ValueError(f"layer file escapes edit dir: {rel!r}")
        return p

    def layer_path(self, rel: str) -> Path:
        """The layer every stage after ``align`` should read: the edit copy when the native engine
        has written one, else the customer's file."""
        e = self.edit_path(rel)
        return e if e.is_file() else self.src_path(rel)

    def orig_path(self, rel: str) -> Path:
        return self.src_path(rel)

    def write_artifact(self, kind: str, filename: str, data: bytes | str) -> Artifact:
        key = artifact_key(self.request.output_prefix, filename)
        p = self.storage.write_object(key, data)
        return Artifact(
            kind=kind,
            path=key,
            filename=filename,
            size=p.stat().st_size,
            content_type=CONTENT_TYPES.get(Path(filename).suffix.lower(), "application/octet-stream"),
        )
