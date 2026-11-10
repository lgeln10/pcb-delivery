"""厂规开关的三档（auto | ask | off）—— 洲旭 2026-09-16 回复 C09 确认单：内层删独立 PAD、删塞孔过孔开窗、
塞孔分组、过孔预大、相交小孔删除、公差孔这几类「要人工处理 / 应设为可选项」。

ask = 引擎照做（fix.applied），但 fix.confirm 让报告项仍进 EQ（needs_decision），stage 变 needs_review。
aios 侧 modules/pcb-cam/logic.ts itemNeedsDecision 是同一条规则的镜像。"""

from __future__ import annotations

from engine.model.report import Fix, ReportItem, derive_status
from engine.pipeline.registry import _ask_mode


def _item(**fix) -> ReportItem:
    return ReportItem(id="x", kind="drill_via_plug", severity="info", message="塞孔分组", eq_question="请确认", fix=Fix(type="split", **fix))


def test_applied_fix_without_confirm_is_settled_but_confirm_keeps_it_an_eq():
    assert not _item(applied=True).needs_decision  # 已自动：哪怕带 EQ 文案也没什么可决策
    assert _item(applied=True, confirm=True).needs_decision  # ask 档：做了，人还得点过
    assert _item(applied=False).needs_decision  # 没做的 EQ 照旧
    assert derive_status([_item(applied=True)]) == "ok"
    assert derive_status([_item(applied=True, confirm=True)]) == "needs_review"


def test_ask_mode_is_read_from_the_profile_per_op():
    prof = {"copper": {"inner": {"nfp_removal": "ask"}}, "mask": {"via_opening_delete": "auto"}}
    assert _ask_mode(prof, "NfpRemoval")
    assert not _ask_mode(prof, "MaskDams")
    assert not _ask_mode(prof, "LineCompensation")  # 不在开关表里的 op 永远不问
    assert not _ask_mode({}, "NfpRemoval")  # 没配 = auto


def test_confirm_survives_the_json_contract_and_defaults_false():
    it = ReportItem.model_validate({"id": "a", "kind": "k", "severity": "info", "message": "m",
                                    "fix": {"type": "t", "auto_fixable": True, "applied": True}})
    assert it.fix is not None and it.fix.confirm is False and not it.needs_decision
    it2 = ReportItem.model_validate_json(_item(applied=True, confirm=True).model_dump_json())
    assert it2.fix is not None and it2.fix.confirm and it2.needs_decision
