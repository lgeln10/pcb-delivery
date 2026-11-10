"""Feature-level layer model (B0.1 / B0.4 / B0.5): what the B line edits.

The checks fold a layer into one shapely geometry (good for measuring, useless for editing).
Genesis edits *features* — a pad with a symbol, a line with a width, a surface — and so does
this model. It is a thin, order-preserving wrapper over gerbonara's graphic objects (they
already are feature-level and carry ``%TO``/``%TA`` attributes), plus:

* ``Symbol`` recognition per aperture (``engine.geom.symbols``) so "Change Symbol" has a name to change
* per-feature polygons and an STRtree for neighbourhood queries
* ``.N`` net from the object attributes, and same-layer connectivity components
* a ``ChangeSet`` transaction: every mutation is recorded with before/after, can be reverted
  and summarised (第4章 p111 三副本思想 —— orig 不动、edit 改、对原稿看差异)
* ``to_bytes`` writes the layer back with the *input* file's format so an untouched layer
  round-trips byte-for-byte in content
"""

from __future__ import annotations

import json
import math
import time
import warnings
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from gerbonara import graphic_objects as go
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely import STRtree
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from engine.geom.from_gerbonara import DEFAULT_MAX_ERROR_MM, fold_layer, iter_object_polygons
from engine.geom.symbols import Symbol, symbol_of

FeatureKind = Literal["pad", "line", "arc", "surface"]


def _kind_of(obj: Any) -> FeatureKind:
    if isinstance(obj, go.Flash):
        return "pad"
    if isinstance(obj, go.Line):
        return "line"
    if isinstance(obj, go.Arc):
        return "arc"
    return "surface"


@dataclass
class Feature:
    fid: int
    obj: Any  # gerbonara GraphicObject (Flash / Line / Arc / Region)
    _symbol: Symbol | None = field(default=None, repr=False)
    _geom: BaseGeometry | None = field(default=None, repr=False)

    @property
    def kind(self) -> FeatureKind:
        return _kind_of(self.obj)

    @property
    def polarity_dark(self) -> bool:
        return bool(self.obj.polarity_dark)

    @property
    def attrs(self) -> dict[str, Any]:
        a = getattr(self.obj, "attrs", None)
        return a if isinstance(a, dict) else {}

    @property
    def net(self) -> str | None:
        n = self.attrs.get(".N")
        if not n:
            return None
        return str(n[0]) if isinstance(n, (tuple, list)) else str(n)

    @property
    def function(self) -> str | None:
        """``%TA.AperFunction`` of the aperture (SMDPad / ViaPad / Conductor …) if any."""
        ap = getattr(self.obj, "aperture", None)
        for k, v in (getattr(ap, "attrs", None) or ()):
            if k == ".AperFunction":
                return str(v[0]) if isinstance(v, (tuple, list)) else str(v)
        return None

    @property
    def symbol(self) -> Symbol | None:
        if self._symbol is None and self.kind != "surface":
            self._symbol = symbol_of(self.obj.aperture)
        return self._symbol

    @property
    def xy(self) -> tuple[float, float]:
        o = self.obj
        if isinstance(o, go.Flash):
            return (float(o.x), float(o.y))
        if isinstance(o, (go.Line, go.Arc)):
            return ((float(o.x1) + float(o.x2)) / 2, (float(o.y1) + float(o.y2)) / 2)
        return self.geom.centroid.coords[0] if not self.geom.is_empty else (0.0, 0.0)

    @property
    def width_mm(self) -> float | None:
        """Stroke width of a line/arc (its aperture's size)."""
        if self.kind not in ("line", "arc"):
            return None
        s = self.symbol
        return s.size_mm[0] if s else None

    @property
    def geom(self) -> BaseGeometry:
        """The object's own footprint, whatever its polarity (a clear pad on a negative film is
        copper — callers that want painted copper filter on ``polarity_dark`` / use ``dark_union``)."""
        if self._geom is None:
            polys = [poly for _, poly in iter_object_polygons([self.obj], max_error=DEFAULT_MAX_ERROR_MM)]
            self._geom = unary_union(polys) if polys else Polygon()
        return self._geom

    def invalidate(self) -> None:
        self._symbol = None
        self._geom = None

    def describe(self) -> dict[str, Any]:
        d: dict[str, Any] = {"fid": self.fid, "kind": self.kind, "polarity": "dark" if self.polarity_dark else "clear"}
        if self.kind != "surface":
            s = self.symbol
            d["symbol"] = s.name if s else None
        x, y = self.xy
        d["x"], d["y"] = round(x, 4), round(y, 4)
        if self.net:
            d["net"] = self.net
        return d


@dataclass
class Change:
    action: Literal["add", "delete", "modify"]
    fid: int
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    note: str = ""


@dataclass
class ChangeSet:
    op: str
    layer: str
    params: dict[str, Any] = field(default_factory=dict)
    changes: list[Change] = field(default_factory=list)
    started: float = field(default_factory=time.time)
    _snapshot: list[Any] | None = field(default=None, repr=False)

    def __len__(self) -> int:
        return len(self.changes)

    @property
    def n_added(self) -> int:
        return sum(1 for c in self.changes if c.action == "add")

    @property
    def n_deleted(self) -> int:
        return sum(1 for c in self.changes if c.action == "delete")

    @property
    def n_modified(self) -> int:
        return sum(1 for c in self.changes if c.action == "modify")

    def summary(self, detail_cap: int = 50) -> dict[str, Any]:
        return {
            "op": self.op, "layer": self.layer, "params": self.params,
            "added": self.n_added, "deleted": self.n_deleted, "modified": self.n_modified,
            "details": [{"action": c.action, "fid": c.fid, "before": c.before, "after": c.after, "note": c.note} for c in self.changes[:detail_cap]],
            "truncated": max(0, len(self.changes) - detail_cap),
        }  # fmt: skip

    def to_json(self) -> str:
        return json.dumps(self.summary(), ensure_ascii=False, indent=1, default=str)


class FeatureLayer:
    """An editable Gerber layer. Mutate only through ``add`` / ``delete`` / ``replace`` inside a
    ``begin(op)`` … ``commit()`` transaction so every edit is recorded and revertible."""

    def __init__(self, gf: GerberFile, rel: str = "", layer_type: str = "") -> None:
        self.gf = gf
        self.rel = rel
        self.layer_type = layer_type
        self.features: list[Feature] = [Feature(i, o) for i, o in enumerate(gf.objects)]
        self._next_fid = len(self.features)
        self._tree: STRtree | None = None
        self._tree_feats: list[Feature] = []
        self._cs: ChangeSet | None = None
        self.history: list[ChangeSet] = []

    # ---- construction ---------------------------------------------------------------------
    @classmethod
    def load(cls, path: Path, rel: str = "", layer_type: str = "") -> FeatureLayer:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            gf = GerberFile.open(path)
        return cls(gf, rel or path.name, layer_type)

    @classmethod
    def from_bytes(cls, data: bytes, rel: str = "", layer_type: str = "") -> FeatureLayer:
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / (rel.rsplit("/", 1)[-1] or "layer.gbr")
            p.write_bytes(data)
            return cls.load(p, rel, layer_type)

    # ---- queries --------------------------------------------------------------------------
    def __iter__(self) -> Iterator[Feature]:
        return iter(self.features)

    def __len__(self) -> int:
        return len(self.features)

    def pads(self) -> list[Feature]:
        return [f for f in self.features if f.kind == "pad"]

    def lines(self) -> list[Feature]:
        return [f for f in self.features if f.kind in ("line", "arc")]

    def surfaces(self) -> list[Feature]:
        return [f for f in self.features if f.kind == "surface"]

    def by_fid(self, fid: int) -> Feature | None:
        return next((f for f in self.features if f.fid == fid), None)

    def tree(self) -> STRtree:
        if self._tree is None:
            self._tree_feats = [f for f in self.features if not f.geom.is_empty]
            self._tree = STRtree([f.geom for f in self._tree_feats])
        return self._tree

    def query(self, geom: BaseGeometry, predicate: str | None = "intersects") -> list[Feature]:
        idx = self.tree().query(geom, predicate=predicate) if predicate else self.tree().query(geom)
        return [self._tree_feats[i] for i in idx]

    def fold(self) -> BaseGeometry:
        geom, _ = fold_layer([f.obj for f in self.features])
        return geom

    def dark_union(self, feats: list[Feature] | None = None) -> BaseGeometry:
        fs = feats if feats is not None else [f for f in self.features if f.polarity_dark]
        return unary_union([f.geom for f in fs if not f.geom.is_empty]) if fs else Polygon()

    def painted_geom(self, f: Feature) -> BaseGeometry:
        """What a dark feature still paints after the clear features drawn *after* it (Gerber paints
        in file order): a plane loses its antipads, a pad flashed into an antipad afterwards does not.
        Anything that measures "how close is other copper" must use this, not ``f.geom``: C09 l5's
        plane region reaches to 0.1 mm of a whole island of pads on paper, the customer's clear
        region erases it there, and PadUp saw "no room" and left 21 pads short."""
        if not f.polarity_dark or f.geom.is_empty:
            return f.geom
        order = {ff.fid: i for i, ff in enumerate(self.features)}
        mine = order.get(f.fid)
        if mine is None:
            return f.geom
        later = [ff.geom for ff in self.query(f.geom) if not ff.polarity_dark and not ff.geom.is_empty and order[ff.fid] > mine]
        return f.geom.difference(unary_union(later)) if later else f.geom

    def components(self, feats: list[Feature] | None = None, touch: float = 0.0) -> dict[int, int]:
        """Same-layer connectivity: fid → component id.

        Judged on the *painted* copper when the layer has clear features: a pad sitting in a clearance
        a clear region cut into a plane is not attached to that plane, even though the two dark
        features overlap on paper (C09 l5: 40 pads in the plane's antipads counted as "a plane reaches
        it" and NfpRemoval kept them; the engineer deletes every one and leaves the clearance).
        Without clear features (or for an explicit ``feats`` subset) it is the plain union of
        overlapping dark features."""
        fs = [f for f in (feats if feats is not None else self.features) if f.polarity_dark and not f.geom.is_empty]
        parent = {f.fid: f.fid for f in fs}

        def find(a: int) -> int:
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        def join(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb

        has_clear = feats is None and any(not f.polarity_dark and not f.geom.is_empty for f in self.features)
        if not has_clear:
            tree = STRtree([f.geom for f in fs])
            for i, f in enumerate(fs):
                g = f.geom.buffer(touch) if touch else f.geom
                for j in tree.query(g, predicate="intersects"):
                    if j != i:
                        join(f.fid, fs[j].fid)
            return {fid: find(fid) for fid in parent}

        painted = self.fold()
        parts = [g for g in (painted.geoms if hasattr(painted, "geoms") else [painted]) if not g.is_empty]
        ptree = STRtree(parts)
        owner: dict[int, int] = {}  # painted part → the first feature found on it
        for f in fs:
            surv = self.painted_geom(f)
            if surv.is_empty or surv.area <= 1e-6:
                continue  # wholly erased: attached to nothing
            g = surv.buffer(touch) if touch else surv
            for j in ptree.query(g, predicate="intersects"):
                if j in owner:
                    join(f.fid, owner[j])
                else:
                    owner[j] = f.fid
        return {fid: find(fid) for fid in parent}

    # ---- transactions ---------------------------------------------------------------------
    def begin(self, op: str, params: dict[str, Any] | None = None) -> ChangeSet:
        if self._cs is not None:
            raise RuntimeError("transaction already open")
        self._cs = ChangeSet(op=op, layer=self.rel, params=dict(params or {}))
        self._cs._snapshot = list(self.features)
        return self._cs

    def commit(self) -> ChangeSet:
        if self._cs is None:
            raise RuntimeError("no open transaction")
        cs, self._cs = self._cs, None
        cs._snapshot = None if not cs.changes else cs._snapshot
        self.history.append(cs)
        return cs

    def revert(self, cs: ChangeSet | None = None) -> None:
        """Undo the open transaction (or the last committed one)."""
        if cs is None:
            cs = self._cs or (self.history.pop() if self.history else None)
        if cs is None:
            return
        if cs._snapshot is not None:
            self.features = list(cs._snapshot)
            self._dirty()
        if self._cs is cs:
            self._cs = None

    def _record(self, change: Change) -> None:
        if self._cs is None:
            raise RuntimeError("mutations must happen inside begin()/commit()")
        self._cs.changes.append(change)

    def _dirty(self) -> None:
        self._tree = None
        self._tree_feats = []

    # ---- mutations ------------------------------------------------------------------------
    def add(self, obj: Any, note: str = "") -> Feature:
        f = Feature(self._next_fid, obj)
        self._next_fid += 1
        self.features.append(f)
        self._record(Change("add", f.fid, None, f.describe(), note))
        self._dirty()
        return f

    def delete(self, f: Feature, note: str = "") -> None:
        self._record(Change("delete", f.fid, f.describe(), None, note))
        self.features = [x for x in self.features if x.fid != f.fid]
        self._dirty()

    def replace(self, f: Feature, new_obj: Any, note: str = "") -> Feature:
        before = f.describe()
        nf = Feature(f.fid, new_obj)
        self.features = [nf if x.fid == f.fid else x for x in self.features]
        self._record(Change("modify", f.fid, before, nf.describe(), note))
        self._dirty()
        return nf

    def replace_aperture(self, f: Feature, aperture: Any, note: str = "") -> Feature:
        """Same object, new aperture (Genesis ``Change Symbol`` / ``Resize``)."""
        o = f.obj
        if isinstance(o, go.Flash):
            new = go.Flash(o.x, o.y, aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        elif isinstance(o, go.Line):
            new = go.Line(o.x1, o.y1, o.x2, o.y2, aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        elif isinstance(o, go.Arc):
            new = go.Arc(o.x1, o.y1, o.x2, o.y2, o.cx, o.cy, o.clockwise, aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        else:
            raise TypeError("surfaces have no aperture")
        return self.replace(f, new, note)

    def set_symbol(self, f: Feature, symbol: Symbol, note: str = "") -> Feature:
        attrs = getattr(f.obj.aperture, "attrs", None)
        return self.replace_aperture(f, symbol.to_aperture(unit=MM, attrs=attrs), note or f"symbol {f.symbol.name if f.symbol else '?'} → {symbol.name}")

    def move(self, f: Feature, dx: float, dy: float, note: str = "") -> Feature:
        o = f.obj
        if isinstance(o, go.Flash):
            new = go.Flash(o.x + dx, o.y + dy, o.aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        elif isinstance(o, go.Line):
            new = go.Line(o.x1 + dx, o.y1 + dy, o.x2 + dx, o.y2 + dy, o.aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        elif isinstance(o, go.Arc):
            new = go.Arc(o.x1 + dx, o.y1 + dy, o.x2 + dx, o.y2 + dy, o.cx + dx, o.cy + dy, o.clockwise, o.aperture, polarity_dark=o.polarity_dark, unit=o.unit, attrs=dict(o.attrs))
        else:
            new = go.Region([(x + dx, y + dy) for x, y in o.outline], list(o.arc_centers) if o.arc_centers else None, unit=o.unit, polarity_dark=o.polarity_dark)
        return self.replace(f, new, note or f"move ({dx:+.4f}, {dy:+.4f})")

    def add_pad(self, x: float, y: float, symbol: Symbol, *, polarity_dark: bool = True, attrs: dict[str, Any] | None = None, note: str = "") -> Feature:
        return self.add(go.Flash(x, y, symbol.to_aperture(unit=MM), polarity_dark=polarity_dark, unit=MM, attrs=dict(attrs or {})), note or f"add {symbol.name}")

    def add_surface(self, geom: BaseGeometry, *, polarity_dark: bool = True, attrs: dict[str, Any] | None = None, note: str = "") -> list[Feature]:
        """A shapely (Multi)Polygon as Region objects. Holes are drawn as *cut-ins* of one contour
        (Gerber spec 4.10.4), never as a second region of opposite polarity — that would erase
        (or paint) everything already inside the hole in painting order. ``attrs`` tags the regions
        (gerbonara's Region.__init__ takes none, so they are set afterwards)."""
        out: list[Feature] = []
        polys = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
        for poly in polys:
            if poly.is_empty or poly.area <= 0 or poly.geom_type != "Polygon":
                continue
            r = go.Region(cutin_ring(poly), unit=MM, polarity_dark=polarity_dark)
            if attrs:
                r.attrs = dict(attrs)
            out.append(self.add(r, note or "add surface"))
        return out

    def replace_surface(self, f: Feature, geom: BaseGeometry, note: str = "") -> list[Feature]:
        """``f`` becomes the Region(s) of ``geom`` *in its own place* in the painting order. Deleting
        and re-adding at the end would paint the new surface over every clear object that came
        after the old one — on a plane layer with LPC cut-outs that fills the cut-outs (first
        real job, L5: +9 700 mm² from resizing the pours)."""
        polys = [g for g in (list(geom.geoms) if hasattr(geom, "geoms") else [geom]) if g.geom_type == "Polygon" and not g.is_empty and g.area > 0]
        if self.by_fid(f.fid) is None:
            raise ValueError(f"replace_surface: feature {f.fid} ({f.kind}) is no longer on layer {self.rel!r}")
        if not polys:
            self.delete(f, note or "surface replaced by nothing")
            return []
        dark = f.polarity_dark
        first = self.replace(f, go.Region(cutin_ring(polys[0]), unit=MM, polarity_dark=dark), note or "replace surface")
        out = [first]
        at = next(i for i, x in enumerate(self.features) if x.fid == first.fid) + 1
        for poly in polys[1:]:
            nf = Feature(self._next_fid, go.Region(cutin_ring(poly), unit=MM, polarity_dark=dark))
            self._next_fid += 1
            self.features.insert(at, nf)
            at += 1
            self._record(Change("add", nf.fid, None, nf.describe(), note or "replace surface (extra piece)"))
            out.append(nf)
        self._dirty()
        return out

    # ---- output ---------------------------------------------------------------------------
    def to_gerber_file(self) -> GerberFile:
        gf = GerberFile(
            objects=[f.obj for f in self.features], comments=list(self.gf.comments or []), import_settings=self.gf.import_settings,
            original_path=self.gf.original_path, generator_hints=list(self.gf.generator_hints or []), layer_hints=list(self.gf.layer_hints or []),
            file_attrs=dict(self.gf.file_attrs or {}),
        )  # fmt: skip
        return gf

    def to_bytes(self, settings: Any | None = None) -> bytes:
        gf = self.to_gerber_file()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            data = gf.write_to_bytes(settings=settings or self.gf.import_settings)
        text = data.decode("utf-8", errors="replace")
        import re

        text = re.sub(r"^(G7[45])$", r"\1*", text, flags=re.MULTILINE)
        return text.encode("utf-8")

    def save(self, path: Path, settings: Any | None = None) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.to_bytes(settings))
        return path

    def stats(self) -> dict[str, int]:
        c = {"pad": 0, "line": 0, "arc": 0, "surface": 0}
        for f in self.features:
            c[f.kind] += 1
        return c


def cutin_ring(poly: Polygon) -> list[tuple[float, float]]:
    """One closed contour for a polygon with holes: the exterior (CCW) with every interior (CW)
    spliced in through a zero-width slit to a vertex of the contour built so far. Re-reading such
    a contour with the painting model gives back exactly the polygon (the slit has no area).

    A slit must not cross another hole, the exterior, its own ring or an earlier slit: any
    crossing makes the contour self-intersect, and what a reader gives back for that is
    undefined (C12 L2: a 60 mm² triangle of plane bounded by slits through three antipad rings
    came back as a hole; C09 L2 round 2: a 4 mm slit cut a 37 mm one and shapely dropped the
    49 mm² wedge between them). Touching is fine (two slits may leave the same vertex);
    crossing, overlapping and T-joints are not.

    Holes are spliced closest-to-the-contour first (the hole nearest the contour always has a
    clear straight slit to it: anything in the way would be nearer), and every vertex pair is a
    candidate, nearest first — the old "nearest 4096 pairs of the holes in file order" ran out
    of clear candidates on a 153-hole plane and fell back to a crossing slit."""
    import numpy as np
    from shapely import LinearRing, LineString, MultiPoint, Point, STRtree
    from shapely.geometry.polygon import orient

    poly = orient(poly, sign=1.0)  # exterior CCW, interiors CW
    ring = [tuple(map(float, c)) for c in poly.exterior.coords[:-1]]
    holes = [[tuple(map(float, c)) for c in h.coords[:-1]] for h in poly.interiors]
    holes = [h for h in holes if len(h) >= 3]
    if not holes:
        return ring
    exterior = LinearRing(poly.exterior.coords)
    hole_rings = [LinearRing(h + [h[0]]) for h in holes]
    tree = STRtree([exterior] + hole_rings)
    slits: list[LineString] = []
    stree: STRtree | None = None

    def only_touches_at(x, pts: list[Point]) -> bool:
        """The intersection ``x`` is empty or just the allowed points."""
        if x.is_empty:
            return True
        if x.geom_type == "Point":
            return any(x.equals_exact(p, 1e-9) for p in pts)
        if x.geom_type == "MultiPoint":
            return all(any(q.equals_exact(p, 1e-9) for p in pts) for q in x.geoms)
        return False

    def clear(slit: LineString, k: int, start: Point, end: Point) -> bool:
        for r in tree.query(slit, predicate="intersects"):
            r = int(r)
            allowed = [end] if r == k + 1 else [start]
            if not only_touches_at(slit.intersection(tree.geometries[r]), allowed):
                return False
        if stree is not None:
            for idx in stree.query(slit, predicate="intersects"):
                # only a shared end point is allowed: a crossing, an overlap or an end landing on
                # the other slit's middle all make the contour self-intersect
                if not only_touches_at(slit.intersection(slits[int(idx)]), [start, end]):
                    return False
        return True

    # closest-to-the-exterior first; the nearest-vertex search below then never has to reach past
    # a hole that is still to come
    todo = sorted(range(len(holes)), key=lambda k: exterior.distance(hole_rings[k]))
    for k in todo:
        hpts = holes[k]
        rp = np.asarray(ring)
        hp = np.asarray(hpts)
        d = ((rp[:, None, 0] - hp[None, :, 0]) ** 2 + (rp[:, None, 1] - hp[None, :, 1]) ** 2)
        order = np.argsort(d, axis=None)
        i = j = 0
        for flat in order:
            i, j = divmod(int(flat), len(hpts))
            slit = LineString([ring[i], hpts[j]])
            if slit.length < 1e-9:
                break
            if clear(slit, k, Point(ring[i]), Point(hpts[j])):
                break
        loop = hpts[j:] + hpts[:j] + [hpts[j]]  # around the hole, back to its start
        ring = ring[: i + 1] + loop + ring[i:]
        slits.append(LineString([ring[i], hpts[j]]))
        stree = STRtree(slits)
    return ring


def xor_area(a: BaseGeometry, b: BaseGeometry) -> float:
    return a.symmetric_difference(b).area


def distance_mm(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.dist(a, b)
