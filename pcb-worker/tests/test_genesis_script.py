"""Genesis script assembly (docs/genesis_op_mapping.md 附 C)."""

from __future__ import annotations

from engine.model.report import Fix, ReportItem, StageReport
from engine.output.genesis_script import build_script, collect_blocks


def _rep(stage, *items):
    return StageReport(stage=stage, status="ok", items=list(items))


def _item(kind, layer, op, script, applied=False, iid=None):
    return ReportItem(
        id=iid or f"{kind}_{layer}", kind=kind, severity="warn", layer=layer, message=kind,
        fix=Fix(type=kind, op=op, auto_fixable=applied, applied=applied, genesis_script=script),
    )  # fmt: skip


def test_blocks_follow_stage_order_and_dedupe():
    reports = {
        "mask": _rep("mask", _item("mask_sliver", "gts", "MaskOptimize", "COM a")),
        "align": _rep("align", _item("profile_line_width", "gko", "SetProfile", "COM sel_change_sym,symbol=r5.906")),
        "outer": _rep(
            "outer",
            _item("line_width", "gtl", "LineCompensation", "COM sel_resize,size=1", iid="a"),
            _item("line_width", "gtl", "LineCompensation", "COM sel_resize,size=1", iid="b"),  # duplicate draft
            _item("smd_pads", "gtl", "SetSmdAttribute", "COM x"),
        ),
    }
    blocks = collect_blocks(reports)
    # p137 SMD 属性先于 p138 补偿；CopyStep 是 A0 骨架补的（align 阶段必做，不需要 layer map）
    assert [b.op for b in blocks] == ["SetProfile", "CopyStep", "SetSmdAttribute", "LineCompensation", "MaskOptimize"]
    assert blocks[0].pages == (111,)


def test_script_shape_guards_and_pauses():
    reports = {
        "silk": _rep("silk", _item("silk_outside_profile", "gto", "DeleteOutsideProfile", "COM sel_delete", applied=True)),
        "mask": _rep(
            "mask",
            _item("mask_sliver", "gts", "MaskOptimize", "COM chklist_run,chklist=smo"),
            _item("mask_coverage", "gts", "MaskOptimize", "COM chklist_run,chklist=smo,nact=2"),
        ),
        "outer": _rep("outer", _item("annular_ring", "gtl", "SignalLayerOptimize", "COM chklist_run,chklist=slo")),
    }
    text = build_script("job-1", reports)
    assert text.startswith("#!/bin/csh -f")
    assert "COM open_job,job=job-1" in text and text.rstrip().endswith('echo "DONE job-1" >> job-1.log')
    # applied lite fix -> comment only, no checkpoint for it
    assert "# COM sel_delete" in text and text.count('echo "OK DeleteOutsideProfile') == 0
    # human-judgement op pauses
    assert 'PAUSE "[' in text and "SignalLayerOptimize gtl" in text
    # MaskOptimize once only (p142): the second call folds into the first, noted in the header
    assert text.count("COM chklist_run,chklist=smo\n") == 1 and "nact=2" not in text
    assert "# note: MaskOptimize gts" in text
    # every real block has a checkpoint + save
    assert text.count("if ($STATUS != 0) then") == 2
    assert text.count("COM save_job,job=job-1") == 3  # 2 blocks + tail


def test_pipeline_emits_script_artifact(pipeline):
    rep = pipeline.run("kicad-x2ap", "outer")
    names = [a.filename for a in rep.artifacts]
    assert any(n.startswith("genesis_") and n.endswith(".csh") for n in names), names
    art = next(a for a in rep.artifacts if a.kind == "genesis_script")
    text = pipeline.storage.object_path(art.path).read_text(encoding="utf-8")
    assert "SetSmdAttribute" in text and "LineCompensation" in text
    assert "COM open_job" in text
