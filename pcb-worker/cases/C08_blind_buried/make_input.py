"""Generate ``input/board.zip`` for C08: C01 turned into a **six-layer blind/buried-via board**.

    uv run python cases/C08_blind_buried/make_input.py

Layers: F_Cu (L1), In1..In4 (L2–L5, positive, synthesised), B_Cu (L6). Three drill files:

  Flashpads-PTH.drl      %TF Plated,1,6,PTH    through (C01's holes + via TH)
  Flashpads-L1-L2.drl    %TF Plated,1,2,Blind  blind via BV  ⌀0.2
  Flashpads-L2-L5.drl    %TF Plated,2,5,Buried buried via BUR ⌀0.2

Planted (net names via %TO.N text injection):
  TH  pads on all six layers named TH  → one net through all layers (no finding)
  BV  pads on L1+L2 named BV           → one net L1–L2 (no finding)
  BUR pads on L2..L5 named BUR **and a pad on L1 also named BUR** → the buried via cannot reach
      L1 → net_open ×1. If spans were ignored (1–6), there would be no open: the case proves
      drill_span handling in intake → netlist.

Nothing else is planted; DFM stages should look like C01 plus quiet inner layers.
"""

from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = ROOT / "tests" / "fixtures" / "kicad-x2ap"
OUT = HERE / "input" / "board.zip"
sys.path.insert(0, str(ROOT))

from gerbonara.rs274x import GerberFile  # noqa: E402
from shapely.geometry import box  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

from engine.geom.from_gerbonara import camfile_to_geometry  # noqa: E402
from engine.geom.layers import open_camfile  # noqa: E402
from engine.geom.profile import extract_profile  # noqa: E402

FS = 1_000_000
PAD = 0.65  # ring ≥ 8mil on the 0.2 vias (p122); was 0.45
VIA = 0.2


def c(v: float) -> str:
    return f"{int(round(v * FS)):+011d}".replace("+", "")


def flash(x, y, dcode="90"):
    return f"D{dcode}*\nX{c(x)}Y{c(y)}D03*"


def named(name: str, *objs: str) -> list[str]:
    return [f"%TO.N,{name}*%", *objs, "%TD*%"]


def inject(text: str, apertures: list[str], body: list[str]) -> str:
    lines = text.splitlines()
    last_add = max(i for i, ln in enumerate(lines) if ln.startswith("%ADD"))
    lines[last_add + 1 : last_add + 1] = apertures
    m02 = max(i for i, ln in enumerate(lines) if ln.strip() == "M02*")
    lines[m02:m02] = body
    return "\n".join(lines) + "\n"


def synth_layer(template: Path, n: int) -> str:
    gf = GerberFile.open(template)
    gf.file_attrs[".FileFunction"] = ("Copper", f"L{n}", "Inr")
    gf.file_attrs[".FilePolarity"] = ("Positive",)
    gf.objects = []
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "x.gbr"
        gf.save(p)
        text = p.read_text("utf-8")
    import re

    text = re.sub(r"^(G7[45])$", r"\1*", text, flags=re.M)
    if "%ADD" not in text:  # empty layer: give it one aperture line so inject() has an anchor
        text = text.replace("%LPD*%", "%LPD*%\n%ADD10C,0.100000*%")
    return text


def drill_file(header_src: str, function: str, tool_dia: float, holes: list[tuple[float, float]]) -> str:
    head = []
    for ln in header_src.splitlines():
        if ln.startswith("T") and "C" in ln:
            continue
        if ln.strip() == "%":
            break
        if "TF.FileFunction" in ln:
            ln = f"; #@! TF.FileFunction,{function}"
        head.append(ln)
    body = [f"T1C{tool_dia:.3f}", "%", "G90", "G05", "T1", *[f"X{x:.3f}Y{y:.3f}" for x, y in holes], "T0", "M30"]
    return "\n".join(head + body) + "\n"


def free_spots(profile, busy, n: int, size: float = 5.0, step: float = 1.0):
    x0, y0, x1, y1 = profile.bounds
    taken, out = [], []
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
    assert len(out) == n
    return out


def main() -> None:
    files = {p.name: p.read_bytes() for p in sorted(SRC.iterdir()) if p.is_file()}
    profile = extract_profile(GerberFile.open(SRC / "Flashpads-Edge_Cuts.gbr")).profile
    busy = unary_union([camfile_to_geometry(open_camfile(SRC / n, "top_copper"))[0] for n in (
        "Flashpads-F_Cu.gbr", "Flashpads-B_Cu.gbr", "Flashpads-F_Mask.gbr", "Flashpads-B_Mask.gbr", "Flashpads-F_Silkscreen.gbr",
    )])  # fmt: skip
    TH, BV, BUR = free_spots(profile, busy, 3)
    print("spots:", {"TH": TH, "BV": BV, "BUR": BUR})

    # ---- outer layers (KiCad text, FS 4.6 mm) --------------------------------------------
    ap = ["%ADD90C,0.650000*%"]
    fcu = files["Flashpads-F_Cu.gbr"].decode("utf-8")
    files["Flashpads-F_Cu.gbr"] = inject(fcu, ap, [*named("TH", flash(*TH)), *named("BV", flash(*BV)), *named("BUR", flash(*BUR))]).encode("utf-8")
    bcu = files["Flashpads-B_Cu.gbr"].decode("utf-8")
    files["Flashpads-B_Cu.gbr"] = inject(bcu, ap, named("TH", flash(*TH))).encode("utf-8")

    # ---- inner layers L2..L5 ------------------------------------------------------------------
    for n, name in ((2, "In1"), (3, "In2"), (4, "In3"), (5, "In4")):
        text = synth_layer(SRC / "Flashpads-F_Cu.gbr", n)
        body = [*named("TH", flash(*TH)), *named("BUR", flash(*BUR))]
        if n == 2:
            body += named("BV", flash(*BV))
        files[f"Flashpads-{name}_Cu.gbr"] = inject(text, ap, body).encode("utf-8")

    # ---- drills ---------------------------------------------------------------------------
    pth = files["Flashpads-PTH.drl"].decode("utf-8")
    out: list[str] = []
    for ln in pth.splitlines():
        if ln == "T0":
            out += ["T7", f"X{TH[0]:.3f}Y{TH[1]:.3f}"]
        out.append(ln)
        if ln == "T6C1.100":
            out.append(f"T7C{VIA:.3f}")
    pth = "\n".join(out) + "\n"
    pth = pth.replace("TF.FileFunction,Plated,1,2,PTH", "TF.FileFunction,Plated,1,6,PTH")
    files["Flashpads-PTH.drl"] = pth.encode("utf-8")
    files["Flashpads-NPTH.drl"] = files["Flashpads-NPTH.drl"].replace(b"TF.FileFunction,NonPlated,1,2,NPTH", b"TF.FileFunction,NonPlated,1,6,NPTH")
    files["Flashpads-L1-L2.drl"] = drill_file(pth, "Plated,1,2,Blind", VIA, [BV]).encode("utf-8")
    files["Flashpads-L2-L5.drl"] = drill_file(pth, "Plated,2,5,Buried", VIA, [BUR]).encode("utf-8")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in sorted(files.items()):
            zf.writestr(name, data)
    (HERE / "expected").mkdir(exist_ok=True)
    (HERE / "expected" / "spots.json").write_text(json.dumps({"TH": TH, "BV": BV, "BUR": BUR}, indent=1), "utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(files)} files)")


if __name__ == "__main__":
    main()
