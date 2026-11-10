"""Output writers (Gerber factory format + round trip, IPC-D-356) and the gatekeeper re-read."""

from __future__ import annotations

from gerbonara.rs274x import GerberFile

from engine.geom.from_gerbonara import camfile_to_geometry
from engine.output.gerber_writer import (
    read_gerber_bytes,
    roundtrip,
    settings_from_profile,
    write_gerber,
)
from engine.output.ipc356 import TestPoint, count_records, write_ipc356

FIX = "tests/fixtures/kicad-x2ap"
GCFG = {"unit": "inch", "number_format": [2, 4], "zeros": "none", "notation": "absolute"}


def test_gerber_factory_format_roundtrip():
    gf = GerberFile.open(f"{FIX}/Flashpads-F_Cu.gbr")
    orig, _ = camfile_to_geometry(gf)
    data = write_gerber(gf, settings_from_profile(GCFG))
    text = data.decode()
    assert "%MOIN*%" in text and "%FSLAX24Y24*%" in text and "\nG75\n" not in text
    rt = roundtrip(orig, data)
    assert rt["objects"] == len(gf.objects)
    assert rt["ratio"] < 0.005  # inch 2.4 quantisation: ~0.2 %
    back = read_gerber_bytes(data)
    assert len(back.objects) == len(gf.objects)


def test_ipc356_records_roundtrip_count():
    pts = [TestPoint("N00001", 10.0, -20.5, 0.8, ref="TH", pin="T1"), TestPoint("N00002", 11.25, 3.0, 0.3), TestPoint("GND", 1, 1, 0.0, w_mm=1.0, h_mm=0.5, side=1)]
    text = write_ipc356("job-x", pts)
    lines = text.splitlines()
    assert lines[3] == "P  UNITS CUST 1" and lines[-1] == "999"
    assert lines[6].startswith("317N00001           TH    -T1  ") and "D0800" in lines[6] and "X+010000Y-020500" in lines[6]
    assert lines[8].startswith("327GND")
    assert count_records(text) == {"through": 2, "surface": 1, "nets": 3}


def test_output_and_gatekeeper_on_sample(pipeline):
    out = pipeline.run("kicad-x2ap", "output")
    assert out.status == "ok", out.summary
    names = {a.filename for a in out.artifacts}
    assert {"job.GTL", "job.GBL", "job.GTS", "job.GKO", "job.IPC", "output_manifest.json"} <= {n.replace(pipeline.job_id("kicad-x2ap"), "job") for n in names}
    assert any(n.endswith(".TXT") for n in names)
    kinds = {i.kind for i in out.items}
    assert "roundtrip_diff" not in kinds and "gerber_output" in kinds and "ipc356_output" in kinds
    gate = pipeline.run("kicad-x2ap", "gatekeeper")
    # Native is the default candidate generator, but an un-certified factory profile must go
    # through EQ even when all output round-trip checks are green.
    assert gate.status == "needs_review", [i.message for i in gate.items]
    assert any(i.kind == "gate_release_profile" and i.needs_decision for i in gate.items)
    s = next(i for i in gate.items if i.kind == "gate_summary")
    assert s.measured == 0
    certified = pipeline.run("kicad-x2ap", "gatekeeper", profile_yaml="release:\n  mode: certified\n")
    assert certified.status == "ok"
    assert not any(i.kind == "gate_release_profile" for i in certified.items)


def test_gatekeeper_blocks_on_tampered_output(pipeline):
    """Corrupt one written Gerber after the output stage: the re-read must block."""
    board = "kicad-x2ap"
    out = pipeline.run(board, "output")
    art = next(a for a in out.artifacts if a.kind == "gerber_review" and a.filename.endswith(".GTL"))
    p = pipeline.storage.object_path(art.path)
    original = p.read_bytes()
    try:
        p.write_bytes(b"%FSLAX24Y24*%\n%MOIN*%\nM02*\n")  # empty layer
        gate = pipeline.run(board, "gatekeeper", layer_map=pipeline.reports[(board, "intake")].layer_map)
        assert gate.status == "blocked"
        assert any(i.kind == "gate_area_mismatch" for i in gate.items)
    finally:
        p.write_bytes(original)


def test_report_html_artifact(pipeline):
    out = pipeline.run("kicad-x2ap", "output")
    art = next(a for a in out.artifacts if a.kind == "eq_report" and a.filename.endswith(".html"))
    text = pipeline.storage.object_path(art.path).read_text(encoding="utf-8")
    assert text.startswith("<!doctype html>") and "PCB CAM 任务报告" in text and "步骤总览" in text
    assert "npth_clearance" in text and "Genesis 操作草稿" in text and art.content_type == "text/html"




def test_rail_lines_follow_the_material_but_reach_the_profile_box():
    """V-cut 线只画在板材上（3×3 板：两只单元之间 6 mm 的锣通道处断开），两头拉到 Profile 外框
    （六层板终稿 x 0..500，板材 3..497 —— 线头伸出圆角板角）。"""
    from shapely.geometry import box

    from engine.stages.output import _on_material

    prof = box(3, 0, 97, 50).difference(box(40, -1, 46, 51))  # 板材 3..97，中间一条 6 mm 锣槽；外框 3..97
    got = _on_material([(0.0, 25.0), (100.0, 25.0)], prof)
    spans = sorted((round(p[0][0], 3), round(p[-1][0], 3)) for p in got)
    assert spans == [(3.0, 40.0), (46.0, 97.0)]
    prof2 = box(3, 0, 97, 50).union(box(0, 5, 100, 45))  # 圆角板角的近似：外框 0..100，y=2 处板材只有 3..97
    got = _on_material([(0.0, 2.0), (100.0, 2.0)], prof2)
    assert [(round(p[0][0], 3), round(p[-1][0], 3)) for p in got] == [(0.0, 100.0)]
