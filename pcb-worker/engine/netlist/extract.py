"""Copper connectivity → nets (第6章 p130 网络分析).

Nodes are the folded copper polygons of every copper layer; a plated hole joins every node it
touches on the layers of its span (blind/buried spans come from the drill layer's ``drill_span``).
Union-find gives the *production* netlist. Two compares:

* **declared** (Gerber X2 ``%TO.N`` net names, e.g. KiCad/Altium 20+): a node set with two
  declared names is a **short**, a declared name spread over several node sets is an **open**
* **reduced** (p130 第二次减铜 0.15MM): shrink every polygon by ``reduce_mm/2`` and re-extract;
  a production net that falls apart is held together by copper thinner than ``reduce_mm``

No geometry is modified; results are reported and written as ``netlist.json``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import shapely
from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely.geometry import Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from engine.geom.svg import iter_polygons


@dataclass
class CopperLayerNodes:
    rel: str
    index: int  # stackup number, 1 = top
    polys: list[Polygon]
    tree: STRtree | None = None

    def __post_init__(self) -> None:
        self.tree = STRtree(self.polys) if self.polys else None
        for p in self.polys:  # prepared predicates: O(log n) per test instead of O(vertices)
            shapely.prepare(p)

    def containing(self, pt: Point) -> list[int]:
        return [int(i) for i in self.tree.query(pt, predicate="within")] if self.tree else []

    def touching(self, g: BaseGeometry) -> list[int]:
        return [int(i) for i in self.tree.query(g, predicate="intersects")] if self.tree else []


@dataclass
class HoleLink:
    x: float
    y: float
    dia: float
    span: tuple[int, int]  # inclusive stackup numbers
    tool: str = ""

    def disc(self) -> Polygon:
        return Point(self.x, self.y).buffer(self.dia / 2)


class UnionFind:
    def __init__(self) -> None:
        self.p: dict[Any, Any] = {}

    def find(self, a):
        self.p.setdefault(a, a)
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


@dataclass
class Net:
    id: int
    nodes: list[tuple[str, int]]  # (layer rel, polygon index)
    names: set[str] = field(default_factory=set)
    holes: int = 0

    @property
    def layers(self) -> list[str]:
        return sorted({rel for rel, _ in self.nodes})


@dataclass
class Netlist:
    layers: dict[str, CopperLayerNodes]
    nets: list[Net]
    node_net: dict[tuple[str, int], int]
    hole_net: dict[int, int] = field(default_factory=dict)  # hole index (input order) -> net id

    def net_of(self, rel: str, i: int) -> Net | None:
        n = self.node_net.get((rel, i))
        return self.nets[n] if n is not None else None


def layers_from_geoms(entries: list[dict[str, Any]], geoms: dict[str, BaseGeometry]) -> dict[str, CopperLayerNodes]:
    out: dict[str, CopperLayerNodes] = {}
    for e in sorted(entries, key=lambda e: e.get("index") or 999):
        g = geoms.get(e["file"])
        if g is None:
            continue
        out[e["file"]] = CopperLayerNodes(rel=e["file"], index=int(e.get("index") or 1), polys=list(iter_polygons(g)))
    return out


def extract_nets(layers: dict[str, CopperLayerNodes], holes: list[HoleLink]) -> Netlist:
    """Union-find over copper polygons joined by plated holes.

    One vectorised STRtree query per layer (all discs whose span covers the layer) instead of
    one query per hole: on a 14-layer / 4 000-hole board this is 1 s instead of 30 s, because
    shapely prepares the tree geometries once per call."""
    uf = UnionFind()
    for L in layers.values():
        for i in range(len(L.polys)):
            uf.find((L.rel, i))
    touched: dict[int, list[tuple[str, int]]] = {}
    if holes:
        discs = [h.disc() for h in holes]
        for L in layers.values():
            if L.tree is None:
                continue
            idx = [k for k, h in enumerate(holes) if h.span[0] <= L.index <= h.span[1]]
            if not idx:
                continue
            sub = [discs[k] for k in idx]
            q = L.tree.query(sub)  # bbox candidates only; the exact test uses the prepared polygon
            for hi, pi in zip(q[0].tolist(), q[1].tolist()):
                if L.polys[int(pi)].intersects(sub[hi]):
                    touched.setdefault(idx[hi], []).append((L.rel, int(pi)))
    hole_count: dict[Any, int] = {}
    for nodes in touched.values():
        for a, b in zip(nodes, nodes[1:]):
            uf.union(a, b)
        for t in nodes:
            hole_count[t] = hole_count.get(t, 0) + 1
    groups: dict[Any, list[tuple[str, int]]] = {}
    for L in layers.values():
        for i in range(len(L.polys)):
            groups.setdefault(uf.find((L.rel, i)), []).append((L.rel, i))
    nets: list[Net] = []
    node_net: dict[tuple[str, int], int] = {}
    for k, nodes in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[1][0])):
        n = Net(id=len(nets), nodes=nodes, holes=sum(hole_count.get(t, 0) for t in nodes))
        for t in nodes:
            node_net[t] = n.id
        nets.append(n)
    hole_net = {k: node_net[nodes[0]] for k, nodes in touched.items() if nodes and nodes[0] in node_net}
    return Netlist(layers=layers, nets=nets, node_net=node_net, hole_net=hole_net)


# ---------------------------------------------------------------------------------------------
# declared nets (%TO.N)
# ---------------------------------------------------------------------------------------------
def _rep_point(o) -> Point | None:
    try:
        (x0, y0), (x1, y1) = o.bounding_box(unit=MM)
    except Exception:  # noqa: BLE001
        return None
    if isinstance(o, go.Flash):
        return Point((x0 + x1) / 2, (y0 + y1) / 2)
    if isinstance(o, go.Line):
        return Point((x0 + x1) / 2, (y0 + y1) / 2)
    return Point((x0 + x1) / 2, (y0 + y1) / 2)


def declared_points(objects: list[Any], ignore: set[str]) -> list[tuple[str, Point, Any]]:
    """(net name, representative point, object) for every object carrying ``.N``."""
    out = []
    for o in objects:
        attrs = getattr(o, "attrs", None) or {}
        n = attrs.get(".N") if hasattr(attrs, "get") else None
        if not n:
            continue
        name = n[0] if isinstance(n, (tuple, list)) else str(n)
        if name in ignore or not getattr(o, "polarity_dark", True):
            continue
        pt = _rep_point(o)
        if pt is not None:
            out.append((name, pt, o))
    return out


def apply_declared(nl: Netlist, declared: dict[str, list[tuple[str, Point, Any]]]) -> dict[str, list[tuple[str, Point]]]:
    """Attach declared names to nets. Returns name -> [(rel, point)] of points that hit no copper."""
    unplaced: dict[str, list[tuple[str, Point]]] = {}
    for rel, pts in declared.items():
        L = nl.layers.get(rel)
        if L is None:
            continue
        for name, pt, _o in pts:
            hit = L.containing(pt)
            if not hit:
                # a line's midpoint may miss a curved polygon: try the object's own outline
                hit = L.touching(pt.buffer(0.01))
            if not hit:
                unplaced.setdefault(name, []).append((rel, pt))
                continue
            net = nl.net_of(rel, hit[0])
            if net is not None:
                net.names.add(name)
    return unplaced


@dataclass
class Short:
    net: Net
    names: list[str]
    where: tuple[str, Polygon]  # a node of the net (layer, polygon)


@dataclass
class Open:
    name: str
    nets: list[Net]
    pieces: list[tuple[str, Polygon]]  # one polygon per extra net


def find_shorts_and_opens(nl: Netlist) -> tuple[list[Short], list[Open]]:
    shorts: list[Short] = []
    for n in nl.nets:
        if len(n.names) >= 2:
            rel, i = n.nodes[0]
            shorts.append(Short(net=n, names=sorted(n.names), where=(rel, nl.layers[rel].polys[i])))
    by_name: dict[str, list[Net]] = {}
    for n in nl.nets:
        for name in n.names:
            by_name.setdefault(name, []).append(n)
    opens: list[Open] = []
    for name, nets in by_name.items():
        if len(nets) >= 2:
            nets = sorted(nets, key=lambda n: -sum(nl.layers[r].polys[i].area for r, i in n.nodes))
            pieces = [(n.nodes[0][0], nl.layers[n.nodes[0][0]].polys[n.nodes[0][1]]) for n in nets[1:]]
            opens.append(Open(name=name, nets=nets, pieces=pieces))
    return shorts, opens


# ---------------------------------------------------------------------------------------------
# copper reduction (p130 减铜 0.15MM)
# ---------------------------------------------------------------------------------------------
@dataclass
class ReduceSplit:
    net: Net
    pieces: list[tuple[str, Polygon]]  # the smaller fragments after reduction (layer, polygon)
    n_pieces: int


def reduce_layers(layers: dict[str, CopperLayerNodes], reduce_mm: float) -> dict[str, CopperLayerNodes]:
    out: dict[str, CopperLayerNodes] = {}
    for rel, L in layers.items():
        polys: list[Polygon] = []
        for p in L.polys:
            g = p.buffer(-reduce_mm / 2)
            polys.extend(q for q in iter_polygons(g) if not q.is_empty)
        out[rel] = CopperLayerNodes(rel=rel, index=L.index, polys=polys)
    return out


PAD_PIECE_AREA = 1.0  # mm²: a reduced piece this small is a pad on thermal spokes / a via ring, not a pour fragment
MIN_PIECE_AREA = 0.02  # mm²: smaller fragments are erosion artefacts at acute corners, not a net


def compare_reduced(nl: Netlist, reduced: Netlist) -> list[ReduceSplit]:
    """Production nets that fall into several nets once the copper is shrunk.

    Each reduced polygon lies inside exactly one original polygon (shrinking never crosses a
    boundary), found with one vectorised ``within`` query per layer on the representative points."""
    member_nets: dict[int, dict[int, list[tuple[str, int]]]] = {}  # orig net -> reduced net -> nodes
    for rel, R in reduced.layers.items():
        L = nl.layers.get(rel)
        if L is None or L.tree is None or not R.polys:
            continue
        pts = [p.representative_point() for p in R.polys]
        q = L.tree.query(pts, predicate="within")
        for j, i in zip(q[0].tolist(), q[1].tolist()):
            on = nl.node_net.get((rel, int(i)))
            rn = reduced.node_net.get((rel, int(j)))
            if on is None or rn is None:
                continue
            member_nets.setdefault(on, {}).setdefault(rn, []).append((rel, int(j)))
    splits: list[ReduceSplit] = []
    for net in nl.nets:
        # a piece that is pad-sized after the shrink is a pad hanging on thermal spokes (< 2×reduce
        # wide by design) or a via ring — not a sliver between pours (2×2 Protel job: 52 "opens",
        # all ⌀0.66 via pads on the L2 plane, 0.36 mm² each after the shrink)
        parts = {k: v for k, v in member_nets.get(net.id, {}).items()
                 if sum(reduced.layers[r].polys[j].area for r, j in v) >= PAD_PIECE_AREA}  # fmt: skip
        if len(parts) >= 2:
            ordered = sorted(parts.items(), key=lambda kv: -sum(reduced.layers[r].polys[j].area for r, j in kv[1]))
            pieces = [(nodes[0][0], reduced.layers[nodes[0][0]].polys[nodes[0][1]]) for _, nodes in ordered[1:]]
            splits.append(ReduceSplit(net=net, pieces=pieces, n_pieces=len(parts)))
    return splits


def netlist_json(nl: Netlist, *, reduced_splits: list[ReduceSplit] | None = None) -> dict[str, Any]:
    return {
        "layers": [{"file": L.rel, "index": L.index, "polygons": len(L.polys)} for L in nl.layers.values()],
        "nets": [
            {"id": n.id, "name": sorted(n.names)[0] if len(n.names) == 1 else None, "names": sorted(n.names),
             "layers": n.layers, "nodes": len(n.nodes), "holes": n.holes}
            for n in nl.nets
        ],  # fmt: skip
        "stats": {
            "nets": len(nl.nets),
            "named": sum(1 for n in nl.nets if n.names),
            "multi_layer": sum(1 for n in nl.nets if len(n.layers) > 1),
            "reduced_splits": len(reduced_splits or []),
        },
    }
