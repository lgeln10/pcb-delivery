"""Generate ``input/board.zip`` for C06 from C05 (re-runnable; runs C05's generator if needed).

    uv run python cases/C06_net_guard/make_input.py

C05's four-layer board + three netlist defects. Net names are Gerber X2 ``%TO.N`` object
attributes, injected as text (gerbonara does not write object attributes):

  S  short   F_Cu: pad NET_A and pad NET_B joined by a trace          -> net_short   (1)
  O  open    F_Cu: two pads both named NET_C, nothing between them    -> net_open    (1)
  R  sliver  In2:  two 1.5 mm squares touching only at a 0.05 mm corner overlap
              (no drawn line, so the reduction is not capped by it)   -> net_open_after_reduce (1, inner → EQ)

Every other C05 finding stays as in C05. Coordinates come from C05's ``expected/spots.json``
(spot letters) plus two new copper-free spots found here.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
C05 = ROOT / "cases" / "C05_four_layer_dfm"
OUT = HERE / "input" / "board.zip"
sys.path.insert(0, str(ROOT))

FS = 1_000_000  # %FSLAX46Y46 in mm


def c(v: float) -> str:
    return f"{int(round(v * FS)):+011d}".replace("+", "")


def flash(x, y, dcode):
    return f"D{dcode}*\nX{c(x)}Y{c(y)}D03*"


def line(x1, y1, x2, y2, dcode):
    return f"D{dcode}*\nX{c(x1)}Y{c(y1)}D02*\nX{c(x2)}Y{c(y2)}D01*"


def inject(text: str, apertures: list[str], body: list[str]) -> str:
    """Add aperture definitions after the last %ADD line and objects before M02."""
    lines = text.splitlines()
    last_add = max(i for i, ln in enumerate(lines) if ln.startswith("%ADD"))
    lines[last_add + 1 : last_add + 1] = apertures
    m02 = max(i for i, ln in enumerate(lines) if ln.strip() == "M02*")
    lines[m02:m02] = body
    return "\n".join(lines) + "\n"


def main() -> None:
    if not (C05 / "input" / "board.zip").is_file():
        subprocess.run([sys.executable, str(C05 / "make_input.py")], check=True)
    spots = json.loads((C05 / "expected" / "spots.json").read_text("utf-8"))
    files = {n: z.read(n) for z in [zipfile.ZipFile(C05 / "input" / "board.zip")] for n in z.namelist()}

    # three fresh copper/mask/silk-free spots (C05's own spots are "busy" too)
    import importlib.util
    import tempfile

    from shapely.geometry import box
    from shapely.ops import unary_union

    from engine.geom.from_gerbonara import camfile_to_geometry
    from engine.geom.layers import open_camfile
    from engine.geom.profile import extract_profile
    from gerbonara.rs274x import GerberFile

    spec = importlib.util.spec_from_file_location("c05", C05 / "make_input.py")
    c05 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c05)  # type: ignore[union-attr]
    with tempfile.TemporaryDirectory() as d:
        busy = [box(x - 3, y - 3, x + 3, y + 3) for x, y in spots.values()]
        for n in ("Flashpads-F_Cu.gbr", "Flashpads-F_Mask.gbr", "Flashpads-F_Silkscreen.gbr", "Flashpads-In2_Cu.gbr", "Flashpads-B_Cu.gbr", "Flashpads-B_Mask.gbr"):
            p = Path(d) / n
            p.write_bytes(files[n])
            busy.append(camfile_to_geometry(open_camfile(p, "top_copper"))[0])
        (Path(d) / "edge.gbr").write_bytes(files["Flashpads-Edge_Cuts.gbr"])
        profile = extract_profile(GerberFile.open(Path(d) / "edge.gbr")).profile
        S, O, R = c05.free_spots(profile, unary_union(busy), 3, size=6.0, step=1.0)

    # ---- F_Cu: short + open -------------------------------------------------------------
    fcu = files["Flashpads-F_Cu.gbr"].decode("utf-8")
    body = [
        "%TO.N,NET_A*%", flash(S[0] - 1.5, S[1], 90), line(S[0] - 1.5, S[1], S[0] + 1.5, S[1], 91),
        "%TO.N,NET_B*%", flash(S[0] + 1.5, S[1], 90),
        "%TO.N,NET_C*%", flash(O[0] - 1.5, O[1], 90), flash(O[0] + 1.5, O[1], 90),
        "%TD*%",
    ]  # fmt: skip
    files["Flashpads-F_Cu.gbr"] = inject(fcu, ["%ADD90C,1.000000*%", "%ADD91C,0.250000*%"], body).encode("utf-8")
    # matching mask openings so the new pads do not add mask findings
    fm = files["Flashpads-F_Mask.gbr"].decode("utf-8")
    fm_body = [flash(S[0] - 1.5, S[1], 90), flash(S[0] + 1.5, S[1], 90), flash(O[0] - 1.5, O[1], 90), flash(O[0] + 1.5, O[1], 90)]
    files["Flashpads-F_Mask.gbr"] = inject(fm, ["%ADD90C,1.100000*%"], fm_body).encode("utf-8")

    # ---- In2: sliver connection (two squares overlapping 0.05 × 0.05 at a corner) ---------
    in2 = files["Flashpads-In2_Cu.gbr"].decode("utf-8")
    sq = 1.5
    ov = 0.05
    a = (R[0], R[1])
    b = (R[0] + sq - ov, R[1] + sq - ov)  # centre offset so the squares overlap by ov in x and y
    in2_body = [
        "%TO.N,NET_R*%", flash(a[0], a[1], 92), flash(b[0], b[1], 92), "%TD*%",
    ]  # fmt: skip
    files["Flashpads-In2_Cu.gbr"] = inject(in2, [f"%ADD92R,{sq:.6f}X{sq:.6f}*%"], in2_body).encode("utf-8")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in sorted(files.items()):
            zf.writestr(name, data)
    (HERE / "expected" / "spots.json").write_text(json.dumps({**spots, "S": S, "O": O, "R": R}, indent=1), "utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(files)} files); spots S={S} O={O} R={R}")


if __name__ == "__main__":
    main()
