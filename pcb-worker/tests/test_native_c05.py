"""B1 on the planted-defect board: run C05 under ``PCB_CAM_ENGINE=native``, then re-run the
checks on the edited layers — every defect whose op is native must be gone (reverse
construction: the fix restores the rule's post-condition), everything else must still be there."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine.geom.features import FeatureLayer
from engine.model.report import StageReport
from engine.storage import Storage
from engine.verify import _apply_confirmations, _load, _run

CASE = Path(__file__).resolve().parents[1] / "cases" / "C05_four_layer_dfm"
STAGES = ["align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output", "gatekeeper"]


@pytest.fixture(scope="module")
def c05(tmp_path_factory):
    import os

    base = tmp_path_factory.mktemp("c05native")
    os.environ["PCB_CAM_ENGINE"] = "native"
    try:
        storage = Storage(storage_root=base / "storage", work_root=base / "work")
        job = "c05-native"
        key = f"pcb-cam/verify/{job}/input/board.zip"
        storage.put_file(key, CASE / "input" / "board.zip")
        first: dict[str, StageReport] = {"intake": _run(storage, job, "intake", [key])}
        lm = _apply_confirmations(first["intake"].layer_map, _load(CASE / "expected" / "layer_map.json"))
        for st in STAGES:
            first[st] = _run(storage, job, st, [key], layer_map=lm)
        second = {st: _run(storage, job, st, [key], layer_map=lm, attempt=2) for st in ("inner", "outer", "mask", "silk")}
        yield storage, job, first, second
    finally:
        os.environ.pop("PCB_CAM_ENGINE", None)


def _kinds(rep: StageReport, layer: str | None = None) -> set[str]:
    return {i.kind for i in rep.items if layer is None or i.layer == layer}


def _applied(rep: StageReport) -> set[str]:
    return {i.fix.op for i in rep.items if i.fix and i.fix.applied and i.fix.op}


def test_native_ops_applied_on_first_pass(c05):
    storage, job, first, _ = c05
    assert all(r.status != "failed" for r in first.values()), {s: r.summary for s, r in first.items() if r.status == "failed"}
    assert {"NpthClearance", "BorderClearance", "LineCompensation"} <= _applied(first["inner"]) | _applied(first["outer"])
    assert "NegativePadReshape" in _applied(first["inner"])
    assert {"SetSmdAttribute"} <= _applied(first["outer"])
    assert {"MaskResize"} <= _applied(first["mask"])
    work = storage.work_dir(job)
    logs = sorted(p.name for p in (work / "edit_log").glob("*.json") if p.name != "applied.json")
    assert logs and any("NegativePadReshape" in n for n in logs)
    # every edited layer still re-reads with the same object count or more (nothing lost by accident)
    for rel in ("Flashpads-In1_Cu.gbr", "Flashpads-F_Cu.gbr"):
        edit = work / "steps" / "edit" / rel
        assert edit.is_file() and len(FeatureLayer.load(edit)) >= len(FeatureLayer.load(work / "src" / rel)) - 1


def test_planted_defects_fixed_by_native_ops_are_gone_on_rerun(c05):
    _, _, first, second = c05
    in1, in2, fcu = "Flashpads-In1_Cu.gbr", "Flashpads-In2_Cu.gbr", "Flashpads-F_Cu.gbr"
    # negative plane: isolation ring 0.20 → 0.254, missing clearance added, border trimmed (p120/p121)
    assert {"isolation_ring", "negative_no_clearance"} <= _kinds(first["inner"], in1)
    assert not {"isolation_ring", "negative_no_clearance", "copper_to_edge"} & _kinds(second["inner"], in1)
    # positive inner: border trim removes the copper_to_edge trace (p128)
    assert "copper_to_edge" in _kinds(first["inner"], in2) and "copper_to_edge" not in _kinds(second["inner"], in2)
    # outer: NPTH cutouts (p127)
    assert "npth_clearance" in _kinds(first["outer"], fcu) and "npth_clearance" not in _kinds(second["outer"], fcu)
    # the 3 mil trace is legitimately fixed by +1 mil compensation (3 → 4 mil = the minimum); not native yet
    # → still reported: annular ring, hole_to_copper, partition line
    assert "line_width" in _kinds(first["outer"], fcu) and "line_width" not in _kinds(second["outer"], fcu)
    # the two 0.2 mm traces 0.05 mm apart are NOT grown (that would short them) → spacing still reported
    assert {"annular_ring", "spacing"} <= _kinds(second["outer"], fcu)
    assert {"hole_to_copper"} <= _kinds(second["inner"], in2) and "partition_line_width" in _kinds(second["inner"], in1)


def test_mask_and_silk_fixes(c05):
    storage, job, first, second = c05
    fm, fs = "Flashpads-F_Mask.gbr", "Flashpads-F_Silkscreen.gbr"
    assert "mask_expansion" in _kinds(first["mask"], fm) and "mask_expansion" not in _kinds(second["mask"], fm)
    # ② MaskResize is routed by finding: the too-small opening and the NPTH opening are fixed one by one
    assert {"opening_smaller_than_pad", "npth_opening_small"} <= _kinds(first["mask"], fm)
    assert not {"opening_smaller_than_pad", "npth_opening_small"} & _kinds(second["mask"], fm)
    modes = {json.loads(p.read_text())["params"].get("mode") for p in (storage.work_dir(job) / "edit_log").glob("*MaskResize_Flashpads-F_Mask*")}
    assert modes == {"global", "per_pad", "per_npth"}
    # B2.3 MaskConstructPads runs in the *outer* stage (p135 转 PAD before the mask checks), so the
    # planted pad without opening already has one when the mask stage looks; KiCad's drawn
    # (non-pad) mask objects that sit on no single pad are left for a person
    assert "missing_opening" not in _kinds(first["mask"], fm) and "missing_opening" not in _kinds(second["mask"], fm)
    assert "MaskConstructPads@Flashpads-F_Cu.gbr" in set(json.loads((storage.work_dir(job) / "edit_log" / "applied.json").read_text()))
    assert "mask_not_pad_objects" in _kinds(second["mask"], fm)
    # B2.6 SilkClearByMask: silk on the openings is cut away on the edit copy
    assert "silk_on_opening" in _kinds(first["silk"], fs) and "silk_on_opening" not in _kinds(second["silk"], fs)
    # silk: the align stage already deleted the outside strokes natively (edit copy), so the silk
    # stage never sees them; the rest is untouched
    assert any(i.kind == "outside_profile" and i.layer == fs and i.fix.applied for i in first["align"].items)
    assert "silk_outside_profile" not in _kinds(first["silk"], fs) and "silk_outside_profile" not in _kinds(second["silk"], fs)


def test_b2_inner_constructive_ops(c05):
    storage, job, first, second = c05
    in2 = "Flashpads-In2_Cu.gbr"
    # B2.1 NfpRemoval on the planted isolated pad; B2.4/B2.5 are skeleton calls (no finding) → their
    # op@layer tokens are in the ledger and nothing failed or was skipped
    assert "isolated_pad" in _kinds(first["inner"], in2) and "isolated_pad" not in _kinds(second["inner"], in2)
    tokens = set(json.loads((storage.work_dir(job) / "edit_log" / "applied.json").read_text()))
    assert {f"NfpRemoval@{in2}", f"SliverFill@{in2}", f"Teardrops@{in2}", "SilkClearByMask@Flashpads-F_Silkscreen.gbr"} <= tokens
    assert not any(i.kind in ("native_failed", "native_skipped") for i in second["inner"].items + second["outer"].items + second["silk"].items)
    assert {f"CopperCutout@{in2}", "LineCompensation@Flashpads-F_Cu.gbr", "CopperCutout@Flashpads-F_Cu.gbr"} <= tokens


def test_second_pass_applies_nothing_new(c05):
    storage, job, _, second = c05
    work = storage.work_dir(job)
    applied = set(json.loads((work / "edit_log" / "applied.json").read_text()))
    for rep in second.values():
        assert not any(i.kind == "native_applied" for i in rep.items), rep.stage
    assert applied  # keys persisted from the first pass
