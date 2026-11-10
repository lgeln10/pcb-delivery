"""Panel plan: candidates, placements, preview, COM draft, and the stage on a sample board."""

from __future__ import annotations

from shapely.geometry import box

from engine.panel.plan import com_draft, panel_svg, plan_candidates, unit_placements

CFG = {"working_panels_mm": [[406.4, 508.0], [457.2, 609.6]], "rail_mm": 8.0, "gap_mm": 2.0, "rotations": [0, 90]}


def test_candidates_ranked_by_count_then_utilisation():
    board = box(20, -70, 100, -20)  # 80×50
    cands = plan_candidates(board, CFG)
    assert cands and cands[0].count == max(c.count for c in cands)
    best = cands[0]
    # 457.2×609.6, rot 90 (unit 50×80): floor((441.2+2)/52)=8, floor((593.6+2)/82)=7 -> 56 (beats rot 0: 5×11=55)
    assert (best.panel_w, best.panel_h, best.rotation, best.nx, best.ny, best.count) == (457.2, 609.6, 90, 8, 7, 56)
    assert 0 < best.utilization < 1
    assert best.used_w <= best.panel_w and best.used_h <= best.panel_h


def test_placements_inside_rails_and_disjoint():
    board = box(0, 0, 80, 50)
    c = plan_candidates(board, CFG)[0]
    units = unit_placements(c, board)
    assert len(units) == c.count
    inner = box(c.rail - 1e-6, c.rail - 1e-6, c.panel_w - c.rail + 1e-6, c.panel_h - c.rail + 1e-6)
    assert all(inner.contains(u) for u in units)
    for i in range(len(units)):
        for j in range(i + 1, len(units)):
            assert units[i].distance(units[j]) >= c.gap - 1e-6


def test_svg_and_com():
    board = box(20, -70, 100, -20)
    c = plan_candidates(board, CFG)[0]
    svg = panel_svg(c, board)
    assert svg.startswith("<svg") and svg.count("<path") == c.count and 'data-layer="_panel"' in svg
    com = com_draft("job-1", c, board)
    assert "COM sr_tab_add" in com and f"nx={c.nx},ny={c.ny}" in com and "PanelBuild" in com


def test_stage_on_sample(pipeline):
    rep = pipeline.run("kicad-x2ap", "panel")
    assert rep.status == "ok", rep.summary
    plan = next(i for i in rep.items if i.kind == "panel_plan")
    assert plan.fix and plan.fix.op == "PanelBuild" and plan.measured >= 20
    assert {a.filename for a in rep.artifacts} >= {"panel.json", "panel.svg"}
    work = pipeline.storage.work_dir(pipeline.job_id("kicad-x2ap"), create=False)
    assert (work / "cache" / "_panel.svg").is_file()


def test_stage_with_customer_spec(pipeline):
    rep = pipeline.run("kicad-x2ap", "panel", order_spec={"panelization": "2×3 拼板，工艺边 5mm 加 mark 点"})
    kinds = {i.kind for i in rep.items}
    assert "panel_customer_spec" in kinds and rep.status == "needs_review"
