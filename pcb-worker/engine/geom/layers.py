"""Layer loading + folded-geometry cache (WKB in ``<work>/<job>/cache``)."""

from __future__ import annotations

import re
import warnings
from pathlib import Path

from gerbonara.excellon import ExcellonFile
from gerbonara.rs274x import GerberFile
from shapely import from_wkb, to_wkb
from shapely.geometry.base import BaseGeometry

from engine.geom.from_gerbonara import camfile_to_geometry
from engine.ingest.classify import DRILL_TYPES

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def cache_name(rel: str) -> str:
    """Stable, filesystem-safe cache file name for a layer's relative path."""
    return _SAFE.sub("_", rel).strip("_") or "layer"


def safe_stem(name: str, fallback: str = "layer") -> str:
    """Artifact file stem derived from a customer file name. Non-ASCII runs collapse to ``_`` and the
    result must start with a letter/digit (``storage.validate_id``): a Chinese stem like
    ``六层内外3oz (1)`` would otherwise become ``_3oz_1_`` and crash the stage (first real customer
    package, 2026-09-09)."""
    return _SAFE.sub("_", name).strip("_.-") or fallback


def layer_display_name(rel: str) -> str:
    """Name used in the SVG route: file name without extension."""
    base = rel.replace("\\", "/").rsplit("/", 1)[-1]
    stem, _, _ = base.rpartition(".")
    return stem or base


def open_camfile(path: Path, layer_type: str):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", SyntaxWarning)
        if layer_type in DRILL_TYPES:
            return ExcellonFile.open(path)
        return GerberFile.open(path)


def fold_cached(cache_dir: Path, path: Path, rel: str, layer_type: str) -> BaseGeometry:
    """Fold a layer into shapely geometry, reading/writing the WKB cache."""
    cache = cache_dir / (cache_name(rel) + ".wkb")
    if cache.is_file() and cache.stat().st_mtime >= path.stat().st_mtime:
        return from_wkb(cache.read_bytes())
    cam = open_camfile(path, layer_type)
    geom, _ = camfile_to_geometry(cam)
    cache.write_bytes(to_wkb(geom))
    return geom


def fold_many(
    cache_dir: Path, jobs: list[tuple[Path, str, str]], workers: int | None = None
) -> dict[str, BaseGeometry | Exception]:
    """Fold several layers, in parallel processes when there is more than one heavy layer.

    ``jobs`` = [(path, rel, layer_type)]. Returns rel -> geometry (or the exception raised).
    Layer folding is CPU-bound Python + GEOS; the Altium 12-layer board takes ~45 s serially.
    ``PCB_FOLD_WORKERS=1`` forces the serial path (handy for debugging).
    """
    import os
    from concurrent.futures import ProcessPoolExecutor

    out: dict[str, BaseGeometry | Exception] = {}
    if workers is None:
        workers = int(os.environ.get("PCB_FOLD_WORKERS", "0")) or (os.cpu_count() or 1)
    todo = [(p, rel, t) for p, rel, t in jobs]
    heavy = [j for j in todo if j[0].stat().st_size > 200_000]
    if workers <= 1 or len(heavy) < 2:
        for p, rel, t in todo:
            try:
                out[rel] = fold_cached(cache_dir, p, rel, t)
            except Exception as e:  # noqa: BLE001
                out[rel] = e
        return out
    from concurrent.futures.process import BrokenProcessPool

    try:
        with ProcessPoolExecutor(max_workers=min(workers, len(todo))) as ex:
            futs = {rel: ex.submit(fold_cached, cache_dir, p, rel, t) for p, rel, t in todo}
            for rel, f in futs.items():
                try:
                    out[rel] = f.result()
                except BrokenProcessPool:
                    raise
                except Exception as e:  # noqa: BLE001
                    out[rel] = e
        return out
    except BrokenProcessPool:
        # spawn cannot re-import an unimportable __main__ (REPL/stdin) or a worker died:
        # degrade to the serial path rather than reporting every layer as unparseable
        return fold_many(cache_dir, jobs, workers=1)


def read_cached(cache_dir: Path, rel: str) -> BaseGeometry | None:
    cache = cache_dir / (cache_name(rel) + ".wkb")
    if not cache.is_file():
        return None
    return from_wkb(cache.read_bytes())
