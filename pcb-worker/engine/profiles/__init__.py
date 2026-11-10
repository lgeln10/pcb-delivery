"""Factory profiles: YAML defaults merged with a per-job ``profile_yaml`` override."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

DEFAULT_PROFILE_PATH = Path(__file__).with_name("default.yaml")


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_profile(profile_yaml: str | None = None) -> dict[str, Any]:
    base = yaml.safe_load(DEFAULT_PROFILE_PATH.read_text("utf-8")) or {}
    if profile_yaml:
        override = yaml.safe_load(profile_yaml) or {}
        if not isinstance(override, dict):
            raise ValueError("profile_yaml must be a mapping")
        base = _deep_merge(base, override)
    return base
