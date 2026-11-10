"""FastAPI entry point for the PCB worker (HTTP contract for modules/pcb-cam/worker-client.ts)."""

from __future__ import annotations

import faulthandler
import re
import signal
import threading
from importlib.metadata import version

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from shapely import from_wkb

from engine import compare as cmp
from engine import query as boardq
from engine.pipeline import progress
from engine.geom.layers import fold_cached, layer_display_name
from engine.geom.svg import geometry_to_svg
from engine.model.report import StageReport
from engine.pipeline.context import JobContext, StageRequest
from engine.pipeline.registry import STAGE_NAMES, is_known_stage, run_stage
from engine.profiles.schema import default_yaml_text, validate
from engine.storage import Storage, UnsafeKeyError

app = FastAPI(title="pcb-worker")


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "gerbonara_version": version("gerbonara"),
        "shapely_version": version("shapely"),
    }


class ProfileBody(BaseModel):
    profile_yaml: str | None = None


@app.get("/profiles/default")
def get_default_profile() -> dict:
    """The built-in factory profile (= the schema) as YAML text + flattened fields with docs."""
    v = validate(None)
    return {"yaml": default_yaml_text(), "fields": v["fields"]}


@app.post("/profiles/validate")
def post_validate_profile(body: ProfileBody) -> dict:
    """Validate a tenant override against the default profile; returns errors + merged fields."""
    return validate(body.profile_yaml)


# One stage at a time per worker process: a stage is CPU-bound Python (GIL) and folds layers in a
# process pool, so two at once gain nothing — and two real boards at once hung a thread for good on
# 2026-09-10 (never returned, 0 % CPU). Health / SVG / profile calls stay concurrent.
# ``kill -USR1 <pid>`` dumps every thread's stack to stderr when something like that happens again.
_STAGE_LOCK = threading.Lock()
if hasattr(signal, "SIGUSR1"):
    faulthandler.register(signal.SIGUSR1, all_threads=True)


@app.post("/jobs/{job_id}/stages/{stage}", response_model=StageReport)
def post_stage(job_id: str, stage: str, body: StageRequest) -> StageReport:
    if not is_known_stage(stage):
        raise HTTPException(status_code=404, detail=f"unknown stage {stage!r}; known: {STAGE_NAMES}")
    try:
        ctx = JobContext(job_id=job_id, stage=stage, request=body, storage=Storage())
    except UnsafeKeyError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    with _STAGE_LOCK:
        return run_stage(ctx)


_JOB_ID = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def _genesis():
    from engine.adapters.genesis import GenesisAdapter, engine_from_env

    eng = engine_from_env()
    if not isinstance(eng, GenesisAdapter) or not eng.configured:
        raise HTTPException(status_code=409, detail="Genesis 投递未配置（PCB_CAM_ENGINE=genesis|hybrid 且 PCB_GENESIS_DROP_DIR）")
    return eng


class ResumeBody(BaseModel):
    from_part: int


@app.get("/jobs/{job_id}/genesis/status")
def get_genesis_status(job_id: str) -> dict:
    """A4.2: what the Genesis host has done with the job (not_delivered / waiting / paused / failed / done)."""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    return _genesis().status(job_id)


@app.post("/jobs/{job_id}/genesis/resume")
def post_genesis_resume(job_id: str, body: ResumeBody) -> dict:
    """A4.2 / A5: continue a paused or failed job from part ``from_part`` (the engineer released
    the EQ in AIOS); the host agent runs only the parts still pending."""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    r = _genesis().resume(job_id, body.from_part)
    if not r.get("resumed"):
        raise HTTPException(status_code=409, detail=r.get("reason", "cannot resume"))
    return r


@app.get("/jobs/{job_id}/layers/{layer:path}.svg")  # :path — 源文件直读的层叫 cad_export/<name>
def get_layer_svg(job_id: str, layer: str, frame: str | None = None, rev: str | None = None, step: str | None = None) -> Response:
    """``frame=board`` renders with the board outline as the viewBox instead of the layer's own
    extent, so several layers can be stacked for comparison (each layer's own bounds differ).
    ``rev=orig`` renders the customer's file even when the B line has written an edit copy
    (对原稿, p144). ``step=panel`` renders the working-panel copy the native engine wrote
    (``steps/panel/<file>``: nx×ny units, frame, thieving dots, tooling holes) with the panel
    as the frame — the ``_panel`` preview is only the placement plan."""
    storage = Storage()
    try:
        layer_map = storage.read_json(job_id, "layer_map.json")
    except UnsafeKeyError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not layer_map:
        raise HTTPException(status_code=404, detail="job has no layer_map (run intake first)")
    if layer.startswith("_"):  # stage-generated previews (e.g. ``_panel`` from the panel stage)
        p = storage.work_dir(job_id, create=False) / "cache" / f"{layer}.svg"
        if not p.is_file():
            raise HTTPException(status_code=404, detail=f"preview {layer!r} not generated yet")
        return Response(content=p.read_text(encoding="utf-8"), media_type="image/svg+xml")
    entry = _find_layer(layer_map, layer)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"layer {layer!r} not in layer_map")
    work = storage.work_dir(job_id, create=False)
    if step == "panel":
        path = work / "steps" / "panel" / entry["file"]
        if not path.is_file():
            raise HTTPException(status_code=404, detail="拼板层还没有生成（本地引擎的拼板阶段未跑，或该层不出工作板）")
        svg = _panel_svg(work, entry, path)
        if svg is None:  # no placement facts: fall back to folding the whole panel file (slow, big)
            cache = work / "cache"
            cache.mkdir(exist_ok=True)
            geom = fold_cached(cache, path, entry["file"] + "@panel", entry["type"])
            svg = geometry_to_svg(geom, layer_display_name(entry["file"]) + " (panel)", entry["type"], frame=_panel_frame(work))
        return Response(content=svg, media_type="image/svg+xml")
    path = work / "steps" / "edit" / entry["file"]  # the B line's edit copy wins over the customer file
    cache_rel = entry["file"]
    if rev and rev not in ("orig", "edit"):  # ``rev=<stage>``: the layer as it stood after that stage (时间轴刷写)
        hp, tag = boardq.frame_path(work, entry["file"], rev)
        if not tag:
            raise HTTPException(status_code=400, detail=f"unknown rev {rev!r}")
        path = hp if hp is not None else work / "src" / entry["file"]
        cache_rel = entry["file"] + tag
        rev = None
    if rev == "orig" or not path.is_file():
        path = work / "src" / entry["file"]
        cache_rel = entry["file"] + "@orig" if rev == "orig" else cache_rel
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"layer file missing: {entry['file']}")
    cache = work / "cache"
    cache.mkdir(exist_ok=True)
    geom = fold_cached(cache, path, cache_rel, entry["type"])
    box = _board_frame(work) if frame == "board" else None
    svg = geometry_to_svg(geom, layer_display_name(entry["file"]), entry["type"], frame=box)
    return Response(content=svg, media_type="image/svg+xml")


@app.get("/jobs/{job_id}/progress")
def get_progress(job_id: str, after: int = 0, limit: int = 200) -> dict:
    """引擎实况流：stage / op 级的进度行（``engine/pipeline/progress.py``），页面按 ``after=<n>`` 增量拉。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    work = Storage().work_dir(job_id, create=False)
    if not work.is_dir():
        return {"lines": [], "running": False}
    lines = progress.read(work, after=after, limit=limit)
    last = progress.read(work, after=0, limit=1)
    running = bool(last) and last[-1].get("event") != "stage_end"
    return {"lines": lines, "running": running}


@app.get("/jobs/{job_id}/history")
def get_history(job_id: str) -> dict:
    """时间轴刷写的帧清单：orig → 每个改过图的 stage（本地引擎写在 steps/history/<stage>/）→ panel。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    work = Storage().work_dir(job_id, create=False)
    if not work.is_dir():
        raise HTTPException(status_code=404, detail="unknown job")
    return boardq.history(work)


@app.post("/jobs/{job_id}/query")
def post_query(job_id: str, body: boardq.QueryBody) -> dict:
    """结构化查板（自然语言由 AIOS 侧翻成这个）：按层/类型/线宽/盘径/极性/网名/范围找物件，或问「哪里改动最多」。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    storage = Storage()
    work = storage.work_dir(job_id, create=False)
    if not work.is_dir():
        raise HTTPException(status_code=404, detail="unknown job")
    if body.what == "changes":
        return boardq.query_changes(work, body)
    return boardq.query_features(storage, job_id, body)


class GoldenBody(BaseModel):
    keys: list[str]


@app.post("/jobs/{job_id}/golden")
def post_golden(job_id: str, body: GoldenBody) -> dict:
    """终稿对比：存一套人工终稿（工程师改好的成品，zip 或散文件的 storage key），按后缀和输出产物配对。
    重传替换整套。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    if not body.keys:
        raise HTTPException(status_code=400, detail="no files")
    try:
        return cmp.store_golden(Storage(), job_id, body.keys)
    except UnsafeKeyError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.get("/jobs/{job_id}/compare")
def get_compare(job_id: str, force: bool = False) -> dict:
    """终稿对比：每个配上对的层的三档面积 + C 档簇清单，钻孔按孔径×孔数。缓存到文件变了为止。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    storage = Storage()
    if not storage.work_dir(job_id, create=False).is_dir():
        raise HTTPException(status_code=404, detail="unknown job")
    if not force and (hit := cmp.cached_compare(storage, job_id)) is not None:
        return hit  # 缓存命中不排队：页面切回来看结果不该等正在跑的 stage
    with _STAGE_LOCK:  # 整板逐层折叠 + 差集和 stage 一样吃 CPU，别和正在跑的 stage 抢
        return cmp.compare_job(storage, job_id, force=force)


@app.get("/jobs/{job_id}/compare/{suffix}.svg")
def get_compare_svg(job_id: str, suffix: str) -> Response:
    """终稿对比叠加图：终稿垫灰、我们的叠层色、人有我们没有涂红、我们有人没有涂蓝、C 档簇画框。"""
    if not _JOB_ID.match(job_id):
        raise HTTPException(status_code=400, detail="bad job id")
    storage = Storage()
    if not storage.work_dir(job_id, create=False).is_dir():
        raise HTTPException(status_code=404, detail="unknown job")
    svg = cmp.compare_svg(storage, job_id, "." + suffix.lstrip(".").lower())  # 单层，和层预览一样不排队
    if svg is None:
        raise HTTPException(status_code=404, detail=f"这一层没有配上对的人工终稿：{suffix}")
    return Response(content=svg, media_type="image/svg+xml")


def _board_frame(work) -> tuple[float, float, float, float] | None:
    """Board outline bounds (the align stage writes profile.wkb); None → each layer keeps its own extent."""
    p = work / "profile.wkb"
    if not p.is_file():
        return None
    try:
        return from_wkb(p.read_bytes()).bounds
    except Exception:  # noqa: BLE001 — a broken cache must not break the preview
        return None


def _panel_svg(work, entry: dict, panel_path) -> str | None:
    """Working-panel layer as SVG without folding nx×ny copies: the single unit's geometry is
    folded once (edit / SET copy, cached) and placed with ``<use>`` transforms that replay
    ``engine.panel.plan.unit_placements``; only the panel-only features (frame, thieving dots,
    tooling holes — whatever lies outside every unit) are folded from the panel file. A 56-up
    panel is then ~the size of one unit instead of 56×. Cached next to the WKB cache."""
    import json

    from shapely.affinity import rotate
    from shapely.geometry import Point, box

    from engine.geom.from_gerbonara import camfile_to_geometry
    from engine.geom.layers import open_camfile
    from engine.geom.svg import polygon_path

    meta_p = work / "steps" / "panel" / "panel.json"
    if not meta_p.is_file():
        return None
    try:
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        cand, places, ub = meta["candidate"], meta["placements"], meta["unit_bbox"]
    except Exception:  # noqa: BLE001
        return None
    cache = work / "cache"
    cache.mkdir(exist_ok=True)
    out = cache / (entry["file"].replace("/", "_") + "@panel.svg")
    # 单只副本:与 panel_build 读的是同一份 —— 本地引擎改过的层在 steps/edit,没改过的仍是客户原稿。
    # (只看 steps/edit 会让大多数层走回整层折叠的慢路。)
    from_set = bool(meta.get("from_set"))
    unit_src = work / "steps" / "set" / entry["file"] if from_set else work / "steps" / "edit" / entry["file"]
    tag = "@set" if from_set else ""
    if not unit_src.is_file():
        unit_src, tag = work / "src" / entry["file"], "@orig"
    if not unit_src.is_file():
        return None
    # 缓存要跟着三样东西失效:工作板文件、拼板方案(摆放/候选)、单只副本(改图后重画)
    newest = max(panel_path.stat().st_mtime, meta_p.stat().st_mtime, unit_src.stat().st_mtime)
    if out.is_file() and out.stat().st_mtime >= newest:
        return out.read_text(encoding="utf-8")
    unit = fold_cached(cache, unit_src, entry["file"] + tag, entry["type"])
    x0, y0, x1, y1 = (float(v) for v in ub)
    # panel-only features: anything outside every placed unit's bbox (dots between units, rails, frame)
    placed = []
    uses = []
    for pl in places:
        dx, dy, ang = float(pl["dx"]), float(pl["dy"]), float(pl.get("angle", 0))
        off_x, off_y = dx + x0, dy + y0
        base = box(0, 0, x1 - x0, y1 - y0)
        if ang % 360:
            base = rotate(base, ang, origin=(0, 0))
        bx0, by0, bx1, by1 = base.bounds
        placed.append(box(off_x, off_y, off_x + (bx1 - bx0), off_y + (by1 - by0)))
        uses.append(f'<use href="#unit" transform="translate({off_x - bx0:.4f},{off_y - by0:.4f}) rotate({ang:g}) translate({-x0:.4f},{-y0:.4f})"/>')
    try:
        cam = open_camfile(panel_path, entry["type"])
        keep = []
        for obj in cam.objects:
            try:
                bb = obj.bounding_box(unit="mm")
            except Exception:  # noqa: BLE001
                keep.append(obj)
                continue
            if bb is None:
                continue
            (ox0, oy0), (ox1, oy1) = bb
            # 按物件中心判断属于哪只板:用 bbox 包含会漏 —— 板边的外形线/焊盘 bbox 会伸出单只轮廓
            # 半个线宽,于是整块板都被当成"工作板独有",既重画一遍又退回整层折叠。
            c = Point((ox0 + ox1) / 2, (oy0 + oy1) / 2)
            # covers 而不是 contains:外形线的中点正好落在单只轮廓上,contains 不算「在里面」,
            # 于是 56 只板的外形会被当成工作板独有物件再折一遍
            if not any(pb.covers(c) for pb in placed):
                keep.append(obj)
        cam.objects = keep
        extras, _ = camfile_to_geometry(cam) if keep else (box(0, 0, 0, 0).buffer(0), None)
    except Exception:  # noqa: BLE001 — extras are decoration; the units still render
        extras = box(0, 0, 0, 0).buffer(0)
    svg = geometry_to_svg(extras, layer_display_name(entry["file"]) + " (panel)", entry["type"], frame=(0.0, 0.0, float(cand["panel_w"]), float(cand["panel_h"])))
    polys = [unit] if unit.geom_type == "Polygon" else list(getattr(unit, "geoms", []))
    paths = "".join(f'<path d="{polygon_path(pg)}"/>' for pg in polys if pg.geom_type == "Polygon" and not pg.is_empty)
    inject = f'<defs><g id="unit">{paths}</g></defs>\n' + "\n".join(uses) + "\n"
    k = svg.rfind("</g>")
    svg = svg[:k] + inject + svg[k:] if k >= 0 else svg
    out.write_text(svg, encoding="utf-8")
    return svg


def _panel_frame(work) -> tuple[float, float, float, float] | None:
    """The working panel's extent (``steps/panel/panel.json`` written by PanelBuild)."""
    import json

    p = work / "steps" / "panel" / "panel.json"
    if not p.is_file():
        return None
    try:
        c = json.loads(p.read_text(encoding="utf-8"))["candidate"]
        return (0.0, 0.0, float(c["panel_w"]), float(c["panel_h"]))
    except Exception:  # noqa: BLE001
        return None


def _find_layer(layer_map: dict, layer: str) -> dict | None:
    files = layer_map.get("files", [])
    for f in files:  # the file name itself is the safe key: Altium exports share one stem across every layer
        if f["file"] == layer:
            return f
    by_stem = [f for f in files if layer_display_name(f["file"]) == layer]
    if len(by_stem) == 1:  # stem only when it is unambiguous (first real job: 「六层内外3oz (1)」 × 26 layers)
        return by_stem[0]
    for f in files:  # then by type name (first of that type; inner_copper<N> selects by index)
        if f["type"] == layer:
            return f
        if f["type"] == "inner_copper" and layer == f"inner_copper{f.get('index')}":
            return f
    return None
