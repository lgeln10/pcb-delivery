"""Neutral in-memory board model shared by the Altium and Protel readers.

Units: millimetres, degrees, coordinates in the file's own frame (the exporter re-bases them).
Layers are Altium layer ids (1 top, 2..31 mid, 32 bottom, 33/34 overlay, 35/36 paste, 37/38 solder,
39..54 internal planes, 55 drill guide, 56 keep-out, 57..72 mechanical 1-16, 73 drill drawing,
74 multi-layer); Protel 99 SE uses the same numbering.
"""

from __future__ import annotations

from dataclasses import dataclass, field

TOP, BOTTOM, MULTI = 1, 32, 74
TOP_OVERLAY, BOTTOM_OVERLAY = 33, 34
TOP_PASTE, BOTTOM_PASTE = 35, 36
TOP_SOLDER, BOTTOM_SOLDER = 37, 38
KEEPOUT = 56
MECH1 = 57
DRILL_DRAWING = 73

MID_LAYERS = range(2, 32)
PLANE_LAYERS = range(39, 55)
MECH_LAYERS = range(57, 73)

# pad / hole shapes
ROUND, RECT, OCTAGON, ROUNDED_RECT = "round", "rect", "octagon", "rounded_rect"


@dataclass
class Pad:
    x: float
    y: float
    layer: int  # 1 / 32 / 74
    shape: str  # top shape
    w: float
    h: float
    hole: float = 0.0
    rotation: float = 0.0
    plated: bool = True
    name: str = ""
    net: int = -1
    component: int = -1
    mid_shape: str = ROUND  # shape/size on inner layers (multi-layer pads)
    mid_w: float = 0.0
    mid_h: float = 0.0
    bot_shape: str = ROUND
    bot_w: float = 0.0
    bot_h: float = 0.0
    corner_radius_pct: float = 0.0  # rounded_rect: radius as % of half the shorter side (Altium)
    hole_shape: str = ROUND  # round / square / slot
    slot_length: float = 0.0
    hole_rotation: float = 0.0
    mask_expansion: float | None = None  # None → use the board rule
    paste_expansion: float | None = None
    per_layer: dict[int, tuple[str, float, float]] = field(default_factory=dict)  # full-stack pads

    def size_on(self, layer: int) -> tuple[str, float, float]:
        if layer in self.per_layer:
            return self.per_layer[layer]
        if layer == BOTTOM and self.layer in (MULTI, BOTTOM):
            # a bottom-only pad keeps its size in the *bottom* slot of the stack too (Protel 99, C12: the
            # 212 test points are top 0×0 / bottom ⌀1.27 — read from the top slot they vanished, and the
            # engineer's ⌀1.3 pads + ⌀1.4 windows on them were the biggest pile of differences on the board)
            return (self.bot_shape, self.bot_w, self.bot_h) if self.bot_w > 0 else (self.shape, self.w, self.h)
        if layer in MID_LAYERS and self.layer == MULTI:
            return (self.mid_shape, self.mid_w, self.mid_h) if self.mid_w > 0 else (self.shape, self.w, self.h)
        return (self.shape, self.w, self.h)


@dataclass
class Via:
    x: float
    y: float
    diameter: float
    hole: float
    start_layer: int = TOP
    end_layer: int = BOTTOM
    net: int = -1
    tent_top: bool = False
    tent_bottom: bool = False
    mask_expansion: float | None = None


@dataclass
class Track:
    layer: int
    x1: float
    y1: float
    x2: float
    y2: float
    width: float
    net: int = -1
    component: int = -1
    keepout: bool = False
    polygon: int = -1  # pour it was generated for (-1 = drawn by the designer)


@dataclass
class Arc:
    layer: int
    cx: float
    cy: float
    radius: float
    start_angle: float  # degrees, CCW from +x
    end_angle: float
    width: float
    net: int = -1
    component: int = -1
    keepout: bool = False
    polygon: int = -1


@dataclass
class Fill:
    layer: int
    x1: float
    y1: float
    x2: float
    y2: float
    rotation: float = 0.0
    net: int = -1
    keepout: bool = False


@dataclass
class Region:
    layer: int
    outline: list[tuple[float, float]]
    holes: list[list[tuple[float, float]]] = field(default_factory=list)
    kind: int = 0  # 0 copper, 1 polygon cutout, 5 board cutout (Altium KIND)
    is_board_cutout: bool = False
    keepout: bool = False
    net: int = -1
    polygon: int = -1


@dataclass
class Text:
    layer: int
    x: float
    y: float
    height: float
    text: str
    rotation: float = 0.0
    mirrored: bool = False
    stroke_width: float = 0.0
    truetype: bool = False
    font: str = ""
    bold: bool = False
    italic: bool = False
    inverted: bool = False
    component: int = -1
    is_designator: bool = False
    is_comment: bool = False
    hidden: bool = False


@dataclass
class OutlineVertex:
    x: float
    y: float
    arc: bool = False
    cx: float = 0.0
    cy: float = 0.0
    radius: float = 0.0
    start_angle: float = 0.0
    end_angle: float = 0.0


@dataclass
class Board:
    source: str = ""
    fmt: str = ""  # altium / protel99
    layer_names: dict[int, str] = field(default_factory=dict)
    copper_layers: list[int] = field(default_factory=list)  # stack order, top → bottom, layer ids
    outline: list[OutlineVertex] = field(default_factory=list)  # Board6 board shape
    pads: list[Pad] = field(default_factory=list)
    vias: list[Via] = field(default_factory=list)
    tracks: list[Track] = field(default_factory=list)
    arcs: list[Arc] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)
    regions: list[Region] = field(default_factory=list)
    texts: list[Text] = field(default_factory=list)
    nets: dict[int, str] = field(default_factory=dict)
    components: list[dict] = field(default_factory=list)
    polygons: list[dict] = field(default_factory=list)  # pour definitions: layer, net, outline, index
    mask_expansion: float = 0.1016  # default SolderMaskExpansion rule (4 mil)
    paste_expansion: float = 0.0
    notes: list[str] = field(default_factory=list)  # reader remarks worth surfacing in the report

    def layers_used(self) -> dict[int, int]:
        c: dict[int, int] = {}
        for lst in (self.pads, self.vias, self.tracks, self.arcs, self.fills, self.regions, self.texts):
            for p in lst:
                lyr = getattr(p, "layer", MULTI)
                c[lyr] = c.get(lyr, 0) + 1
        return dict(sorted(c.items()))

    def bounds(self) -> tuple[float, float, float, float]:
        xs: list[float] = []
        ys: list[float] = []
        for p in self.pads:
            xs.append(p.x)
            ys.append(p.y)
        for t in self.tracks:
            xs += [t.x1, t.x2]
            ys += [t.y1, t.y2]
        for r in self.regions:
            for x, y in r.outline:
                xs.append(x)
                ys.append(y)
        for v in self.outline:
            xs.append(v.x)
            ys.append(v.y)
        if not xs:
            return (0.0, 0.0, 0.0, 0.0)
        return (min(xs), min(ys), max(xs), max(ys))
