"""Align on the three sample boards + profile / SVG unit checks."""

import pytest
from shapely import from_wkb
from shapely.geometry import Polygon

from engine.geom.svg import geometry_to_svg
from tests.conftest import BOARDS


@pytest.mark.parametrize("board", BOARDS)
def test_align_runs_and_defines_profile(pipeline, board):
    rep = pipeline.run(board, "align")
    assert rep.status in ("ok", "needs_review"), rep.summary
    kinds = [i.kind for i in rep.items]
    assert "profile_not_closed" not in kinds
    assert "layer_parse_error" not in kinds
    profile = [a for a in rep.artifacts if a.kind == "profile"]
    assert profile and pipeline.storage.object_exists(profile[0].path)
    geom = from_wkb(pipeline.storage.read_object(profile[0].path))
    assert isinstance(geom, Polygon) and geom.area > 100
    work = pipeline.storage.work_dir(pipeline.job_id(board), create=False)
    assert (work / "profile.wkb").is_file()
    for step in ("orig", "net", "edit"):
        assert any((work / "steps" / step).rglob("*"))
    assert any((work / "cache").glob("*.wkb"))


def test_kicad_profile_and_linewidth(pipeline):
    rep = pipeline.run("kicad-x2ap", "align")
    geom = from_wkb((pipeline.storage.work_dir(pipeline.job_id("kicad-x2ap"), create=False) / "profile.wkb").read_bytes())
    assert geom.bounds == pytest.approx((20.0, -70.0, 100.0, -20.0))
    lw = [i for i in rep.items if i.kind == "profile_line_width"]
    assert lw and lw[0].fix and lw[0].fix.genesis_script == "COM sel_change_sym,symbol=r5.906"
    assert lw[0].fix.auto_fixable is False and lw[0].measured == "0.254"
    # 2-layer KiCad test board: nothing outside the profile, nothing offset from the drills
    assert not [i for i in rep.items if i.kind == "layer_offset"]
    assert not [i for i in rep.items if i.kind == "outside_profile"]


def test_altium_align_reports_outside_objects(pipeline):
    rep = pipeline.run("altium-limesdr", "align")
    outs = [i for i in rep.items if i.kind == "outside_profile"]
    # mechanical layer GM1 has dimension drawings far outside the board: silk/other layers do too
    assert outs, [i.kind for i in rep.items]
    for i in outs:
        # 本地引擎的 DeleteOutsideProfile 已经把板外物删掉了（p112）：fix 是「已执行」，不是待办
        assert i.fix and i.fix.type == "delete" and i.fix.op == "DeleteOutsideProfile" and i.fix.auto_fixable
        assert i.fix.applied and "本地引擎已执行" in i.message
        assert i.location is not None and i.location.bbox is not None
    align = [a for a in rep.artifacts if a.filename == "align.json"]
    assert align and pipeline.storage.object_exists(align[0].path)


def test_align_without_layer_map_fails(pipeline):
    from engine.pipeline.context import JobContext, StageRequest
    from engine.pipeline.registry import run_stage

    req = StageRequest(tenant_id="t1", input_keys=[], output_prefix="pcb-cam/t1/job-empty/output/align/")
    rep = run_stage(JobContext(job_id="job-empty", stage="align", request=req, storage=pipeline.storage))
    assert rep.status == "failed"


def test_svg_render_flips_y_and_tags_paths():
    poly = Polygon([(0, 0), (10, 0), (10, 5), (0, 5)], [[(1, 1), (2, 1), (2, 2), (1, 2)]])
    svg = geometry_to_svg(poly, "L1", "top_copper")
    assert 'viewBox="-1 -6 12 7"' in svg
    assert 'transform="scale(1,-1)"' in svg and 'data-id="L1:0"' in svg
    assert svg.count("<path") == 1 and svg.count(" Z") == 2
