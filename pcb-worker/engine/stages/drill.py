"""Stage ``drill``: parse Excellon, derive plating / attributes, oversize, write drill tape,
and run the six Genesis "Drill Checks".

Rules referenced (knowledge/rules/drill.yaml, 《CAM工程技能培训》第5章):
- drill.verify.size_and_count (p113)   核对孔径大小及孔数
- drill.attribute.* (p114)             plated / non_plated / via
- drill.oversize.* (p114)              plated +0.15 / non_plated +0.05 / via 0
- drill.check.* (p116-117)             Hole Size / Extra Holes / Hole Separation /
                                        Power-Ground Shorts / Missing Holes / NPTH to Rout
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely import from_wkb
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from engine.geom.layers import fold_cached, open_camfile, safe_stem
from engine.geom.svg import iter_polygons
from engine.ingest.classify import DRILL_TYPES
from engine.model.report import Fix, Location, ReportItem, StageReport, derive_status, summarize
from engine.output.excellon_writer import DrillTool, write_excellon
from engine.pipeline.context import JobContext

ITEM_CAP = 30  # per check: individual items before we collapse into a summary item


@dataclass
class Hole:
    x: float
    y: float
    dia: float
    plated: bool | None
    file: str
    slot: bool = False
    x2: float | None = None
    y2: float | None = None
    tool: str = ""
    attribute: str = "unknown"  # via | plated | non_plated | unknown
    drill_dia: float = 0.0  # the bit that drills it (finished dia + oversize / order override); 0 = not assigned yet

    def geom(self) -> BaseGeometry:
        if self.slot and self.x2 is not None:
            return LineString([(self.x, self.y), (self.x2, self.y2)]).buffer(self.dia / 2)
        return Point(self.x, self.y).buffer(self.dia / 2)

    def center(self) -> Point:
        if self.slot and self.x2 is not None:
            return Point((self.x + self.x2) / 2, (self.y + self.y2) / 2)
        return Point(self.x, self.y)


@dataclass
class ToolRow:
    tool: str
    file: str
    dia_mm: float
    plated: bool | None
    slot: bool
    count: int = 0
    attribute: str = "unknown"
    oversize_mm: float = 0.0
    drill_dia_mm: float = 0.0
    holes: list[Hole] = field(default_factory=list)
    second: bool = False  # 二钻（电镀后再钻的 NPTH），写到 *_2nd 钻带
    rect: bool = False  # 客户钻孔报告里标 Rectangle 的孔 → 锣（不进钻带）
    override: bool = False  # 钻嘴由订单指定（order_spec.drill_overrides）：不套预大/预钻规则
    outer_pad_mm: float = 0.0  # 订单指定：这些孔的外层焊盘做到这么大（压接/压铆孔；TerminalPad）
    rout_circle_mm: float = 0.0  # 订单指定：内锣带上在孔位画这么大的圆（第一块真板：15 个压接孔各一个 ⌀5）
    rout_shape: dict | None = None  # 圆之外的锣形：{kind: plum, teeth: 8, inner_dia_mm: 4.35}（C09 压接孔是 8 齿梅花，不是圆）
    note: str = ""  # 工厂规则说明（塞孔 / 订单指定 …）
    source_dia_mm: float = 0.0  # the customer's finished size when a rule changed dia_mm (via_min): the panel copy still carries this tool

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("holes")
        return d


# ---------------------------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------------------------
_TF_PLATED = re.compile(r"TF\.FileFunction,(Plated|NonPlated)", re.IGNORECASE)


def file_level_plating(entry: dict[str, Any], comments: list[str]) -> bool | None:
    """File-wide plating: X2 comment > layer type from intake (which already used the name)."""
    for c in comments:
        if m := _TF_PLATED.search(c):
            return m.group(1).lower() == "plated"
    t = entry.get("type")
    if t == "drill_pth" and not entry.get("mixed_plating"):
        return True
    if t == "drill_npth":
        return False
    name = Path(entry["file"]).name.lower()
    if re.search(r"npth|non[-_]?plated", name):
        return False
    if re.search(r"(?<![a-z])pth|plated", name):
        return True
    return None


def parse_drill_layer(ctx: JobContext, entry: dict[str, Any]) -> list[ToolRow]:
    rel = entry["file"]
    x = open_camfile(ctx.layer_path(rel), entry["type"])
    default_plated = file_level_plating(entry, list(getattr(x, "comments", []) or []))
    rows: dict[tuple[float, bool | None, bool], ToolRow] = {}
    for o in x.objects:
        tool = o.tool

        def mm(v: float, unit=o.unit) -> float:
            return float(MM(v, unit))

        dia = round(float(MM(tool.diameter, tool.unit)), 4)
        plated = tool.plated if tool.plated is not None else default_plated
        if isinstance(o, go.Line):
            h = Hole(mm(o.x1), mm(o.y1), dia, plated, rel, slot=True, x2=mm(o.x2), y2=mm(o.y2))
        elif isinstance(o, go.Flash):
            h = Hole(mm(o.x), mm(o.y), dia, plated, rel)
        else:  # Arc-routed slots etc. are not expected in M1
            continue
        key = (dia, plated, h.slot)
        row = rows.get(key)
        if row is None:
            row = rows[key] = ToolRow(tool="", file=rel, dia_mm=dia, plated=plated, slot=h.slot)
        row.holes.append(h)
        row.count += 1
    out = list(rows.values())
    for i, r in enumerate(out, start=1):
        r.tool = f"T{i:02d}"
        for h in r.holes:
            h.tool = r.tool
    return out


# ---------------------------------------------------------------------------------------------
PLUG_TAPE_VALUES = ("resin", "aluminum", "alu", "树脂", "铝")


def needs_plug_tape(order_spec: dict[str, Any] | None) -> bool:
    """铝片塞孔 / 树脂塞孔 need their own drill tape (p140); solder-mask plugging does not."""
    v = str((order_spec or {}).get("via_plugging") or "").lower()
    return any(k in v for k in PLUG_TAPE_VALUES)


# attributes + oversize (p114)
# ---------------------------------------------------------------------------------------------
def round_to_step(v: float, step: float) -> float:
    return round(round(v / step) * step, 4)


def infer_plating_by_pads(ctx: JobContext, lm: dict[str, Any], rows: list[ToolRow], items: list[ReportItem]) -> int:
    """Rows whose file gave no plating clue: a hole sitting inside a copper pad on an outer layer
    is plated (a component/via hole), a hole with no pad on either side is NPTH (p114 定义孔属性,
    M2 W6). Returns the number of rows decided; undecidable rows stay ``plated=None``."""
    unknown = [r for r in rows if r.plated is None]
    if not unknown:
        return 0
    outer = [e for e in lm.get("files", []) if e.get("type") in ("top_copper", "bottom_copper")]
    if not outer:
        return 0
    pads: list[Polygon] = []
    for e in outer:
        try:
            objs = list(open_camfile(ctx.layer_path(e["file"]), e["type"]).objects)
        except Exception:  # noqa: BLE001 — the copper stage reports unreadable layers
            objs = []
        for o in objs:
            if isinstance(o, go.Flash):
                (x0, y0), (x1, y1) = o.bounding_box(unit=MM)
                pads.append(Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]))
    if not pads:
        return 0
    tree = STRtree(pads)
    decided = 0
    for r in unknown:
        if not r.holes:
            continue
        on_pad = sum(1 for h in r.holes if len(tree.query(h.center(), predicate="within")))
        frac = on_pad / len(r.holes)
        if frac >= 0.8:
            r.plated = True
        elif frac <= 0.2:
            r.plated = False
        else:
            continue
        decided += 1
        items.append(
            ReportItem(
                id=f"plating_inferred_{r.file}_{r.tool}", kind="drill_plating_inferred", severity="info", layer=r.file,
                measured=round(frac, 2), threshold=0.8,
                message=f"{r.file} {r.tool} ⌀{r.dia_mm}：文件未标镀孔属性，{on_pad}/{len(r.holes)} 孔落在外层焊盘上 → 按 {'PTH' if r.plated else 'NPTH'} 处理（请在钻孔表核对）",
                fix=Fix(type="set_plated", op="SetDrillAttrs", params={"plated": r.plated, "by": "pad"}, auto_fixable=True, applied=True),
            )
        )  # fmt: skip
    return decided


HASL_WORDS = ("喷锡", "hasl", "hal ")


def oversize_table(cfg: dict[str, Any], order_spec: dict[str, Any] | None) -> dict[str, float]:
    """p114 的预大表，按表面处理分档后的结果（``drill.oversize_by_finish``）。

    这家厂 2026-09-16 的回复：喷锡 PTH +0.15、非喷锡 PTH +0.10，NPTH 两档都 +0.05。
    """
    over = dict(cfg["oversize_mm"])
    by_finish = cfg.get("oversize_by_finish") or {}
    if not by_finish:
        return over
    finish = str((order_spec or {}).get("surface_finish") or "").strip().lower()
    if not finish:
        return over  # 订单没写表面处理（order_spec 检查会报）：不猜档，按 p114 默认
    key = "hasl" if any(w in finish for w in HASL_WORDS) else "other"
    over.update({k: float(v) for k, v in (by_finish.get(key) or {}).items()})
    return over


def assign_attributes(rows: list[ToolRow], cfg: dict[str, Any], order_spec: dict[str, Any] | None = None) -> None:
    via_max = cfg["via_max_mm"]
    over = oversize_table(cfg, order_spec)
    for r in rows:
        if r.plated is None:
            r.attribute = "unknown"
            r.oversize_mm = 0.0
        elif r.plated and r.dia_mm <= via_max + 1e-9 and not r.slot:
            r.attribute = "via"  # M1 simplification: small plated hole == via (no pad lookup)
            r.oversize_mm = over["via"]
            via_min = float(cfg.get("via_min_mm", 0) or 0)
            if via_min > 0 and r.dia_mm < via_min - 1e-9:
                # the factory's smallest via: a 0.2 via is made as 0.3 (3×3 1oz job: all 45 ⌀0.2 vias
                # drilled 0.35 like the 0.3 ones); pad rings then follow the 0.3 drill too
                r.note = (r.note + "；" if r.note else "") + f"⌀{r.dia_mm:g} 过孔按厂最小过孔 ⌀{via_min:g} 做"
                r.source_dia_mm = r.dia_mm
                r.dia_mm = via_min
        elif r.plated:
            r.attribute = "plated"
            r.oversize_mm = over["plated"]
        else:
            r.attribute = "non_plated"
            r.oversize_mm = over["non_plated"]
        big = cfg.get("oversize_large") or {}
        if r.plated is not None and float(big.get("min_dia_mm", 0) or 0) > 0 and r.dia_mm > float(big["min_dia_mm"]) + 1e-9:
            # 「超出 6.45mm 钻孔，采用扩孔钻，比正常补偿多补 0.05mm」（C09 ⌀6.55 → 0.15+0.05 → 钻 6.75）
            extra = big.get("extra_mm")
            r.oversize_mm = r.oversize_mm + float(extra) if extra is not None else float(big.get("add_mm", r.oversize_mm))
        r.drill_dia_mm = round_to_step(r.dia_mm + r.oversize_mm, cfg["round_step_mm"])
    sync_holes(rows)


def sync_holes(rows: list[ToolRow]) -> None:
    """Every hole carries its row's attribute and bit (rows are split/re-sized by the rules below)."""
    for r in rows:
        for h in r.holes:
            h.attribute = r.attribute
            h.drill_dia = r.drill_dia_mm


# ---------------------------------------------------------------------------------------------
# factory rules beyond p114 (first real 6-layer / 3oz job, 2026-09-09; profile drill.* / output.*)
# ---------------------------------------------------------------------------------------------
PLUG_OWN_OPENING_ADD_MM = 0.6  # a via's own mask opening ≈ hole + 2×0.3 (Altium/KiCad default expansion)
_NO_PLUG = ("无", "none", "no", "否", "不塞")


def via_plug_requested(order_spec: dict[str, Any] | None) -> bool:
    """The order asks for via plugging of any kind (绿油/树脂/铝片塞孔)."""
    v = str((order_spec or {}).get("via_plugging") or "").strip().lower()
    if not v or v in _NO_PLUG or v.startswith(("不塞", "无塞")):
        return False
    return any(k in v for k in ("塞", "plug", "fill", "resin", "alu", "树脂", "铝"))


def via_tent_requested(order_spec: dict[str, Any] | None) -> bool:
    """The order asks for vias to be covered by solder mask (盖油 / 覆盖阻焊 / tented) — no plug,
    but the vias' own openings go, exactly like plugged ones; the drill keeps the plain via oversize."""
    v = str((order_spec or {}).get("via_plugging") or "").strip().lower()
    if not v or via_plug_requested(order_spec) or v.startswith(("不", "无", "开窗")):
        return False
    return any(k in v for k in ("盖油", "覆盖", "盖阻焊", "tent", "cover"))


def _renumber(rows: list[ToolRow]) -> None:
    by_file: dict[str, int] = {}
    for r in rows:
        by_file[r.file] = by_file.get(r.file, 0) + 1
        r.tool = f"T{by_file[r.file]:02d}"
        for h in r.holes:
            h.tool = r.tool
            h.attribute = r.attribute


def _split_row(rows: list[ToolRow], row: ToolRow, take: list[Hole], **changes: Any) -> ToolRow:
    """Move ``take`` out of ``row`` into a new row carrying ``changes``; returns the new row."""
    new = ToolRow(tool="", file=row.file, dia_mm=row.dia_mm, plated=row.plated, slot=row.slot, attribute=row.attribute,
                  oversize_mm=row.oversize_mm, drill_dia_mm=row.drill_dia_mm, source_dia_mm=row.source_dia_mm)  # fmt: skip
    for k, v in changes.items():
        setattr(new, k, v)
    keep = [h for h in row.holes if h not in take]
    row.holes, row.count = keep, len(keep)
    new.holes, new.count = list(take), len(take)
    rows.insert(rows.index(row) + 1, new)
    return new


def split_plugged_vias(ctx: JobContext, lm: dict[str, Any], rows: list[ToolRow], cfg: dict[str, Any], order_spec: dict[str, Any] | None) -> int:
    """绿油塞孔 (order via_plugging): a via is plugged when it is *not on a pad* — its solder-mask
    opening on both sides is just its own little disc. A via inside a larger opening (an exposed
    SMD/thermal pad) cannot be plugged and stays open. Plugged vias get their own tool and
    oversize (``drill.plug.oversize_mm``; this factory drills them -0.05). Returns the number of
    holes moved to ``via_plug``."""
    tent = via_tent_requested(order_spec)
    if not via_plug_requested(order_spec) and not tent:
        return 0
    pcfg = cfg.get("plug") or {}
    if str(pcfg.get("mode") or "auto").lower() == "off":
        return 0  # the factory sorts plugged vias by hand (drill.plug.mode: off); ask = split, then a person signs it off
    over = float((cfg.get("oversize_mm") or {}).get("via", 0.0) or 0.0) if tent else float(pcfg.get("oversize_mm", 0.0))
    attr, note = ("via_tent", "盖油过孔（不在焊盘上）") if tent else ("via_plug", "塞孔过孔（不在焊盘上）")
    masks = [e for e in lm.get("files", []) if e.get("type") in ("top_mask", "bottom_mask")]
    trees: list[tuple[STRtree, list[Polygon]]] = []
    masks = [e for e in masks if e.get("type") in ("top_mask", "bottom_mask")]
    for e in masks:
        try:
            polys = list(iter_polygons(fold_cached(ctx.cache_dir, ctx.layer_path(e["file"]), e["file"], e["type"])))
        except Exception:  # noqa: BLE001 — an unreadable mask means "no opening info": nothing is plugged
            polys = []
        trees.append((STRtree(polys) if polys else STRtree([Polygon()]), polys))
    if not trees:
        return 0

    # Which vias stay open (drilled like PTH) on a plugged board is a factory rule about the
    # drawn openings they sit in. Two ways to see "in a drawn opening", ``drill.plug.method``:
    #   opening_ratio — the opening the via sits in is bigger than its own little disc (C09:
    #                   3339/3362 against work/; dense stitching fields whose discs merge count
    #                   as exposed too)
    #   ring          — the mask-free ring just outside the via pad's own opening is still clear
    #                   (a via inside a window has it clear all round, a via next to a pad's
    #                   opening only partly; needs ``via_opening_expansion_mm`` = the export's
    #                   mask expansion)
    #   drawn         — the via centre lies in an opening the customer *drew* on the mask layer
    #                   (lines / arcs / regions, not pad flashes) — the 3×3 Altium job: 342 of the
    #                   351 vias the factory left open sit in the 1 mm exposed-trace strokes on
    #                   Top Solder, none of the 1611 plugged ones do (the other 9 straddle a
    #                   stroke edge to 0.01 mm either way — the engineer's call, not geometry);
    #                   ``drawn_margin_mm`` widens the strokes for the test
    # ``open_sides``: which side's window keeps the via open — any (C09), top (the 3×3 job's
    # set/: only vias in the top-side exposed traces stay open, those in the bottom heat-sink
    # window are plugged), bottom, both.
    method = str(pcfg.get("method", "opening_ratio")).lower()
    side_rule = str(pcfg.get("open_sides", "any")).lower()
    ratio = float(pcfg.get("opening_ratio_max", 1.6))
    exp = float(pcfg.get("via_opening_expansion_mm", 0.1016))
    ov_expand = float(pcfg.get("overlap_expand_mm", 0.0762))  # overlap: the via's disc grown 3 mil a side (the engineer's 「比孔大 3mil」)
    ov_min = float(pcfg.get("overlap_min", 0.5))  # overlap: ≥ this share of the disc inside pad openings = exposed, else plugged (「小于 1/2 … 按塞孔」)
    pad_idx = outer_pad_index(ctx, lm) if method == "ring" else None
    sides = [str(e.get("type", "")) for e in masks]
    drawn_trees: list[STRtree] = []
    if method == "drawn":
        margin = float(pcfg.get("drawn_margin_mm", 0.0) or 0.0)
        for e in masks:
            drawn_trees.append(STRtree(drawn_mask_openings(ctx, e, margin) or [Polygon()]))

    def plugged(h: Hole) -> bool:
        c = Point(h.x, h.y)
        exposed: dict[str, bool] = {}
        if method == "drawn":
            for tree, side in zip(drawn_trees, sides, strict=False):
                exposed[side] = len(tree.query(c, predicate="within")) > 0
        elif method == "ring":
            pad = pad_size_at(pad_idx, h.x, h.y) or (h.dia + 0.3)
            ro = pad / 2 + exp + 0.02
            ring = c.buffer(ro + 0.05).difference(c.buffer(ro))
            for (tree, polys), side in zip(trees, sides, strict=False):  # only nearby openings: a difference against the whole layer is minutes
                near = [polys[int(i)] for i in tree.query(ring, predicate="intersects")]
                left = ring.difference(unary_union(near)) if near else ring
                exposed[side] = left.area < 0.05 * ring.area
        elif method == "overlap":
            # the engineer's rule (C09 sheet 五-1): grow the via's disc 3 mil a side and see how much of it
            # lies in *pad* openings (bigger than the via's own little disc); < 1/2 → plugged. A via
            # straddling a pad opening's edge gets a definite answer where opening_ratio said "inside"
            own_max = ratio * math.pi * ((h.dia + PLUG_OWN_OPENING_ADD_MM) / 2) ** 2
            disc = c.buffer(h.dia / 2 + ov_expand)
            for (tree, polys), side in zip(trees, sides, strict=False):
                big = [polys[int(i)] for i in tree.query(disc, predicate="intersects") if polys[int(i)].area > own_max]
                inside = unary_union(big).intersection(disc).area if big else 0.0
                exposed[side] = inside >= ov_min * disc.area
        else:
            own_max = ratio * math.pi * ((h.dia + PLUG_OWN_OPENING_ADD_MM) / 2) ** 2
            for (tree, polys), side in zip(trees, sides, strict=False):
                exposed[side] = any(polys[int(i)].area > own_max for i in tree.query(c, predicate="within"))
        if not exposed:
            return True
        if side_rule == "both":
            return not all(exposed.values())
        if side_rule in ("top", "bottom"):
            return not exposed.get(f"{side_rule}_mask", False)
        return not any(exposed.values())

    moved = 0
    for row in list(rows):
        if row.attribute != "via" or row.slot:
            continue
        # 盖油 covers every via, windows or not (2×2 job: "所有过孔按文件覆盖阻焊油" → work/ has no via
        # opening on either side, 0/884); only plugging leaves the vias in drawn windows open
        take = list(row.holes) if tent else [h for h in row.holes if plugged(h)]
        if not take:
            continue
        drill = round_to_step(row.dia_mm + over, cfg["round_step_mm"])
        if len(take) == len(row.holes):
            row.attribute, row.oversize_mm, row.drill_dia_mm, row.note = attr, over, drill, note
        else:
            _split_row(rows, row, take, attribute=attr, oversize_mm=over, drill_dia_mm=drill, note=note)
        moved += len(take)
    _renumber(rows)
    return moved


def drop_outside_profile(ctx: JobContext, rows: list[ToolRow]) -> int:
    """p112 删板外物 for the drill: holes whose centre lies outside the Profile (+ the layer
    tolerance) are dropped — a via the customer left lying 300 mm off the board (3×3 Altium job)
    must not become an "extra hole" EQ, and must not be drilled. Returns the number dropped."""
    from engine.checks.common import load_profile

    prof = load_profile(ctx)
    if prof is None or prof.is_empty:
        return 0
    tol = float(ctx.profile["layer"]["outside_profile_tolerance_mm"])
    area = prof.buffer(tol)
    dropped = 0
    for r in list(rows):
        keep = [h for h in r.holes if area.intersects(h.geom() if r.slot else Point(h.x, h.y))]
        if len(keep) == len(r.holes):
            continue
        dropped += len(r.holes) - len(keep)
        r.holes = keep
        r.count = len(keep)
        if not keep:
            rows.remove(r)
    if dropped:
        _renumber(rows)
    return dropped


def drawn_mask_openings(ctx: JobContext, e: dict[str, Any], margin_mm: float = 0.0) -> list[Polygon]:
    """The openings the customer *drew* on a mask layer (lines / arcs / regions — everything that
    is not a pad flash), from the customer's copy, as polygons grown by ``margin_mm``."""
    from engine.geom.from_gerbonara import primitive_to_polygon

    try:
        orig = ctx.orig_path(e["file"])
        objs = list(open_camfile(orig if orig.is_file() else ctx.src_path(e["file"]), e["type"]).objects)
    except Exception:  # noqa: BLE001 — the mask stage reports unreadable layers
        return []
    polys: list[Polygon] = []
    for o in objs:
        if isinstance(o, go.Flash):
            continue
        for prim in o.to_primitives(unit=MM):
            poly = primitive_to_polygon(prim)
            if poly is not None and not poly.is_empty:
                polys.append(poly)
    if not polys:
        return []
    merged = unary_union(polys)
    if margin_mm > 0:
        merged = merged.buffer(margin_mm)
    return list(iter_polygons(merged))


def outer_pad_index(ctx: JobContext, lm: dict[str, Any]) -> tuple[STRtree, list[Polygon], list[float]] | None:
    """Outer-layer pad flashes as boxes + their size (max side), for "is this hole on a pad / how big".
    Read from the customer's copy: the order names pads by their designed size (5.5), and the edit
    copy has been compensated / padded up by the time the outer and mask stages ask."""
    pads: list[Polygon] = []
    sizes: list[float] = []
    for e in lm.get("files", []):
        if e.get("type") not in ("top_copper", "bottom_copper"):
            continue
        try:
            orig = ctx.orig_path(e["file"])
            objs = list(open_camfile(orig if orig.is_file() else ctx.src_path(e["file"]), e["type"]).objects)
        except Exception:  # noqa: BLE001 — the copper stage reports unreadable layers
            objs = []
        for o in objs:
            if isinstance(o, go.Flash):
                (x0, y0), (x1, y1) = o.bounding_box(unit=MM)
                pads.append(Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]))
                sizes.append(round(max(x1 - x0, y1 - y0), 3))
    if not pads:
        return None
    return STRtree(pads), pads, sizes


def pad_size_at(idx: tuple[STRtree, list[Polygon], list[float]] | None, x: float, y: float) -> float | None:
    if idx is None:
        return None
    tree, _pads, sizes = idx
    hits = [sizes[int(i)] for i in tree.query(Point(x, y), predicate="within")]
    return min(hits) if hits else None


def apply_drill_overrides(ctx: JobContext, lm: dict[str, Any], rows: list[ToolRow], order_spec: dict[str, Any] | None) -> list[str]:
    """``order_spec.drill_overrides``: [{dia_mm, drill_mm, pad_mm?, slot?}] — the engineer's per-tool
    final bit (压接孔、客户指定公差…) that no rule derives. ``pad_mm`` narrows to holes whose outer
    pad is that size (±0.05), splitting the tool if needed. Returns human notes."""
    ov = [o for o in ((order_spec or {}).get("drill_overrides") or []) if isinstance(o, dict) and o.get("dia_mm") and o.get("drill_mm")]
    if not ov:
        return []
    idx = outer_pad_index(ctx, lm) if any(o.get("pad_mm") for o in ov) else None
    notes: list[str] = []
    for o in ov:
        dia, drill, pad = float(o["dia_mm"]), float(o["drill_mm"]), o.get("pad_mm")
        want_slot = bool(o.get("slot", False))
        extra = {k: float(o[k]) for k in ("outer_pad_mm", "rout_circle_mm") if o.get(k)}
        if o.get("rout_shape") and o.get("rout_circle_mm"):
            extra["rout_shape"] = dict(o["rout_shape"])
        dcfg = ctx.profile["drill"]
        ring = float(dcfg.get("rout_circle_ring_mm", 0) or 0)
        if extra.get("rout_circle_mm") and not extra.get("outer_pad_mm") and ring > 0:
            # 梅花/压接孔: the outer pad is the routed circle plus the factory's ring (「直接加大到单边 0.5mm 宽」)
            extra["outer_pad_mm"] = round_to_step(extra["rout_circle_mm"] + 2 * ring, dcfg["round_step_mm"])
        for row in list(rows):
            if row.slot != want_slot or abs(row.dia_mm - dia) > 0.011:
                continue
            take = row.holes if pad is None else [h for h in row.holes if (ps := pad_size_at(idx, h.x, h.y)) is not None and abs(ps - float(pad)) <= 0.051]
            if not take:
                continue
            note = f"订单指定 ⌀{dia}" + (f"（焊盘 {pad}）" if pad else "") + f" → 钻 {drill}"
            if extra.get("outer_pad_mm"):
                note += f"，外层焊盘 {extra['outer_pad_mm']}"
            if extra.get("rout_circle_mm"):
                note += f"，内锣带画 ⌀{extra['rout_circle_mm']}"
            if len(take) == len(row.holes):
                row.drill_dia_mm, row.oversize_mm, row.note, row.override = round(drill, 3), round(drill - dia, 3), note, True
                for k, v in extra.items():
                    setattr(row, k, v)
            else:
                _split_row(rows, row, take, drill_dia_mm=round(drill, 3), oversize_mm=round(drill - dia, 3), note=note, override=True, **extra)
            notes.append(f"{note} ×{len(take)}")
    _renumber(rows)
    return notes


def second_drill_split(ctx: JobContext, lm: dict[str, Any], rows: list[ToolRow], cfg: dict[str, Any]) -> int:
    """``drill.second_drill`` — which NPTH holes are drilled again after plating (二钻) from their
    own tape. ``npth_without_pad``: NPTH holes with no copper pad at all; ``npth_small``: NPTH
    holes up to ``second_drill_max_mm`` (the first real job: one ⌀0.5 NPTH went to the .2nd file,
    the eleven ⌀4.2 ones stayed in the main program — small holes cannot be kept out of the
    plating bath by the dry film, so they are drilled after it). Second-drill holes are still
    listed in the drill layer Gerber (工程资料 shows every hole)."""
    mode = str(cfg.get("second_drill") or "none")
    if mode not in ("npth_without_pad", "npth_small"):
        return 0
    idx = outer_pad_index(ctx, lm) if mode == "npth_without_pad" else None
    max_d = float(cfg.get("second_drill_max_mm", 1.0) or 0)
    n = 0
    for row in list(rows):
        if row.attribute != "non_plated" or row.slot or row.second:
            continue
        if mode == "npth_small":
            take = list(row.holes) if row.dia_mm <= max_d + 1e-9 else []
            note = f"二钻（≤{max_d} mm 的非金属孔，电镀后再钻）"
        else:
            # a "pad" no bigger than the hole (EDA tools export one for NPTH) is no copper ring at all
            take = [h for h in row.holes if (ps := pad_size_at(idx, h.x, h.y)) is None or ps <= h.dia + 0.1]
            note = "二钻（无铜盘的非金属孔）"
        if not take:
            continue
        if len(take) == len(row.holes):
            row.second, row.note = True, note
        else:
            _split_row(rows, row, take, second=True, note=note)
        n += len(take)
    _renumber(rows)
    return n


def delete_overlapping_holes(rows: list[ToolRow], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """``drill.overlap: delete_smaller`` — a hole whose circle overlaps a bigger hole's circle is
    dropped (the bigger bit takes it away anyway; two bits in one spot break). The first real job:
    the customer drew eight ⌀1.0 holes on a 1.95 mm circle around each ⌀4.2 press-fit hole and
    the factory deleted all 120. ``ask`` (default) keeps them and lets Drill Checks report."""
    if str(cfg.get("overlap") or "ask") != "delete_smaller":
        return []
    pts = [(h, r) for r in rows if not r.rect for h in r.holes if not h.slot]
    if len(pts) < 2:
        return []
    tree = STRtree([Point(h.x, h.y) for h, _ in pts])
    gone: list[dict[str, Any]] = []
    doomed: set[int] = set()
    for i, (h, r) in enumerate(pts):
        if i in doomed:
            continue
        for j in tree.query(Point(h.x, h.y).buffer(r.drill_dia_mm / 2 + 3.5)):
            j = int(j)
            if j == i or j in doomed:
                continue
            h2, r2 = pts[j]
            if r2.drill_dia_mm <= r.drill_dia_mm + 1e-9:
                continue  # only a bigger hole swallows this one
            if Point(h.x, h.y).distance(Point(h2.x, h2.y)) < (r.drill_dia_mm + r2.drill_dia_mm) / 2 - 1e-6:
                doomed.add(i)
                gone.append({"x": round(h.x, 4), "y": round(h.y, 4), "dia_mm": r.dia_mm, "tool": r.tool, "file": r.file, "inside": r2.tool, "inside_dia_mm": r2.dia_mm})
                break
    if not gone:
        return []
    dead = {id(pts[i][0]) for i in doomed}
    for r in rows:
        r.holes = [h for h in r.holes if id(h) not in dead]
        r.count = len(r.holes)
    rows[:] = [r for r in rows if r.holes or r.rect]
    _renumber(rows)
    return gone


_DRR_ROW = re.compile(r"^(T\d+)\s+\S+\s*\(([\d.]+)mm\).*?\b(Round|Slot|Rectangle)\s+(\d+)\s+(PTH|NPTH)", re.IGNORECASE)


def parse_altium_drr(ctx: JobContext) -> list[dict[str, Any]]:
    """Altium's NC drill report (*.DRR) lists every tool with its hole *kind* (Round / Slot /
    Rectangle) — the only place that says which routed holes are rectangles. Tolerances are
    listed too but not consumed yet."""
    out: list[dict[str, Any]] = []
    src = ctx.work_dir / "src"
    if not src.is_dir():
        return out
    for p in src.rglob("*"):
        if not p.is_file() or p.suffix.lower() != ".drr":
            continue
        try:
            text = p.read_bytes().decode("gbk", "replace")
        except OSError:
            text = ""
        for line in text.splitlines():
            m = _DRR_ROW.match(line.strip())
            if m:
                out.append({"tool": m.group(1), "size_mm": float(m.group(2)), "kind": m.group(3).capitalize(), "count": int(m.group(4)), "plated": m.group(5).upper() == "PTH", "file": p.name})
    return out


def rect_to_rout(rows: list[ToolRow], drr: list[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows that the DRR calls Rectangle (drawn as routed slots in the Excellon) leave the drill
    tape and become inner-rout contours (方孔用锣). Returns the contours for the output stage."""
    if not cfg.get("rect_to_rout") or not drr:
        return []
    rects = [t for t in drr if t["kind"] == "Rectangle"]
    contours: list[dict[str, Any]] = []
    for t in rects:
        cands = [r for r in rows if r.slot and not r.rect and abs(r.dia_mm - t["size_mm"]) <= 0.011]
        if not cands:
            continue
        row = next((r for r in cands if r.count == t["count"]), cands[0])
        row.rect, row.note = True, f"矩形孔（{t['file']} {t['tool']} Rectangle）→ 锣"
        for h in row.holes:
            if h.slot and h.x2 is not None:
                contours.append({"x1": h.x, "y1": h.y, "x2": h.x2, "y2": h.y2, "width_mm": row.dia_mm, "tool": row.tool, "file": row.file})
    return contours


def profile_bbox(ctx: JobContext) -> tuple[float, float, float, float] | None:
    p = ctx.work_dir / "profile.wkb"
    if not p.is_file():
        return None
    g = from_wkb(p.read_bytes())
    return tuple(round(v, 4) for v in g.bounds)  # type: ignore[return-value]


def origin_shift(ctx: JobContext) -> tuple[float, float]:
    """``output.origin: profile_ll`` → translate every output so the Profile's lower-left corner
    is (0, 0) (Genesis operators expect the datum at the board corner)."""
    if str(ctx.profile.get("output", {}).get("origin", "keep")) != "profile_ll":
        return 0.0, 0.0
    bb = profile_bbox(ctx)
    return (-bb[0], -bb[1]) if bb else (0.0, 0.0)


def drawn_hole_rows(ctx: JobContext, cfg: dict[str, Any], file: str, existing: list[Hole], over: float | None = None) -> list[ToolRow]:
    """Circles drawn on the outline layer that no drill file has (align → profile.json
    ``drawn_holes``): NPTH holes with the non_plated oversize (p113). Positions already drilled
    (within 0.1 mm) are skipped."""
    meta_path = ctx.work_dir / "profile.json"
    if not cfg.get("drawn_holes_to_drill") or not meta_path.is_file():
        return []
    try:
        drawn = json.loads(meta_path.read_text("utf-8")).get("drawn_holes") or []
    except (OSError, ValueError):
        return []
    have = [(h.x, h.y) for h in existing]
    by_dia: dict[float, ToolRow] = {}
    over = float(cfg["oversize_mm"]["non_plated"]) if over is None else over
    for x, y, dia in drawn:
        if any(abs(x - hx) <= 0.1 and abs(y - hy) <= 0.1 for hx, hy in have):
            continue
        row = by_dia.get(dia)
        if row is None:
            row = by_dia[dia] = ToolRow(tool="DRAWN", file=file, dia_mm=dia, plated=False, slot=False, attribute="non_plated",
                                        oversize_mm=over, drill_dia_mm=round_to_step(dia + over, cfg["round_step_mm"]), note="外形层上画的孔（p113，按 NPTH）")  # fmt: skip
        row.holes.append(Hole(round(x, 4), round(y, 4), dia, False, file, tool="DRAWN", attribute="non_plated"))
        row.count += 1
        have.append((x, y))
    return list(by_dia.values())


def vcut_end_hole_spots(lines: list[list[tuple[float, float]]], rails: list[Polygon], units: BaseGeometry, holes: list[dict[str, Any]],
                        side: str = "low", exit_holes: list[dict[str, Any]] | None = None, probe_mm: float = 0.3) -> list[tuple[float, float, float]]:
    """(x, y, dia) of every V-cut end hole. For each V-cut line that runs *between units* (no rail on
    either side) and each unit on the line's ``side`` (low = the unit whose top / right edge is the
    line): the *entry* group ``holes`` = [{dia_mm, from_edge_mm}] on the line, that far past the
    unit's bounding-box edge; and, when the unit's material along the line stops short of its box
    (a corner cutout), the *exit* group ``exit_holes`` = [{dia_mm, along_mm, into_mm}] placed from the
    cutout corner (along = back along the line, into = into the unit). 3×3 job: entry ⌀1.201/0.901/0.6
    @ 1.112/1.427/1.785 from x = 0 / 49.55 / 99.1; exit trio at the 11.7 mm top-right cutout, the
    ⌀1.2 0.43 back and 0.541 in, the others up the −20° diagonal — 12 groups, none on rail lines."""
    out: list[tuple[float, float, float]] = []
    polys = [u for u in (units.geoms if hasattr(units, "geoms") else [units]) if u.geom_type == "Polygon" and not u.is_empty]
    for ln in lines:
        (ax, ay), (bx, by) = ln[0], ln[-1]
        L = math.hypot(bx - ax, by - ay)
        if L < 1e-6:
            continue
        d = ((bx - ax) / L, (by - ay) / L)
        if (d[0] < 0) or (abs(d[0]) < 1e-9 and d[1] < 0):
            d = (-d[0], -d[1])  # run the line in the +x / +y direction so "low" is its start
        nrm = (-d[1], d[0])  # +normal = the high side (above a horizontal line, left of a vertical one)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        if any(r.contains(Point(mx - d[1] * s_, my + d[0] * s_)) for r in rails for s_ in (1.0, -1.0)):
            continue  # a rail line: no end holes (the coupon lives there instead)
        into = (-nrm[0], -nrm[1]) if side == "low" else nrm
        line = LineString([(ax, ay), (bx, by)])
        inner = LineString([(ax + into[0] * probe_mm, ay + into[1] * probe_mm), (bx + into[0] * probe_mm, by + into[1] * probe_mm)])
        for u in polys:
            if not u.buffer(0.01).intersects(line) or not u.intersects(inner):
                continue
            seg = inner.intersection(u)
            parts = [g for g in (seg.geoms if hasattr(seg, "geoms") else [seg]) if g.geom_type == "LineString" and g.length > 1.0]
            if not parts:
                continue
            x0, y0, x1, y1 = u.bounds
            lo = (x0, y0) if abs(d[0]) >= abs(d[1]) else (x0, y0)
            # position along the line of the unit's box start / end
            t_lo = (x0 * d[0] + y0 * d[1]) if abs(d[0]) >= abs(d[1]) else (x0 * d[0] + y0 * d[1])
            t_hi = (x1 * d[0] + y1 * d[1])
            base = (ax * d[0] + ay * d[1])
            # a point on the line at parameter t
            def on_line(t: float, off_into: float = 0.0) -> tuple[float, float]:
                px = ax + d[0] * (t - base) + into[0] * off_into
                py = ay + d[1] * (t - base) + into[1] * off_into
                return (round(px, 4), round(py, 4))
            for h in holes:
                x, y = on_line(t_lo + float(h["from_edge_mm"]))
                out.append((x, y, float(h["dia_mm"])))
            if exit_holes:
                first = min(parts, key=lambda g: g.coords[0][0] * d[0] + g.coords[0][1] * d[1])
                (ex0, ey0), (ex1, ey1) = first.coords[0], first.coords[-1]
                t_end = max(ex0 * d[0] + ey0 * d[1], ex1 * d[0] + ey1 * d[1])
                if t_end < t_hi - 1.0:  # the material stops before the box: a cutout at the line
                    for h in exit_holes:
                        x, y = on_line(t_end + float(h.get("along_mm", 0)), float(h.get("into_mm", 0)))
                        out.append((x, y, float(h["dia_mm"])))
    return out


def vcut_end_hole_rows(ctx: JobContext, cfg: dict[str, Any], file: str) -> list[ToolRow]:
    """V-cut 端孔 (``drill.vcut_end_holes``, factory standard): NPTH holes on every unit-to-unit V-cut
    line just inside each unit's entry edge (the 3×3 job's tape). Drilled at the configured size
    (no oversize: the numbers are the bits), windowed by the masks like any NPTH, never given a
    copper clearance (the finished pour runs straight past them)."""
    import json as _json

    from shapely import from_wkb
    from shapely.ops import unary_union

    spec = cfg.get("vcut_end_holes") or {}
    if not spec.get("enabled") or not spec.get("holes"):
        return []
    meta_path, rails_path, prof_path = ctx.work_dir / "profile.json", ctx.work_dir / "rails.wkb", ctx.work_dir / "profile.wkb"
    if not (meta_path.is_file() and prof_path.is_file()):
        return []
    lines = [[tuple(pt) for pt in ln] for ln in _json.loads(meta_path.read_text("utf-8")).get("rail_lines") or [] if len(ln) >= 2]
    rails = []
    if rails_path.is_file():
        g = from_wkb(rails_path.read_bytes())
        rails = [x for x in (g.geoms if hasattr(g, "geoms") else [g]) if x.geom_type == "Polygon" and not x.is_empty]
    prof = from_wkb(prof_path.read_bytes())
    units = prof.difference(unary_union(rails)) if rails else prof
    spots = vcut_end_hole_spots(lines, rails, units, list(spec["holes"]), str(spec.get("side", "low")), list(spec.get("exit_holes") or []) or None)
    by_dia: dict[float, ToolRow] = {}
    for x, y, dia in spots:
        row = by_dia.get(dia)
        if row is None:
            row = by_dia[dia] = ToolRow(tool="VCUT_END", file=file, dia_mm=dia, plated=False, slot=False, attribute="non_plated",
                                        oversize_mm=0.0, drill_dia_mm=dia, note="V-cut 端孔（工厂标准）")  # fmt: skip
        row.holes.append(Hole(x, y, dia, False, file, tool="VCUT_END", attribute="non_plated", drill_dia=dia))
        row.count += 1
    return list(by_dia.values())


def tooling_rows(ctx: JobContext, cfg: dict[str, Any], file: str, npth_over: float | None = None) -> list[ToolRow]:
    """Factory tooling / pin holes on the board (or its rails) from ``drill.tooling_holes``,
    positioned from the Profile corners. NPTH, so they get the non_plated oversize."""
    specs = cfg.get("tooling_holes") or []
    npth_over = float(cfg["oversize_mm"]["non_plated"]) if npth_over is None else npth_over
    bb = profile_bbox(ctx) if specs else None
    if not specs or bb is None:
        return []
    x0, y0, x1, y1 = bb
    by_dia: dict[float, ToolRow] = {}
    for sp in specs:
        corner = str(sp.get("corner", "ll")).lower()
        dx, dy, dia = float(sp.get("dx_mm", 0)), float(sp.get("dy_mm", 0)), float(sp.get("dia_mm", 3.175))
        x = (x0 + dx) if corner[1:] == "l" else (x1 - dx)
        y = (y0 + dy) if corner[0] == "l" else (y1 - dy)
        row = by_dia.get(dia)
        if row is None:
            over = npth_over
            row = by_dia[dia] = ToolRow(tool="TOOLING", file=file, dia_mm=dia, plated=False, slot=False, attribute="non_plated",
                                        oversize_mm=over, drill_dia_mm=round_to_step(dia + over, cfg["round_step_mm"]), note="板边定位孔（工厂标准）")  # fmt: skip
        h = Hole(round(x, 4), round(y, 4), dia, False, file, tool="TOOLING", attribute="non_plated")
        row.holes.append(h)
        row.count += 1
    return list(by_dia.values())


def apply_factory_rules(ctx: JobContext, lm: dict[str, Any], rows: list[ToolRow], cfg: dict[str, Any], order_spec: dict[str, Any] | None) -> dict[str, Any]:
    """Everything after ``assign_attributes`` that changes which holes exist / how big they drill.
    Shared by the drill stage and ``load_holes`` so every later stage sees the same holes."""
    info: dict[str, Any] = {}
    info["outside"] = drop_outside_profile(ctx, rows)
    info["plugged"] = split_plugged_vias(ctx, lm, rows, cfg, order_spec)
    info["overrides"] = apply_drill_overrides(ctx, lm, rows, order_spec)
    info["overlap_deleted"] = delete_overlapping_holes(rows, cfg)
    info["second"] = second_drill_split(ctx, lm, rows, cfg)
    drr = parse_altium_drr(ctx)
    info["drr_tools"] = len(drr)
    info["rect_contours"] = rect_to_rout(rows, drr, cfg)
    first = next((r.file for r in rows), None)
    npth_over = oversize_table(cfg, order_spec)["non_plated"]
    drawn = drawn_hole_rows(ctx, cfg, first, [h for r in rows for h in r.holes], npth_over) if first else []
    rows.extend(drawn)
    info["drawn_holes"] = sum(r.count for r in drawn)
    tool = tooling_rows(ctx, cfg, first, npth_over) if first else []
    have = [(h.x, h.y) for r in rows for h in r.holes]
    for r in tool:  # the customer may have drawn the factory's tooling holes already
        r.holes = [h for h in r.holes if not any(abs(h.x - x) <= 0.1 and abs(h.y - y) <= 0.1 for x, y in have)]
        r.count = len(r.holes)
    tool = [r for r in tool if r.holes]
    rows.extend(tool)
    info["tooling"] = sum(r.count for r in tool)
    endh = vcut_end_hole_rows(ctx, cfg, first) if first else []
    rows.extend(endh)
    info["vcut_end_holes"] = sum(r.count for r in endh)
    sync_holes(rows)
    return info


def drill_gerber(tools: list[DrillTool], shift: tuple[float, float] = (0.0, 0.0)) -> bytes:
    """The drill layer as RS-274X (工程资料习惯：每把刀一个 C 光圈，孔 = flash，槽 = 线)."""
    from gerbonara.apertures import CircleAperture
    from gerbonara.rs274x import GerberFile

    from engine.output.gerber_writer import write_gerber

    sx, sy = shift
    objs: list[Any] = []
    for t in tools:
        ap = CircleAperture(diameter=t.diameter_mm, unit=MM)
        for x, y in t.holes:
            objs.append(go.Flash(x + sx, y + sy, ap, unit=MM))
        for x1, y1, x2, y2 in t.slots:
            objs.append(go.Line(x1 + sx, y1 + sy, x2 + sx, y2 + sy, ap, unit=MM))
    return write_gerber(GerberFile(objects=objs), None)


# ---------------------------------------------------------------------------------------------
# order_spec drill table comparison (p113)
# ---------------------------------------------------------------------------------------------
def compare_with_order_spec(rows: list[ToolRow], spec: list[dict[str, Any]], tol: float, items: list[ReportItem]) -> None:
    unmatched_rows = list(rows)
    for i, s in enumerate(spec):
        dia = float(s.get("dia_mm") or s.get("size_mm") or s.get("dia") or 0)  # LLM schema says size_mm, older specs dia_mm
        want_slot = bool(s.get("slot", False))
        cands = [r for r in unmatched_rows if r.slot == want_slot]
        best = min(cands, key=lambda r: abs(r.dia_mm - dia), default=None)
        if best is None or abs(best.dia_mm - dia) > tol:
            items.append(
                ReportItem(
                    id=f"spec_{i}", kind="drill_table_mismatch", severity="error",
                    measured=None, threshold=tol,
                    message=f"钻孔表孔径 {dia} mm{'(槽)' if want_slot else ''} 在 Excellon 中找不到匹配工具",
                    eq_question="钻孔表与 Excellon 不一致：钻孔表孔径 "
                    f"{dia} mm 在钻孔文件中不存在，请客户确认以哪个为准",
                    fix=Fix(type="add_holes", op="AddHolesFromDrawing", params={"dia_mm": dia, "slot": want_slot}, auto_fixable=False, applied=False,
                            genesis_script=f"# p113 分孔图上有、钻孔层没有：从分孔图复制 ⌀{dia} 的{'槽' if want_slot else '孔'}到钻孔层\nCOM filter_set,filter_name=popup,update_popup=no,feat_types=pad,symbol=r{dia / 0.0254:.1f}  【待验证】\nCOM sel_copy_other,dest=layer_name,target_layer=<drl>,invert=no,dx=0,dy=0,size=0  【待验证】"),
                )
            )  # fmt: skip
            continue
        unmatched_rows.remove(best)
        count = s.get("count")
        if count is not None and int(count) != best.count:
            items.append(
                ReportItem(
                    id=f"spec_{i}", kind="drill_table_mismatch", severity="error", layer=best.file,
                    measured=best.count, threshold=int(count),
                    message=f"孔径 {best.dia_mm} mm 数量不一致：钻孔表 {count}，Excellon {best.count}",
                    eq_question=f"钻孔表与 Excellon 不一致：{best.dia_mm} mm 孔数 {count} vs {best.count}，请客户确认",
                )
            )  # fmt: skip
        elif abs(best.dia_mm - dia) > 1e-6:
            items.append(
                ReportItem(
                    id=f"spec_{i}_dia", kind="drill_table_dia_diff", severity="info", layer=best.file,
                    measured=best.dia_mm, threshold=dia,
                    message=f"孔径 {best.dia_mm} mm 与钻孔表 {dia} mm 相差 {abs(best.dia_mm - dia):.3f} mm（容差内）",
                )
            )  # fmt: skip
    for r in unmatched_rows:
        items.append(
            ReportItem(
                id=f"spec_extra_{r.file}_{r.tool}", kind="drill_table_mismatch", severity="error", layer=r.file,
                measured=r.dia_mm,
                message=f"Excellon 工具 {r.tool} {r.dia_mm} mm ×{r.count} 不在钻孔表中",
                eq_question=f"钻孔表与 Excellon 不一致：钻孔文件多出 {r.dia_mm} mm ×{r.count}，请客户确认",
            )
        )  # fmt: skip


# ---------------------------------------------------------------------------------------------
# Drill Checks (p116-117)
# ---------------------------------------------------------------------------------------------
def _loc(h: Hole) -> Location:
    c = h.center()
    b = h.geom().bounds
    return Location(x=round(c.x, 4), y=round(c.y, 4), bbox=tuple(round(v, 4) for v in b))


def _capped(items: list[ReportItem], new: list[ReportItem], kind: str, message: str) -> None:
    """Over ``ITEM_CAP`` hits of one check collapse into one summary item that carries the EQ; the
    listed individuals keep their location (for 定位) but stop being decisions of their own —
    120 touching-hole pairs on the first real job produced 31 identical EQ cards."""
    if len(new) <= ITEM_CAP:
        items.extend(new)
        return
    severity, eq = new[0].severity, new[0].eq_question
    for it in new[:ITEM_CAP]:
        it.eq_question = None
        if it.severity == "error":
            it.severity = "warn"
        it.message += f"（汇总见 {kind}_more）"
    items.extend(new[:ITEM_CAP])
    items.append(
        ReportItem(
            id=f"{kind}_more", kind=kind, severity=severity, measured=len(new),
            message=f"{message}：共 {len(new)} 处，仅列出前 {ITEM_CAP} 处",
            eq_question=eq,
        )
    )  # fmt: skip


def check_hole_size(rows: list[ToolRow], items: list[ReportItem]) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    for attr in ("via", "via_plug", "plated", "non_plated", "unknown"):
        rs = [r for r in rows if r.attribute == attr]
        if rs:
            stats[attr] = {
                "tools": len(rs),
                "holes": sum(r.count for r in rs),
                "dia_min": min(r.dia_mm for r in rs),
                "dia_max": max(r.dia_mm for r in rs),
            }
    text = "; ".join(f"{k}: {v['holes']} 孔 / {v['tools']} 工具 ({v['dia_min']}~{v['dia_max']} mm)" for k, v in stats.items())
    items.append(ReportItem(id="hole_size", kind="hole_size", severity="info", message=f"Hole Size: {text or '无孔'}"))
    return stats


def check_extra_holes(holes: list[Hole], copper: list[Polygon], items: list[ReportItem]) -> int:
    """Extra Holes: plated holes whose centre lies in no outer-layer copper pad (p116)."""
    if not copper:
        items.append(ReportItem(id="extra_skip", kind="extra_holes", severity="info", message="Extra Holes: 无外层铜，跳过"))
        return 0
    tree = STRtree(copper)
    new = []
    for h in holes:
        if h.plated is not True:
            continue
        c = h.center()
        hit = tree.query(c, predicate="within")
        if len(hit) == 0:
            new.append(
                ReportItem(
                    id=f"extra_{len(new)}", kind="extra_holes", severity="error", layer=h.file, location=_loc(h),
                    measured=h.dia_mm if hasattr(h, "dia_mm") else h.dia,
                    message=f"孔 {h.tool} ⌀{h.dia} mm @({c.x:.3f},{c.y:.3f}) 不落在任何外层焊盘内",
                    eq_question="发现不属于任何 Pad 的多余孔，请客户确认是删除还是补焊盘",
                )
            )  # fmt: skip
    _capped(items, new, "extra_holes", "多余孔")
    return len(new)


def check_hole_separation(holes: list[Hole], min_sep: float, items: list[ReportItem]) -> int:
    """Hole Separation: duplicate / touching / close holes (p116-117)."""
    geoms = [h.geom() for h in holes]
    if not geoms:
        return 0
    tree = STRtree(geoms)
    new = []
    seen: set[tuple[int, int]] = set()
    for i, g in enumerate(geoms):
        for j in tree.query(g.buffer(min_sep), predicate="intersects").tolist():
            if j <= i or (i, j) in seen:
                continue
            seen.add((i, j))
            d = g.distance(geoms[j])
            kind = "duplicate" if geoms[j].intersects(g) and holes[i].center().distance(holes[j].center()) < 1e-3 else (
                "touching" if d <= 1e-6 else "close"
            )
            a, b = holes[i], holes[j]
            new.append(
                ReportItem(
                    id=f"sep_{len(new)}", kind="hole_separation", severity="error", layer=a.file, location=_loc(a),
                    measured=round(d, 4), threshold=min_sep,
                    message=f"{kind} holes: {a.tool} ⌀{a.dia} 与 {b.tool} ⌀{b.dia}({b.file}) 边距 {d:.3f} mm",
                    eq_question="发现重复/接触/过近的孔，请客户确认设计意图（p118：近孔及相交孔按工厂要求处理）",
                )
            )  # fmt: skip
    _capped(items, new, "hole_separation", "孔距不足")
    return len(new)


def _pad_candidates(ctx: JobContext, entry: dict[str, Any], min_area: float) -> list[tuple[Polygon, str]]:
    """Non-SMD pads on an outer copper layer (heuristic, p116 Missing holes 非SMD Pads)."""
    gf = open_camfile(ctx.layer_path(entry["file"]), entry["type"])
    out: list[tuple[Polygon, str]] = []
    for o in gf.objects:
        if not isinstance(o, go.Flash):
            continue
        ap = o.aperture
        fn = ""
        for name, vals in getattr(ap, "attrs", ()) or ():
            if name == ".AperFunction":
                fn = ",".join(vals)
        if "SMD" in fn or "Fiducial" in fn or "Heatsink" in fn or "Test" in fn:
            continue
        kind = type(ap).__name__
        explicit = any(k in fn for k in ("ComponentPad", "ViaPad", "ConnectorPad", "BGAPad"))
        if not explicit and kind not in ("CircleAperture", "ObroundAperture", "PolygonAperture"):
            continue
        (x0, y0), (x1, y1) = o.bounding_box(unit=MM)
        area = (x1 - x0) * (y1 - y0)
        if not explicit and area < min_area:
            continue
        # a circle drawn as a "hole-less" round pad is exactly what a THT pad looks like
        out.append((Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]), f"{kind}{'/' + fn if fn else ''}"))
    return out


def check_missing_holes(ctx: JobContext, outer_entries: list[dict[str, Any]], holes: list[Hole], min_area: float, items: list[ReportItem]) -> int:
    centers = [h.center() for h in holes]
    tree = STRtree(centers) if centers else None
    new = []
    for e in outer_entries:
        for pad, desc in _pad_candidates(ctx, e, min_area):
            if tree is not None and len(tree.query(pad, predicate="contains")) > 0:
                continue
            c = pad.centroid
            new.append(
                ReportItem(
                    id=f"missing_{len(new)}", kind="missing_holes", severity="warn", layer=e["file"],
                    location=Location(x=round(c.x, 4), y=round(c.y, 4), bbox=tuple(round(v, 4) for v in pad.bounds)),
                    measured=round(pad.area, 3), threshold=min_area,
                    message=f"非 SMD 焊盘 {desc} @({c.x:.3f},{c.y:.3f}) 中心无孔（启发式）",
                )
            )  # fmt: skip
    _capped(items, new, "missing_holes", "疑似缺孔")
    return len(new)


def check_npth_to_rout(holes: list[Hole], profile: BaseGeometry | None, min_d: float, items: list[ReportItem]) -> int:
    if profile is None:
        items.append(ReportItem(id="npth_rout_skip", kind="npth_to_rout", severity="info", message="NPTH to Rout: 无 Profile，跳过"))
        return 0
    boundary = profile.boundary
    new = []
    for h in holes:
        if h.plated is not False:
            continue
        d = boundary.distance(h.geom())
        if d < min_d:
            new.append(
                ReportItem(
                    id=f"npth_rout_{len(new)}", kind="npth_to_rout", severity="warn", layer=h.file, location=_loc(h),
                    measured=round(d, 4), threshold=min_d,
                    message=f"NPTH {h.tool} ⌀{h.dia} mm 距板边 {d:.3f} mm（< {min_d} mm）",
                )
            )  # fmt: skip
    _capped(items, new, "npth_to_rout", "非金属孔靠近板边")
    return len(new)


# ---------------------------------------------------------------------------------------------
def _report_factory_rules(rules: dict[str, Any], rows: list[ToolRow], cfg: dict[str, Any], items: list[ReportItem]) -> None:
    # ask 档（洲旭 2026-09-16：塞孔分组、订单指定钻嘴/公差孔、相交小孔删除「要人工处理」）：照做，但 fix.confirm 让报告项进 EQ
    ask_plug = str((cfg.get("plug") or {}).get("mode") or "auto").lower() == "ask"
    ask_override = str(cfg.get("override_mode") or "auto").lower() == "ask"
    ask_overlap = bool(cfg.get("overlap_confirm", False))
    if rules.get("plugged"):
        plug_rows = [r for r in rows if r.attribute == "via_plug"]
        open_vias = sum(r.count for r in rows if r.attribute == "via")
        items.append(ReportItem(id="via_plug_split", kind="drill_via_plug", severity="info", measured=rules["plugged"], threshold=open_vias,
                                eq_question=(f"塞孔分组已按厂规做了（{rules['plugged']} 塞 / {open_vias} 开，判法 {(cfg.get('plug') or {}).get('method', 'opening_ratio')}），请确认；不同型号/板厚要改的，把 drill.plug 改了重跑本步" if ask_plug else None),
                                message=f"绿油塞孔：{rules['plugged']} 个过孔不在焊盘上 → 塞孔，钻嘴 {sorted({r.drill_dia_mm for r in plug_rows})}；{open_vias} 个落在露铜焊盘的开窗里 → 不塞（订单：塞孔）",
                                fix=Fix(type="split", op="SetDrillAttrs", params={"attribute": "via_plug", "count": rules["plugged"]}, auto_fixable=True, applied=True, confirm=ask_plug)))  # fmt: skip
    for note in rules.get("overrides") or []:
        items.append(ReportItem(id=f"drill_override_{len(items)}", kind="drill_override", severity="info", message=note,
                                eq_question=(f"订单指定的钻嘴已套用（{note}），属特殊做法，请确认" if ask_override else None),
                                fix=Fix(type="resize", op="ResizeDrills", params={"note": note}, auto_fixable=True, applied=True, confirm=ask_override)))  # fmt: skip
    if rules.get("overlap_deleted"):
        gone = rules["overlap_deleted"]
        items.append(ReportItem(id="overlap_deleted", kind="drill_overlap_deleted", severity="warn", measured=len(gone),
                                location=Location(x=gone[0]["x"], y=gone[0]["y"], bbox=(gone[0]["x"] - 2, gone[0]["y"] - 2, gone[0]["x"] + 2, gone[0]["y"] + 2)),
                                message=f"重叠孔：{len(gone)} 个小孔的孔圈与更大的孔相交，按工厂标准删除小孔（如 ⌀{gone[0]['dia_mm']} 在 ⌀{gone[0]['inside_dia_mm']} 旁）",
                                eq_question=f"资料里有 {len(gone)} 个孔与更大的孔重叠（例如 ⌀{gone[0]['dia_mm']} 与 ⌀{gone[0]['inside_dia_mm']}），已按厂规删除小孔；若客户另有用意请告知",
                                fix=Fix(type="delete", op="DrillChecks", params={"overlap_deleted": len(gone)}, auto_fixable=True, applied=True, confirm=ask_overlap)))  # fmt: skip
    if rules.get("second"):
        items.append(ReportItem(id="second_drill", kind="drill_second", severity="info", measured=rules["second"],
                                message=f"二钻：{rules['second']} 个非金属孔另出 *_2nd 钻带（电镀后再钻；钻孔层 Gerber 仍列出）",
                                fix=Fix(type="export", op="ExportExcellon", params={"second": True}, auto_fixable=True, applied=True)))  # fmt: skip
    if rules.get("rect_contours"):
        n = len({(c["file"], c["tool"]) for c in rules["rect_contours"]})
        items.append(ReportItem(id="rect_rout", kind="drill_rect_to_rout", severity="info", measured=len(rules["rect_contours"]),
                                message=f"矩形孔 {len(rules['rect_contours'])} 个（{n} 把刀，客户钻孔报告标 Rectangle）改锣，进内锣带，不进钻带",
                                fix=Fix(type="rout", op="RoutDesign", params={"rect": len(rules["rect_contours"])}, auto_fixable=True, applied=True)))  # fmt: skip
    small = [r for r in rows if r.attribute in ("via", "via_plug", "via_tent") and r.source_dia_mm > 0]
    if small:
        items.append(ReportItem(id="via_min", kind="drill_via_min", severity="info", measured=sum(r.count for r in small), threshold=float(cfg.get("via_min_mm", 0) or 0),
                                message=f"{sum(r.count for r in small)} 个小于厂最小过孔 ⌀{cfg.get('via_min_mm')} 的过孔按 ⌀{cfg.get('via_min_mm')} 钻（工厂工艺）",
                                fix=Fix(type="resize", op="SetDrillAttrs", params={"via_min_mm": cfg.get("via_min_mm"), "count": sum(r.count for r in small)}, auto_fixable=True, applied=True)))  # fmt: skip
    if rules.get("outside"):
        items.append(ReportItem(id="drill_outside", kind="drill_outside_profile", severity="info", measured=rules["outside"],
                                message=f"{rules['outside']} 个孔在 Profile 外（客户遗留在板外的过孔/孔），不钻（p112 删板外物）",
                                fix=Fix(type="delete", op="DeleteOutsideProfile", params={"count": rules["outside"], "layer": "drill"}, auto_fixable=True, applied=True,
                                        genesis_script="# p112 钻孔层：sel_ref_feat 选 Profile 外的孔 → sel_delete  【待验证】")))  # fmt: skip
    if rules.get("drawn_holes"):
        items.append(ReportItem(id="drawn_holes", kind="drill_drawn_holes", severity="info", measured=rules["drawn_holes"],
                                message=f"外形层上画的 {rules['drawn_holes']} 个圆按 NPTH 加进钻带（p113）",
                                fix=Fix(type="add_holes", op="AddHolesFromDrawing", params={"count": rules["drawn_holes"]}, auto_fixable=True, applied=True)))  # fmt: skip
    if rules.get("tooling"):
        items.append(ReportItem(id="tooling_holes", kind="drill_tooling", severity="info", measured=rules["tooling"],
                                message=f"按工厂标准加 {rules['tooling']} 个板边定位孔（NPTH）",
                                fix=Fix(type="add", op="AddTooling", params={"count": rules["tooling"]}, auto_fixable=True, applied=True)))  # fmt: skip
    pre = cfg.get("predrill") or {}
    if float(pre.get("min_dia_mm", 0) or 0) > 0:
        big = [r for r in rows if not r.slot and not r.rect and not r.override and r.drill_dia_mm >= float(pre["min_dia_mm"]) - 1e-9]
        if big:
            items.append(ReportItem(id="predrill", kind="drill_predrill", severity="info", measured=sum(r.count for r in big), threshold=float(pre.get("bit_mm", 3.175)),
                                    message=f"≥{pre['min_dia_mm']} mm 的 {sum(r.count for r in big)} 个孔先钻 ⌀{pre.get('bit_mm', 3.175)} 再扩孔（工厂工艺）"))  # fmt: skip
    rc = cfg.get("rect_corner_predrill") or {}
    if rules.get("rect_contours") and float(rc.get("bit_mm", 0) or 0) > 0:
        n = sum(1 for c in rules["rect_contours"] if float(c["width_mm"]) >= float(rc.get("min_width_mm", 0) or 0) - 1e-9)
        if n:
            items.append(ReportItem(id="rect_corner_predrill", kind="drill_rect_corner_predrill", severity="info", measured=4 * n, threshold=float(rc["bit_mm"]),
                                    message=f"{n} 个 ≥{rc.get('min_width_mm', 0)} mm 宽的矩形锣孔四角先钻 ⌀{rc['bit_mm']}（工厂工艺，锣刀留方角）"))  # fmt: skip
    for sp in cfg.get("slot_end_predrill") or []:
        n = sum(r.count for r in rows if r.slot and not r.rect and abs(r.dia_mm - float(sp.get("width_mm", 0))) <= 0.011)
        if n:
            items.append(ReportItem(id=f"slot_pre_{sp.get('width_mm')}", kind="drill_slot_predrill", severity="info", measured=n, threshold=float(sp.get("bit_mm", 0)),
                                    message=f"{sp.get('width_mm')} mm 槽 {n} 条两端先钻 ⌀{sp.get('bit_mm')}（工厂工艺）"))  # fmt: skip


def rect_corner_tools(contours: list[dict[str, Any]], file: str, cfg: dict[str, Any], shift: tuple[float, float]) -> DrillTool | None:
    """``drill.rect_corner_predrill``: a routed rectangle gets a small hole in each corner first,
    tangent to both edges, so the round rout bit leaves a square corner (the first real job: four
    ⌀0.8 per 4 mm rectangle; the 1.2 mm ones had none → ``min_width_mm``)."""
    rc = cfg.get("rect_corner_predrill") or {}
    bit = float(rc.get("bit_mm", 0) or 0)
    if bit <= 0:
        return None
    min_w = float(rc.get("min_width_mm", 0) or 0)
    over = float(cfg.get("rect_rout_oversize_mm", 0) or 0)  # the contour the tool follows (output._inner_rout) is this much bigger
    sx, sy = shift
    holes: list[tuple[float, float]] = []
    for c in contours:
        if c.get("file") != file or float(c["width_mm"]) < min_w - 1e-9:
            continue
        w = float(c["width_mm"]) + over
        dx, dy = c["x2"] - c["x1"], c["y2"] - c["y1"]
        ln = math.hypot(dx, dy)
        if ln < 1e-6:
            continue
        ux, uy = dx / ln, dy / ln  # along the slot
        px, py = -uy, ux  # across it
        a = bit / 2
        # the routed rectangle has square ends w/2 beyond the two path points (Altium RectHoles are
        # G85 slots of length − width); the hole sits in the corner, tangent to both edges
        for ex, ey, sgn in ((c["x1"], c["y1"], -1), (c["x2"], c["y2"], 1)):
            for side in (1, -1):
                holes.append((ex + sgn * ux * (w / 2 - a) + side * px * (w / 2 - a) + sx, ey + sgn * uy * (w / 2 - a) + side * py * (w / 2 - a) + sy))
    return DrillTool(number=0, diameter_mm=bit, plated=True, holes=holes) if holes else None


def profile_rout_predrill_tools(ctx: JobContext, cfg: dict[str, Any], shift: tuple[float, float]) -> list[DrillTool]:
    """Pre-drills for the rout paths that come from the outline layer itself (align → profile.json /
    profile.wkb), the factory's tape for the 2×2 Protel job: ⌀0.8 at both ends of every 1 mm
    keep-out slot (``slot_end_predrill`` by width; bends of a polyline are routed through, only
    the two ends get a hole) and ⌀0.8 in the four corners of every rectangular cut-out
    (``rect_corner_predrill``, tangent to both edges). Routed, not drilled: no G85 in the tape."""
    from shapely import from_wkb

    sx, sy = shift
    tools: list[DrillTool] = []
    meta_path = ctx.work_dir / "profile.json"
    meta = json.loads(meta_path.read_text("utf-8")) if meta_path.is_file() else {}
    by_bit: dict[float, list[tuple[float, float]]] = {}
    for pts, w in meta.get("drawn_slots") or []:
        if len(pts) < 2:
            continue
        bit = next((float(sp.get("bit_mm", 0)) for sp in cfg.get("slot_end_predrill") or [] if abs(float(w) - float(sp.get("width_mm", 0))) <= 0.011), 0.0)
        if bit <= 0:
            continue
        for x, y in (pts[0], pts[-1]):
            by_bit.setdefault(bit, []).append((float(x) + sx, float(y) + sy))
    rc = cfg.get("rect_corner_predrill") or {}
    bit = float(rc.get("bit_mm", 0) or 0)
    wkb = ctx.work_dir / "profile.wkb"
    if bit > 0 and wkb.is_file():
        min_w = float(rc.get("min_width_mm", 0) or 0)
        prof = from_wkb(wkb.read_bytes())
        for pg in (list(prof.geoms) if hasattr(prof, "geoms") else [prof]):
            for ring in pg.interiors:
                x0, y0, x1, y1 = ring.bounds
                poly = Polygon(ring)
                if min(x1 - x0, y1 - y0) < min_w - 1e-9 or poly.area < 0.98 * (x1 - x0) * (y1 - y0):
                    continue  # not an axis-aligned rectangle
                a = bit / 2
                for cx, cy in ((x0 + a, y0 + a), (x1 - a, y0 + a), (x0 + a, y1 - a), (x1 - a, y1 - a)):
                    by_bit.setdefault(bit, []).append((cx + sx, cy + sy))
    for b, holes in sorted(by_bit.items()):
        tools.append(DrillTool(number=0, diameter_mm=b, plated=True, holes=holes))
    return tools


def _tape_tools(rows: list[ToolRow], cfg: dict[str, Any], shift: tuple[float, float]) -> tuple[list[DrillTool], int]:
    """The tools of one drill program: the factory's extra passes first (pre-drill for big holes,
    slot-end holes), then the rows themselves. Returns (tools, number of extra holes)."""
    sx, sy = shift
    tools: list[DrillTool] = []
    extra = 0
    # 工厂工艺：大孔先钻小孔再扩（订单指定钻嘴的孔除外）；槽两端先钻孔 —— 这些不是设计上的孔，只进钻带不进检查
    pre = cfg.get("predrill") or {}
    pre_min = float(pre.get("min_dia_mm", 0) or 0)
    if pre_min > 0:
        big = [(h.x + sx, h.y + sy) for r in rows for h in r.holes if not h.slot and not r.override and r.drill_dia_mm >= pre_min - 1e-9]
        if big:
            tools.append(DrillTool(number=0, diameter_mm=float(pre.get("bit_mm", 3.175)), plated=True, holes=big))
            extra += len(big)
    # 短槽（p118「短槽的制作各厂不同」）：行程 ≤ ratio × 名义槽宽的才预钻两端（第一块真板：2.0 宽行程 2.0 的钻、7.5 的不钻，1.2 宽行程 1.9 的也不钻）
    short_ratio = float(cfg.get("short_slot_max_travel_ratio", 0) or 0)
    for sp in cfg.get("slot_end_predrill") or []:
        w, bit = float(sp.get("width_mm", 0)), float(sp.get("bit_mm", 0))
        ends: list[tuple[float, float]] = []
        for r in rows:
            if not r.slot or abs(r.dia_mm - w) > 0.011:
                continue
            # the end hole is tangent to the slot's rounded end from the inside: its centre sits
            # (slot ⌀ − end bit ⌀) / 2 *beyond* the path's end point. Measured on the first real
            # board's tape, three slot sizes, all exact: 2.152/1.95 → 0.101, 1.752/0.95 → 0.401,
            # 1.152/0.7 → 0.226. (Until 2026-09-20 this moved *inward* and was clamped to half the
            # travel, so a slot whose travel is shorter than that — 1.752 ⌀ with 0.4 travel — got
            # both of its holes stacked on the slot's centre.)
            out = max(0.0, (r.drill_dia_mm - bit) / 2)
            for h in r.holes:
                if h.x2 is None:
                    continue
                dx, dy = h.x2 - h.x, h.y2 - h.y
                if short_ratio > 0 and math.hypot(dx, dy) > short_ratio * r.dia_mm + 1e-9:
                    continue  # a long slot is just routed
                ln = math.hypot(dx, dy) or 1.0
                ux, uy = dx / ln * out, dy / ln * out
                ends += [(h.x - ux + sx, h.y - uy + sy), (h.x2 + ux + sx, h.y2 + uy + sy)]
        if ends and bit > 0:
            tools.append(DrillTool(number=0, diameter_mm=bit, plated=True, holes=ends))
            extra += len(ends)
    tools += [
        DrillTool(
            number=0, diameter_mm=r.drill_dia_mm, plated=r.plated,
            holes=[(h.x + sx, h.y + sy) for h in r.holes if not h.slot],
            slots=[(h.x + sx, h.y + sy, h.x2 + sx, h.y2 + sy) for h in r.holes if h.slot],
        )
        for r in rows
    ]  # fmt: skip
    return tools, extra


def run_drill(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="drill", status="failed", summary="no layer_map (run intake first)")
    cfg = ctx.profile["drill"]
    xcfg = ctx.profile["excellon"]
    entries = lm.get("files", [])
    drill_entries = [e for e in entries if e.get("type") in DRILL_TYPES]
    if not drill_entries:
        items.append(
            ReportItem(
                id="no_drill", kind="missing_layer", severity="error", message="layer_map 中没有钻孔层",
                eq_question="资料中未找到钻孔文件，请客户提供 Excellon 钻孔文件",
            )
        )  # fmt: skip
        return StageReport(stage="drill", status="needs_review", summary="no drill layers", items=items)

    # 1. parse + attributes
    rows: list[ToolRow] = []
    for e in drill_entries:
        try:
            file_rows = parse_drill_layer(ctx, e)
        except Exception as ex:  # noqa: BLE001
            items.append(
                ReportItem(
                    id=f"drill_parse_{len(items)}", kind="layer_parse_error", severity="error", layer=e["file"],
                    message=f"无法解析钻孔文件 {e['file']}: {type(ex).__name__}: {ex}",
                    eq_question=f"钻孔文件 {e['file']} 无法解析，请客户重新导出",
                )
            )  # fmt: skip
            continue
        rows.extend(file_rows)
    infer_plating_by_pads(ctx, lm, rows, items)
    assign_attributes(rows, cfg, ctx.request.order_spec)
    rules = apply_factory_rules(ctx, lm, rows, cfg, ctx.request.order_spec)
    _report_factory_rules(rules, rows, cfg, items)
    for e in drill_entries:
        unknown = [r for r in rows if r.file == e["file"] and r.plated is None]
        if unknown:
            items.append(
                ReportItem(
                    id=f"plating_unknown_{len(items)}", kind="drill_plating_unknown", severity="error", layer=e["file"],
                    measured=sum(r.count for r in unknown),
                    message=f"{e['file']} 无法判断镀孔属性（{len(unknown)} 把工具，{sum(r.count for r in unknown)} 孔），预大按 0 处理",
                    eq_question=f"钻孔文件 {e['file']} 未标明金属化/非金属化，请客户确认各孔径是否为 PTH（p114 定义孔属性需与客户确认）",
                )
            )  # fmt: skip
    holes = [h for r in rows for h in r.holes]

    # 2. order_spec drill table
    spec = (ctx.request.order_spec or {}).get("drill_table") if ctx.request.order_spec else None
    if spec:
        compare_with_order_spec(rows, spec, cfg["table_dia_tolerance_mm"], items)

    # 3. oversize items + drill tape per file
    artifacts = []
    ask_via = str(cfg.get("via_oversize_mode") or "auto").lower() == "ask"  # 洲旭：过孔预大「非通用规则…要人工处理」
    for r in rows:
        via_ask = ask_via and r.attribute in ("via", "via_plug", "via_tent") and abs(r.oversize_mm) > 1e-9
        items.append(
            ReportItem(
                id=f"oversize_{r.file}_{r.tool}", kind="drill_oversize", severity="info", layer=r.file,
                measured=r.dia_mm, threshold=r.drill_dia_mm,
                message=f"{r.tool} {r.attribute} ⌀{r.dia_mm} → 钻嘴 ⌀{r.drill_dia_mm} mm (+{r.oversize_mm}) ×{r.count}{' 槽' if r.slot else ''}",
                eq_question=(f"过孔预大 {r.oversize_mm:+g}（⌀{r.dia_mm} → {r.drill_dia_mm}，×{r.count}）按厂 profile 做了，不同型号/板厚不同，请确认" if via_ask else None),
                fix=Fix(type="resize", op="ResizeDrills", params={"from": r.dia_mm, "to": r.drill_dia_mm, "tool": r.tool},
                        auto_fixable=True, applied=True, confirm=via_ask),
            )
        )  # fmt: skip
    shift = origin_shift(ctx)
    sx, sy = shift
    extra_tape_holes = 0
    drill_gerber_parts: list[DrillTool] = []
    as_gerber = bool(ctx.profile.get("output", {}).get("drill_as_gerber"))
    for e in drill_entries:
        file_rows = [r for r in rows if r.file == e["file"]]
        if not file_rows:
            continue
        main_rows = [r for r in file_rows if not r.rect and not r.second]
        tools, extra = _tape_tools(main_rows, cfg, shift)
        corner = rect_corner_tools(rules.get("rect_contours") or [], e["file"], cfg, shift)
        if corner is not None:
            tools.insert(0, corner)
            extra += len(corner.holes)
        if e is drill_entries[0]:  # the outline's own rout paths (slots / cut-outs) get their pre-drills in the first tape
            for t in profile_rout_predrill_tools(ctx, cfg, shift):
                tools.insert(0, t)
                extra += len(t.holes)
                rules.setdefault("profile_predrills", 0)
                rules["profile_predrills"] += len(t.holes)
        extra_tape_holes += extra
        for i, t in enumerate(tools, start=1):
            t.number = i
        text = write_excellon(
            tools, unit=xcfg["unit"], zeros=xcfg["zeros"], fmt=tuple(xcfg["format"]),
            comments=[f"source={Path(e['file']).name}", "oversized by pcb-worker drill stage"] + ([f"origin shifted by ({sx:.4f}, {sy:.4f}) mm"] if shift != (0.0, 0.0) else []),
        )  # fmt: skip
        stem = safe_stem(Path(e["file"]).stem, "drill")
        artifacts.append(ctx.write_artifact("drill", f"{stem}_oversized.drl", text))
        second_rows = [r for r in file_rows if r.second]
        # the drill layer Gerber (工程资料) lists every hole of both passes, pre-drills included
        drill_gerber_parts += ([corner] if corner is not None else []) + (profile_rout_predrill_tools(ctx, cfg, shift) if e is drill_entries[0] else []) + _tape_tools([r for r in file_rows if not r.rect], cfg, shift)[0]
        if second_rows:
            if as_gerber:  # the factory's .2nd is a Gerber at the *nominal* size (0.5, not 0.55)
                stools = [DrillTool(number=i, diameter_mm=r.dia_mm, plated=False, holes=[(h.x, h.y) for h in r.holes if not h.slot]) for i, r in enumerate(second_rows, start=1)]
                stext: bytes | str = drill_gerber(stools, shift)
            else:
                stools = [DrillTool(number=i, diameter_mm=r.drill_dia_mm, plated=False, holes=[(h.x + sx, h.y + sy) for h in r.holes if not h.slot]) for i, r in enumerate(second_rows, start=1)]
                stext = write_excellon(stools, unit=xcfg["unit"], zeros=xcfg["zeros"], fmt=tuple(xcfg["format"]), comments=[f"source={Path(e['file']).name}", "second drill: NPTH after plating"])
            artifacts.append(ctx.write_artifact("drill", f"{stem}_2nd.drl", stext))
        # p140 要求3 / p144 注意7: 铝片塞孔、树脂塞孔要做塞孔钻带（过孔，整体大 plug_oversize）
        if needs_plug_tape(ctx.request.order_spec):
            plug_over = float(cfg.get("plug_oversize_mm", 0.1))
            # once the mask-opening rule has split the vias, only the ``via_plug`` rows go on the plug tape;
            # with no mask info (nothing split) every via is assumed plugged, as before
            via_rows = [r for r in file_rows if r.attribute == "via_plug" and not r.slot] or [r for r in file_rows if r.attribute == "via" and not r.slot]
            if via_rows:
                ptools = [DrillTool(number=i, diameter_mm=round(r.dia_mm + plug_over, 3), plated=True, holes=[(h.x + sx, h.y + sy) for h in r.holes if not h.slot])
                          for i, r in enumerate(via_rows, start=1)]  # fmt: skip
                ptext = write_excellon(ptools, unit=xcfg["unit"], zeros=xcfg["zeros"], fmt=tuple(xcfg["format"]),
                                       comments=[f"source={Path(e['file']).name}", f"plug drill: via holes + {plug_over} mm (p140)"])  # fmt: skip
                artifacts.append(ctx.write_artifact("drill", f"{stem}_plug.drl", ptext))
                items.append(ReportItem(id=f"plug_{e['file']}", kind="drill_plug_tape", severity="info", layer=e["file"], measured=sum(r.count for r in via_rows), threshold=plug_over,
                                        message=f"塞孔钻带 {stem}_plug.drl：{sum(r.count for r in via_rows)} 个过孔，孔径整体 +{plug_over} mm（订单塞孔 {ctx.request.order_spec.get('via_plugging')}，p140 要求3）",
                                        fix=Fix(type="export", op="ExportExcellon", params={"plug": True}, auto_fixable=True, applied=True)))  # fmt: skip
    if rules.get("profile_predrills"):
        items.append(ReportItem(id="profile_predrill", kind="drill_profile_predrill", severity="info", measured=rules["profile_predrills"],
                                message=f"外形层上画的锣槽两端 / 矩形挖空四角先钻 {rules['profile_predrills']} 个孔（工厂工艺：槽端按 slot_end_predrill、角孔按 rect_corner_predrill）",
                                fix=Fix(type="predrill", op="AddHolesFromDrawing", params={"count": rules["profile_predrills"], "kind": "rout_predrill"}, auto_fixable=True, applied=True)))  # fmt: skip
    if drill_gerber_parts and as_gerber:
        for i, t in enumerate(drill_gerber_parts, start=1):
            t.number = i
        artifacts.append(ctx.write_artifact("drill_gerber", "drill_layer.gbr", drill_gerber(drill_gerber_parts)))
    circles = [[h.x, h.y, r.rout_circle_mm, r.rout_shape] for r in rows for h in r.holes if r.rout_circle_mm > 0 and not h.slot]  # 订单指定：孔位画圆 / 梅花（压接孔 ⌀5）
    if rules.get("rect_contours") or circles:
        doc = {"shift": [sx, sy], "oversize_mm": float(cfg.get("rect_rout_oversize_mm", 0) or 0), "contours": rules.get("rect_contours") or [], "circles": circles}
        artifacts.append(ctx.write_artifact("dfm_report", "rect_rout.json", json.dumps(doc, ensure_ascii=False, indent=1)))

    # 4. drill checks
    outer_entries = [e for e in entries if e.get("type") in ("top_copper", "bottom_copper")]
    copper_polys: list[Polygon] = []
    for e in outer_entries:
        try:
            g = fold_cached(ctx.cache_dir, ctx.layer_path(e["file"]), e["file"], e["type"])
            copper_polys.extend(iter_polygons(g))
        except Exception as ex:  # noqa: BLE001
            items.append(ReportItem(id=f"cu_parse_{len(items)}", kind="layer_parse_error", severity="warn", layer=e["file"], message=f"外层铜解析失败，Extra Holes 检查降级: {ex}"))
    profile_path = ctx.work_dir / "profile.wkb"
    profile = from_wkb(profile_path.read_bytes()) if profile_path.is_file() else None

    checks = {"hole_size": check_hole_size(rows, items)}
    checks["extra_holes"] = check_extra_holes(holes, copper_polys, items)
    checks["hole_separation"] = check_hole_separation(holes, cfg["hole_separation_min_mm"], items)
    checks["missing_holes"] = check_missing_holes(ctx, outer_entries, holes, cfg["missing_hole_pad_min_area_mm2"], items)
    items.append(
        ReportItem(
            id="pg_shorts", kind="power_ground_shorts", severity="info",
            message="Power/Ground Shorts: M1 未实现，需在 Genesis 中运行 Drill Checks 复核",
        )
    )  # fmt: skip
    checks["npth_to_rout"] = check_npth_to_rout(holes, profile, cfg["npth_to_rout_min_mm"], items)

    # 5. 第16章 盲孔 / HDI (p202–211): classification for blind / buried drill files
    try:
        from engine.checks.hdi import run_hdi

        order = list((lm.get("stackup") or {}).get("order") or [])
        n_layers = int((lm.get("stackup") or {}).get("copper_layers") or len(order))
        spans = {e["file"]: tuple(e.get("drill_span") or (1, n_layers)) for e in drill_entries}
        wanted = {L for sp in spans.values() if sp != (1, n_layers) for L in sp}
        copper_folds = {}
        for L in wanted:
            if 1 <= L <= len(order):
                fe = next((e for e in entries if e["file"] == order[L - 1]), None)
                if fe is not None:
                    copper_folds[L] = fold_cached(ctx.cache_dir, ctx.layer_path(fe["file"]), fe["file"], fe["type"])
        holes_by_file: dict[str, list[Hole]] = {}
        for h in holes:
            holes_by_file.setdefault(h.file, []).append(h)
        checks["hdi"] = run_hdi(holes_by_file, drill_entries, copper_folds, n_layers, ctx.profile["hdi"], ctx.request.order_spec, items)
    except Exception as ex:  # noqa: BLE001 — HDI classification never fails the drill stage
        items.append(ReportItem(id="hdi_error", kind="hdi_error", severity="info", message=f"HDI 分类未完成：{type(ex).__name__}: {ex}"))

    table = {
        "files": [e["file"] for e in drill_entries],
        "tools": [r.public() for r in rows],
        "total_holes": len(holes),
        "tape_holes_expected": sum(r.count for r in rows if not r.rect and not r.second) + extra_tape_holes,
        "origin_shift": list(shift),
        "factory_rules": {k: v for k, v in rules.items() if k not in ("rect_contours", "overlap_deleted")} | {"rect_contours": len(rules.get("rect_contours") or []), "overlap_deleted": len(rules.get("overlap_deleted") or [])},
        "checks": checks,
        "profile": {"oversize_mm": cfg["oversize_mm"], "via_max_mm": cfg["via_max_mm"], "round_step_mm": cfg["round_step_mm"]},
    }
    artifacts.append(ctx.write_artifact("dfm_report", "drill_table.json", json.dumps(table, ensure_ascii=False, indent=2)))
    status = derive_status(items)
    ctx.storage.update_progress(ctx.job_id, "drill", status=status, holes=len(holes))
    return StageReport(
        stage="drill", status=status, items=items, artifacts=artifacts,
        summary=f"{len(drill_entries)} drill files, {len(rows)} tools, {len(holes)} holes; " + summarize(items),
    )  # fmt: skip


def _unused(*_: Any) -> None:  # keep math imported for future distance helpers
    math.hypot(0, 0)
