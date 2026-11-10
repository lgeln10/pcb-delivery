"""Generate ``input/board.zip`` for C04 from the C01 KiCad fixture (re-runnable).

    uv run python cases/C04_messy_names/make_input.py

Same board as C01, but every file is renamed to a "customer style" name and every Gerber X2
attribute line (``%TF.…*%``) and Excellon ``; #@! TF.…`` comment is stripped, so the layer
identifier has to fall back to name / extension / content rules. Nothing else is changed.
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SRC = ROOT / "tests" / "fixtures" / "kicad-x2ap"
OUT = HERE / "input" / "board.zip"

RENAME = {
    "Flashpads-F_Cu.gbr": "top.art",
    "Flashpads-B_Cu.gbr": "bot.art",
    "Flashpads-F_Mask.gbr": "smt.gbr",
    "Flashpads-B_Mask.gbr": "smb.gbr",
    "Flashpads-F_Silkscreen.gbr": "sst.gbr",
    "Flashpads-B_Silkscreen.gbr": "ssb.gbr",
    "Flashpads-F_Paste.gbr": "spt.gbr",
    "Flashpads-B_Paste.gbr": "spb.gbr",
    "Flashpads-Edge_Cuts.gbr": "outline.gbr",
    "Flashpads-PTH.drl": "drill.txt",
    "Flashpads-NPTH.drl": "npth.txt",
}

_TF_LINE = re.compile(r"^%TF\..*\*%\s*$")  # Gerber X2 file attribute
_TF_COMMENT = re.compile(r"^(G04\s+|;\s*)#@!\s*TF\.")  # EAGLE / KiCad comment form


def strip_tf(text: str) -> tuple[str, int]:
    kept: list[str] = []
    n = 0
    for ln in text.splitlines():
        if _TF_LINE.match(ln) or _TF_COMMENT.match(ln):
            n += 1
            continue
        kept.append(ln)
    return "\n".join(kept) + "\n", n


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for src_name, new_name in RENAME.items():
            text, n = strip_tf((SRC / src_name).read_text("utf-8"))
            assert "TF." not in text, f"{src_name}: TF attribute survived"
            zf.writestr(new_name, text.encode("utf-8"))
            print(f"  {src_name:28} -> {new_name:12} ({n} TF lines removed)")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
