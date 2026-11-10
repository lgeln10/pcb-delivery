"""Protel 99 SE ``.pcb`` reader ("PCB 4.0 Binary File", also the stream inside a ``.ddb``).

The file is a Delphi object stream: a text header of ``|RECORD=Board|…`` key/value records, then
named sections (``\\x06Tracks`` …). Each primitive section carries a 256-byte block after its name,
then ``[u16 record_size][u32 count][u32 next_section_offset]`` and ``count`` fixed-size records.
Coordinates are int32 in 1/10000 mil, angles are Delphi Real48. Solid pours are stored as the
tracks/arcs they were poured with (tagged by polygon index) — the copper is fully explicit.

Layout of the fixed records (0-based byte offsets, established on real customer boards):

  common header  0-1 ?  2 layer  3 flags  4-5 net  6 ?  7-10 ?  11-12 polygon  13-14 component  15-18 ?
  Track (41)     19 x1 23 y1 27 x2 31 y2 35 width
  Arc   (49)     19 cx 23 cy 27 radius 31 start(R48) 37 end(R48) 43 width
  Via   (75)     19 x 23 y 27 dia 31 hole 35 start-layer 36 end-layer … 60 mask-expansion
  Pad   (125)    19 x 23 y 27 top-w 31 top-h 35 mid-w 39 mid-h 43 bot-w 47 bot-h 51 hole
                 55/56/57 shapes 58 name(pascal, 20) 79 rotation(R48) 85 plated 87 stack-mode(0 simple/1 top-mid-bot) … 110 mask-exp
  Text  (302)    19 x 23 y 27 height 31 font 33 rotation(R48) 39 mirrored 40 text(pascal, 255) 296 stroke width
"""

from __future__ import annotations

import re
import struct
from pathlib import Path

from engine.cad.model import (
    BOTTOM,
    OCTAGON,
    RECT,
    ROUND,
    TOP,
    Arc,
    Board,
    OutlineVertex,
    Pad,
    Text,
    Track,
    Via,
)

U = 0.0254 / 10000.0
_SHAPES = {1: ROUND, 2: RECT, 3: OCTAGON}
_SECTIONS = ("Arcs", "Pads", "Vias", "Tracks", "Texts", "Fills", "Components", "Nets", "Polygons")


def _mm(v: int) -> float:
    return v * U


def real48(b: bytes) -> float:
    e = b[0]
    if e == 0:
        return 0.0
    m = int.from_bytes(b[1:6], "little")
    sign = -1.0 if m & (1 << 39) else 1.0
    m &= (1 << 39) - 1
    return sign * (1 + m / 2**39) * 2.0 ** (e - 129)


def _u16(b: bytes, i: int) -> int:
    return struct.unpack_from("<H", b, i)[0]


def _i32(b: bytes, i: int) -> int:
    return struct.unpack_from("<i", b, i)[0]


def _idx(v: int) -> int:
    return -1 if v == 0xFFFF else v


class _File:
    def __init__(self, data: bytes):
        self.d = data
        self.sections: dict[str, tuple[int, int, int]] = {}  # name → (record_size, count, data_start)
        for name in _SECTIONS:
            pat = bytes([len(name)]) + name.encode()
            for m in re.finditer(re.escape(pat), data):
                off = m.start() + 256
                if off + 10 > len(data):
                    continue
                size = _u16(data, off)
                count = struct.unpack_from("<I", data, off + 2)[0]
                nxt = struct.unpack_from("<I", data, off + 6)[0]
                start = off + 10
                # a real section header points at the next section and its records fit exactly
                if 0 < size < 4096 and nxt <= len(data) and (nxt - start == size * count or name == "Polygons"):
                    self.sections[name] = (size, count, start)
                    break

    def records(self, name: str):
        if name not in self.sections:
            return
        size, count, start = self.sections[name]
        d = self.d
        for k in range(count):
            r = d[start + k * size : start + (k + 1) * size]
            if len(r) < size:
                break
            yield r


def _header(board: Board, data: bytes) -> None:
    end = data.find(b"\x07Classes")
    head = data[:end if end > 0 else 60000].decode("latin-1", "replace")
    kv: dict[str, str] = {}
    for rec in re.findall(r"\|RECORD=Board\|[^\x00]*", head):
        for p in rec.split("|"):
            if "=" in p:
                k, v = p.split("=", 1)
                kv[k] = v
    for k, v in kv.items():
        m = re.match(r"^LAYER(\d+)NAME$", k)
        if m:
            board.layer_names[int(m.group(1))] = v
    stack = [TOP]
    cur = int(kv.get("LAYER1NEXT", "0") or 0)
    seen = {TOP}
    while cur and cur not in seen and cur != BOTTOM:
        seen.add(cur)
        stack.append(cur)
        cur = int(kv.get(f"LAYER{cur}NEXT", "0") or 0)
    stack.append(BOTTOM)
    board.copper_layers = stack
    m = re.search(r"ORIGINX=([-\d.]+)mil\|ORIGINY=([-\d.]+)mil", head)
    if m:
        board.notes.append(f"origin {m.group(1)}mil,{m.group(2)}mil")
    board.notes.append(f"Protel 99 SE, {len(stack)} copper layers (LAYERnNEXT chain)")
    i = 0
    while f"VX{i}" in kv:
        board.outline.append(OutlineVertex(float(kv[f"VX{i}"].replace("mil", "")) * 0.0254, float(kv[f"VY{i}"].replace("mil", "")) * 0.0254))
        i += 1


def read_protel99(path: Path) -> Board:
    data = path.read_bytes()
    if b"PCB 4.0 Binary File" not in data[:64]:
        raise ValueError(f"{path.name}: not a Protel 99 SE PCB binary")
    f = _File(data)
    board = Board(source=str(path), fmt="protel99")
    _header(board, data)
    board.notes.append("sections: " + ", ".join(f"{k}={v[1]}" for k, v in f.sections.items()))
    for r in f.records("Tracks"):
        board.tracks.append(
            Track(r[2], _mm(_i32(r, 19)), _mm(_i32(r, 23)), _mm(_i32(r, 27)), _mm(_i32(r, 31)), _mm(_i32(r, 35)), _idx(_u16(r, 4)), _idx(_u16(r, 13)), False, _idx(_u16(r, 11)))
        )
    for r in f.records("Arcs"):
        board.arcs.append(
            Arc(r[2], _mm(_i32(r, 19)), _mm(_i32(r, 23)), _mm(_i32(r, 27)), real48(r[31:37]), real48(r[37:43]), _mm(_i32(r, 43)), _idx(_u16(r, 4)), _idx(_u16(r, 13)), False, _idx(_u16(r, 11)))
        )
    for r in f.records("Vias"):
        v = Via(_mm(_i32(r, 19)), _mm(_i32(r, 23)), _mm(_i32(r, 27)), _mm(_i32(r, 31)), r[35], r[36], _idx(_u16(r, 4)))
        board.vias.append(v)
    for r in f.records("Pads"):
        tx, ty, mx, my, bx, by, hole = struct.unpack_from("<7i", r, 27)
        n = r[58]
        name = r[59 : 59 + min(n, 20)].decode("latin-1", "replace")
        # byte 85 = plated, byte 87 = stack mode — the Altium Pads6 layout (60/62) shifted by the 21-byte
        # pascal name and the 6-byte Real48 rotation (C12: 3204 pads all plated, 28 simple-mode)
        p = Pad(_mm(_i32(r, 19)), _mm(_i32(r, 23)), r[2], _SHAPES.get(r[55], ROUND), _mm(tx), _mm(ty), _mm(hole), real48(r[79:85]), bool(r[85]), name, _idx(_u16(r, 4)), _idx(_u16(r, 13)))
        p.mid_shape, p.mid_w, p.mid_h = _SHAPES.get(r[56], ROUND), _mm(mx), _mm(my)
        p.bot_shape, p.bot_w, p.bot_h = _SHAPES.get(r[57], ROUND), _mm(bx), _mm(by)
        if len(r) >= 118 and r[117] == 2:  # manual solder mask expansion
            p.mask_expansion = _mm(_i32(r, 110))
        board.pads.append(p)
    for r in f.records("Texts"):
        n = r[40]
        raw = r[41 : 41 + min(n, 255)]
        txt = raw.decode("gbk", "replace")
        t = Text(r[2], _mm(_i32(r, 19)), _mm(_i32(r, 23)), _mm(_i32(r, 27)), txt, real48(r[33:39]), bool(r[39]), _mm(_i32(r, 296)) if len(r) >= 300 else 0.0, component=_idx(_u16(r, 13)))
        t.font = {1: "Default", 2: "Sans Serif", 3: "Serif"}.get(r[31], "Default")
        t.is_comment, t.is_designator = bool(r[300]), bool(r[301])
        board.texts.append(t)
    for i, r in enumerate(f.records("Components")):
        n = r[47]
        # byte 303 = designator shown, 304 = comment shown (checked against a factory export: the
        # MARK fiducials' designators and every comment were hidden there)
        board.components.append(
            {"layer": r[2], "x": _mm(_i32(r, 6)), "y": _mm(_i32(r, 10)), "pattern": r[48 : 48 + min(n, 40)].decode("latin-1", "replace"), "index": i,
             "name_on": bool(r[303]) if len(r) > 304 else True, "comment_on": bool(r[304]) if len(r) > 304 else True}
        )  # fmt: skip
    for t in board.texts:
        if 0 <= t.component < len(board.components):
            c = board.components[t.component]
            if (t.is_designator and not c["name_on"]) or (t.is_comment and not c["comment_on"]):
                t.hidden = True
    _polygons(board, f)
    return board


def _polygons(board: Board, f: _File) -> None:
    """Polygon outlines: 45-byte header (2 prefix, layer @2, bbox @6, net @23, options, vertex count
    @43) + (n+1) × 33-byte vertices ``[kind][x][y][cx][cy][sa R48][ea R48][r]`` (last vertex repeats the first)."""
    if "Polygons" not in f.sections:
        return
    _size, count, start = f.sections["Polygons"]
    d = f.d
    i = start
    for _n in range(count):
        if i + 45 > len(d):
            break
        h = d[i : i + 45]
        layer = h[2]  # same 2-byte prefix as every other record
        net = _idx(_u16(h, 23))
        nv = _u16(h, 43) + 1
        pts: list[tuple[float, float]] = []
        j = i + 45
        for _k in range(nv):
            v = d[j : j + 33]
            if len(v) < 33:
                break
            x, y = struct.unpack_from("<2i", v, 1)
            pts.append((_mm(x), _mm(y)))  # arc vertices (kind 1) are kept as their end point
            j += 33
        board.polygons.append({"layer": layer, "net": net, "outline": pts, "index": len(board.polygons)})
        i = j
