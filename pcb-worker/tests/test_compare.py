"""终稿对比（页面「终稿对比」页的后端，engine/compare.py + 三个端点）。

人工终稿 = 工程师改好的成品 Gerber。这里拿我们自己的输出当终稿传上去：配对必须按后缀全对上、
逐层差异必须是零、钻孔孔径×孔数必须全等 —— 这是「对比器本身没毛病」的底线；真差异的分档
在 tests/test_xordiff.py 里另测。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from engine import compare as cmp
from engine.api.main import app


def _golden_zip_of_own_output(pipeline, board: str, drop_suffix: str | None = None) -> bytes:
    out = pipeline.run(board, "output")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for a in out.artifacts:
            if a.filename in (None, "output_manifest.json") or a.filename.endswith((".html", ".json", ".csh", ".ipc")):
                continue
            if drop_suffix and a.filename.lower().endswith(drop_suffix):
                continue
            zf.writestr(a.filename, pipeline.storage.read_object(a.path))
    return buf.getvalue()


def test_own_output_as_golden_pairs_every_layer_and_differs_nowhere(worker_env, pipeline):
    board = "kicad-x2ap"
    pipeline.run(board, "output")
    job = pipeline.job_id(board)
    key = f"pcb-cam/t/{job}/golden/final.zip"
    worker_env.write_object(key, _golden_zip_of_own_output(pipeline, board))
    client = TestClient(app)

    r = client.post(f"/jobs/{job}/golden", json={"keys": [key]})
    assert r.status_code == 200, r.text
    m = r.json()
    assert m["has_golden"] and m["has_output"] and m["errors"] == []
    assert m["unmatched_output"] == [], m["unmatched_output"]  # 每个输出层都有同后缀的终稿
    assert {x["suffix"] for x in m["layers"]} >= {".gtl", ".gbl", ".gts", ".gko"}
    assert m["drill"] and m["drill"]["golden"]

    r = client.get(f"/jobs/{job}/compare")
    assert r.status_code == 200, r.text
    c = r.json()
    assert c["summary"]["n_layers"] == len(m["layers"])
    for lay in c["layers"]:
        assert lay["n_clusters"] == 0, (lay["suffix"], lay["clusters"][:2])
        assert lay["xor_pct"] < 1e-6
        assert lay["bands"]["missing"]["shape"] == 0 and lay["bands"]["extra"]["shape"] == 0
    assert c["drill"]["n_mismatch"] == 0 and c["drill"]["holes_ours"] == c["drill"]["holes_golden"] > 0
    assert c["summary"]["n_clusters"] == 0
    # ★契约样例：aios 仓 modules/pcb-cam/tests/fixtures/compare/kicad-x2ap.json 用的就是这一份（改字段要重导）
    sample = Path(__file__).parent / "fixtures" / "compare_samples" / "kicad-x2ap.json"
    sample.parent.mkdir(parents=True, exist_ok=True)
    sample.write_text(json.dumps(c, ensure_ascii=False, indent=1), "utf-8")

    # 第二次问同样的问题不重算：缓存带指纹
    r2 = client.get(f"/jobs/{job}/compare")
    assert r2.json()["fingerprint"] == c["fingerprint"]

    r = client.get(f"/jobs/{job}/compare/gtl.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    svg = r.text
    for cls in ("cmp-gold", "cmp-orig", "cmp-ours", "cmp-missing", "cmp-extra", "cmp-clusters"):
        assert f'class="{cls}"' in svg  # cmp-orig = 客户原稿（移到输出坐标系），三方对比
    assert m["layers"][0]["file"]  # 每层记着客户源文件，原稿层由它折出来
    assert 'data-cluster="' not in svg  # 零差异 = 没有簇框
    assert client.get(f"/jobs/{job}/compare/nope.svg").status_code == 404
    assert client.get("/jobs/job-does-not-exist/compare").status_code == 404


def test_reupload_replaces_the_whole_set_and_reports_unmatched(worker_env, pipeline):
    board = "kicad-x2ap"
    pipeline.run(board, "output")
    job = pipeline.job_id(board)
    k1 = f"pcb-cam/t/{job}/golden/full.zip"
    k2 = f"pcb-cam/t/{job}/golden/partial.zip"
    worker_env.write_object(k1, _golden_zip_of_own_output(pipeline, board))
    worker_env.write_object(k2, _golden_zip_of_own_output(pipeline, board, drop_suffix=".gts"))
    client = TestClient(app)
    assert client.post(f"/jobs/{job}/golden", json={"keys": [k1]}).json()["unmatched_output"] == []
    m = client.post(f"/jobs/{job}/golden", json={"keys": [k2]}).json()
    assert [x["suffix"] for x in m["unmatched_output"]] == [".gts"]  # 上一套的 .gts 没有残留下来冒充
    assert ".gts" not in {x["suffix"] for x in m["layers"]}
    c = client.get(f"/jobs/{job}/compare").json()
    assert ".gts" not in {x["suffix"] for x in c["layers"]}
    assert client.get(f"/jobs/{job}/compare/gts.svg").status_code == 404


def test_loose_files_and_missing_keys(worker_env, pipeline):
    board = "kicad-x2ap"
    out = pipeline.run(board, "output")
    job = pipeline.job_id(board)
    gtl = next(a for a in out.artifacts if a.filename and a.filename.lower().endswith(".gtl"))
    k = f"pcb-cam/t/{job}/golden/{gtl.filename}"
    worker_env.write_object(k, pipeline.storage.read_object(gtl.path))
    m = cmp.store_golden(worker_env, job, [k, f"pcb-cam/t/{job}/golden/ghost.gbl"])
    assert [x["suffix"] for x in m["layers"]] == [".gtl"]
    assert m["errors"] and "ghost.gbl" in m["errors"][0]
    r = TestClient(app).post(f"/jobs/{job}/golden", json={"keys": []})
    assert r.status_code == 400


def test_drill_sizes_reads_gerber_and_excellon(tmp_path):
    g = tmp_path / "a.drl"
    g.write_text("%FSLAX26Y26*%\n%MOMM*%\n%ADD10C,0.300*%\n%ADD11C,1.000*%\nD10*\nX1000000Y1000000D03*\nX2000000Y1000000D03*\nD11*\nX3000000Y1000000D03*\nM02*\n")
    assert cmp.drill_sizes(g) == {(0.3, "hole"): 2, (1.0, "hole"): 1}
    x = tmp_path / "a.txt"
    x.write_text("M48\nMETRIC\nT01C0.300\nT02C1.000\n%\nT01\nX1000Y1000\nX2000Y1000\nT02\nX3000Y1000\nX3000Y2000G85X4000Y2000\nM30\n")
    assert cmp.drill_sizes(x) == {(0.3, "hole"): 2, (1.0, "hole"): 1, (1.0, "slot"): 1}


def test_same_spot_missing_and_extra_become_one_changed_entry():
    """梅花孔：他画带缺口的圆、我们画整圆 —— 同一处一红一蓝，给人看要合成一处「改了」。"""
    from shapely.geometry import box as B

    from engine.geom import xordiff

    gold = B(0, 0, 100, 100).difference(B(10, 10, 14, 14))  # 他这里挖了个方
    ours = B(0, 0, 100, 100).difference(B(11, 9, 15, 13))  # 我们挖的方错位了：同一处两边都有、形状不同
    ours = ours.difference(B(60, 60, 62, 62))  # 另一处只有我们少了铜（多了一个洞）→ 工程师有铜我们没有
    rep = xordiff.compare(ours, gold)
    merged = cmp.merge_changed(rep["clusters"])
    kinds = sorted(m["direction"] for m in merged)
    assert kinds == ["changed", "missing"], merged
    ch = next(m for m in merged if m["direction"] == "changed")
    assert ch["area_missing_mm2"] > 0 and ch["area_extra_mm2"] > 0
    assert abs(ch["area_mm2"] - (ch["area_missing_mm2"] + ch["area_extra_mm2"])) < 1e-6
    assert [m["id"] for m in merged] == [0, 1]  # 编号按面积降序重排，SVG 的 data-cluster 用同一套


def test_drill_sizes_converts_inch_gerber_to_mm(tmp_path):
    """这家厂的 .drl 是英寸 Gerber：搬代码时丢过单位处理，C09 钻孔对比一度变成「⌀0.018」。"""
    g = tmp_path / "a.drl"
    g.write_text("%FSLAX25Y25*%\n%MOIN*%\n%ADD10C,0.017717*%\nD10*\nX100000Y100000D03*\nM02*\n")
    assert cmp.drill_sizes(g) == {(0.45, "hole"): 1}
    x = tmp_path / "a.txt"
    x.write_text("M48\nINCH\nT01C0.0177\n%\nT01\nX1000Y1000\nM30\n")
    assert cmp.drill_sizes(x) == {(0.45, "hole"): 1}
