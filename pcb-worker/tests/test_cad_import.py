"""Native CAD files → Gerber set (engine/cad) and multi-unit set profiles (engine/geom/profile).

The Altium / Protel readers are exercised on the real customer boards kept locally under cases/
(the repo is local-only; the tests skip when the files are absent). Synthetic checks cover the
pieces that do not need a real file: fonts, Real48, set/rail profile logic.
"""

from __future__ import annotations

import struct
from pathlib import Path

import pytest
from shapely.geometry import Polygon

from engine.cad import fonts, sniff
from engine.cad.protel99 import real48
from engine.geom.profile import _spec_rails

ROOT = Path(__file__).resolve().parents[1]
PCBDOC = ROOT / "cases/C11_real_4l_altium/input/1H-WSL007-2-1.PcbDoc"
PROTEL = ROOT / "cases/C12_real_4l_protel99/input/CPU191.pcb"


def test_real48_decodes_delphi_angles():
    # 180.0 = exponent 0x88 (2^7) × 1.40625, sign bit clear
    assert real48(bytes.fromhex("88 00 00 00 00 34")) == 180.0
    assert real48(bytes.fromhex("87 00 00 00 00 34")) == 90.0
    assert real48(bytes.fromhex("89 00 00 00 00 34")) == 360.0
    assert real48(bytes(6)) == 0.0


def test_stroke_text_height_is_the_cap_height():
    segs, adv = fonts.stroke_text("HI", 1.0)
    ys = [y for a, b in segs for _x, y in (a, b)]
    assert abs(max(ys) - 1.0) < 1e-6 and abs(min(ys)) < 1e-6
    assert adv > 1.0


def test_truetype_text_renders_filled_glyphs_with_holes():
    polys, adv = fonts.truetype_text("08", 2.0)
    if not polys:
        pytest.skip("no TrueType font found on this machine")
    assert adv > 1.0
    assert sum(len(p.interiors) for p in polys) >= 2  # 0 and 8 have counters


def test_spec_rails_split_the_missing_height_equally():
    body = Polygon([(0, 0), (146.65, 0), (146.65, 94.8), (0, 94.8)])
    strips, info = _spec_rails(body, (146.65, 100.8))
    assert len(strips) == 2 and info["rail_top_mm"] == 3.0 and info["rail_bottom_mm"] == 3.0
    assert min(s.bounds[1] for s in strips) == -3.0 and max(s.bounds[3] for s in strips) == 97.8
    assert _spec_rails(body, (146.65, 94.8)) == ([], {"set_w": 146.65, "set_h": 94.8, "drawn_w": 146.65, "drawn_h": 94.8})
    assert _spec_rails(body, (100.0, 50.0))[1].get("oversize") is True


def test_sniff_recognises_both_formats(tmp_path: Path):
    p = tmp_path / "x.pcb"
    p.write_bytes(b"\x13PCB 4.0 Binary File" + bytes(60))
    assert sniff(p) == "protel99"
    q = tmp_path / "board.GTL"
    q.write_bytes(b"%FSLAX26Y26*%\n%MOMM*%\n")
    assert sniff(q) is None


@pytest.mark.skipif(not PCBDOC.is_file(), reason="real customer PcbDoc not present")
def test_pcbdoc_reader_and_export(tmp_path: Path):
    from engine.cad import export_gerbers, read_board

    b = read_board(PCBDOC)
    assert b.fmt == "altium" and b.copper_layers == [1, 2, 3, 32]
    assert len(b.pads) == 801 and len(b.vias) == 1963 and len(b.texts) == 774
    assert sum(t.hidden for t in b.texts) == 468  # comments hidden by COMMENTON=FALSE, designators by NAMEON=FALSE
    assert sum(1 for t in b.texts if t.truetype) == 27
    files = export_gerbers(b, tmp_path, "A")
    assert {"A.GTL", "A.G1", "A.G2", "A.GBL", "A.GTS", "A.GBS", "A.GTO", "A.GBO", "A.GKO", "A.TXT", "A.DRR"} <= set(files)
    g1 = (tmp_path / "A.G1").read_text("latin-1")
    assert "LPC" not in g1  # pour holes are cut-in rings, never clear regions
    txt = (tmp_path / "A.TXT").read_text("latin-1")
    assert ";TYPE=PLATED" in txt


@pytest.mark.skipif(not PCBDOC.is_file(), reason="real customer PcbDoc not present")
def test_set_profile_from_exported_outline(tmp_path: Path):
    from gerbonara.rs274x import GerberFile

    from engine.cad import export_gerbers, read_board
    from engine.geom.profile import extract_profile

    export_gerbers(read_board(PCBDOC), tmp_path, "A", text=False)
    pr = extract_profile(GerberFile.open(tmp_path / "A.GKO"), (146.65, 100.8))
    x0, y0, x1, y1 = pr.profile.bounds
    assert abs((x1 - x0) - 146.65) < 0.02 and abs((y1 - y0) - 100.8) < 0.02
    assert len(pr.units) == 9 and pr.set_info["nx"] == 3 and pr.set_info["ny"] == 3
    assert len(pr.rails) == 2 and pr.set_info["spec_rails"] == 0  # the customer drew the rails
    assert len(pr.profile.interiors) == 11  # 2 column slots + 9 notch cut-outs
    assert len(pr.drawn_holes) == 36
    # every V-cut line spans the whole panel
    assert all(abs(ln[-1][0] - ln[0][0]) > 146 for ln in pr.rail_lines if abs(ln[0][1] - ln[-1][1]) < 0.02)


@pytest.mark.skipif(not PROTEL.is_file(), reason="real customer Protel file not present")
def test_protel99_reader():
    from engine.cad import read_board

    b = read_board(PROTEL)
    assert b.fmt == "protel99" and b.copper_layers == [1, 2, 3, 32]
    assert len(b.pads) == 3204 and len(b.vias) == 884 and len(b.tracks) == 54138 and len(b.arcs) == 29346
    assert len(b.texts) == 2588 and sum(t.hidden for t in b.texts) == 1296
    assert all(abs(a.end_angle - a.start_angle) <= 360.0 + 1e-6 for a in b.arcs)
    assert len(b.polygons) == 24 and b.polygons[0]["layer"] == 1


def test_classify_stray_edge_notch_and_sketch():
    """Open linework on the outline layer: a ≥ half-circle arc reaching a unit edge is a hole that
    breaks through the edge (routed, not drilled); an open polyline deep inside that touches
    nothing is a sketch; a line touching the edge stays stray (a slot → EQ)."""
    import math

    from shapely.geometry import LineString, Polygon

    from engine.geom.profile import classify_stray

    unit = Polygon([(0, 0), (50, 0), (50, 40), (0, 40)])
    board = Polygon([(-5, 0), (55, 0), (55, 40), (-5, 40)])  # unit + rails; the unit edge x=0 is a V-cut line
    r = 1.75
    arc = LineString([(1.4 + r * math.cos(math.radians(a)), 20 + r * math.sin(math.radians(a))) for a in range(-135, 136, 5)])  # 270°, gap towards x=0
    sketch = LineString([(20, 10), (25, 10), (25, 15), (22, 15)])
    slot_line = LineString([(30, 0), (30, 4)])  # touches the edge
    stray, notches, sketches, slots = classify_stray([arc, sketch, slot_line], board, [unit], widths=[0.2, 0.2, 0.2])
    assert len(notches) == 1 and abs(notches[0][2] - 2 * r) < 0.02 and abs(notches[0][0] - 1.4) < 0.02
    assert len(sketches) == 1 and sketches[0].length == sketch.length and not slots
    assert len(stray) == 1 and stray[0].equals(slot_line)
    # the same polyline drawn 1 mm wide is a routed NPTH slot (2×2 job's keep-out slots)
    stray, notches, sketches, slots = classify_stray([arc, sketch, slot_line], board, [unit], widths=[0.2, 1.0, 1.0], min_slot_mm=0.5)
    assert not sketches and len(slots) == 1 and slots[0][1] == 1.0 and len(slots[0][0]) == 4
    assert len(stray) == 1  # the wide line touching the edge is still an EQ
    # a quarter arc is a fillet, not a notch: stays stray
    fillet = LineString([(1.4 + r * math.cos(math.radians(a)), 20 + r * math.sin(math.radians(a))) for a in range(90, 181, 5)])
    assert classify_stray([fillet], board, [unit])[1] == []


def test_rail_vcut_notch_cuts_the_rail_at_the_score_line_ends():
    """layer.rail_vcut_notch_mm: where a V-cut runs out through a rail the rail is notched
    length × depth from the panel edge (square, or half-round ended when a radius is given)."""
    from shapely.geometry import Polygon

    from engine.geom.profile import _notch_rail_ends

    board = Polygon([(0, 0), (100, 0), (100, 50), (0, 50)])
    rail = Polygon([(0, -10), (100, -10), (100, 0), (0, 0)])
    body = board.union(rail)
    lines = [[(0.0, 0.0), (100.0, 0.0)]]
    b2, rails = _notch_rail_ends(body, [rail], lines, (3.0, 1.5, 0.0))
    assert abs(body.area - b2.area - 2 * 3.0 * 1.5) < 1e-6  # two square notches
    assert len(rails) == 1 and abs(rail.area - rails[0].area - 9.0) < 1e-6
    assert not b2.contains(Polygon([(0.1, -1.4), (2.9, -1.4), (2.9, -0.1), (0.1, -0.1)]))
    b3, _ = _notch_rail_ends(body, [rail], lines, (3.7, 1.5, 0.75))
    cut = body.area - b3.area
    assert abs(cut - 2 * ((3.7 - 0.75) * 1.5 + 3.14159 * 0.75**2 / 2)) < 0.01  # half-round ended
    # a score line between two units (no rail on either side) is left alone
    b4, _ = _notch_rail_ends(board, [], [[(0.0, 25.0), (100.0, 25.0)]], (3.0, 1.5, 0.0))
    assert b4.area == board.area
