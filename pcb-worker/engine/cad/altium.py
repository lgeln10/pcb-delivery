"""Altium Designer ``.PcbDoc`` reader (binary v5/v6 streams inside an OLE compound file).

Record layouts follow the community reverse engineering used by KiCad's Altium importer and were
re-checked byte-by-byte on real customer boards (docs/ROADMAP §M6i). Coordinates are int32 in
1/10000 mil; angles are float64 degrees. Only what the Gerber export needs is decoded.
"""

from __future__ import annotations

import re
import struct
from pathlib import Path
from typing import Any

from engine.cad.model import (
    BOTTOM,
    OCTAGON,
    RECT,
    ROUND,
    ROUNDED_RECT,
    TOP,
    Arc,
    Board,
    Fill,
    OutlineVertex,
    Pad,
    Region,
    Text,
    Track,
    Via,
)

U = 0.0254 / 10000.0  # 1/10000 mil → mm
_SHAPES = {1: ROUND, 2: RECT, 3: OCTAGON, 9: ROUNDED_RECT}
_HOLE_SHAPES = {0: "round", 1: "square", 2: "slot"}


def _mm(v: int) -> float:
    return v * U


def _len_mm(s: str) -> float:
    """``4560mil`` / ``12.7mm`` / ``0`` → mm."""
    s = s.strip()
    m = re.match(r"^\s*(-?[\d.]+(?:[eE][-+]?\d+)?)\s*(mil|mm|in|um)?\s*$", s)
    if not m:
        return 0.0
    v = float(m.group(1))
    unit = (m.group(2) or "mil").lower()
    return v * {"mil": 0.0254, "mm": 1.0, "in": 25.4, "um": 0.001}[unit]


def _props(text: str) -> dict[str, str]:
    return dict(p.split("=", 1) for p in text.strip("\x00").split("|") if "=" in p)


class _Ole:
    def __init__(self, path: Path):
        import olefile

        self.o = olefile.OleFileIO(path)

    def read(self, name: str) -> bytes:
        if not self.o.exists(name):
            return b""
        with self.o.openstream(name) as s:
            return s.read()

    def close(self) -> None:
        self.o.close()


def _typed_records(b: bytes):
    """``[u8 type][u32 len][payload]`` framing (Tracks6, Arcs6, Vias6, Fills6, Regions6, Texts6)."""
    i = 0
    n = len(b)
    while i + 5 <= n:
        t = b[i]
        ln = struct.unpack_from("<I", b, i + 1)[0]
        yield t, b[i + 5 : i + 5 + ln], i + 5 + ln
        i += 5 + ln


def _text_records(b: bytes) -> list[dict[str, str]]:
    """``[u32 len][text]`` framing (Board6, Nets6, Polygons6, Components6, Classes6)."""
    out: list[dict[str, str]] = []
    i = 0
    while i + 4 <= len(b):
        ln = struct.unpack_from("<I", b, i)[0]
        raw = b[i + 4 : i + 4 + ln]
        i += 4 + ln
        if not raw:
            continue
        out.append(_props(raw.decode("latin-1")))
    return out


def _hdr(r: bytes) -> tuple[int, int, int, int, int, int]:
    """layer, flags1, flags2, net, subpolyindex, component."""
    return struct.unpack_from("<BBBHHH", r, 0)


# ---------------------------------------------------------------------------------------------
def _board(ole: _Ole, board: Board) -> None:
    raw = ole.read("Board6/Data")
    if not raw:
        raise ValueError("Board6/Data missing — not a PcbDoc")
    recs = _text_records(raw)
    kv: dict[str, str] = {}
    for r in recs:
        kv.update(r)
    for k, v in kv.items():
        m = re.match(r"^LAYER(\d+)NAME$", k)
        if m:
            board.layer_names[int(m.group(1))] = v
    # copper stack: V9 stack entries (AD17+) carry LAYERID = 0x01000000 + n (n=1 top, 2.. mids,
    # 0xFFFF bottom); older files chain LAYERnNEXT from 1.
    stack: list[int] = []
    n = 0
    while f"V9_STACK_LAYER{n}_LAYERID" in kv:
        lid = int(kv[f"V9_STACK_LAYER{n}_LAYERID"])
        if lid >> 24 == 1 and (lid & 0xFF0000) == 0:
            low = lid & 0xFFFF
            stack.append(BOTTOM if low == 0xFFFF else low)
        n += 1
    if not stack:
        cur = TOP
        seen = set()
        while cur and cur not in seen:
            seen.add(cur)
            stack.append(cur)
            cur = int(kv.get(f"LAYER{cur}NEXT", "0") or 0)
        if BOTTOM not in stack:
            stack.append(BOTTOM)
    board.copper_layers = stack
    # board shape (KINDn / VXn / VYn … in Board6)
    i = 0
    while f"VX{i}" in kv:
        kind = int(kv.get(f"KIND{i}", "0") or 0)
        v = OutlineVertex(_len_mm(kv[f"VX{i}"]), _len_mm(kv[f"VY{i}"]))
        if kind == 1:
            v.arc = True
            v.cx, v.cy = _len_mm(kv.get(f"CX{i}", "0")), _len_mm(kv.get(f"CY{i}", "0"))
            v.radius = _len_mm(kv.get(f"R{i}", "0"))
            v.start_angle = float(kv.get(f"SA{i}", "0") or 0)
            v.end_angle = float(kv.get(f"EA{i}", "0") or 0)
        board.outline.append(v)
        i += 1
    board.notes.append(f"Board6: {kv.get('KIND', '')} version {kv.get('VERSION', '?')}, {len(stack)} copper layers")


def _rule_records(b: bytes) -> list[dict[str, str]]:
    """Rules6 framing is ``[u16 kind][u32 len][text]`` (not the plain u32 one Board6/Nets6 use)."""
    out: list[dict[str, str]] = []
    i = 0
    while i + 6 <= len(b):
        ln = struct.unpack_from("<I", b, i + 2)[0]
        raw = b[i + 6 : i + 6 + ln]
        i += 6 + ln
        if raw:
            out.append(_props(raw.decode("latin-1")))
    return out


def _rules(ole: _Ole, board: Board) -> None:
    scoped: list[str] = []
    for r in _rule_records(ole.read("Rules6/Data")):
        if r.get("ENABLED", "TRUE").upper() != "TRUE":
            continue
        kind = r.get("RULEKIND")
        if kind not in ("SolderMaskExpansion", "PasteMaskExpansion"):
            continue
        scope = r.get("SCOPE1EXPRESSION", "All")
        exp = _len_mm(r.get("EXPANSION", "4mil" if kind == "SolderMaskExpansion" else "0mil"))
        if scope != "All":
            # per-net / per-component expansion rules are not applied to individual pads yet;
            # surface them so the engineer sees the export may differ from Altium's own
            scoped.append(f"{kind} {r.get('NAME', '')} scope={scope} expansion={exp:.4f} mm")
            continue
        if kind == "SolderMaskExpansion":
            board.mask_expansion = exp
        else:
            board.paste_expansion = exp
    for t in scoped:
        board.notes.append(f"Rules6: scoped rule not applied — {t}")


def _nets(ole: _Ole, board: Board) -> None:
    for i, r in enumerate(_text_records(ole.read("Nets6/Data"))):
        board.nets[i] = r.get("NAME", f"net{i}")


def _components(ole: _Ole, board: Board) -> None:
    for r in _text_records(ole.read("Components6/Data")):
        board.components.append(
            {
                "layer": r.get("LAYER", ""),
                "x": _len_mm(r.get("X", "0")),
                "y": _len_mm(r.get("Y", "0")),
                "pattern": r.get("PATTERN", ""),
                "designator": r.get("SOURCEDESIGNATOR", ""),
                "rotation": float(r.get("ROTATION", "0") or 0),
                "name_on": r.get("NAMEON", "TRUE").upper() == "TRUE",
                "comment_on": r.get("COMMENTON", "TRUE").upper() == "TRUE",
            }
        )


def _tracks(ole: _Ole, board: Board) -> None:
    for t, r, _ in _typed_records(ole.read("Tracks6/Data")):
        if t != 4 or len(r) < 33:
            continue
        layer, _f1, f2, net, sub, comp = _hdr(r)
        x1, y1, x2, y2, w = struct.unpack_from("<iiiii", r, 13)
        board.tracks.append(
            Track(layer, _mm(x1), _mm(y1), _mm(x2), _mm(y2), _mm(w), _net(net), _comp(comp), bool(f2 & 0x02), _net(sub))
        )


def _arcs(ole: _Ole, board: Board) -> None:
    for t, r, _ in _typed_records(ole.read("Arcs6/Data")):
        if t != 1 or len(r) < 45:
            continue
        layer, _f1, f2, net, sub, comp = _hdr(r)
        cx, cy, rad = struct.unpack_from("<iii", r, 13)
        sa, ea = struct.unpack_from("<dd", r, 25)
        w = struct.unpack_from("<i", r, 41)[0]
        board.arcs.append(Arc(layer, _mm(cx), _mm(cy), _mm(rad), sa, ea, _mm(w), _net(net), _comp(comp), bool(f2 & 0x02), _net(sub)))


def _vias(ole: _Ole, board: Board) -> None:
    for t, r, _ in _typed_records(ole.read("Vias6/Data")):
        if t != 3 or len(r) < 31:
            continue
        _layer, _f1, f2, net, _sub, _comp = _hdr(r)
        x, y, dia, hole, ls, le = struct.unpack_from("<iiiiBB", r, 13)
        v = Via(_mm(x), _mm(y), _mm(dia), _mm(hole), ls, le, _net(net))
        v.tent_top, v.tent_bottom = bool(f2 & 0x01), bool(f2 & 0x02)
        if len(r) >= 62:
            manual = struct.unpack_from("<i", r, 54)[0]
            mode = r[62] if len(r) > 62 else 1
            if mode == 2:
                v.mask_expansion = _mm(manual)
        board.vias.append(v)


def _fills(ole: _Ole, board: Board) -> None:
    for t, r, _ in _typed_records(ole.read("Fills6/Data")):
        if t != 6 or len(r) < 37:
            continue
        layer, _f1, f2, net, _sub, _comp = _hdr(r)
        x1, y1, x2, y2 = struct.unpack_from("<iiii", r, 13)
        rot = struct.unpack_from("<d", r, 29)[0]
        board.fills.append(Fill(layer, _mm(x1), _mm(y1), _mm(x2), _mm(y2), rot, _net(net), bool(f2 & 0x02)))


def _regions(ole: _Ole, board: Board) -> None:
    for t, r, _ in _typed_records(ole.read("Regions6/Data")):
        if t != 11 or len(r) < 26:
            continue
        layer, _f1, f2, net, sub, _comp = _hdr(r)
        n = struct.unpack_from("<I", r, 18)[0]
        props = _props(r[22 : 22 + n].decode("latin-1"))
        i = 22 + n
        nv = struct.unpack_from("<I", r, i)[0]
        i += 4
        pts = [(_mm(x), _mm(y)) for x, y in struct.iter_unpack("<dd", r[i : i + 16 * nv])]
        i += 16 * nv
        holes: list[list[tuple[float, float]]] = []
        # holes follow as ``[u32 n][n × (f64 x, f64 y)]`` blocks until the record ends (no count prefix)
        while i + 4 <= len(r):
            hv = struct.unpack_from("<I", r, i)[0]
            i += 4
            if hv == 0 or i + 16 * hv > len(r):
                break
            holes.append([(_mm(x), _mm(y)) for x, y in struct.iter_unpack("<dd", r[i : i + 16 * hv])])
            i += 16 * hv
        kind = int(props.get("KIND", "0") or 0)
        v7 = props.get("V7_LAYER", "")
        if v7.startswith("MECHANICAL") and v7[10:].isdigit():
            layer = 56 + int(v7[10:])  # mech 17+ (byte value is not meaningful there)
        reg = Region(layer, pts, holes, kind, props.get("ISBOARDCUTOUT", "").upper() == "TRUE", bool(f2 & 0x02) or props.get("KEEPOUT", "").upper() == "TRUE", _net(net), _net(sub))
        board.regions.append(reg)


def _wide_strings(ole: _Ole) -> dict[int, str]:
    b = ole.read("WideStrings6/Data")
    out: dict[int, str] = {}
    if b[:1] == b"|" or b.startswith(b"\x00\x00\x00\x00|"):  # newer: text records with ENCODEDTEXT
        for r in _text_records(b):
            idx = r.get("INDEX")
            enc = r.get("ENCODEDTEXT", "")
            if idx is None or not enc:
                continue
            try:
                out[int(idx)] = bytes(int(v) for v in enc.split(",")).decode("utf-16-le", "replace").rstrip("\x00")
            except ValueError:
                pass
        return out
    i = 0
    while i + 8 <= len(b):
        idx, n = struct.unpack_from("<II", b, i)
        i += 8
        if n > len(b) - i or n % 2:
            break
        out[idx] = b[i : i + n].decode("utf-16-le", "replace").rstrip("\x00")
        i += n
    return out


def _texts(ole: _Ole, board: Board) -> None:
    b = ole.read("Texts6/Data")
    wide = _wide_strings(ole)
    i = 0
    n = len(b)
    while i + 5 <= n:
        t = b[i]
        ln = struct.unpack_from("<I", b, i + 1)[0]
        r = b[i + 5 : i + 5 + ln]
        i += 5 + ln
        if i + 4 > n:
            break
        sl = struct.unpack_from("<I", b, i)[0]
        s = b[i + 4 : i + 4 + sl]
        i += 4 + sl
        if t != 5 or len(r) < 40:
            continue
        layer, f1, _f2, _net, _sub, comp = _hdr(r)
        x, y, h = struct.unpack_from("<iii", r, 13)
        rot = struct.unpack_from("<d", r, 27)[0]
        mirrored = bool(r[35])
        sw = struct.unpack_from("<i", r, 36)[0]
        txt = s[1 : 1 + s[0]].decode("gbk", "replace") if s else ""
        tx = Text(layer, _mm(x), _mm(y), _mm(h), txt, rot, mirrored, _mm(sw), component=_comp(comp))
        if len(r) >= 123:
            tx.is_comment, tx.is_designator = bool(r[40]), bool(r[41])
            tx.bold, tx.italic = bool(r[44]), bool(r[45])
            tx.font = r[46:110].decode("utf-16-le", "replace").split("\x00", 1)[0]
            tx.inverted = bool(r[110])
            widx = struct.unpack_from("<I", r, 115)[0]
            if wide.get(widx):
                tx.text = wide[widx]
            if len(r) > 160:
                tx.truetype = r[160] == 1
        tx.hidden = bool(f1 & 0x80)
        # designator / comment visibility lives on the component (NAMEON / COMMENTON)
        if tx.component >= 0 and tx.component < len(board.components):
            c = board.components[tx.component]
            if (tx.is_designator and not c["name_on"]) or (tx.is_comment and not c["comment_on"]):
                tx.hidden = True
        board.texts.append(tx)


def _sub(b: bytes, i: int) -> tuple[bytes, int]:
    ln = struct.unpack_from("<I", b, i)[0]
    return b[i + 4 : i + 4 + ln], i + 4 + ln


def _pads(ole: _Ole, board: Board) -> None:
    b = ole.read("Pads6/Data")
    i = 0
    n = len(b)
    while i < n:
        if b[i] != 2:
            raise ValueError(f"Pads6: unexpected record type {b[i]} at {i}")
        i += 1
        name, i = _sub(b, i)
        _, i = _sub(b, i)
        _, i = _sub(b, i)
        _, i = _sub(b, i)
        r, i = _sub(b, i)
        s6, i = _sub(b, i)
        if len(r) < 62:
            continue
        layer, _f1, _f2, net, _subpoly, comp = _hdr(r)
        x, y, tx, ty, mx, my, bx, by, hole = struct.unpack_from("<9i", r, 13)
        ts, ms, bs = r[49], r[50], r[51]
        rot = struct.unpack_from("<d", r, 52)[0]
        plated = bool(r[60])
        mode = r[62]
        p = Pad(_mm(x), _mm(y), layer, _SHAPES.get(ts, ROUND), _mm(tx), _mm(ty), _mm(hole), rot, plated, name[1 : 1 + name[0]].decode("latin-1") if name else "", _net(net), _comp(comp))
        p.mid_shape, p.mid_w, p.mid_h = _SHAPES.get(ms, ROUND), _mm(mx), _mm(my)
        p.bot_shape, p.bot_w, p.bot_h = _SHAPES.get(bs, ROUND), _mm(bx), _mm(by)
        if mode == 0:  # simple: one size everywhere
            p.mid_w = p.mid_h = p.bot_w = p.bot_h = 0.0
        if len(r) >= 103:
            paste, mask = struct.unpack_from("<ii", r, 86)
            pmode, mmode = r[101], r[102]
            if mmode == 2:
                p.mask_expansion = _mm(mask)
            if pmode == 2:
                p.paste_expansion = _mm(paste)
        if len(r) >= 114:
            p.hole_rotation = struct.unpack_from("<d", r, 106)[0]
        if len(s6) >= 262:
            xs = struct.unpack_from("<29i", s6, 0)
            ys = struct.unpack_from("<29i", s6, 116)
            shapes = s6[232:261]
            if mode == 2:
                for k in range(29):
                    if xs[k] > 0 and ys[k] > 0:
                        p.per_layer[2 + k] = (_SHAPES.get(shapes[k], ROUND), _mm(xs[k]), _mm(ys[k]))
            if len(s6) >= 275:
                p.hole_shape = _HOLE_SHAPES.get(s6[262], "round")
                p.slot_length = _mm(struct.unpack_from("<i", s6, 263)[0])
                p.hole_rotation = struct.unpack_from("<d", s6, 267)[0]
            if len(s6) >= 596 + 32 and p.shape == ROUNDED_RECT:
                p.corner_radius_pct = float(s6[596 + 0]) if s6[596] else 50.0
        board.pads.append(p)


def _net(v: int) -> int:
    return -1 if v == 0xFFFF else v


def _comp(v: int) -> int:
    return -1 if v == 0xFFFF else v


def read_pcbdoc(path: Path) -> Board:
    ole = _Ole(path)
    try:
        board = Board(source=str(path), fmt="altium")
        _board(ole, board)
        _rules(ole, board)
        _nets(ole, board)
        _components(ole, board)
        _tracks(ole, board)
        _arcs(ole, board)
        _vias(ole, board)
        _fills(ole, board)
        _regions(ole, board)
        _texts(ole, board)
        _pads(ole, board)
    finally:
        ole.close()
    return board


def describe(board: Board) -> dict[str, Any]:
    return {
        "format": board.fmt,
        "copper_layers": board.copper_layers,
        "layer_names": {k: board.layer_names.get(k, "") for k in board.layers_used()},
        "counts": {
            "pads": len(board.pads), "vias": len(board.vias), "tracks": len(board.tracks), "arcs": len(board.arcs),
            "fills": len(board.fills), "regions": len(board.regions), "texts": len(board.texts), "components": len(board.components),
        },
        "layers_used": board.layers_used(),
        "outline_vertices": len(board.outline),
        "mask_expansion_mm": round(board.mask_expansion, 4),
        "bounds_mm": [round(v, 3) for v in board.bounds()],
    }  # fmt: skip
