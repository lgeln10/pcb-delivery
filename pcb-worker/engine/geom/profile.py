"""Board profile extraction from an outline Gerber layer.

The outline layer is normally stroked centre-lines (Lines/Arcs with a thin round aperture);
some tools emit a filled Region instead. We polygonise the centre-line network (after a small
snap so that near-miss endpoints still close) and take the largest ring as the profile.
"""

from __future__ import annotations

import itertools
import math
import warnings
from dataclasses import dataclass, field

from gerbonara import graphic_objects as go
from gerbonara.utils import MM, approximate_arc
from shapely import set_precision
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import linemerge, polygonize, unary_union
from shapely.strtree import STRtree

from engine.geom.from_gerbonara import DEFAULT_MAX_ERROR_MM, arc_poly_points

SNAP_MM = 0.01


def _stroke_width(obj) -> float | None:
    ap = getattr(obj, "aperture", None)
    if ap is None:
        return None
    try:
        return float(ap.equivalent_width(MM))
    except Exception:  # noqa: BLE001 - macro apertures without a meaningful width
        return None


@dataclass
class OutlineLinework:
    lines: list[LineString] = field(default_factory=list)
    regions: list[Polygon] = field(default_factory=list)
    widths: set[float] = field(default_factory=set)
    n_objects: int = 0
    line_widths: list[float] = field(default_factory=list)  # stroke width of each entry in ``lines`` (0 = unknown)


def outline_linework(gf, max_error: float = DEFAULT_MAX_ERROR_MM) -> OutlineLinework:
    lw = OutlineLinework()
    for o in gf.objects:
        lw.n_objects += 1

        def mm(v: float, unit=o.unit) -> float:
            return float(MM(v, unit))

        if isinstance(o, go.Arc):
            x1, y1, x2, y2 = mm(o.x1), mm(o.y1), mm(o.x2), mm(o.y2)
            cx, cy = x1 + mm(o.cx), y1 + mm(o.cy)
            if math.dist((x1, y1), (cx, cy)) < 1e-9:
                pts = [(x1, y1), (x2, y2)]
            else:
                pts = list(approximate_arc(cx, cy, x1, y1, x2, y2, o.clockwise, max_error=max_error))
            if len(pts) >= 2:
                lw.lines.append(LineString(pts))
                lw.line_widths.append(_stroke_width(o) or 0.0)
        elif isinstance(o, go.Line):
            x1, y1, x2, y2 = mm(o.x1), mm(o.y1), mm(o.x2), mm(o.y2)
            if math.dist((x1, y1), (x2, y2)) > 1e-9:
                lw.lines.append(LineString([(x1, y1), (x2, y2)]))
                lw.line_widths.append(_stroke_width(o) or 0.0)
        elif isinstance(o, go.Region):
            for prim in o.to_primitives(unit=MM):
                pts = arc_poly_points(prim, max_error)
                if len(pts) >= 3:
                    poly = Polygon(pts)
                    if poly.area > 0:
                        lw.regions.append(poly if poly.is_valid else poly.buffer(0))
            continue
        else:  # flashes are not outline geometry
            continue
        w = _stroke_width(o)
        if w is not None:
            lw.widths.add(round(w, 4))
    return lw


def outline_rings(gf, snap_mm: float = SNAP_MM) -> list[Polygon]:
    """Closed rings found in the outline layer, largest first."""
    lw = outline_linework(gf)
    rings: list[Polygon] = list(lw.regions)
    if lw.lines:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            merged = unary_union([set_precision(line, snap_mm) for line in lw.lines])
        rings.extend(p for p in polygonize(merged) if p.area > 0)
    rings.sort(key=lambda p: p.area, reverse=True)
    return rings


@dataclass
class ProfileResult:
    profile: Polygon | None
    widths: set[float]
    n_rings: int
    n_objects: int
    reason: str = ""
    stray: list[LineString] = field(default_factory=list)  # linework that is part of no ring
    attached_rings: int = 0  # rings merged into the board: rails / 工艺边, the other units of a set, spec rails
    drawn_holes: list[tuple[float, float, float]] = field(default_factory=list)  # small circles inside the board: (x, y, dia) to drill, not cut-outs
    rails: list[Polygon] = field(default_factory=list)  # rails (drawn by the customer or added to reach the ordered set size): copper fill / V-cut lines need them
    rail_lines: list[list[tuple[float, float]]] = field(default_factory=list)  # every boundary two abutting pieces share (rail ↔ board, unit ↔ unit): the V-cut / score lines
    units: list[Polygon] = field(default_factory=list)  # the repeated unit boards of a set (1 = a single board)
    set_info: dict | None = None  # {"nx", "ny", "unit_w", "unit_h", "rail_top_mm", …} for a multi-unit set / spec rails
    junk_rings: int = 0  # rings that overlap the board (drawings crossing the outline) or frame it — ignored
    edge_notches: list[tuple[float, float, float]] = field(default_factory=list)  # (x, y, dia): a hole drawn as an open arc because it breaks through the board edge — routed as a full circle, mask opened, not drilled
    sketches: list[LineString] = field(default_factory=list)  # thin open linework well inside the board that touches nothing: a drawing (component sketch, a note) the factory deletes
    drawn_slots: list[tuple[list[tuple[float, float]], float]] = field(default_factory=list)  # (centreline points, width): a stroke ≥ min_slot wide drawn on the outline / keep-out layer is a routed NPTH slot (2×2 Protel job: "KEEPOUT 层上的孔及开槽为非金属孔")


DRAWN_HOLE_MAX_MM = 6.6  # a circle up to the biggest drill bit is a hole drawn on the outline layer; larger rounds are routed cut-outs
TOUCH_MM = 0.05
SKETCH_CLEAR_MM = 1.0  # open linework farther than this from every edge/cut-out and not nearly closed is a sketch, not a slot
NOTCH_REACH_MM = 0.5  # an arc's circle within this of the board edge is a notch breaking through the edge
ABUT_MM = 0.5  # two rings sharing at least this much boundary abut (V-cut neighbours); a point contact does not count


def _touch_line(a: Polygon, b: Polygon, snap: Polygon | None = None) -> list[list[tuple[float, float]]]:
    """Straight stretches of boundary ``a`` and ``b`` share (the score line between two abutting
    pieces), as point lists on the shared edge. ``snap`` = the piece whose edge *is* the score
    line (the unit board: the factory scores on the board edge even when the customer's rail
    rectangle overlaps it by 0.02); without it the line runs midway between the two boundaries."""
    if a.distance(b) > TOUCH_MM:
        return []
    shared = linemerge([g for g in _lines_of(a.boundary.buffer(TOUCH_MM).intersection(b.boundary)) if g.length > ABUT_MM])
    out = []
    for g in _lines_of(shared):
        if g.length <= ABUT_MM:
            continue
        pts = []
        for x, y in g.coords:
            if snap is not None:
                q = snap.exterior.interpolate(snap.exterior.project(Point(x, y)))
                pts.append((round(q.x, 4), round(q.y, 4)))
            else:
                q = a.exterior.interpolate(a.exterior.project(Point(x, y)))
                pts.append((round((x + q.x) / 2, 4), round((y + q.y) / 2, 4)))
        out.append(pts)
    return out


def _full_width(lines: list[list[tuple[float, float]]], bounds: tuple[float, float, float, float]) -> list[list[tuple[float, float]]]:
    """A V-cut is a straight score across the whole panel: every axis-aligned shared edge is
    extended to the board's extent and collinear pieces (the three column segments of one row
    boundary) collapse into one line. Oblique edges are kept as they are."""
    x0, y0, x1, y1 = bounds
    out: list[list[tuple[float, float]]] = []
    seen: set[tuple[str, float]] = set()
    for ln in lines:
        (ax, ay), (bx, by) = ln[0], ln[-1]
        if len(ln) > 2:  # the shared edge may follow the board's corner radius for a few points: take the longest straight run
            runs = sorted(itertools.pairwise(ln), key=lambda s: -math.dist(s[0], s[1]))
            (ax, ay), (bx, by) = runs[0]
        if abs(ay - by) < 0.02 and abs(ax - bx) > ABUT_MM:
            key = ("h", round((ay + by) / 2, 2))
            if key not in seen:
                seen.add(key)
                out.append([(round(x0, 4), key[1]), (round(x1, 4), key[1])])
        elif abs(ax - bx) < 0.02 and abs(ay - by) > ABUT_MM:
            key = ("v", round((ax + bx) / 2, 2))
            if key not in seen:
                seen.add(key)
                out.append([(key[1], round(y0, 4)), (key[1], round(y1, 4))])
        else:
            out.append(ln)
    return out


def _notch_rail_ends(body: BaseGeometry, rails: list[Polygon], rail_lines: list[list[tuple[float, float]]],
                     notch: tuple[float, float, float]) -> tuple[BaseGeometry, list[Polygon]]:
    """Factory rule (per profile ``layer.rail_vcut_notch_mm`` = [length, depth, end radius]): where a
    V-cut line runs out through a rail, the rail is notched ``length`` in from the panel edge and
    ``depth`` from the score line — the blade's run-out (6-layer job: 3 × 1.5 square; 3×3 job:
    3.7 × 1.5 with a half-round end; the 2×2 job has none). Cut out of the profile and the rail."""
    length, depth, radius = float(notch[0]), float(notch[1]), float(notch[2]) if len(notch) > 2 else 0.0
    if length <= 0 or depth <= 0:
        return body, rails
    x0, y0, x1, y1 = body.bounds
    cuts: list[BaseGeometry] = []
    for ln in rail_lines:
        (ax, ay), (bx, by) = ln[0], ln[-1]
        horizontal = abs(ay - by) < 0.02
        vertical = abs(ax - bx) < 0.02
        if not (horizontal or vertical):
            continue
        for end in (ln[0], ln[-1]):
            ex, ey = end
            # only ends on the panel's outer edge
            if horizontal and not (abs(ex - x0) < 0.05 or abs(ex - x1) < 0.05):
                continue
            if vertical and not (abs(ey - y0) < 0.05 or abs(ey - y1) < 0.05):
                continue
            inward = 1.0 if (horizontal and abs(ex - x0) < 0.05) or (vertical and abs(ey - y0) < 0.05) else -1.0
            for side in (1.0, -1.0):  # which side of the score line the rail is on
                probe = Point(ex + inward * 0.3, ey + side * 0.3) if horizontal else Point(ex + side * 0.3, ey + inward * 0.3)
                if not any(r.contains(probe) for r in rails):
                    continue
                if horizontal:
                    a = (ex - inward, ey + side * depth / 2)
                    b = (ex + inward * (length - (depth / 2 if radius > 0 else 0.0)), ey + side * depth / 2)
                else:
                    a = (ex + side * depth / 2, ey - inward)
                    b = (ex + side * depth / 2, ey + inward * (length - (depth / 2 if radius > 0 else 0.0)))
                cut = LineString([a, b]).buffer(depth / 2, cap_style="round" if radius > 0 else "flat")
                cuts.append(cut)
    if not cuts:
        return body, rails
    cut_all = unary_union(cuts)
    body = body.difference(cut_all).buffer(0)
    rails = [q for r in rails for q in _polys_of(r.difference(cut_all)) if q.area > 0.01]
    return body, rails


def _polys_of(g: BaseGeometry) -> list[Polygon]:
    if isinstance(g, Polygon):
        return [g]
    return [q for q in getattr(g, "geoms", []) if isinstance(q, Polygon)]


def _same_size(a: Polygon, b: Polygon, tol: float = 0.1) -> bool:
    ab, bb = a.bounds, b.bounds
    return abs((ab[2] - ab[0]) - (bb[2] - bb[0])) <= tol and abs((ab[3] - ab[1]) - (bb[3] - bb[1])) <= tol and abs(a.area - b.area) <= 0.02 * max(a.area, b.area)


def _spec_rails(body: BaseGeometry, set_size_mm: tuple[float, float] | None) -> tuple[list[Polygon], dict]:
    """Strips that bring the board up to the ordered set size (拼板尺寸, rails included): the missing
    width / height is split equally on both sides — what the factory did on the 3×3 job (100.8
    ordered, 94.8 drawn → 3 mm rails top and bottom)."""
    if not set_size_mm:
        return [], {}
    x0, y0, x1, y1 = body.bounds
    w, h = x1 - x0, y1 - y0
    sw, sh = float(set_size_mm[0]), float(set_size_mm[1])
    info: dict = {"set_w": sw, "set_h": sh, "drawn_w": round(w, 3), "drawn_h": round(h, 3)}
    strips: list[Polygon] = []
    if sw - w < -0.5 or sh - h < -0.5:
        info["oversize"] = True  # drawn bigger than ordered: nothing to add, the engineer decides
        return [], info
    ex, ey = sw - w, sh - h
    if ey > 0.5:
        r = ey / 2
        strips.append(Polygon([(x0, y0 - r), (x1, y0 - r), (x1, y0), (x0, y0)]))
        strips.append(Polygon([(x0, y1), (x1, y1), (x1, y1 + r), (x0, y1 + r)]))
        info["rail_top_mm"] = info["rail_bottom_mm"] = round(r, 3)
    if ex > 0.5:
        r = ex / 2
        yy0, yy1 = (y0 - ey / 2, y1 + ey / 2) if ey > 0.5 else (y0, y1)
        strips.append(Polygon([(x0 - r, yy0), (x0, yy0), (x0, yy1), (x0 - r, yy1)]))
        strips.append(Polygon([(x1, yy0), (x1 + r, yy0), (x1 + r, yy1), (x1, yy1)]))
        info["rail_left_mm"] = info["rail_right_mm"] = round(r, 3)
    return strips, info


def _circle_of(ring: Polygon) -> tuple[float, float, float] | None:
    x0, y0, x1, y1 = ring.bounds
    w, h = x1 - x0, y1 - y0
    d = max(w, h)
    if d <= 0 or d > DRAWN_HOLE_MAX_MM or abs(w - h) > 0.05 * d:
        return None
    if ring.area < 0.85 * math.pi * (d / 2) ** 2:
        return None
    c = ring.centroid
    return round(c.x, 4), round(c.y, 4), round(d, 3)


def _arc_circle(ln: LineString) -> tuple[float, float, float] | None:
    """(cx, cy, r) when the polyline is an arc of at least a half circle (a hole drawn open
    towards the board edge), else None. Least-squares circle through the vertices."""
    pts = list(ln.coords)
    if len(pts) < 6:
        return None
    n = len(pts)
    sx = sum(x for x, _ in pts) / n
    sy = sum(y for _, y in pts) / n
    u = [x - sx for x, _ in pts]
    v = [y - sy for _, y in pts]
    suu, svv, suv = sum(a * a for a in u), sum(b * b for b in v), sum(a * b for a, b in zip(u, v, strict=True))
    suuu, svvv = sum(a**3 for a in u), sum(b**3 for b in v)
    suvv, svuu = sum(a * b * b for a, b in zip(u, v, strict=True)), sum(b * a * a for a, b in zip(u, v, strict=True))
    det = suu * svv - suv * suv
    if abs(det) < 1e-12:
        return None
    r1, r2 = (suuu + suvv) / 2, (svvv + svuu) / 2
    uc, vc = (r1 * svv - r2 * suv) / det, (suu * r2 - suv * r1) / det
    cx, cy = sx + uc, sy + vc
    r = math.sqrt(uc * uc + vc * vc + (suu + svv) / n)
    if r <= 0 or 2 * r > DRAWN_HOLE_MAX_MM:
        return None
    if max(abs(math.dist(p, (cx, cy)) - r) for p in pts) > max(0.02, 0.02 * r):
        return None
    if ln.length < math.pi * r * 0.95:  # less than a half circle is a fillet / a construction arc
        return None
    return cx, cy, r


def classify_stray(stray: list[LineString], profile: Polygon, units: list[Polygon] | None = None, snap_mm: float = SNAP_MM,
                   widths: list[float] | None = None, min_slot_mm: float = 0.5) -> tuple[list[LineString], list[tuple[float, float, float]], list[LineString], list[tuple[list[tuple[float, float]], float]]]:
    """Split the dangling outline linework into (still stray, edge notches, sketches).

    * edge notch — an open arc (≥ half circle) whose circle reaches the board edge: a hole the
      customer drew open because it breaks through the edge (2×2 Protel job: ⌀3.5 three-quarter
      arcs on the keep-out layer at each unit's edge). The factory routs it as a full circle on
      the outline and opens the mask; it is not drilled.
    * slot — open linework deep inside the board (> SKETCH_CLEAR_MM from every edge/cut-out,
      ends far apart) drawn with a stroke ≥ ``min_slot_mm`` wide: a routed NPTH slot of that
      width (2×2 Protel job: 1 mm keep-out strokes, the customer's sheet says "KEEPOUT 层上的孔及
      开槽为非金属孔"; the factory routs them, outlines them on gko / masks, pre-drills the ends).
    * sketch — the same but thinner than ``min_slot_mm``: a component sketch / note drawn on the
      outline or keep-out layer. The factory deletes it (p112); no EQ.
    * everything else stays stray (a slot drawn on the outline layer, an unfinished cut-out)."""
    if not stray:
        return [], [], [], []
    widths = list(widths) if widths else [0.0] * len(stray)
    bnd = unary_union([profile.boundary] + [u.boundary for u in units or []])  # the units' edges (V-cut lines) count as edges too
    rest: list[LineString] = []
    notches: list[tuple[float, float, float]] = []
    sketches: list[LineString] = []
    slots: list[tuple[list[tuple[float, float]], float]] = []
    # merge per stroke width: a slot keeps its width, and lines of different widths are different things
    groups: dict[float, list[LineString]] = {}
    for ln, w in zip(stray, widths, strict=False):
        groups.setdefault(round(w, 3), []).append(ln)
    for w, lines in groups.items():
        with warnings.catch_warnings():  # an arc exported in two pieces meets itself only to 1e-8: snap first
            warnings.simplefilter("ignore")
            noded = unary_union([set_precision(ln, snap_mm) for ln in lines])
            merged = linemerge(list(getattr(noded, "geoms", [noded])))
        for ln in getattr(merged, "geoms", [merged]):
            if not isinstance(ln, LineString) or ln.is_empty:
                continue
            c = _arc_circle(ln)
            if c is not None:
                cx, cy, r = c
                if Point(cx, cy).buffer(r).distance(bnd) <= NOTCH_REACH_MM:
                    notches.append((round(cx, 4), round(cy, 4), round(2 * r, 3)))
                    continue
            pts = list(ln.coords)
            gap = math.dist(pts[0], pts[-1])
            inside = profile.contains(ln) and ln.distance(bnd) > SKETCH_CLEAR_MM and gap >= 0.2 * ln.length
            if inside and w >= min_slot_mm:
                slots.append(([(round(x, 4), round(y, 4)) for x, y in pts], round(w, 3)))
                continue
            if inside:
                sketches.append(ln)
                continue
            rest.append(ln)
    return rest, notches, sketches, slots


def stray_widths(lw: OutlineLinework, stray: list[LineString]) -> list[float]:
    """Stroke width of each stray line (by identity in ``lw.lines``)."""
    wid = {id(ln): w for ln, w in zip(lw.lines, lw.line_widths, strict=False)}
    return [wid.get(id(ln), 0.0) for ln in stray]


def stray_segments(lw: OutlineLinework, rings: list[Polygon], snap_mm: float = SNAP_MM) -> list[LineString]:
    """Outline lines/arcs that lie on no closed ring: a slot drawn on the outline layer, a
    dangling construction line, an unfinished cut-out. ``polygonize`` drops them silently, so
    the profile still closes — but Genesis would rout them (p112/p170) and the drill stage
    would never see the slot."""
    if not lw.lines:
        return []
    boundary = unary_union([r.boundary for r in rings]).buffer(snap_mm * 2) if rings else None
    out: list[LineString] = []
    for ln in lw.lines:
        if ln.length < snap_mm:
            continue
        if boundary is not None and boundary.contains(ln):
            continue
        out.append(ln)
    return out


def extract_profile(gf, set_size_mm: tuple[float, float] | None = None, vcut_notch: tuple[float, float, float] | None = None, min_slot_mm: float = 0.5) -> ProfileResult:
    """The board Profile from an outline layer.

    Rings that abut each other (shared boundary ≥ ``ABUT_MM``) are one board: the customer's rails
    glued to the unit, or the units of a set drawn side by side (2×2 with a frame, 3×3 rows
    V-cut together). Rings of the same size as the main ring that stand apart (columns separated
    by a routed gap) are the other units of the same set; ``set_size_mm`` (拼板尺寸, rails included)
    then adds the rails that join them. Rings inside another ring are its cut-outs, small circles
    are drawn holes, rings that merely overlap the board are drawings and ignored."""
    lw = outline_linework(gf)
    rings = outline_rings(gf)
    if not rings:
        return ProfileResult(None, lw.widths, 0, lw.n_objects, "outline does not close", stray_segments(lw, []))
    # drawings that cross the board (a slot drawn over the units, a dimension box) come out of
    # polygonize as rings overlapping real ones: a ring mostly covered by *other* rings is junk
    big = [r for r in rings if r.area > 1.0]
    tree = STRtree(big)
    junk_set: set[int] = set()
    for i, r in enumerate(big):
        others = []
        for j in tree.query(r, predicate="intersects").tolist():
            o = big[j]
            if o is r or Polygon(o.exterior.coords).contains(r) or Polygon(r.exterior.coords).contains(o):
                continue
            others.append(o)
        if others and unary_union(others).intersection(r).area > 0.5 * r.area:
            junk_set.add(id(r))
    junk = len(junk_set)
    candidates = [r for r in rings if id(r) not in junk_set]
    if not candidates:
        candidates = rings
    main = candidates[0]
    shell = Polygon(main.exterior.coords)
    # top-level pieces: not inside another ring, not a frame around the main ring.
    # Every candidate is tested against the pieces accepted so far; done as two scans over the whole
    # list that was O(n²) — 1.68 M pair tests, each building a shell Polygon, on the 12-layer test
    # board's dimension-drawing layer (cProfile: 68 of extract_profile's 85 s). The shells are built
    # once and the pieces are asked through STRtrees; the predicates are the same, so are the answers.
    cand = [r for r in candidates[1:] if r.area > 1e-6]
    cand_shell = [Polygon(r.exterior.coords) for r in cand]
    shell_tree = STRtree(cand_shell) if cand else None
    ring_tree = STRtree(cand) if cand else None
    accepted: set[int] = set()  # indices into cand that became pieces
    pieces: list[Polygon] = [main]
    for i, r in enumerate(cand):
        rp = r.representative_point()
        if shell.contains(rp) or any(int(j) in accepted for j in shell_tree.query(rp, predicate="within")):
            continue  # a cut-out / drawn hole of a piece: comes back as an interior ring of the union
        if cand_shell[i].contains(shell):
            junk += 1  # a frame drawn around the board (dimensions, panel frame)
            continue
        if r.intersection(main).area > 0.02 * min(r.area, main.area) or any(
            int(j) in accepted and r.intersection(cand[j]).area > 0.02 * min(r.area, cand[j].area)
            for j in ring_tree.query(r, predicate="intersects")
        ):
            junk += 1  # still overlapping something that survived: a drawing crossing the outline
            continue
        accepted.add(i)
        pieces.append(r)
    # a face enclosed on every side by other faces is the void between them (the routed gap between
    # two columns closed off by the rails), not a piece of board: it must become a hole of the union
    if len(pieces) > 1:
        # buffer the union's boundary once — it was inside the comprehension, i.e. once per piece,
        # and a mechanical layer full of dimension drawings has hundreds of pieces (12-layer Altium
        # test board: 80+ minutes in this one line)
        outer = unary_union(pieces).buffer(0).boundary.buffer(TOUCH_MM)
        voids = [p for p in pieces[1:] if p.boundary.intersection(outer).length < ABUT_MM]
        if voids:
            junk += len(voids)
            pieces = [p for p in pieces if p not in voids]
    # connectivity by abutting boundaries (transitive), starting from the main ring
    n = len(pieces)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # only pairs whose envelopes come within TOUCH_MM can abut: ask the tree instead of testing every
    # pair (the all-pairs loop was the other half of the 12-layer test board's 80 minutes)
    ptree = STRtree(pieces)
    for i in range(n):
        for j in ptree.query(pieces[i].buffer(TOUCH_MM), predicate="intersects").tolist():
            if j <= i:
                continue
            if pieces[i].distance(pieces[j]) <= TOUCH_MM and _touch_line(pieces[i], pieces[j]):
                parent[find(i)] = find(j)
    root = find(0)
    members = [p for i, p in enumerate(pieces) if find(i) == root]
    # units: the main ring and every member of its size; everything else the customer drew touching
    # them is a rail. Rings standing apart but of the unit size are the other columns / rows of the set.
    units = [p for p in members if _same_size(p, main)]
    unit_size = (round(main.bounds[2] - main.bounds[0], 2), round(main.bounds[3] - main.bounds[1], 2))
    apart = [p for i, p in enumerate(pieces) if find(i) != root and _same_size(p, main)]
    if apart:
        members += apart
        units += apart
    attached = [p for p in members if p is not main]
    body: BaseGeometry = unary_union(members).buffer(0) if attached else main
    strips, set_info = _spec_rails(body, set_size_mm)
    if strips:
        body = unary_union([body, *strips]).buffer(0)
    if isinstance(body, MultiPolygon):
        body = max(body.geoms, key=lambda p: p.area)  # pieces that never got joined stay out
    # V-cut / score lines: every boundary two abutting members share, plus the inner edge of each spec rail
    rail_lines: list[list[tuple[float, float]]] = []
    for i, a in enumerate(members):
        for b in members[i + 1 :]:
            au, bu = a in units, b in units
            rail_lines += _touch_line(a, b, snap=a if au and not bu else b if bu and not au else None)
    if strips:
        bx0, by0, _bx1, _by1 = unary_union(members).bounds
        for st in strips:
            x0, y0, x1, y1 = st.bounds
            if y1 - y0 < x1 - x0:  # horizontal strip: the edge touching the units is the score line
                yy = y1 if abs(y1 - by0) < 1e-6 else y0
                rail_lines.append([(round(x0, 4), round(yy, 4)), (round(x1, 4), round(yy, 4))])
            else:
                xx = x1 if abs(x1 - bx0) < 1e-6 else x0
                rail_lines.append([(round(xx, 4), round(y0, 4)), (round(xx, 4), round(y1, 4))])
    rail_lines = _full_width(rail_lines, body.bounds)
    rails = [p for p in members if p not in units] + strips
    if vcut_notch and rails:
        body, rails = _notch_rail_ends(body, rails, rail_lines, vcut_notch)
    # interiors: small circles are holes drawn on the outline layer (p113: 分孔图/外形层上有、钻孔层
    # 没有的孔要复制到钻孔层), anything else is a routed cut-out kept as a hole of the profile
    holes = []
    drawn: list[tuple[float, float, float]] = []
    for ring in body.interiors:
        poly = Polygon(ring.coords)
        if poly.area <= 1e-6:
            continue
        c = _circle_of(poly)
        if c is not None:
            drawn.append(c)
        else:
            holes.append(ring.coords)
    profile = Polygon(body.exterior.coords, holes)
    if not profile.is_valid:
        profile = profile.buffer(0)
    if len(units) > 1 or strips:
        xs = sorted({round(u.bounds[0], 1) for u in units})
        ys = sorted({round(u.bounds[1], 1) for u in units})
        set_info.update({"nx": len(xs), "ny": len(ys), "units": len(units), "unit_w": unit_size[0], "unit_h": unit_size[1],
                         "gap_x": round(min((b - a for a, b in itertools.pairwise(xs)), default=unit_size[0]) - unit_size[0], 2),
                         "gap_y": round(min((b - a for a, b in itertools.pairwise(ys)), default=unit_size[1]) - unit_size[1], 2),
                         "customer_rails": len(members) - len(units), "spec_rails": len(strips)})  # fmt: skip
    raw_stray = stray_segments(lw, rings)
    stray, notches, sketches, slots = classify_stray(raw_stray, profile, units, widths=stray_widths(lw, raw_stray), min_slot_mm=min_slot_mm)
    return ProfileResult(profile, lw.widths, len(rings), lw.n_objects, stray=stray, attached_rings=len(attached) + len(strips), drawn_holes=drawn,
                         rails=[Polygon(r.exterior.coords) for r in rails], rail_lines=rail_lines, units=units, set_info=set_info or None, junk_rings=junk,
                         edge_notches=notches, sketches=sketches, drawn_slots=slots)  # fmt: skip


def _lines_of(g: BaseGeometry) -> list[LineString]:
    if g.is_empty:
        return []
    if isinstance(g, LineString):
        return [g]
    return [x for x in getattr(g, "geoms", []) if isinstance(x, LineString) and not x.is_empty]


def largest_polygon(geom: BaseGeometry) -> Polygon | None:
    if geom.is_empty:
        return None
    if isinstance(geom, Polygon):
        return geom
    if isinstance(geom, MultiPolygon):
        return max(geom.geoms, key=lambda p: p.area)
    polys = [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    return max(polys, key=lambda p: p.area) if polys else None
