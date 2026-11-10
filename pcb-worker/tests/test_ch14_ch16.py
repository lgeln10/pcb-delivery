"""第14章 半孔/金属包边 and 第16章 HDI checks (M6 补项)."""

from __future__ import annotations

import zipfile
from pathlib import Path

from engine.storage import Storage
from engine.verify import _apply_confirmations, _load, _run
from tests.conftest import FIXTURES

C08 = Path(__file__).resolve().parents[1] / "cases" / "C08_blind_buried"


def _board_with_half_holes(tmp_path: Path) -> Path:
    """KiCad demo board + two plated holes on the left board edge (x = 20 mm): one ⌀0.7 and one
    ⌀0.4 (below the 0.5 minimum), 0.6 mm apart edge to edge."""
    src = FIXTURES / "kicad-x2ap"
    out = tmp_path / "half.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(src.iterdir()):
            if not p.is_file():
                continue
            data = p.read_bytes()
            if p.name == "Flashpads-PTH.drl":
                text = data.decode()
                # tool list: add a 0.4 tool; body: add holes under T1 (0.7) and the new tool
                text = text.replace("%\n", "T9C0.400\n%\n", 1) if "T9C" not in text else text
                text = text.replace("T1\n", "T1\nX20.0Y-40.0\n", 1)
                text = text.replace("M30", "T9\nX20.0Y-41.5\nM30")
                data = text.encode()
            zf.write(p, f"kicad/{p.name}")
            if p.name == "Flashpads-PTH.drl":
                zf.writestr(f"kicad/{p.name}", data)
    return out


def _run_all(storage: Storage, job: str, zip_path: Path, stages: list[str], expected_lm: Path | None = None, **kw):
    key = f"pcb-cam/verify/{job}/input/board.zip"
    storage.put_file(key, zip_path)
    reps = {"intake": _run(storage, job, "intake", [key])}
    lm = _apply_confirmations(reps["intake"].layer_map, _load(expected_lm) if expected_lm else None)
    for st in stages:
        reps[st] = _run(storage, job, st, [key], layer_map=lm, **kw)
    return reps


def test_half_holes_detected_with_min_dia_and_gap(tmp_path):
    storage = Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w")
    reps = _run_all(storage, "half", _board_with_half_holes(tmp_path), ["align", "drill", "inner", "outer"])
    outer = reps["outer"]
    kinds = {i.kind: i for i in outer.items}
    assert "half_hole" in kinds and kinds["half_hole"].measured == 2 and kinds["half_hole"].eq_question
    assert kinds["half_hole"].fix and kinds["half_hole"].fix.op == "RoutDesign"
    assert "half_hole_min_dia" in kinds and kinds["half_hole_min_dia"].severity == "error"  # the ⌀0.4 one
    gap = kinds.get("half_hole_gap")
    assert gap is None or gap.severity == "error"  # 0.6 mm edge gap ≥ 0.4 → no gap finding on this board
    assert "edge_plating_suspect" not in kinds  # round holes, not slots


def test_edge_plating_checks_only_when_ordered(tmp_path):
    storage = Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w")
    reps = _run_all(storage, "edge", _board_with_half_holes(tmp_path), ["align", "drill", "inner", "outer"], order_spec={"edge_plating": True})
    kinds = {i.kind for i in reps["outer"].items}
    # ordered edge plating but no plated slots on the edge → nothing to check, no false EQ
    assert not kinds & {"edge_plating_ring", "edge_plating_to_pad", "edge_plating_mask"}
    assert "half_hole" in kinds


def test_hdi_classification_on_blind_buried_board(tmp_path):
    storage = Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w")
    reps = _run_all(storage, "c08", C08 / "input" / "board.zip", ["align", "drill"], C08 / "expected" / "layer_map.json")
    drill = reps["drill"]
    assert drill.status != "failed"
    kinds = {i.kind for i in drill.items}
    assert "hdi_error" not in kinds
    assert {"hdi_expose_method", "hdi_mechanical_ok"} <= kinds  # ⌀0.2 blind vias: LDI, mechanical possible
    expose = [i for i in drill.items if i.kind == "hdi_expose_method"]
    assert len(expose) == 2 and all("LDI" in i.message for i in expose)  # two blind files, both ≤0.4
    laser = [i for i in drill.items if i.kind == "hdi_laser_required"]
    assert all("p203" in i.message for i in laser)
    # teardrop advice only where a pad's ring is under 5 mil — C08 pads are 0.65 on 0.2 vias → no advice
    assert "hdi_teardrop_advised" not in kinds
    # a through-hole-only board has no HDI items at all
    storage2 = Storage(storage_root=tmp_path / "s2", work_root=tmp_path / "w2")
    reps2 = _run_all(storage2, "plain", _board_with_half_holes(tmp_path), ["align", "drill"])
    assert not {i.kind for i in reps2["drill"].items} & {"hdi_expose_method", "hdi_laser_required", "hdi_mechanical_ok"}
