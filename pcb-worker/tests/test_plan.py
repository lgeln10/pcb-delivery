"""OpPlan (S0): ordering, guards, mandatory ops, idempotency keys, routing table."""

import pytest

from engine.adapters import CamOp
from engine.adapters.fake import FakeEngine
from engine.adapters.lite import LiteEngine
from engine.adapters.status import GENESIS_STATES, NATIVE_STATES, HybridEngine, load_status, route
from engine.model.plan import CANON_ORDER, SLO_PASSES, OpPlan, build_plan, validate
from engine.model.report import Fix, ReportItem, StageReport


def _rep(stage, *items):
    return StageReport(stage=stage, status="ok", items=list(items))


def _item(kind, layer, op, script="COM x", *, applied=False, params=None, eq=None, iid=None):
    return ReportItem(
        id=iid or f"{kind}_{layer}", kind=kind, severity="warn", layer=layer, message=kind, eq_question=eq,
        fix=Fix(type=kind, op=op, params=params or {}, auto_fixable=applied, applied=applied, genesis_script=script),
    )  # fmt: skip


LM = {"files": [
    {"file": "in1.gbr", "type": "inner_copper", "polarity": "negative"},
    {"file": "in2.gbr", "type": "inner_copper"},
    {"file": "gtl.gbr", "type": "top_copper"},
]}  # fmt: skip


def test_canon_order_follows_the_book():
    i = {op: k for k, op in enumerate(CANON_ORDER)}
    assert i[CamOp.CONTOURIZE] < i[CamOp.LINE_COMPENSATION] < i[CamOp.COPPER_CUTOUT] < i[CamOp.SIGNAL_LAYER_OPTIMIZE] < i[CamOp.TEARDROPS]  # p123–131
    assert i[CamOp.MASK_CONSTRUCT_PADS] < i[CamOp.MASK_RESIZE] < i[CamOp.MASK_OPTIMIZE] < i[CamOp.MASK_CHECKS] < i[CamOp.MASK_DAMS]  # p141–144
    assert i[CamOp.PANEL_BUILD] < i[CamOp.EXPORT_EXCELLON]  # p118


def test_stage_order_then_book_order_and_dedupe():
    reports = {
        "mask": _rep("mask", _item("mask_sliver", "gts", "MaskOptimize", "COM a")),
        "align": _rep("align", _item("profile_line_width", "gko", "SetProfile", "COM sel_change_sym,symbol=r5.906")),
        "outer": _rep(
            "outer",
            _item("line_width", "gtl.gbr", "LineCompensation", "COM sel_resize,size=1", iid="a"),
            _item("line_width", "gtl.gbr", "LineCompensation", "COM sel_resize,size=1", iid="b"),
            _item("smd_pads", "gtl.gbr", "SetSmdAttribute", "COM x"),
        ),
    }
    plan = build_plan("j", reports, LM, skeleton=False)
    assert plan.ok and [c.op for c in plan.calls] == ["SetProfile", "SetSmdAttribute", "LineCompensation", "MaskOptimize"]
    lc = plan.by_op(CamOp.LINE_COMPENSATION)[0]
    assert lc.item_ids == ["a", "b"] and lc.layer_type == "top_copper" and lc.polarity == "positive"
    assert [c.n for c in plan.calls] == [1, 2, 3, 4] and len({c.key for c in plan.calls}) == 4
    assert plan.by_op(CamOp.SET_SMD_ATTRIBUTE)[0].needs_human  # judgement op
    assert not lc.needs_human


def test_keys_are_stable_and_sensitive_to_params():
    a = build_plan("j", {"outer": _rep("outer", _item("k", "gtl.gbr", "LineCompensation", params={"size_mil": 1}))})
    b = build_plan("j", {"outer": _rep("outer", _item("k", "gtl.gbr", "LineCompensation", params={"size_mil": 1}))})
    c = build_plan("j", {"outer": _rep("outer", _item("k", "gtl.gbr", "LineCompensation", params={"size_mil": 2}))})
    assert a.calls[0].key == b.calls[0].key != c.calls[0].key


def test_guard_nfp_only_inner_positive():
    bad = build_plan("j", {"inner": _rep("inner", _item("nfp", "in1.gbr", "NfpRemoval"))}, LM)
    assert not bad.ok and "负片" in bad.problems[0]
    outer = build_plan("j", {"outer": _rep("outer", _item("nfp", "gtl.gbr", "NfpRemoval"))}, LM)
    assert not outer.ok and "只允许内层正片" in outer.problems[0]
    good = build_plan("j", {"inner": _rep("inner", _item("nfp", "in2.gbr", "NfpRemoval"))}, LM)
    assert good.ok


def test_guard_slo_two_passes_injected_and_checked():
    plan = build_plan("j", {"inner": _rep("inner", _item("ring", "in2.gbr", "SignalLayerOptimize"))}, LM)
    assert plan.ok and plan.by_op(CamOp.SIGNAL_LAYER_OPTIMIZE)[0].params["passes"] == [dict(p) for p in SLO_PASSES]
    slo = plan.by_op(CamOp.SIGNAL_LAYER_OPTIMIZE)[0]
    slo.params["passes"] = slo.params["passes"][:1]
    assert any("两遍" in p for p in validate(plan))


def test_guard_mask_optimize_once_per_layer_collapses():
    plan = build_plan("j", {"mask": _rep(
        "mask",
        _item("mask_sliver", "gts", "MaskOptimize", "COM a"),
        _item("mask_coverage", "gts", "MaskOptimize", "COM b", eq="桥做不到"),
        _item("mask_sliver", "gbs", "MaskOptimize", "COM a"),
    )})  # fmt: skip
    smo = plan.by_op(CamOp.MASK_OPTIMIZE)
    assert plan.ok and [c.layer for c in smo] == ["gbs", "gts"]
    gts = next(c for c in smo if c.layer == "gts")
    assert gts.item_ids == ["mask_sliver_gts", "mask_coverage_gts"] and gts.needs_human and plan.notes


def test_netlist_compare_twice_is_mandatory():
    plan = build_plan("j", {"net_compare": StageReport(stage="net_compare", status="ok")})
    modes = sorted(c.params["mode"] for c in plan.by_op(CamOp.NETLIST_COMPARE))
    assert plan.ok and modes == ["normal", "reduced_copper"] and sum("NetlistCompare" in n for n in plan.notes) == 2
    # a finding-driven compare of one mode still gets the other injected
    plan2 = build_plan("j", {"net_compare": _rep("net_compare", _item("net_short", None, "NetlistCompare", params={"mode": "normal"}))})
    assert sorted(c.params["mode"] for c in plan2.by_op(CamOp.NETLIST_COMPARE)) == ["normal", "reduced_copper"]
    plan2.calls = [c for c in plan2.calls if c.params.get("mode") == "normal"]
    assert any("两次" in p for p in validate(plan2))


def test_guard_excellon_after_panel():
    plan = OpPlan(job="j", stages=["panel", "output"])
    plan.calls = build_plan("j", {
        "panel": _rep("panel", _item("panel_plan", None, "PanelBuild", "COM p")),
        "output": _rep("output", _item("drill_out", "drl", "ExportExcellon", "COM e", applied=True)),
    }, skeleton=False).calls
    assert validate(plan) == []
    plan.calls[0], plan.calls[1] = plan.calls[1], plan.calls[0]
    plan.calls[0].n, plan.calls[1].n = 1, 2
    assert any("PanelBuild 之后" in p for p in validate(plan))


def test_status_table_complete_and_valid():
    st = load_status()
    assert set(st) == set(CamOp)
    assert all(s.genesis in GENESIS_STATES and s.native in NATIVE_STATES for s in st.values())
    assert st[CamOp.RESIZE_DRILLS].native == "in_stage" and st[CamOp.ADD_TEXT].native == "none"


def test_routing_and_hybrid_execute():
    plan = build_plan("j", {
        "silk": _rep("silk", _item("silk_outside_profile", "gto", "DeleteOutsideProfile", "COM sel_delete", applied=True)),
        "outer": _rep("outer", _item("line_width", "gtl.gbr", "LineCompensation", "COM sel_resize,size=1")),
    }, LM, skeleton=False)
    pending, applied = plan.calls[0], plan.calls[1]  # outer stage runs before silk
    assert applied.op == "DeleteOutsideProfile" and pending.op == "LineCompensation"
    assert route(applied, native=None, genesis_configured=False) == "already_applied"
    assert route(pending, native=None, genesis_configured=False) == "report_only"
    assert route(pending, native=None, genesis_configured=True) == "genesis"
    # native only when the table says verified: LineCompensation is (B1), AddText is not (a person's content)
    assert route(pending, native=FakeEngine(), genesis_configured=True) == "native"
    txt = build_plan("j", {"silk": _rep("silk", _item("silk_add_text_required", "gto", "AddText"))}, LM, skeleton=False).by_op(CamOp.ADD_TEXT)[0]
    assert route(txt, native=FakeEngine(), genesis_configured=True) == "genesis"

    res = HybridEngine(native=None, genesis=FakeEngine(), genesis_configured=True).execute(plan)
    assert [(r.mode, r.applied) for r in res] == [("delivered", False), ("already_applied", True)]
    res = HybridEngine().execute(plan)
    assert [r.mode for r in res] == ["report_only", "already_applied"]
    # default CamEngine.execute via LiteEngine keeps the same shape
    res = LiteEngine().execute(plan)
    assert [r.key for r in res] == [pending.key, applied.key] and res[0].mode == "report_only"


def test_invalid_plan_is_skipped_by_executors():
    plan = build_plan("j", {"outer": _rep("outer", _item("nfp", "gtl.gbr", "NfpRemoval"))}, LM)
    assert not plan.ok
    assert all(r.mode == "skipped" for r in HybridEngine().execute(plan))


@pytest.mark.parametrize("op", list(CamOp))
def test_every_op_orders(op):
    assert op in CANON_ORDER
