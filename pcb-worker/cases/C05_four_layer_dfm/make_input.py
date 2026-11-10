"""Generate ``input/board.zip`` for C05 from the C01 KiCad fixture (re-runnable).

    uv run python cases/C05_four_layer_dfm/make_input.py

The two-layer board becomes a **four-layer** board: ``Flashpads-In1_Cu.gbr`` (negative plane,
``%TF.FilePolarity,Negative``) and ``Flashpads-In2_Cu.gbr`` (positive signal) are synthesised
with gerbonara; F_Cu / B_Cu / F_Mask / F_Silkscreen / PTH.drl get planted defects. Every
defect sits in a copper-free, mask-free, silk-free 5×5 mm spot found at generation time so the
planted hit is the *only* hit of its kind there.

Planted (see expected/findings.md):

 outer  D1 F_Cu 3 mil (0.076 mm) trace                         -> line_width
        D2 F_Cu two 0.2 mm traces 0.05 mm apart                -> spacing
        D3 via ⌀0.3 (new PTH tool T7) with ⌀0.4 pads F/B       -> annular_ring (0.05 < 0.1)
 inner  D4 In1 (negative): clearance ring 0.20 on hole X       -> isolation_ring
           no clearance on hole Y                              -> negative_no_clearance
           partition line 0.15 mm                              -> partition_line_width
           no border trim                                      -> copper_to_edge (negative)
        D5 In2 (positive): ⌀1.0 pad, no hole, no trace         -> isolated_pad
           0.2 mm trace 0.1 mm from hole H                     -> hole_to_copper
           0.2 mm trace 0.1 mm from the profile                -> copper_to_edge
 mask   D6 F_Mask: pad E 1.0×1.0 with 0.6×0.6 opening          -> opening_smaller_than_pad
           pad F 1.0×1.0 without opening                       -> missing_opening
           pads G1/G2 with openings 0.05 mm apart              -> mask_sliver (green: 3 mil)
 silk   D7 F_Silkscreen: 0.15 mm stroke across pad E's opening -> silk_on_opening
           0.10 mm stroke                                      -> silk_line_width
           3 strokes at x = 105 (profile ends at 100)          -> silk_outside_profile (auto-deleted)
"""

from __future__ import annotations

import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = ROOT / "tests" / "fixtures" / "kicad-x2ap"
OUT = HERE / "input" / "board.zip"
sys.path.insert(0, str(ROOT))

from gerbonara import graphic_objects as go  # noqa: E402
from gerbonara.apertures import CircleAperture, RectangleAperture  # noqa: E402
from gerbonara.rs274x import GerberFile  # noqa: E402
from gerbonara.utils import MM  # noqa: E402
from shapely.geometry import box  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

from engine.geom.from_gerbonara import camfile_to_geometry  # noqa: E402
from engine.geom.profile import extract_profile  # noqa: E402

HOLE_X = (73.114, -67.536, 0.7)  # PTH, gets a 0.20 clearance ring on In1 (needs 0.254)
HOLE_Y = (76.314, -67.536, 0.7)  # PTH, gets NO clearance on In1
HOLE_H = (75.514, -65.786, 0.7)  # PTH, In2 trace passes 0.1 mm from its edge
VIA = (0.3, 0.4)  # hole, pad


def circ(d: float) -> CircleAperture:
    return CircleAperture(diameter=d, unit=MM)


def rect(w: float, h: float) -> RectangleAperture:
    return RectangleAperture(w=w, h=h, unit=MM)


def flash(x: float, y: float, ap) -> go.Flash:
    return go.Flash(x, y, aperture=ap, unit=MM)


def line(x1: float, y1: float, x2: float, y2: float, w: float) -> go.Line:
    return go.Line(x1, y1, x2, y2, aperture=circ(w), unit=MM)


def save_bytes(gf: GerberFile) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "x.gbr"
        gf.save(p)
        text = p.read_text("utf-8")
    import re

    return re.sub(r"^(G7[45])$", r"\1*", text, flags=re.M).encode("utf-8")


def free_spots(profile, busy, n: int, size: float = 5.0, step: float = 1.0) -> list[tuple[float, float]]:
    """Centres of ``n`` disjoint size×size boxes (defects stay within ±2 mm of a centre) inside the profile touching nothing in ``busy``."""
    x0, y0, x1, y1 = profile.bounds
    taken = []
    out: list[tuple[float, float]] = []
    y = y0 + size
    while y < y1 - size and len(out) < n:
        x = x0 + size
        while x < x1 - size and len(out) < n:
            b = box(x - size / 2, y - size / 2, x + size / 2, y + size / 2)
            if profile.contains(b) and not busy.intersects(b) and not any(b.intersects(t) for t in taken):
                out.append((round(x, 3), round(y, 3)))
                taken.append(b.buffer(1.0))
            x += step
        y += step
    assert len(out) == n, f"only {len(out)} free spots"
    return out


def holes_of(path: Path) -> list[tuple[float, float, float]]:
    """Plain-text Excellon parse (KiCad decimal format) incl. routed slots (``G00``/``G01``),
    which gerbonara does not expose as flashes; returns (x, y, dia[, x2, y2])."""
    import re

    tools: dict[str, float] = {}
    cur = None
    out: list[tuple[float, float, float]] = []
    for ln in path.read_text("utf-8").splitlines():
        m = re.fullmatch(r"T(\d+)C([\d.]+)", ln)
        if m:
            tools[m.group(1)] = float(m.group(2))
            continue
        m = re.fullmatch(r"T(\d+)", ln)
        if m:
            cur = m.group(1) if m.group(1) != "0" else None
            continue
        m = re.fullmatch(r"X(-?[\d.]+)Y(-?[\d.]+)", ln)
        if m and cur:
            out.append((float(m.group(1)), float(m.group(2)), tools[cur]))
            continue
        m = re.fullmatch(r"G00X(-?[\d.]+)Y(-?[\d.]+)", ln)  # routed slot: G00 start, G01 end
        if m and cur:
            start = (float(m.group(1)), float(m.group(2)))
            continue
        m = re.fullmatch(r"G01X(-?[\d.]+)Y(-?[\d.]+)", ln)
        if m and cur:
            out.append((start[0], start[1], tools[cur], float(m.group(1)), float(m.group(2))))  # type: ignore[has-type]
    return out


def clearance(h, ring: float):
    """Dark clearance for a hole (circle) or a slot (obround = stroked line)."""
    x, y, d = h[:3]
    if len(h) == 5:
        return line(x, y, h[3], h[4], d + 2 * ring)
    return flash(x, y, circ(d + 2 * ring))


def main() -> None:
    files = {p.name: p.read_bytes() for p in sorted(SRC.iterdir()) if p.is_file()}
    profile = extract_profile(GerberFile.open(SRC / "Flashpads-Edge_Cuts.gbr")).profile
    busy = unary_union([camfile_to_geometry(GerberFile.open(SRC / n))[0] for n in (
        "Flashpads-F_Cu.gbr", "Flashpads-B_Cu.gbr", "Flashpads-F_Mask.gbr", "Flashpads-B_Mask.gbr",
        "Flashpads-F_Silkscreen.gbr", "Flashpads-B_Silkscreen.gbr",
    )])  # fmt: skip
    spots = free_spots(profile, busy, 8)
    A, B, C, D, E, F, G, P = spots
    print("spots:", dict(zip("ABCDEFGP", spots)))
    px0, py0, px1, py1 = profile.bounds

    # ---- F_Cu: D1 D2 D3(pad) D6(pads E F G1 G2) ------------------------------------------
    fcu = GerberFile.open(SRC / "Flashpads-F_Cu.gbr")
    fcu.objects += [
        line(A[0] - 2, A[1], A[0] + 2, A[1], 0.076),  # D1
        line(B[0] - 2, B[1] + 0.125, B[0] + 2, B[1] + 0.125, 0.2),  # D2 (gap 0.05)
        line(B[0] - 2, B[1] - 0.125, B[0] + 2, B[1] - 0.125, 0.2),
        flash(C[0], C[1], circ(VIA[1])),  # D3 via pad
        flash(E[0], E[1], rect(1.0, 1.0)),  # D6 pad E (opening too small)
        flash(F[0], F[1], rect(1.0, 1.0)),  # D6 pad F (no opening)
        flash(G[0] - 0.35, G[1], rect(0.5, 1.0)),  # D6 G1/G2 (0.2 apart on copper)
        flash(G[0] + 0.35, G[1], rect(0.5, 1.0)),
    ]
    files["Flashpads-F_Cu.gbr"] = save_bytes(fcu)

    bcu = GerberFile.open(SRC / "Flashpads-B_Cu.gbr")
    bcu.objects += [flash(C[0], C[1], circ(VIA[1]))]  # D3 via pad on the bottom
    files["Flashpads-B_Cu.gbr"] = save_bytes(bcu)

    # ---- PTH drill: D3 via tool T7 ---------------------------------------------------------
    lines = files["Flashpads-PTH.drl"].decode("utf-8").splitlines()
    out: list[str] = []
    for ln in lines:
        if ln == "T0":
            out += ["T7", f"X{C[0]:.3f}Y{C[1]:.3f}"]
        out.append(ln)
        if ln == "T6C1.100":
            out.append(f"T7C{VIA[0]:.3f}")
    # the KiCad header says "Plated,1,2" (its 2-layer origin); on the 4-layer board the through
    # span is 1-4 — otherwise intake (rightly) reads 1-2 as a blind drill
    files["Flashpads-PTH.drl"] = ("\n".join(out) + "\n").replace("TF.FileFunction,Plated,1,2,PTH", "TF.FileFunction,Plated,1,4,PTH").encode("utf-8")
    files["Flashpads-NPTH.drl"] = files["Flashpads-NPTH.drl"].replace(b"TF.FileFunction,NonPlated,1,2,NPTH", b"TF.FileFunction,NonPlated,1,4,NPTH")

    pth = holes_of(SRC / "Flashpads-PTH.drl") + [(C[0], C[1], VIA[0])]
    npth = holes_of(SRC / "Flashpads-NPTH.drl")

    # ---- In1: negative plane (dark = clearance) D4 ------------------------------------------
    in1 = GerberFile.open(SRC / "Flashpads-F_Cu.gbr")
    in1.file_attrs[".FileFunction"] = ("Copper", "L2", "Inr")
    in1.file_attrs[".FilePolarity"] = ("Negative",)
    objs: list = []
    for h in pth:
        key = (round(h[0], 3), round(h[1], 3))
        if key == HOLE_Y[:2]:
            continue  # no clearance at all
        objs.append(clearance(h, 0.20 if key == HOLE_X[:2] else 0.30))
    for h in npth:
        objs.append(clearance(h, 0.35))
    objs.append(line(P[0] - 3, P[1], P[0] + 3, P[1], 0.15))  # partition line too thin (needs 0.254)
    in1.objects = objs
    files["Flashpads-In1_Cu.gbr"] = save_bytes(in1)

    # ---- In2: positive signal D5 -------------------------------------------------------------
    in2 = GerberFile.open(SRC / "Flashpads-F_Cu.gbr")
    in2.file_attrs[".FileFunction"] = ("Copper", "L3", "Inr")
    in2.file_attrs[".FilePolarity"] = ("Positive",)
    hx, hy, hd = HOLE_H
    ty = hy + hd / 2 + 0.1 + 0.1  # trace centre: 0.1 from the hole edge (0.2 wide)
    in2.objects = [
        flash(D[0], D[1], circ(1.0)),  # isolated pad
        line(hx - 1.0, ty, hx + 1.0, ty, 0.2),  # hole_to_copper 0.1
        line(px0 + 0.2, py0 + 10, px0 + 0.2, py0 + 20, 0.2),  # 0.1 from the left edge
        line(D[0] + 3, D[1] - 3, D[0] + 3, D[1] + 3, 0.25),  # an ordinary trace (compensation info)
    ]
    files["Flashpads-In2_Cu.gbr"] = save_bytes(in2)

    # ---- F_Mask D6 (dark = opening) ---------------------------------------------------------
    fm = GerberFile.open(SRC / "Flashpads-F_Mask.gbr")
    fm.objects += [
        flash(E[0], E[1], rect(0.6, 0.6)),  # smaller than pad E
        flash(C[0], C[1], circ(0.5)),  # via opening (normal)
        flash(G[0] - 0.35, G[1], rect(0.65, 1.1)),  # G1/G2 openings: 0.05 apart -> sliver
        flash(G[0] + 0.35, G[1], rect(0.65, 1.1)),
    ]
    files["Flashpads-F_Mask.gbr"] = save_bytes(fm)

    # ---- F_Silkscreen D7 -----------------------------------------------------------------------
    fs = GerberFile.open(SRC / "Flashpads-F_Silkscreen.gbr")
    fs.objects += [
        line(E[0] - 1.5, E[1], E[0] + 1.5, E[1], 0.15),  # across pad E's opening
        line(A[0] - 2, A[1] + 2, A[0] + 2, A[1] + 2, 0.10),  # too thin
        line(105, -40, 108, -40, 0.15),  # outside the profile (x > 100)
        line(105, -42, 108, -42, 0.15),
        line(105, -44, 108, -44, 0.15),
    ]
    files["Flashpads-F_Silkscreen.gbr"] = save_bytes(fs)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in sorted(files.items()):
            zf.writestr(name, data)
    (HERE / "expected" / "spots.json").write_text(
        __import__("json").dumps(dict(zip("ABCDEFGP", spots)), indent=1), "utf-8"
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({len(files)} files)")


if __name__ == "__main__":
    main()
