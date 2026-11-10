"""Factory rules learned from the first real customer job (六层内外3oz, 2026-09-09, ROADMAP §M6h):
outline choice with rails, drawn holes, plugged-via grouping, drill overrides, second drill,
pre-drills, tooling holes, rectangle→rout, copper-weight compensation, origin shift and the
outline drawn from the Profile. Each rule is exercised on the small KiCad sample with a profile
override, so the suite stays fast; the real board is ``cases/C09_real_6l_3oz`` (make verify)."""

from __future__ import annotations

import json
import re
import warnings
from pathlib import Path

import pytest
from shapely import from_wkb
from shapely.geometry import Point

from engine.checks.copper import compensation_for
from engine.geom.layers import open_camfile
from engine.geom.profile import extract_profile
from engine.model.report import ReportItem
from engine.output.gerber_writer import gerber_from_geometry, write_gerber
from engine.stages.drill import (
    ITEM_CAP,
    Hole,
    ToolRow,
    _capped,
    _tape_tools,
    assign_attributes,
    delete_overlapping_holes,
    parse_altium_drr,
    rect_corner_tools,
    second_drill_split,
    via_plug_requested,
)
from engine.verify import _drill_sizes

warnings.filterwarnings("ignore")

FIX = Path(__file__).parent / "fixtures" / "kicad-x2ap"


# ---- pure helpers ---------------------------------------------------------------------------
def test_via_plug_requested_reads_the_order():
    assert via_plug_requested({"via_plugging": "绿油塞孔（所有非焊盘上的 0.5mm 孔）"})
    assert via_plug_requested({"via_plugging": "resin plug"})
    assert not via_plug_requested({"via_plugging": "无"})
    assert not via_plug_requested({"via_plugging": "不塞孔"})
    assert not via_plug_requested({})


def test_compensation_table_by_copper_weight():
    thr = {"compensation_threshold_mm": 0.381, "line_compensation_mm": 0.0254}
    cfg = {"compensation_by_oz": [{"oz": 1, "add_mm": 0.0254}, {"oz": 2, "add_mm": 0.05}, {"oz": 3, "add_mm": 0.1}], "compensation_scope": "all"}
    add, below, scope = compensation_for(cfg, thr, {"copper_outer_um": 105, "copper_inner_um": 35}, "outer")
    assert (add, scope) == (0.1, "all") and below == float("inf")
    add, _, _ = compensation_for(cfg, thr, {"copper_outer_um": 105, "copper_inner_um": 35}, "inner")
    assert add == 0.0254
    # 70 µm = 2 oz; 90 µm rounds down to the 2 oz row; no order data → the book's +1 mil, thin lines only
    assert compensation_for(cfg, thr, {"copper_inner_um": 90}, "inner")[0] == 0.05
    add, below, scope = compensation_for({}, thr, {"copper_outer_um": 105}, "outer")
    assert (add, below, scope) == (0.0254, 0.381, "thin_lines")


def test_capped_check_keeps_one_decision():
    items: list[ReportItem] = []
    new = [ReportItem(id=f"x{i}", kind="hole_separation", severity="error", message="near", eq_question="?") for i in range(ITEM_CAP + 5)]
    _capped(items, new, "hole_separation", "孔距不足")
    assert len(items) == ITEM_CAP + 1
    assert sum(1 for i in items if i.eq_question) == 1 and items[-1].id == "hole_separation_more"
    assert all(i.severity == "warn" for i in items[:-1]) and items[-1].severity == "error"


def test_altium_drr_parser(tmp_path, pipeline):
    job = pipeline.job_id("kicad-x2ap")
    pipeline.run("kicad-x2ap", "intake")
    src = pipeline.storage.work_dir(job) / "src"
    (src / "board.DRR").write_bytes(
        "Tool  Hole Size  Hole Tolerance  Hole Type  Hole Count  Plated  Tool Travel\n"
        "T1      20mil (0.5mm)                    Round      6703      PTH   827.01inch (21006.18mm)\n"
        "T14     47mil (1.2mm)                    Rectangle  19        PTH   68.68inch (1744.46mm)\n"
        "T34     165mil (4.2mm)                   Round      11        NPTH  71.56inch (1817.73mm)\n".encode("gbk")
    )
    from engine.pipeline.context import JobContext, StageRequest

    ctx = JobContext(job_id=job, stage="drill", request=StageRequest(tenant_id="t1", input_keys=[], output_prefix="x/"), storage=pipeline.storage)
    tools = parse_altium_drr(ctx)
    (src / "board.DRR").unlink()
    assert [(t["tool"], t["size_mm"], t["kind"], t["count"], t["plated"]) for t in tools] == [
        ("T1", 0.5, "Round", 6703, True), ("T14", 1.2, "Rectangle", 19, True), ("T34", 4.2, "Round", 11, False)]  # fmt: skip


def test_extract_profile_merges_rails_and_finds_drawn_holes(tmp_path):
    # board 50×30 + a 5 mm rail glued to its top edge + a 3 mm circle and a 10×6 cut-out inside
    import math

    circle = [(25 + 1.5 * math.cos(a), 32.5 + 1.5 * math.sin(a)) for a in [i * 2 * math.pi / 64 for i in range(65)]]
    lines = [
        ([(0, 0), (50, 0), (50, 30), (0, 30), (0, 0)], 0.2),
        ([(0, 30), (50, 30), (50, 35), (0, 35), (0, 30)], 0.2),
        (circle, 0.2),
        ([(10, 10), (20, 10), (20, 16), (10, 16), (10, 10)], 0.2),
    ]
    p = tmp_path / "outline.gbr"
    p.write_bytes(write_gerber(gerber_from_geometry(lines, []), None))
    pr = extract_profile(open_camfile(p, "outline"))
    assert pr.profile is not None and pr.attached_rings == 1
    assert [round(v) for v in pr.profile.bounds] == [0, 0, 50, 35]
    assert len(pr.profile.interiors) == 1  # the rectangle stays a routed cut-out
    assert len(pr.drawn_holes) == 1 and pr.drawn_holes[0][2] == pytest.approx(3.0, abs=0.05)
    # the rail itself and the board edge it sits on (the V-cut line) come back for RailFill / the outline
    assert len(pr.rails) == 1 and [round(v) for v in pr.rails[0].bounds] == [0, 30, 50, 35]
    assert len(pr.rail_lines) == 1
    (ax, ay), (bx, by) = pr.rail_lines[0][0], pr.rail_lines[0][-1]
    assert ay == pytest.approx(30, abs=0.05) and by == pytest.approx(30, abs=0.05) and abs(bx - ax) == pytest.approx(50, abs=0.2)  # on the drawn stroke, not on the board face


def _row(tool, dia, holes, *, plated=True, slot=False, drill=None):
    r = ToolRow(tool=tool, file="d.drl", dia_mm=dia, plated=plated, slot=slot, holes=[Hole(x, y, dia, plated, "d.drl", slot=slot, x2=x2, y2=y2, tool=tool) for x, y, x2, y2 in holes])
    r.count = len(r.holes)
    r.drill_dia_mm = drill if drill is not None else dia
    r.attribute = "plated" if plated else "non_plated"
    for h in r.holes:
        h.attribute, h.drill_dia = r.attribute, r.drill_dia_mm
    return r


def test_overlapping_small_holes_go_when_the_factory_says_so():
    # eight ⌀1.0 holes on a 1.95 mm circle round a ⌀4.15 press-fit hole (the first real job) → the small ones go
    import math

    ring = [(10 + 1.95 * math.cos(a), 10 + 1.95 * math.sin(a), None, None) for a in [i * math.pi / 4 for i in range(8)]]
    rows = [_row("T01", 1.0, ring + [(30, 30, None, None)], drill=1.15), _row("T02", 4.2, [(10, 10, None, None)], drill=4.15)]
    assert delete_overlapping_holes(rows, {"overlap": "ask"}) == []
    gone = delete_overlapping_holes(rows, {"overlap": "delete_smaller"})
    assert len(gone) == 8 and all(g["inside"] == "T02" for g in gone)
    assert [(r.tool, r.count) for r in rows] == [("T01", 1), ("T02", 1)]  # renumbered, the far hole stays
    # the bigger hole is never the one deleted
    rows = [_row("T01", 4.2, [(10, 10, None, None)], drill=4.15), _row("T02", 1.0, [(11, 10, None, None)], drill=1.15)]
    assert delete_overlapping_holes(rows, {"overlap": "delete_smaller"})[0]["dia_mm"] == 1.0


def test_second_drill_small_npth_and_big_hole_oversize():
    rows = [_row("T01", 0.5, [(1, 1, None, None)], plated=False), _row("T02", 4.2, [(5, 5, None, None)], plated=False), _row("T03", 0.5, [(2, 2, None, None)])]
    assert second_drill_split(None, {}, rows, {"second_drill": "npth_small", "second_drill_max_mm": 1.0}) == 1
    assert [r.second for r in rows] == [True, False, False]  # only the small NPTH; the PTH 0.5 is not touched
    cfg = {"via_max_mm": 0.5, "oversize_mm": {"via": 0.15, "plated": 0.15, "non_plated": 0.05}, "round_step_mm": 0.05, "oversize_large": {"min_dia_mm": 6.0, "add_mm": 0.2}}
    rows = [_row("T01", 6.55, [(0, 0, None, None)]), _row("T02", 4.2, [(0, 9, None, None)]), _row("T03", 0.5, [(9, 9, None, None)])]
    assign_attributes(rows, cfg)
    assert [r.drill_dia_mm for r in rows] == [6.75, 4.35, 0.65]
    assert rows[0].holes[0].drill_dia == 6.75 and rows[2].holes[0].attribute == "via"


def test_big_hole_uses_the_reamer_step_above_6_45_not_a_fixed_oversize():
    """工程师回复二-3：「超出 6.45mm 钻孔，采用扩孔钻，比正常补偿多补 0.05mm」。"""
    cfg = {"via_max_mm": 0.5, "oversize_mm": {"via": 0.15, "plated": 0.15, "non_plated": 0.05}, "round_step_mm": 0.05,
           "oversize_large": {"min_dia_mm": 6.45, "extra_mm": 0.05}}
    rows = [_row("T01", 6.55, [(0, 0, None, None)]),                      # PTH: 0.15 + 0.05
            _row("T02", 6.45, [(0, 9, None, None)]),                      # 正好 6.45：没「超出」，普通预大
            _row("T03", 8.0, [(9, 0, None, None)], plated=False)]         # NPTH 大孔：0.05 + 0.05
    assign_attributes(rows, cfg)
    assert [r.drill_dia_mm for r in rows] == [6.75, 6.6, 8.1]


def test_drill_oversize_follows_the_surface_finish():
    """工程师回复一-6：喷锡 PTH +0.15、非喷锡 PTH +0.10，NPTH 两档都 +0.05。"""
    cfg = {"via_max_mm": 0.5, "round_step_mm": 0.05,
           "oversize_mm": {"via": 0.0, "plated": 0.15, "non_plated": 0.05},
           "oversize_by_finish": {"hasl": {"plated": 0.15}, "other": {"plated": 0.10}}}
    mk = lambda: [_row("T01", 1.0, [(0, 0, None, None)]), _row("T02", 1.0, [(0, 9, None, None)], plated=False)]  # noqa: E731
    rows = mk(); assign_attributes(rows, cfg, {"surface_finish": "无铅喷锡"})
    assert [r.drill_dia_mm for r in rows] == [1.15, 1.05]
    rows = mk(); assign_attributes(rows, cfg, {"surface_finish": "沉金 ENIG"})
    assert [r.drill_dia_mm for r in rows] == [1.10, 1.05]
    rows = mk(); assign_attributes(rows, cfg, {})  # 订单没写表面处理：不猜档，按 p114 默认
    assert [r.drill_dia_mm for r in rows] == [1.15, 1.05]


def test_slot_end_predrill_sits_tangent_to_the_slot_end_and_overrides_skip_predrill():
    cfg = {"predrill": {"min_dia_mm": 4.0, "bit_mm": 3.175}, "slot_end_predrill": [{"width_mm": 2.0, "bit_mm": 1.95}]}
    slot = _row("T01", 2.0, [(10, 10, 20, 10)], slot=True, drill=2.15)
    big = _row("T02", 4.2, [(30, 30, None, None)], drill=4.35)
    over = _row("T03", 4.2, [(40, 40, None, None)], drill=4.15)
    over.override = True
    tools, extra = _tape_tools([slot, big, over], cfg, (0.0, 0.0))
    assert extra == 3
    pre = next(t for t in tools if t.diameter_mm == 3.175)
    assert pre.holes == [(30.0, 30.0)], "the order-specified bit is drilled as is, no pre-drill"
    ends = next(t for t in tools if t.diameter_mm == 1.95)
    # 2026-09-20 逐条量第一块真板的钻带：孔心在槽端点**外侧** (2.152 − 1.95) / 2 = 0.101，
    # 也就是钻头内切槽的圆头（另两种槽 1.752/0.95 → 0.401、1.152/0.7 → 0.226，全对得上）
    assert ends.holes == [pytest.approx((9.9, 10.0)), pytest.approx((20.1, 10.0))]


def test_rect_corner_predrill_holes_touch_both_edges():
    # 工程师回复三-3：「原稿槽宽 1.7mm 以内的矩形槽，四角不加角孔」→ 门槛 1.75（钻嘴 0.05 步进）
    cfg = {"rect_corner_predrill": {"bit_mm": 0.8, "min_width_mm": 1.75}}
    contours = [{"x1": 0.0, "y1": 0.0, "x2": 10.0, "y2": 0.0, "width_mm": 4.0, "tool": "T02", "file": "a.drl"},
                {"x1": 0.0, "y1": 20.0, "x2": 5.0, "y2": 20.0, "width_mm": 1.2, "tool": "T14", "file": "a.drl"}]
    t = rect_corner_tools(contours, "a.drl", cfg, (0.0, 0.0))
    assert t is not None and t.diameter_mm == 0.8 and len(t.holes) == 4  # the narrow one gets none
    # the cut rectangle runs w/2 past both path points (square ends): corners at x = −2 / 12, y = ±2
    assert sorted(t.holes) == [pytest.approx(p) for p in [(-1.6, -1.6), (-1.6, 1.6), (11.6, -1.6), (11.6, 1.6)]]
    assert rect_corner_tools(contours, "b.drl", cfg, (0.0, 0.0)) is None
    # the factory's contour is drawn 0.1 bigger (4.1 × 12.1): the holes follow it (work/: 0.36 in from each edge of 4.25×11.25)
    t = rect_corner_tools(contours, "a.drl", {**cfg, "rect_rout_oversize_mm": 0.1}, (0.0, 0.0))
    assert sorted(t.holes) == [pytest.approx(p) for p in [(-1.65, -1.65), (-1.65, 1.65), (11.65, -1.65), (11.65, 1.65)]]


def test_drill_sizes_reads_an_excellon_tape_too(tmp_path):
    p = tmp_path / "t.drl"
    p.write_text("M48\nMETRIC,TZ\nT01C0.650\nT02C2.150\n%\nT01\nX1.0Y1.0\nX2.0Y1.0\nT02\nX5.0Y5.0G85X9.0Y5.0\nM30\n")
    assert _drill_sizes(p) == {(0.65, "hole"): 2, (2.15, "slot"): 1}


def test_drill_sizes_reads_a_gerber_drill_layer(tmp_path):
    p = tmp_path / "x.drl"
    p.write_bytes(write_gerber(gerber_from_geometry([([(1, 1), (3, 1)], 1.15)], [(5, 5, 0.65), (6, 6, 0.65), (7, 7, 4.25)]), None))
    sizes = _drill_sizes(p)
    assert sizes[(0.65, "hole")] == 2 and sizes[(4.25, "hole")] == 1 and sizes[(1.15, "slot")] == 1


# ---- the rules on a real (small) board ------------------------------------------------------
PROFILE = """
drill:
  oversize_mm: {via: 0.15}
  via_max_mm: 0.7
  plug: {oversize_mm: -0.05, opening_ratio_max: 1.6}
  predrill: {min_dia_mm: 1.1, bit_mm: 0.8}
  slot_end_predrill: [{width_mm: 0.6, bit_mm: 0.4}]
  second_drill: npth_without_pad
  drawn_holes_to_drill: true
  tooling_holes:
    - {corner: ll, dx_mm: 3.0, dy_mm: 3.0, dia_mm: 3.175}   # ≥ 3 mm: stays on the outline layer (smaller ones live in the drill only)
    - {corner: ur, dx_mm: 3.0, dy_mm: 3.0, dia_mm: 3.175}
copper:
  compensation_by_oz: [{oz: 1, add_mm: 0.0254}, {oz: 3, add_mm: 0.1}]
  compensation_scope: all
  npth_in_pad: clear
output:
  origin: profile_ll
  outline_from_profile: true
  drill_as_gerber: true
"""
ORDER = {"via_plugging": "绿油塞孔", "copper_outer_um": 105, "copper_inner_um": 105, "drill_overrides": [{"dia_mm": 1.1, "drill_mm": 1.3}]}


@pytest.fixture(scope="module")
def ruled(pipeline):
    """intake → align → drill on the KiCad board with the factory-rule profile, fresh job each module."""
    board = "kicad-x2ap"
    pipeline.run(board, "intake")
    align = pipeline.run(board, "align", profile_yaml=PROFILE, order_spec=ORDER)
    drill = pipeline.run(board, "drill", profile_yaml=PROFILE, order_spec=ORDER)
    return board, align, drill


def _table(pipeline, board):
    job = pipeline.job_id(board)
    key = f"pcb-cam/t1/{job}/output/drill/drill_table.json"
    return json.loads(pipeline.storage.read_object(key))


def test_plugged_vias_split_by_mask_opening(pipeline, ruled):
    board, _align, drill = ruled
    table = _table(pipeline, board)
    plug = [t for t in table["tools"] if t["attribute"] == "via_plug"]
    vias = [t for t in table["tools"] if t["attribute"] == "via"]
    assert plug, "the KiCad board's 0.7 mm vias sit in the pour with their own little openings → plugged"
    assert plug[0]["drill_dia_mm"] == pytest.approx(plug[0]["dia_mm"] - 0.05, abs=1e-3)
    for v in vias:  # any via left open is a via under an exposed pad and keeps the normal via oversize
        assert v["drill_dia_mm"] == pytest.approx(v["dia_mm"] + 0.15, abs=1e-3)
    assert any(i.kind == "drill_via_plug" for i in drill.items)
    assert table["factory_rules"]["plugged"] == sum(t["count"] for t in plug)


def test_drill_override_second_drill_and_tooling(pipeline, ruled):
    board, _align, drill = ruled
    table = _table(pipeline, board)
    over = [t for t in table["tools"] if t["note"].startswith("订单指定")]
    assert over and over[0]["drill_dia_mm"] == 1.3 and over[0]["count"] == 4
    second = [t for t in table["tools"] if t.get("second")]
    assert second and all(t["attribute"] == "non_plated" for t in second)
    tooling = [t for t in table["tools"] if t["tool"] == "TOOLING"]
    assert tooling and tooling[0]["count"] == 2 and tooling[0]["drill_dia_mm"] == pytest.approx(3.2, abs=1e-3)
    kinds = {i.kind for i in drill.items}
    assert {"drill_override", "drill_second", "drill_tooling", "drill_predrill", "drill_slot_predrill"} <= kinds
    names = {a.filename for a in drill.artifacts}
    assert any(n.endswith("_2nd.drl") for n in names) and "drill_layer.gbr" in names
    # tapes carry the pre-drills + tooling on top of the design holes
    assert table["tape_holes_expected"] > table["total_holes"]


def test_origin_shift_and_outline_from_profile(pipeline, ruled):
    board, _align, _drill = ruled
    job = pipeline.job_id(board)
    prof = from_wkb((pipeline.storage.work_dir(job) / "profile.wkb").read_bytes())
    x0, y0 = prof.bounds[:2]
    for st in ("inner", "outer", "mask", "silk", "net_compare", "panel"):
        pipeline.run(board, st, profile_yaml=PROFILE, order_spec=ORDER)
    out = pipeline.run(board, "output", profile_yaml=PROFILE, order_spec=ORDER)
    manifest = json.loads(pipeline.storage.read_object(next(a.path for a in out.artifacts if a.filename == "output_manifest.json")))
    assert manifest["origin_shift"] == [pytest.approx(-x0), pytest.approx(-y0)] and manifest["outline_from_profile"]
    gko = next(l for l in manifest["layers"] if l["type"] == "outline")
    text = pipeline.storage.read_object(gko["path"]).decode()
    xs = [int(m) for m in re.findall(r"X(-?\d+)", text)]
    assert min(xs) >= 0 and "D03*" in text, "outline drawn from (0,0) with the tooling holes flashed"
    gate = pipeline.run(board, "gatekeeper", profile_yaml=PROFILE, order_spec=ORDER)
    assert not [i for i in gate.items if i.kind == "gate_area_mismatch"]
    assert any(i.kind == "gate_profile_ok" for i in gate.items)
    assert gate.status != "blocked", gate.summary


def test_outline_candidates_pick_the_one_that_holds_the_copper(pipeline, tmp_path):
    """A second outline layer with a rail on top: the one enclosing every layer wins and an EQ says so."""
    board = "kicad-x2ap"
    pipeline.run(board, "intake")
    job = pipeline.job_id(board)
    work = pipeline.storage.work_dir(job)
    prof = from_wkb((work / "profile.wkb").read_bytes()) if (work / "profile.wkb").is_file() else None
    lm = json.loads((work / "layer_map.json").read_text("utf-8"))
    edge = next(e for e in lm["files"] if e["type"] == "outline")
    src = work / "src" / edge["file"]
    pr = extract_profile(open_camfile(src, "outline"))
    x0, y0, x1, y1 = pr.profile.bounds
    rail = [([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], 0.15), ([(x0, y1), (x1, y1), (x1, y1 + 5), (x0, y1 + 5), (x0, y1)], 0.15)]
    rel = str(Path(edge["file"]).with_name("Rails.gbr"))
    (work / "src" / rel).write_bytes(write_gerber(gerber_from_geometry(rail, []), None))
    lm2 = json.loads(json.dumps(lm))
    lm2["files"].append({"file": rel, "type": "outline", "confidence": 0.5, "index": None, "side": None, "polarity": "positive", "drill_span": None})
    rep = pipeline.run(board, "align", layer_map=lm2)
    cand = [i for i in rep.items if i.kind == "profile_candidates"]
    assert cand and cand[0].eq_question and cand[0].fix and cand[0].fix.params["chosen"] in (rel, edge["file"])
    meta = json.loads((work / "profile.json").read_text("utf-8"))
    # neither layer leaves copper outside (the rail is empty), so the higher-confidence original wins
    assert meta["file"] == edge["file"] and len(meta["candidates"]) == 2
    # an explicit order choice overrides
    rep = pipeline.run(board, "align", layer_map=lm2, order_spec={"outline_layer": rel})
    meta = json.loads((work / "profile.json").read_text("utf-8"))
    assert meta["file"] == rel and round(meta["bbox"][3] - y1, 1) == 5.0
    (work / "src" / rel).unlink()
    pipeline.run(board, "align", layer_map=lm)  # restore the plain profile for the other tests
    assert prof is None or (work / "profile.wkb").is_file()
    assert not Point(0, 0).is_empty


# ---- mask.resize_mode: per_opening (C09: only the under-covered openings grow) ------------------
def test_per_opening_resize_survives_a_stray_piece_shared_by_two_pads():
    """A stray drawn piece sits inside pad A's grown opening and also touches pad B. Pad A merges
    it away; pad B's snapshot still lists it first — growing a deleted feature was the
    `StopIteration` that silently skipped MaskResize on both mask layers of the C09 page run."""
    from gerbonara import graphic_objects as go
    from gerbonara.rs274x import GerberFile
    from gerbonara.utils import MM
    from shapely.geometry import box

    from engine.geom.features import FeatureLayer
    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_basic import _mask_resize_per_opening

    cu = FeatureLayer(GerberFile(), "top.gbr", "top_copper")
    cu.begin("seed")
    cu.add_pad(5, 5, Symbol("r", (1.0,)))
    cu.add_pad(6.05, 5, Symbol("r", (1.0,)))
    cu.commit()
    mask = FeatureLayer(GerberFile(), "mask.gbr", "top_mask")
    mask.begin("seed")
    mask.add_pad(5, 5, Symbol("r", (1.04,)))  # pad + 0.02/side: under the 2 mil rule
    stray = mask.add(go.Region(list(box(5.5, 4.98, 5.555, 5.02).exterior.coords), unit=MM, polarity_dark=True), "stray drawn piece")
    mask.add_pad(6.05, 5, Symbol("r", (1.04,)))
    mask.commit()
    cov = 0.0508
    call = OpCall(n=1, stage="mask", op="MaskResize", layer="mask.gbr", kind="mask_expansion", key="k", params={"mode": "per_opening"})
    cs = _mask_resize_per_opening(mask, cu, call, cov, 0.02)
    assert cs.params["openings_grown"] == 2
    assert mask.by_fid(stray.fid) is None
    u = mask.dark_union().buffer(0.005)  # circle discretisation slack
    assert u.contains(Point(5, 5).buffer(0.5 + cov)) and u.contains(Point(6.05, 5).buffer(0.5 + cov))
    with pytest.raises(ValueError, match="no longer on layer"):
        mask.begin("again")
        mask.replace_surface(stray, box(0, 0, 1, 1))


def test_only_short_slots_get_end_predrills():
    """p118 短槽: the first real job pre-drills the 2.15 slots whose travel is 2.0 (36) and just
    routs the ones whose travel is 7.5 (8) — travel < ratio × width."""
    cfg = {"slot_end_predrill": [{"width_mm": 2.0, "bit_mm": 1.95}], "short_slot_max_travel_ratio": 1.0}
    short = _row("T01", 2.0, [(10, 10, 12, 10)], slot=True, drill=2.15)
    long = _row("T02", 2.0, [(30, 10, 37.5, 10)], slot=True, drill=2.15)
    tools, extra = _tape_tools([short, long], cfg, (0.0, 0.0))
    ends = next(t for t in tools if t.diameter_mm == 1.95)
    assert extra == 2 and ends.holes == [pytest.approx((9.9, 10.0)), pytest.approx((12.1, 10.0))]
    tools, extra = _tape_tools([short, long], {**cfg, "short_slot_max_travel_ratio": 0}, (0.0, 0.0))
    assert extra == 4, "ratio 0 = every slot of the table"


def test_terminal_pads_grow_and_order_pads_get_their_size(monkeypatch):
    from types import SimpleNamespace

    from gerbonara.rs274x import GerberFile

    from engine.checks import common
    from engine.geom.features import FeatureLayer
    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_construct import terminal_pad
    from engine.profiles import load_profile

    cu = FeatureLayer(GerberFile(), "top.gbr", "top_copper")
    cu.begin("seed")
    cu.add_pad(50, 50, Symbol("oval", (14.0, 7.0)))  # the 4 mm slot's pad
    cu.add_pad(10, 10, Symbol("r", (5.5,)))  # the press-fit hole's pad
    cu.add_pad(70, 70, Symbol("r", (2.0,)))  # an ordinary hole: untouched
    cu.commit()
    slot = _row("T01", 4.0, [(48, 50, 52, 50)], slot=True, drill=4.15)
    press = _row("T02", 4.2, [(10, 10, None, None)], drill=4.15)
    press.override, press.outer_pad_mm = True, 6.05
    plain = _row("T03", 1.0, [(70, 70, None, None)], drill=1.15)
    monkeypatch.setattr(common, "load_rows", lambda ctx, lm: [slot, press, plain])
    cfg = json.loads(json.dumps(load_profile(None)))
    cfg["copper"]["terminal_pad"] = {"enabled": True, "min_hole_width_mm": 4.0, "grow_mm": 3.0}
    entries = [{"file": "top.gbr", "type": "top_copper"}]
    n = SimpleNamespace(entry=lambda rel: entries[0] if rel == "top.gbr" else None, layer=lambda rel: cu, cfg=cfg, ctx=SimpleNamespace(layer_map=dict))
    call = OpCall(n=1, stage="outer", op="TerminalPad", layer="top.gbr", kind="factory_terminal_pad", key="k")
    cs = terminal_pad(n, call)
    assert cs.params["pads_grown"] == 1 and cs.params["order_pads"] == 1
    sizes = sorted((round(max(f.symbol.size_mm), 2), round(min(f.symbol.size_mm), 2)) for f in cu.pads())
    assert sizes == [(2.0, 2.0), (6.05, 6.05), (17.0, 10.0)]  # 14×7 + 3.0 → 17×10; 5.5 → 6.05; the plain hole untouched


def test_mount_hole_rings_are_normalised_to_the_factory_size(monkeypatch):
    import math
    from types import SimpleNamespace

    from gerbonara import graphic_objects as go
    from gerbonara.rs274x import GerberFile
    from gerbonara.utils import MM

    from engine.geom.features import FeatureLayer
    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native import ops_copper
    from engine.native.ops_basic import silk_transform
    from engine.profiles import load_profile

    silk = FeatureLayer(GerberFile(), "silk.gbr", "top_silk")
    silk.begin("seed")
    ap = Symbol("r", (0.2,)).to_aperture(unit=MM)
    silk.add(go.Arc.from_circle(20, 20, 4.65, ap, unit=MM), "customer ring ⌀9.3")
    silk.add(go.Arc.from_circle(20, 20, 8.0, ap, unit=MM), "component outline ⌀16 stays")
    silk.add(go.Arc.from_circle(60, 60, 4.65, ap, unit=MM), "ring round a hole that is not a screw hole")
    silk.commit()
    holes = [Hole(20, 20, 4.2, False, "d", tool="T1", attribute="non_plated"), Hole(60, 60, 1.0, True, "d", tool="T2", attribute="plated")]
    monkeypatch.setattr(ops_copper, "_holes", lambda n: holes)
    cfg = json.loads(json.dumps(load_profile(None)))
    cfg["silk"]["mount_hole_ring"] = {"dia_mm": 10.0, "width_mm": 0.25, "min_hole_mm": 4.0, "max_hole_mm": 4.5}
    entries = [{"file": "silk.gbr", "type": "top_silk"}]
    n = SimpleNamespace(entry=lambda rel: entries[0], layer=lambda rel: silk, cfg=cfg)
    cs = silk_transform(n, OpCall(n=1, stage="silk", op="SilkTransform", layer="silk.gbr", kind="mandatory_silk", key="k"))
    assert cs.params["mount_hole_rings"] == 1
    ring = [f for f in silk.features if abs(f.geom.centroid.x - 20) < 0.5 and f.geom.bounds[2] - f.geom.bounds[0] < 12]
    assert len(ring) == 1 and abs((ring[0].geom.bounds[2] - ring[0].geom.bounds[0]) - 10.25) < 0.05
    assert abs(ring[0].geom.area - math.pi * 10 * 0.25) < 0.4
    other = [f for f in silk.features if abs(f.geom.centroid.x - 60) < 0.5]
    assert len(other) == 1 and abs((other[0].geom.bounds[2] - other[0].geom.bounds[0]) - 9.5) < 0.05



def test_slot_shorter_than_the_predrill_offset_still_gets_two_holes():
    """C09 的 ⌀1.752 槽只走 0.4，外移量 (1.752 − 0.95) / 2 = 0.401 比行程还长。原来往里移 + 夹到
    行程一半，两个孔直接重合在槽中心（终稿是 47.90 / 49.10，我们两个都在 48.50）。"""
    cfg = {"slot_end_predrill": [{"width_mm": 1.6, "bit_mm": 0.95}], "short_slot_max_travel_ratio": 1.0}
    slot = _row("T01", 1.6, [(48.3, 219.61, 48.7, 219.61)], slot=True, drill=1.752)
    tools, extra = _tape_tools([slot], cfg, (0.0, 0.0))
    ends = next(t for t in tools if t.diameter_mm == 0.95)
    assert extra == 2
    assert ends.holes == [pytest.approx((47.899, 219.61), abs=1e-3), pytest.approx((49.101, 219.61), abs=1e-3)]
