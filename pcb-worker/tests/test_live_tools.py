"""页面的「引擎实况流 / 时间轴刷写 / 查板」三个接口：进度行随 stage 和本地引擎的 op 一起写、
history 帧按 stage 顺序、``rev=<stage>`` 取那一帧的层、结构化查询按线宽/盘径过滤并带 bbox。"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from engine.api.main import app
from engine.pipeline import progress
from engine.query import QueryBody, frame_path, history, query_features
from engine.storage import Storage
from tests.conftest import Pipeline


@pytest.fixture
def native_pipe(tmp_path, monkeypatch):
    monkeypatch.setenv("PCB_CAM_ENGINE", "native")
    monkeypatch.setenv("PCB_STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setenv("PCB_WORK_ROOT", str(tmp_path / "work"))
    return Pipeline(Storage(storage_root=tmp_path / "storage", work_root=tmp_path / "work"))


def test_progress_lines_are_appended_and_read_incrementally(tmp_path):
    progress.emit(tmp_path, "align", "stage_start", "开始")
    progress.emit(tmp_path, "align", "op_end", "SetProfile", call=3, added=0, deleted=0, modified=28)
    lines = progress.read(tmp_path)
    assert [x["n"] for x in lines] == [1, 2] and lines[1]["modified"] == 28
    assert progress.read(tmp_path, after=1)[0]["event"] == "op_end"
    for i in range(progress.KEEP + 20):
        progress.emit(tmp_path, "inner", "op_end", f"x{i}")
    assert len(progress.read(tmp_path, limit=10_000)) == progress.KEEP


def test_native_run_writes_progress_history_and_rev_frames(native_pipe):
    rep = native_pipe.run("eagle-newer", "align")
    job = native_pipe.job_id("eagle-newer")
    work = native_pipe.storage.work_dir(job)
    lines = progress.read(work, limit=10_000)
    events = [x["event"] for x in lines]
    assert events[0] == "stage_start" and events[-1] == "stage_end" and "op_end" in events
    assert any(x.get("op") == "SetProfile" and x.get("modified", 0) > 0 for x in lines)
    h = history(work)
    assert h["frames"][0]["stage"] == "orig"
    align = next(f for f in h["frames"] if f["stage"] == "align")
    lm = json.loads((work / "layer_map.json").read_text())
    outline = next(e["file"] for e in lm["files"] if e["type"] == "outline")
    assert outline in align["layers"] and any(o["op"] == "SetProfile" for o in align["ops"])
    assert h["by_layer"][outline] == ["align"]
    p, tag = frame_path(work, outline, "align")
    assert p is not None and tag == "@h:align"
    p2, tag2 = frame_path(work, outline, "intake")  # before the change: the customer's file
    assert p2 is None and tag2 == "@orig"
    assert frame_path(work, outline, "nonsense") == (None, "")
    client = TestClient(app)
    r = client.get(f"/jobs/{job}/layers/{outline}.svg", params={"rev": "align", "frame": "board"})
    assert r.status_code == 200 and r.text.startswith("<svg")
    r = client.get(f"/jobs/{job}/layers/{outline}.svg", params={"rev": "nope"})
    assert r.status_code == 400
    r = client.get(f"/jobs/{job}/history")
    assert r.status_code == 200 and r.json()["frames"][1]["stage"] == "align"
    r = client.get(f"/jobs/{job}/progress", params={"after": 0})
    assert r.status_code == 200 and r.json()["running"] is False and r.json()["lines"]
    assert rep.status in ("ok", "needs_review")


def test_query_features_filters_lines_by_width_and_pads_by_size(native_pipe):
    native_pipe.run("eagle-newer", "align")
    job = native_pipe.job_id("eagle-newer")
    # eagle-newer copper: top lines 1.32 mm, bottom lines 1.68 mm — 1.5 splits them
    thin = query_features(native_pipe.storage, job, QueryBody(feature="line", width_lt_mm=1.5))
    assert thin["total"] > 0 and all(h["kind"] in ("line", "arc") and h["measured"] < 1.5 for h in thin["hits"])
    assert all(len(h["bbox"]) == 4 for h in thin["hits"]) and "copper_top.gbr" in thin["by_layer"]
    thick = query_features(native_pipe.storage, job, QueryBody(feature="line", width_gt_mm=1.5))
    assert thick["total"] > 0 and all(h["measured"] > 1.5 for h in thick["hits"]) and "copper_bottom.gbr" in thick["by_layer"]
    pads = query_features(native_pipe.storage, job, QueryBody(feature="pad", size_gt_mm=1.0, layer_types=["top_copper"]))
    assert pads["total"] > 0 and all(h["kind"] == "pad" and h["measured"] > 1.0 for h in pads["hits"])
    assert set(pads["by_layer"]) <= {e["file"] for e in json.loads((native_pipe.storage.work_dir(job) / "layer_map.json").read_text())["files"] if e["type"] == "top_copper"}
    none = query_features(native_pipe.storage, job, QueryBody(feature="line", width_lt_mm=1.5, size_lt_mm=1.0))
    assert none["total"] == 0  # a size bound never matches a line
    client = TestClient(app)
    r = client.post(f"/jobs/{job}/query", json={"what": "changes"})
    assert r.status_code == 200 and r.json()["total"] > 0 and r.json()["by_op"].get("SetProfile")
    r = client.post(f"/jobs/{job}/query", json={"what": "features", "feature": "line", "width_lt_mm": 1.5, "limit": 3})
    assert r.status_code == 200 and len(r.json()["hits"]) == 3 and r.json()["truncated"] == r.json()["total"] - 3
