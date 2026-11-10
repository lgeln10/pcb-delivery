"""Structured board queries for the page's 「自然语言查板」(the LLM on the AIOS side turns a
sentence into one of these; this module only understands the structured form).

Two shapes:

* ``features`` — walk the job's layers (edit copy when the native engine wrote one) and return the
  features matching the filters: kind (line / pad / surface), stroke width or pad size bounds,
  polarity, net, a bbox. Every hit carries a bbox so the page can draw it on the board.
* ``changes`` — what the native engine changed and where, per layer, from ``steps/history/<stage>/ops.json``
  and the edit_log details (「这块板哪里改动最多」).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from engine.geom.features import FeatureLayer
from engine.pipeline.context import JobContext, StageRequest
from engine.pipeline.registry import STAGE_NAMES
from engine.storage import Storage

Kind = Literal["line", "pad", "surface", "any"]


class QueryBody(BaseModel):
    what: Literal["features", "changes"] = "features"
    #: file names; empty = every layer of ``layer_types`` (or every copper layer when both are empty)
    layers: list[str] = Field(default_factory=list)
    #: layer types (top_copper / inner_copper / bottom_copper / top_mask …)
    layer_types: list[str] = Field(default_factory=list)
    feature: Kind = "any"
    width_lt_mm: float | None = None
    width_gt_mm: float | None = None
    size_lt_mm: float | None = None
    size_gt_mm: float | None = None
    polarity: Literal["dark", "clear"] | None = None
    net: str | None = None
    bbox: tuple[float, float, float, float] | None = None
    limit: int = 500


COPPER = ("top_copper", "inner_copper", "bottom_copper")


def _entries(lm: dict[str, Any], body: QueryBody) -> list[dict[str, Any]]:
    files = [e for e in lm.get("files", []) if e.get("file")]
    if body.layers:
        want = set(body.layers)
        return [e for e in files if e["file"] in want]
    types = set(body.layer_types) if body.layer_types else set(COPPER)
    return [e for e in files if e.get("type") in types]


def _to_mm(layer: FeatureLayer) -> float:
    """``Feature.width_mm`` / ``Symbol.size_mm`` are in the *file's* unit (our exports are inch, customers
    mostly mm); only ``f.geom`` is always mm. Same trap as tools/probe.py."""
    return 25.4 if str(getattr(layer.gf, "unit", "mm")).lower().startswith("in") else 1.0


def _feature_hit(rel: str, f, body: QueryBody, k: float = 1.0) -> dict[str, Any] | None:
    if body.feature != "any" and f.kind != body.feature and not (body.feature == "line" and f.kind == "arc"):
        return None
    if body.polarity and (f.polarity_dark != (body.polarity == "dark")):
        return None
    if body.net and (f.net or "") != body.net:
        return None
    measured: float | None = None
    if f.kind in ("line", "arc"):
        measured = None if f.width_mm is None else f.width_mm * k
        if body.width_lt_mm is not None and (measured is None or measured >= body.width_lt_mm):
            return None
        if body.width_gt_mm is not None and (measured is None or measured <= body.width_gt_mm):
            return None
        if body.size_lt_mm is not None or body.size_gt_mm is not None:
            return None
    elif f.kind == "pad":
        s = f.symbol
        measured = min(s.size_mm) * k if s and s.size_mm else None
        if body.size_lt_mm is not None and (measured is None or measured >= body.size_lt_mm):
            return None
        if body.size_gt_mm is not None and (measured is None or measured <= body.size_gt_mm):
            return None
        if body.width_lt_mm is not None or body.width_gt_mm is not None:
            return None
    else:
        if any(v is not None for v in (body.width_lt_mm, body.width_gt_mm, body.size_lt_mm, body.size_gt_mm)):
            return None
    g = f.geom
    if g.is_empty:
        return None
    x0, y0, x1, y1 = g.bounds
    if body.bbox is not None:
        bx0, by0, bx1, by1 = body.bbox
        if x1 < bx0 or x0 > bx1 or y1 < by0 or y0 > by1:
            return None
    return {"layer": rel, "kind": f.kind, "x": round((x0 + x1) / 2, 3), "y": round((y0 + y1) / 2, 3),
            "bbox": [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)],
            "measured": None if measured is None else round(measured, 4),
            "symbol": f.symbol.name if f.kind != "surface" and f.symbol else None, "net": f.net}  # fmt: skip


def query_features(storage: Storage, job_id: str, body: QueryBody) -> dict[str, Any]:
    lm = storage.read_json(job_id, "layer_map.json") or {}
    ctx = JobContext(job_id=job_id, stage="query", request=StageRequest(tenant_id="-", output_prefix="x/"), storage=storage)
    hits: list[dict[str, Any]] = []
    by_layer: dict[str, int] = {}
    total = 0
    for e in _entries(lm, body):
        rel = e["file"]
        p = ctx.layer_path(rel)
        if not p.is_file():
            continue
        try:
            layer = FeatureLayer.load(p, rel, e.get("type", ""))
        except Exception:  # noqa: BLE001 — one unreadable layer must not kill the answer
            continue
        n = 0
        k = _to_mm(layer)
        for f in layer:
            h = _feature_hit(rel, f, body, k)
            if h is None:
                continue
            n += 1
            if len(hits) < body.limit:
                hits.append(h)
        if n:
            by_layer[rel] = n
        total += n
    return {"what": "features", "total": total, "by_layer": by_layer, "hits": hits, "truncated": max(0, total - len(hits))}


def history(work: Path) -> dict[str, Any]:
    """Frames for the scrubber: ``orig`` first, then every stage that wrote ``steps/history/<stage>/``
    in pipeline order, then ``panel`` when the native engine built a working panel."""
    frames: list[dict[str, Any]] = [{"stage": "orig", "layers": [], "ops": []}]
    hroot = work / "steps" / "history"
    by_layer: dict[str, list[str]] = {}
    for st in STAGE_NAMES:
        d = hroot / st
        if not d.is_dir():
            continue
        meta: dict[str, Any] = {"stage": st, "layers": [], "ops": []}
        p = d / "ops.json"
        if p.is_file():
            try:
                meta.update(json.loads(p.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001
                pass
        if not meta["layers"]:
            meta["layers"] = sorted(str(x.relative_to(d)) for x in d.rglob("*") if x.is_file() and x.name != "ops.json")
        for rel in meta["layers"]:
            by_layer.setdefault(rel, []).append(st)
        frames.append(meta)
    if (work / "steps" / "panel" / "panel.json").is_file() and not any(f["stage"] == "panel" for f in frames):
        frames.append({"stage": "panel", "layers": [], "ops": [], "panel": True})  # 工作板只有 step=panel 的图，没有 history 帧时补一帧
    return {"frames": frames, "by_layer": by_layer}


def frame_path(work: Path, rel: str, rev: str) -> tuple[Path | None, str]:
    """The copy of ``rel`` as it stood after stage ``rev``: the newest history snapshot at or before
    ``rev`` in pipeline order; none → the customer's file. Returns (path, cache tag)."""
    if rev not in STAGE_NAMES:
        return None, ""
    upto = STAGE_NAMES[: STAGE_NAMES.index(rev) + 1]
    for st in reversed(upto):
        p = work / "steps" / "history" / st / rel
        if p.is_file():
            return p, f"@h:{st}"
    return None, "@orig"


def query_changes(work: Path, body: QueryBody) -> dict[str, Any]:
    h = history(work)
    by_layer: dict[str, int] = {}
    per_op: dict[str, int] = {}
    hits: list[dict[str, Any]] = []
    for fr in h["frames"]:
        for op in fr.get("ops", []):
            rel = op.get("layer") or "-"
            n = int(op.get("added", 0)) + int(op.get("deleted", 0)) + int(op.get("modified", 0))
            by_layer[rel] = by_layer.get(rel, 0) + n
            per_op[op.get("op", "?")] = per_op.get(op.get("op", "?"), 0) + n
            log = op.get("log")
            if not log or len(hits) >= body.limit:
                continue
            p = work / "edit_log" / log
            if not p.is_file():
                continue
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            for d in doc.get("details", [])[:20]:
                src = d.get("after") or d.get("before") or {}
                if "x" not in src or "y" not in src:
                    continue
                x, y = float(src["x"]), float(src["y"])
                hits.append({"layer": rel, "kind": d.get("action"), "x": x, "y": y, "bbox": [x - 0.5, y - 0.5, x + 0.5, y + 0.5],
                             "measured": None, "symbol": src.get("symbol"), "op": op.get("op"), "stage": fr.get("stage"), "note": d.get("note")})  # fmt: skip
                if len(hits) >= body.limit:
                    break
    if body.layers:
        want = set(body.layers)
        by_layer = {k: v for k, v in by_layer.items() if k in want}
        hits = [x for x in hits if x["layer"] in want]
    return {"what": "changes", "total": sum(by_layer.values()), "by_layer": by_layer, "by_op": per_op, "hits": hits, "truncated": 0}
