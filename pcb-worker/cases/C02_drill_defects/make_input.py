"""Generate ``input/board.zip`` for C02 from the C01 KiCad fixture (re-runnable).

    uv run python cases/C02_drill_defects/make_input.py

Only the two Excellon files and the outline are modified; every Gerber copper/mask/silk/paste
layer is copied verbatim. Planted defects (see expected/findings.md):

1. extra hole      PTH  T3 ⌀0.70 @ (30.000, -35.000): copper-free spot on both outer layers
2. overlapping     PTH  T5 ⌀1.00 @ (40.259, -26.289) duplicated at +0.05 mm in X
3. NPTH near edge  NPTH T1 ⌀0.65 @ (20.475, -45.000): 0.15 mm from the left profile edge
4. missing hole    PTH  T6 ⌀1.10 @ (22.18, -66.213) removed; its ComponentPad stays on F/B_Cu
5. slot on outline Edge_Cuts gets one open 3 mm line segment (a "slot" drawn on the outline)

The script checks (1) against the folded copper so the extra hole really is copper-free.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = ROOT / "tests" / "fixtures" / "kicad-x2ap"
OUT = HERE / "input" / "board.zip"

EXTRA_HOLE = (30.000, -35.000)  # PTH ⌀0.70, no copper here
DUP_SRC = "X40.259Y-26.289"  # T5 ⌀1.00
DUP_NEW = "X40.309Y-26.289"  # +0.05 mm
EDGE_HOLE = (20.475, -45.000)  # NPTH ⌀0.65 -> 0.15 mm from x=20 edge
REMOVED = "X22.18Y-66.213"  # T6 ⌀1.10, ComponentPad on both copper layers
SLOT_SEG = ("X60000000Y-45000000D02*", "X63000000Y-45000000D01*")  # 3 mm open line


def _check_copper_free(x: float, y: float, dia: float) -> None:
    sys.path.insert(0, str(ROOT))
    from shapely.geometry import Point

    from engine.geom.from_gerbonara import camfile_to_geometry
    from engine.geom.layers import open_camfile

    for name, t in (("Flashpads-F_Cu.gbr", "top_copper"), ("Flashpads-B_Cu.gbr", "bottom_copper")):
        geom, _ = camfile_to_geometry(open_camfile(SRC / name, t))
        d = geom.distance(Point(x, y))
        if d < dia:
            raise SystemExit(f"{name}: copper within {d:.3f} mm of extra hole {x},{y}; pick another spot")
        print(f"  {name}: nearest copper {d:.2f} mm from extra hole")


def patch_pth(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    removed = False
    for ln in lines:
        if ln == REMOVED and not removed:
            removed = True  # 4. missing hole
            continue
        out.append(ln)
        if ln == DUP_SRC:
            out.append(DUP_NEW)  # 2. overlapping hole
        if ln == "T3" and out.count("T3") == 1:
            out.append(f"X{EXTRA_HOLE[0]:.3f}Y{EXTRA_HOLE[1]:.3f}")  # 1. extra hole
    assert removed, f"{REMOVED} not found"
    assert DUP_NEW in out
    return "\n".join(out) + "\n"


def patch_npth(text: str) -> str:
    out: list[str] = []
    for ln in text.splitlines():
        out.append(ln)
        if ln == "T1":
            out.append(f"X{EDGE_HOLE[0]:.3f}Y{EDGE_HOLE[1]:.3f}")  # 3. NPTH near edge
    return "\n".join(out) + "\n"


def patch_outline(text: str) -> str:
    out: list[str] = []
    for ln in text.splitlines():
        if ln == "M02*":
            out.extend(SLOT_SEG)  # 5. open segment on the outline layer
        out.append(ln)
    return "\n".join(out) + "\n"


PATCHES = {
    "Flashpads-PTH.drl": patch_pth,
    "Flashpads-NPTH.drl": patch_npth,
    "Flashpads-Edge_Cuts.gbr": patch_outline,
}


def main() -> None:
    print("checking extra-hole spot against F/B copper ...")
    _check_copper_free(*EXTRA_HOLE, 0.70)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(SRC.iterdir()):
            if not p.is_file():
                continue
            data = p.read_bytes()
            if p.name in PATCHES:
                data = PATCHES[p.name](data.decode("utf-8")).encode("utf-8")
                print(f"  patched {p.name}")
            zf.writestr(p.name, data)
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
