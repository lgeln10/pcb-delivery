"""①: the book's mandatory-op skeleton is in every plan, findings attach to it, applied keys stick."""

import json
import re
from pathlib import Path

from engine.adapters import CamOp
from engine.model.plan import build_plan
from engine.model.report import Fix, ReportItem, StageReport
from engine.model.skeleton import RULES, skeleton_calls
from engine.output.genesis_script import build_script, check_script

ROOT = Path(__file__).resolve().parents[1]
LM = {"files": [
    {"file": "in1.gbr", "type": "inner_copper", "polarity": "negative"},
    {"file": "in2.gbr", "type": "inner_copper"},
    {"file": "gtl.gbr", "type": "top_copper"}, {"file": "gbl.gbr", "type": "bottom_copper"},
    {"file": "gts.gbr", "type": "top_mask"}, {"file": "gbs.gbr", "type": "bottom_mask"},
    {"file": "gto.gbr", "type": "top_silk"}, {"file": "gko.gbr", "type": "outline"}, {"file": "pth.drl", "type": "drill_pth"},
]}  # fmt: skip
ALL = {s: StageReport(stage=s, status="ok") for s in ("intake", "align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output")}


def _ops(plan, stage=None, layer=None):
    return [c.op for c in plan.calls if (stage is None or c.stage == stage) and (layer is None or c.layer == layer)]


def test_clean_board_still_gets_the_full_flow():
    plan = build_plan("j", ALL, LM)
    assert plan.ok, plan.problems
    # 第6章 内层正片 p123–129
    assert _ops(plan, "inner", "in2.gbr") == ["NfpRemoval", "Contourize", "LineCompensation", "CopperCutout", "SignalLayerOptimize", "Teardrops", "SliverFill", "BorderClearance", "SignalLayerChecks"]
    # 负片只削外围 + 检查（NfpRemoval 不能上负片 p134）
    assert _ops(plan, "inner", "in1.gbr") == ["BorderClearance", "SignalLayerChecks"]
    # 第7章 外层 p135–139
    # TerminalPad is always on the outer plan: the order's outer_pad_mm holes are an order term (no-op without them)
    assert _ops(plan, "outer", "gtl.gbr") == ["MaskConstructPads", "SetSmdAttribute", "Contourize", "LineCompensation", "TerminalPad", "CopperCutout", "SignalLayerOptimize", "SliverFill", "SignalLayerChecks"]
    assert _ops(plan, "mask", "gts.gbr") == ["MaskOptimize", "MaskChecks"] and _ops(plan, "silk", "gto.gbr") == ["SilkChecks", "SilkClearByMask"]
    assert _ops(plan, "drill") == ["SetDrillAttrs", "ResizeDrills", "DrillChecks"]
    # A0: Genesis's job does not inherit the local engine's work → import + matrix + net/edit steps
    assert _ops(plan, "intake") == ["ImportFiles"] + ["SetLayerTypes"] * 9 and _ops(plan, "align") == ["CopyStep"]
    assert _ops(plan, "net_compare") == ["NetlistExtract", "NetlistCompare", "NetlistCompare"]
    assert _ops(plan, "panel") == ["StepRepeat", "PatternFill", "PatternFill", "PatternFill", "PatternFill", "AddTooling", "RoutDesign"]
    out = _ops(plan, "output")
    assert out.count("ExportExcellon") == 1 and out.count("ExportGerber") == 7 and out[0] == "ExportExcellon"  # p156–158 顺序
    # SLO carries its two passes; every skeleton call has a page and a draft
    assert all(len(c.params["passes"]) == 2 for c in plan.by_op(CamOp.SIGNAL_LAYER_OPTIMIZE))
    assert all(c.pages and c.script for c in plan.calls)
    text = build_script("j", plan)
    assert check_script(text) == []
    # the reference mask / outline layers are filled in, not left as placeholders
    assert "reference_sm=gts.gbr" in text and "name=gko.gbr" in text and "sm_layer=gts.gbr" in text


def test_findings_attach_to_the_skeleton_instead_of_duplicating():
    fix = Fix(type="ring", op="SignalLayerOptimize", params={"spacing_mm": 0.12}, genesis_script="COM chklist_run,chklist=slo  【待验证】")
    rep = StageReport(stage="inner", status="ok", items=[ReportItem(id="r1", kind="ring", severity="warn", layer="in2.gbr", message="ring", fix=fix)])
    plan = build_plan("j", {"inner": rep}, LM)
    slo = [c for c in plan.calls if c.op == "SignalLayerOptimize" and c.layer == "in2.gbr"]
    assert len(slo) == 1 and slo[0].item_ids == ["r1"] and slo[0].params["spacing_mm"] == 0.12
    assert not any(n.startswith("补入必做的 SignalLayerOptimize in2.gbr") for n in plan.notes)


def test_applied_keys_mark_skeleton_and_finding_calls():
    plan = build_plan("j", {"inner": ALL["inner"]}, LM)
    k = next(c.key for c in plan.calls if c.op == "Teardrops")
    plan2 = build_plan("j", {"inner": ALL["inner"]}, LM, applied_keys={k})
    td = next(c for c in plan2.calls if c.op == "Teardrops")
    assert td.applied and td.key == k
    block = build_script("j", plan2).split(f"# ---- [{td.n}] Teardrops", 1)[1]
    assert "# (lite 引擎已自动执行" in block[:300]


def test_without_layer_map_only_stage_level_rules_apply():
    plan = build_plan("j", ALL, None)
    assert {c.op for c in plan.calls} == {"ImportFiles", "CopyStep", "NetlistExtract", "NetlistCompare", "StepRepeat", "AddTooling", "RoutDesign"}


def test_every_skeleton_command_is_in_the_mapping_doc():
    doc = (ROOT / "docs" / "genesis_op_mapping.md").read_text(encoding="utf-8")
    names = set(re.findall(r"^COM ([a-z_0-9]+)", doc, re.MULTILINE)) | set(re.findall(r"COM ([a-z_0-9]+)", doc))
    for d in skeleton_calls([r.stage for r in RULES], LM, None):
        for ln in d["script"].splitlines():
            if ln.startswith("COM "):
                assert ln.split(",", 1)[0][4:].split()[0] in names, f"{d['op']}: {ln}"
    assert {r.op for r in RULES} >= {CamOp.CONTOURIZE, CamOp.SLIVER_FILL, CamOp.TEARDROPS, CamOp.PATTERN_FILL, CamOp.ADD_TOOLING, CamOp.DRILL_CHECKS, CamOp.SILK_CHECKS, CamOp.NETLIST_EXTRACT}


def test_panel_and_rout_drafts_fill_from_job_data():
    """M6e: the panel / tooling / rout drafts carry real numbers once the job has them — no
    ``<>`` left for the factory to fill, and no line refused for the empty ``<>`` params."""
    cand = {"panel_w": 457.2, "panel_h": 609.6, "rotation": 90, "unit_w": 50.0, "unit_h": 80.0, "nx": 8, "ny": 7, "rail": 8.0, "gap": 2.0,
            "count": 56, "utilization": 0.8037, "used_w": 430.0, "used_h": 588.0}  # fmt: skip
    data = {"panel": {"candidate": cand, "tooling": [{"file": "pth.drl", "dia_mm": 3.175, "points": [[4.0, 4.0], [453.2, 4.0]]}]}, "rout": {"first": 3, "edges": 8}}
    stages = {s: ALL[s] for s in ("intake", "align", "panel", "output")}
    plan = build_plan("j", stages, LM, data=data)
    sr = next(c for c in plan.calls if c.op == "StepRepeat").script
    assert "sr_tab_add,line=1,step=edit,x=0.8504,y=0.7402,nx=8,ny=7,dx=2.0472,dy=3.2283,angle=90" in sr  # (457.2-430)/2+8 = 21.6 mm
    assert "profile_rect,x1=0,y1=0,x2=18,y2=24" in sr
    tool = next(c for c in plan.calls if c.op == "AddTooling").script
    assert tool.count("COM add_pad,") == 2 and "x=0.1575,y=0.1575,symbol=r125" in tool and "name=pth.drl" in tool
    assert tool.index("cur_atr_set") < tool.index("add_pad") < tool.index("cur_atr_reset")
    fill = next(c for c in plan.calls if c.op == "PatternFill").script
    assert "<>" not in fill and "step_max_dist_x=18,step_max_dist_y=24" in fill and "feat_margin=0.1181" in fill
    rout = next(c for c in plan.calls if c.op == "RoutDesign").script
    assert "size=78.7,comp=right" in rout and "max_gap=2,max_join=2,smooth_tol=1" in rout
    # 起刀点只作提示,不填值:我们算的是折线段号,不是 Genesis 的 feature 号 —— 注释也不能插在
    # COM 行中间(会把后面的参数吞进注释)
    assert "first=<first>" in rout and "外形第 3/8 段" in rout.splitlines()[0]
    assert all(not (ln.startswith("COM") and "#" in ln.split("【")[0]) for ln in rout.splitlines())
    text = build_script("j", plan, fills={"in_dir": "/d/j.in", "out_dir": "/d/j.out"})
    assert check_script(text) == [] and "REFUSED" not in text
    # 未填的只剩起刀点这一条,别的都算出来了
    unfilled = [ln for ln in text.splitlines() if ln.startswith("# UNFILLED")]
    assert len(unfilled) == 1 and "chain_add" in unfilled[0], unfilled
    assert "dir_path=/d/j.out" in text
    # without the panel facts the table stays a placeholder (kept out of execution), never a guess
    bare = build_plan("j", stages, LM)
    assert "nx=<nx>" in next(c for c in bare.calls if c.op == "StepRepeat").script
    assert "minimum=10)(maximum=250" in next(c for c in build_plan("j", {"outer": ALL["outer"]}, LM).calls if c.op == "MaskConstructPads").script


def test_a0_bootstrap_uses_the_drill_table_and_ships_the_layers(tmp_path, monkeypatch):
    from engine.adapters.genesis import GenesisAdapter

    table = {"tools": [
        {"tool": "T1", "file": "pth.drl", "dia_mm": 0.3, "attribute": "via", "oversize_mm": 0.0, "drill_dia_mm": 0.3, "slot": False},
        {"tool": "T2", "file": "pth.drl", "dia_mm": 1.0, "attribute": "plated", "oversize_mm": 0.15, "drill_dia_mm": 1.15, "slot": False},
    ]}
    plan = build_plan("j", {"intake": ALL["intake"], "align": ALL["align"], "drill": ALL["drill"]}, LM, data={"drill_table": table})
    attrs = next(c for c in plan.calls if c.op == "SetDrillAttrs")
    resize = next(c for c in plan.calls if c.op == "ResizeDrills")
    assert "option=via" in attrs.script and "symbol=r11.8" in attrs.script and "non_plated" not in attrs.script
    assert "finish_size=39.4,drill_size=45.3" in resize.script and "num=2" in resize.script
    # <in_dir> is a job-level fill: without it the import line is kept out of execution
    text = build_script("j", plan)
    assert "# UNFILLED placeholder: COM input_create,path=<in_dir>" in text
    filled = build_script("j", plan, fills={"in_dir": "/share/drop/j.in"})
    assert "COM input_create,path=/share/drop/j.in,job=j,step=orig" in filled and check_script(filled) == []
    # net step is clipped to the profile (p111), matrix types follow the layer map
    copy = next(c for c in plan.calls if c.op == "CopyStep")
    assert "dest_name=net" in copy.script and "clip_area_end" in copy.script and "inout=outside" in copy.script
    neg = next(c for c in plan.calls if c.op == "SetLayerTypes" and c.layer == "in1.gbr")
    assert "polarity=negative" in neg.script and "type=signal" in neg.script
    # delivery ships the layer files under <job>.in/ and the host path is what the script imports from
    drop = tmp_path / "drop"
    monkeypatch.setenv("PCB_GENESIS_HOST_DROP_DIR", "/mnt/genesis/drop")
    g = GenesisAdapter(drop_dir=drop)
    assert g.host_in_dir("j") == "/mnt/genesis/drop/j.in"
    src = tmp_path / "gtl.gbr"
    src.write_text("G04 x*\nM02*\n")
    r = g.deliver("j", filled, files=[("gtl.gbr", src), ("../evil", src)])
    assert (drop / "j.in" / "gtl.gbr").read_text().startswith("G04") and not (tmp_path / "evil").exists()
    import json

    env = json.loads((drop / "j.json").read_text())
    assert env["files"] == ["gtl.gbr"] and env["in_dir"] == "j.in" and r["delivered"]


# ---- 二次审计 4: 词汇表补 AddHolesFromDrawing / AddText（只出草稿 + EQ） ------------------------
def test_new_ops_are_produced_by_their_findings(tmp_path):
    from engine.storage import Storage
    from tests.conftest import Pipeline

    pipe = Pipeline(Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w"))
    spec = {"drill_table": [{"tool": "T9", "size_mm": 2.2, "count": 2}], "customer_notes": ["丝印加 UL 标记和周期，位置见图"]}
    drill = pipe.run("kicad-x2ap", "drill", order_spec=spec)
    miss = [i for i in drill.items if i.kind == "drill_table_mismatch" and i.fix and i.fix.op == "AddHolesFromDrawing"]
    assert miss and miss[0].eq_question and "sel_copy_other" in miss[0].fix.genesis_script and miss[0].fix.params["dia_mm"] == 2.2
    silk = pipe.run("kicad-x2ap", "silk", order_spec=spec)
    at = next(i for i in silk.items if i.kind == "silk_add_text_required")
    assert at.fix.op == "AddText" and at.eq_question and "add_text" in at.fix.genesis_script and at.fix.params["requests"]
    # both are judgement ops: the script pauses after them, and they sit in the book's order
    reports = {"drill": drill, "silk": silk}
    plan = build_plan("j", reports, json.loads((pipe.storage.work_dir(pipe.job_id("kicad-x2ap")) / "layer_map.json").read_text()))
    ops = [c.op for c in plan.calls]
    assert ops.index("AddHolesFromDrawing") < ops.index("SetDrillAttrs") and ops.index("SilkClearByMask") < ops.index("AddText")
    assert all(c.needs_human for c in plan.calls if c.op in ("AddHolesFromDrawing", "AddText"))
    assert check_script(build_script("j", plan)) == []
