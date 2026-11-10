"""B2.8 the working panel as real layers (第10章 p148–155, 第11章 p156–158).

``steps/panel/<rel>`` is a fourth copy next to orig / net / edit: every output layer and drill
file of the edit step repeated ``nx × ny`` on the chosen working panel, plus what the factory
adds on the panel — outline rectangle, copper thieving in the rails (PatternFill, p153),
tooling holes in the corners (AddTooling, p155). ExportGerber / ExportExcellon then write the
production files from that step (p156–158); the review versions of the edit step stay as they
are.

Placement math is ``engine.panel.plan.unit_placements`` — the same numbers the panel stage's
preview and COM draft use — so what the picture shows is what the layers contain.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.apertures import ExcellonTool
from gerbonara.excellon import ExcellonFile
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely.geometry import box
from shapely.ops import unary_union

from engine.adapters.base import CamOp
from engine.geom.features import Change, ChangeSet, FeatureLayer
from engine.geom.symbols import Symbol
from engine.ingest.classify import COPPER_TYPES, DRILL_TYPES
from engine.model.plan import OpCall
from engine.native.engine import NativeContext, NeedsHuman, native_op
from engine.panel.plan import Candidate, plan_candidates

PANEL_STEP = "panel"
OUTLINE_W = 0.15  # p111: 外形线统一 0.15 mm


def panel_dir(n: NativeContext) -> Path:
    return n.ctx.work_dir / "steps" / PANEL_STEP


def panel_path(n: NativeContext, rel: str) -> Path:
    base = panel_dir(n).resolve()
    p = (base / rel).resolve()
    if base not in p.parents:
        raise ValueError(f"layer file escapes panel dir: {rel!r}")
    return p


def _unit_profile(n: NativeContext):
    """What the working panel repeats: the customer SET block when ``steps/set`` exists, else the
    single unit's profile."""
    meta = _set_meta(n)
    if meta:
        return box(0, 0, meta["set_w"], meta["set_h"]), meta
    return n.profile, None


def _candidate(n: NativeContext, call: OpCall) -> Candidate:
    """The candidate the panel stage chose (its params travel on the PanelBuild fix), else the best."""
    prof, _ = _unit_profile(n)
    if prof is None:
        raise NeedsHuman("没有 Profile，无法拼板（先跑 align）")
    cands = plan_candidates(prof, n.cfg["panel"])
    if not cands:
        raise NeedsHuman("单只放不进任何工作板，请确认开料尺寸 (p148)")
    p = call.params
    want = (p.get("nx"), p.get("ny"), tuple(p.get("panel") or ()), p.get("rotation"))
    for c in cands:
        if (c.nx, c.ny, (c.panel_w, c.panel_h), c.rotation) == want:
            return c
    return cands[0]


def _placements(c: Candidate, prof) -> list[tuple[float, float, float]]:
    """(dx, dy, angle_deg) per unit: translate the edit step so its bbox corner sits on the panel
    grid; rotation about the unit's bbox corner (matches ``unit_placements``)."""
    x0, y0, _x1, _y1 = prof.bounds
    off_x = (c.panel_w - c.used_w) / 2 + c.rail
    off_y = (c.panel_h - c.used_h) / 2 + c.rail
    out = []
    for j in range(c.ny):
        for i in range(c.nx):
            out.append((off_x + i * (c.unit_w + c.gap) - x0, off_y + j * (c.unit_h + c.gap) - y0, float(c.rotation)))
    return out


def _place(obj: Any, dx: float, dy: float, angle: float, x0: float, y0: float, y1: float) -> Any:
    """Copy of ``obj`` moved by the placement. A 90° unit is rotated about its bbox corner so that
    the rotated bbox's corner lands where the unrotated one would (unit_placements' convention)."""
    o = copy.deepcopy(obj)
    if angle % 360:
        # rotate about (x0, y0) counter-clockwise by angle; gerbonara's rotate() is clockwise in radians
        o.rotate(-math.radians(angle), x0, y0, unit=MM)
        ap = getattr(o, "aperture", None)
        if ap is not None and hasattr(ap, "rotated") and not isinstance(ap, ExcellonTool):
            o.aperture = ap.rotated(math.radians(angle))
        # after a 90° CCW turn about (x0, y0) the bbox corner is at (x0 - (y1 - y0), y0): shift it back
        if angle % 180:
            o.offset(y1 - y0, 0, unit=MM)
    o.offset(dx, dy, unit=MM)
    return o


def _manual_cs(op: str, layer: str, params: dict[str, Any], notes: list[str]) -> ChangeSet:
    cs = ChangeSet(op=op, layer=layer, params=params)
    cs.changes = [Change(action="add", fid=i, after={"file": layer}, note=note) for i, note in enumerate(notes)]
    return cs


# ---- StepRepeat (customer SET, p148–151) ------------------------------------------------------
SET_STEP = "set"


def set_dir(n: NativeContext) -> Path:
    return n.ctx.work_dir / "steps" / SET_STEP


def _set_meta(n: NativeContext) -> dict[str, Any] | None:
    p = set_dir(n) / "set.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def _repeat_layers(n: NativeContext, out: Path, places: list[tuple[float, float, float]], prof, outline_rect: tuple[float, float] | None, src_of) -> list[str]:
    """Write every output/drill layer of the job into ``out`` repeated at ``places`` (shared by
    the SET and the working panel). ``outline_rect`` = (w, h) adds the block's own frame."""
    x0, y0, x1, y1 = prof.bounds
    written: list[str] = []
    for e in n.entries():
        rel, t = e.get("file"), e.get("type")
        if not rel or t not in (*COPPER_TYPES, "top_mask", "bottom_mask", "top_silk", "bottom_silk", "top_paste", "bottom_paste", "outline", *DRILL_TYPES):
            continue
        src = src_of(rel)
        if not src.is_file():
            continue
        dst = (out / rel).resolve()
        if out.resolve() not in dst.parents:
            raise ValueError(f"layer file escapes step dir: {rel!r}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if t in DRILL_TYPES:
            xf = ExcellonFile.open(src)
            objs = [_place(o, dx, dy, ang, x0, y0, y1) for dx, dy, ang in places for o in xf.objects]
            ExcellonFile(objects=objs, comments=list(xf.comments or []), import_settings=xf.import_settings).save(dst, settings=xf.import_settings)
        else:
            layer = FeatureLayer.load(src, rel, t)
            objs = [_place(f.obj, dx, dy, ang, x0, y0, y1) for dx, dy, ang in places for f in layer.features]
            if t == "outline" and outline_rect:
                ap = Symbol("r", (OUTLINE_W,)).to_aperture(unit=MM)
                w, h = outline_rect
                for (ax, ay), (bx, by) in (((0, 0), (w, 0)), ((w, 0), (w, h)), ((w, h), (0, h)), ((0, h), (0, 0))):
                    objs.append(go.Line(ax, ay, bx, by, ap, polarity_dark=True, unit=MM))
            gf = layer.to_gerber_file()
            gf.objects = objs
            FeatureLayer(gf, rel, t).save(dst)
        written.append(rel)
    return written


@native_op(CamOp.STEP_REPEAT)
def step_repeat(n: NativeContext, call: OpCall) -> ChangeSet | None:
    """p148–151: the customer's SET as real layers under ``steps/set/`` when the requirement
    parses (N×M, 间距, 工艺边); a sentence the parser cannot read is a person's layout."""
    from engine.panel.plan import parse_panelization, set_size

    spec = n.ctx.request.order_spec or {}
    text = spec.get("panelization") or call.params.get("customer")
    if not text:
        return None  # no customer SET: the working panel is built straight from the edit step
    parsed = parse_panelization(text)
    if not parsed:
        raise NeedsHuman(f"客户拼板要求「{str(text)[:60]}」无法自动解析，SET 需工程师排版 (p149/p151)")
    prof = n.profile
    if prof is None:
        raise NeedsHuman("没有 Profile，无法做 SET（先跑 align）")
    x0, y0, x1, y1 = prof.bounds
    uw, uh = x1 - x0, y1 - y0
    sw, sh = set_size(parsed, uw, uh)
    ox = parsed["rail_mm"] if parsed["rails"] in ("lr", "all") else 0.0
    oy = parsed["rail_mm"] if parsed["rails"] in ("tb", "all") else 0.0
    places = [(ox + i * (uw + parsed["gap_mm"]) - x0, oy + j * (uh + parsed["gap_mm"]) - y0, 0.0) for j in range(parsed["ny"]) for i in range(parsed["nx"])]
    out = set_dir(n)
    out.mkdir(parents=True, exist_ok=True)
    written = _repeat_layers(n, out, places, prof, (sw, sh) if parsed["rail_mm"] else None, n.ctx.layer_path)
    meta = {"parsed": parsed, "set_w": round(sw, 3), "set_h": round(sh, 3), "placements": [{"dx": round(dx, 4), "dy": round(dy, 4), "angle": a} for dx, dy, a in places],
            "unit_bbox": [round(v, 4) for v in (x0, y0, x1, y1)], "layers": written}  # fmt: skip
    (out / "set.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return _manual_cs(call.op, SET_STEP, {"nx": parsed["nx"], "ny": parsed["ny"], "gap_mm": parsed["gap_mm"], "rail_mm": parsed["rail_mm"], "rails": parsed["rails"], "set_mm": [round(sw, 3), round(sh, 3)], "pages": "148/151"},
                      [f"{rel} × {len(places)}" for rel in written])  # fmt: skip


# ---- PanelBuild (p152) -------------------------------------------------------------------------
@native_op(CamOp.PANEL_BUILD)
def panel_build(n: NativeContext, call: OpCall) -> ChangeSet | None:
    c = _candidate(n, call)
    prof, set_meta = _unit_profile(n)
    x0, y0, x1, y1 = prof.bounds
    places = _placements(c, prof)
    out = panel_dir(n)
    out.mkdir(parents=True, exist_ok=True)
    src_of = (lambda rel: set_dir(n) / rel) if set_meta else n.ctx.layer_path  # the SET block or the edit step
    written = _repeat_layers(n, out, places, prof, (c.panel_w, c.panel_h), src_of)
    meta = {"candidate": c.public(), "placements": [{"dx": round(dx, 4), "dy": round(dy, 4), "angle": ang} for dx, dy, ang in places], "layers": written,
            "unit_bbox": [round(v, 4) for v in (x0, y0, x1, y1)], "from_set": bool(set_meta), "set": set_meta and set_meta.get("parsed")}  # fmt: skip
    (out / "panel.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return _manual_cs(call.op, PANEL_STEP, {"panel_mm": [c.panel_w, c.panel_h], "nx": c.nx, "ny": c.ny, "rotation": c.rotation, "rail_mm": c.rail, "gap_mm": c.gap, "page": 152},
                      [f"{rel} × {len(places)}" for rel in written])  # fmt: skip


def _meta(n: NativeContext) -> dict[str, Any] | None:
    p = panel_dir(n) / "panel.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else None


def _units_union(n: NativeContext, meta: dict[str, Any]):
    """Unit outlines on the panel (bbox rectangles — the fill keeps clear of the whole unit)."""
    x0, y0, x1, y1 = meta["unit_bbox"]
    boxes = []
    for pl in meta["placements"]:
        w, h = (x1 - x0, y1 - y0) if pl["angle"] % 180 == 0 else (y1 - y0, x1 - x0)
        bx = x0 + pl["dx"]
        by = y0 + pl["dy"]
        boxes.append(box(bx, by, bx + w, by + h))
    return unary_union(boxes)


# ---- PatternFill (p153 阻流块) --------------------------------------------------------------
@native_op(CamOp.PATTERN_FILL)
def pattern_fill(n: NativeContext, call: OpCall) -> ChangeSet | None:
    rel = call.layer
    e = n.entry(rel)
    meta = _meta(n)
    if not rel or e is None or e.get("type") not in COPPER_TYPES or meta is None:
        return None
    if (e.get("polarity") or "positive") == "negative":
        return None  # negative rails are copper already (nothing drawn = copper)
    pcfg = n.cfg["panel"]
    fill = pcfg.get("fill") or {}
    dot = float(call.params.get("dot_mm") or fill.get("dot_mm", 1.5))
    pitch = float(call.params.get("pitch_mm") or fill.get("pitch_mm", 3.0))
    margin = float(call.params.get("margin_mm") or fill.get("panel_margin_mm", 3.0))
    keep = float(call.params.get("feat_margin_mm") or fill.get("unit_margin_mm", 3.0))
    c = meta["candidate"]
    region = box(margin, margin, c["panel_w"] - margin, c["panel_h"] - margin).difference(_units_union(n, meta).buffer(keep))
    p = panel_path(n, rel)
    if not p.is_file():
        return None
    layer = FeatureLayer.load(p, rel, e["type"])
    cs = layer.begin(call.op, {"dot_mm": dot, "pitch_mm": pitch, "panel_margin_mm": margin, "unit_margin_mm": keep, "page": 153})
    sym = Symbol("r", (dot,))
    existing = layer.dark_union()
    x = margin + pitch / 2
    while x < c["panel_w"] - margin:
        y = margin + pitch / 2
        while y < c["panel_h"] - margin:
            disc = box(x - dot / 2, y - dot / 2, x + dot / 2, y + dot / 2)
            if region.contains(disc) and not existing.intersects(disc):
                layer.add_pad(x, y, sym, note="thieving dot (p153)")
            y += pitch
        x += pitch
    layer.commit()
    if len(cs):
        layer.save(p)
    return cs


# ---- AddTooling (p155 定位孔) -----------------------------------------------------------------
@native_op(CamOp.ADD_TOOLING)
def add_tooling(n: NativeContext, call: OpCall) -> ChangeSet | None:
    meta = _meta(n)
    if meta is None:
        return None
    drills = [e for e in n.entries() if e.get("type") in DRILL_TYPES]
    if not drills:
        return None
    target = next((e for e in drills if e.get("type") == "drill_npth"), drills[0])
    p = panel_path(n, target["file"])
    if not p.is_file():
        return None
    tcfg = n.cfg["panel"].get("tooling") or {}
    dia = float(call.params.get("dia_mm") or tcfg.get("dia_mm", 3.175))
    inset = float(call.params.get("inset_mm") or tcfg.get("inset_mm", n.cfg["panel"]["rail_mm"] / 2))
    c = meta["candidate"]
    pts = [(inset, inset), (c["panel_w"] - inset, inset), (c["panel_w"] - inset, c["panel_h"] - inset), (inset, c["panel_h"] - inset)]
    xf = ExcellonFile.open(p)
    have = {(round(float(o.x), 3), round(float(o.y), 3)) for o in xf.objects if isinstance(o, go.Flash)}
    # gerbonara sorts tools by plating on write: follow the file's convention (an NPTH file usually
    # carries plated=None on every tool; a mixed file says False explicitly)
    known = {getattr(o.tool, "plated", None) for o in xf.objects if isinstance(o, go.Flash)}
    tool = ExcellonTool(diameter=dia, plated=False if (known - {None}) else None, unit=MM)
    added = [(x, y) for x, y in pts if (round(x, 3), round(y, 3)) not in have]
    if not added:
        return None
    for x, y in added:
        xf.objects.append(go.Flash(x, y, tool, unit=MM))
    xf.save(p, settings=xf.import_settings)
    meta.setdefault("tooling", []).append({"file": target["file"], "dia_mm": dia, "points": [[round(x, 3), round(y, 3)] for x, y in added]})
    (panel_dir(n) / "panel.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return _manual_cs(call.op, target["file"], {"dia_mm": dia, "inset_mm": inset, "page": 155}, [f"tooling hole ⌀{dia} @ ({x:.2f}, {y:.2f})" for x, y in added])


# ---- ExportGerber / ExportExcellon from the panel step (p156–158) ----------------------------
def _stem(n: NativeContext) -> str:
    cfg = n.cfg["output"]
    spec = n.ctx.request.order_spec or {}
    return cfg["stem"].format(job=n.ctx.job_id, order=spec.get("order_no") or n.ctx.job_id)


@native_op(CamOp.EXPORT_GERBER)
def export_gerber(n: NativeContext, call: OpCall) -> ChangeSet | None:
    from engine.output.gerber_writer import settings_from_profile, write_gerber
    from engine.stages.output import output_name

    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None:
        return None
    if call.params.get("step") != PANEL_STEP:
        raise NeedsHuman(f"{rel} 的审核版已由 output stage 输出；要求重新输出的层需在 Genesis 中输出 (p156)")
    p = panel_path(n, rel)
    if not p.is_file():
        raise NeedsHuman("还没有 panel step（PanelBuild 未执行），生产版 Gerber 无法输出")
    cfg = n.cfg["output"]
    data = write_gerber(GerberFile.open(p), settings_from_profile(cfg["gerber"]))
    name = output_name(cfg, e, _stem(n) + "_panel")
    n.artifacts.append(("gerber_panel", name, data))
    return _manual_cs(call.op, rel, {"step": PANEL_STEP, "output": name, "page": 156}, [f"{name} ← steps/panel/{rel}"])


def _drill_table(n: NativeContext) -> dict[str, Any]:
    """The drill stage's tool table (finished size → actual bit, attributes) from its artifact."""
    p = n.ctx.work_dir / "reports" / "drill.json"
    if not p.is_file():
        return {}
    from engine.model.report import StageReport

    rep = StageReport.model_validate_json(p.read_text(encoding="utf-8"))
    art = next((a for a in rep.artifacts if a.filename == "drill_table.json"), None)
    if art is None:
        return {}
    try:
        return json.loads(n.ctx.storage.read_object(art.path).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _apply_tool_table(xf: ExcellonFile, rows: list[dict[str, Any]], passthrough: set[float] = frozenset()) -> tuple[int, int]:
    """Swap every flash's tool for the drill stage's actual bit (p114 预大): the panel copy keeps
    finished sizes, the tape carries bits. ``passthrough`` diameters (the panel's own tooling
    holes, already bit-sized) stay. Returns (holes changed, holes without a table row)."""
    bits: dict[float, ExcellonTool] = {}
    changed = missing = 0
    for o in xf.objects:
        t = getattr(o, "tool", None) or getattr(o, "aperture", None)
        if t is None:
            continue
        dia = round(float(t.diameter), 3)
        if any(abs(dia - pt) < 1e-3 for pt in passthrough):
            continue
        row = next((r for r in rows if abs(float(r["dia_mm"]) - dia) < 0.011 or (float(r.get("source_dia_mm") or 0) > 0 and abs(float(r["source_dia_mm"]) - dia) < 0.011)), None)
        if row is None:
            missing += 1
            continue
        bit = round(float(row.get("drill_dia_mm") or dia), 3)
        if abs(bit - dia) < 1e-6:
            continue
        if bit not in bits:
            bits[bit] = ExcellonTool(diameter=bit, plated=t.plated, unit=MM)
        o.aperture = bits[bit]
        changed += 1
    return changed, missing


@native_op(CamOp.EXPORT_EXCELLON)
def export_excellon(n: NativeContext, call: OpCall) -> ChangeSet | None:
    from engine.stages.drill import needs_plug_tape
    from engine.stages.output import output_name

    rel = call.layer
    e = n.entry(rel)
    if not rel or e is None:
        return None
    if call.params.get("step") != PANEL_STEP:
        raise NeedsHuman(f"{rel} 的钻带已由 drill/output stage 输出；其它输出需在 Genesis 中做 (p158)")
    p = panel_path(n, rel)
    if not p.is_file():
        raise NeedsHuman("还没有 panel step（PanelBuild 未执行），生产版钻带无法输出")
    xcfg = n.cfg["excellon"]
    from gerbonara.cam import FileSettings

    st = FileSettings(unit=MM if str(xcfg.get("unit", "METRIC")).upper() != "INCH" else __import__("gerbonara.utils", fromlist=["Inch"]).Inch,
                      zeros={"TZ": "trailing", "LZ": "leading"}.get(str(xcfg.get("zeros", "TZ")).upper()), number_format=tuple(xcfg.get("format", (3, 3))))  # fmt: skip
    rows = [r for r in _drill_table(n).get("tools", []) if r.get("file") == rel]
    xf = ExcellonFile.open(p)
    notes = []
    if needs_plug_tape(n.ctx.request.order_spec):  # p140: 塞孔钻带 from the panel too (via holes, +plug_oversize)
        plug_over = float(n.cfg["drill"].get("plug_oversize_mm", 0.1))
        via_dias = {round(float(r["dia_mm"]), 3) for r in rows if r.get("attribute") in ("via", "via_plug", "via_tent") and not r.get("slot")}
        vias = [copy.deepcopy(o) for o in xf.objects if isinstance(o, go.Flash) and round(float(o.tool.diameter), 3) in via_dias]
        if vias:
            plug_tools: dict[float, ExcellonTool] = {}
            for o in vias:
                d = round(float(o.tool.diameter) + plug_over, 3)
                o.aperture = plug_tools.setdefault(d, ExcellonTool(diameter=d, plated=True, unit=MM))
            pdata = ExcellonFile(objects=vias, import_settings=xf.import_settings).write_to_bytes(settings=st, drop_comments=False)
            base = output_name(n.cfg["output"], e, _stem(n) + "_panel")
            pname = f"{Path(base).stem}_plug{Path(base).suffix or '.drl'}"
            n.artifacts.append(("drill_panel", pname, pdata))
            notes.append(f"{pname} ← {len(vias)} via holes + {plug_over} mm (p140)")
    meta = _meta(n) or {}
    tooling = {round(float(t["dia_mm"]), 3) for t in meta.get("tooling", [])}
    changed, missing = _apply_tool_table(xf, rows, tooling)
    if missing and rows:
        raise NeedsHuman(f"{rel} 有 {missing} 个孔在钻孔表里找不到对应刀径，生产钻带不能套预大表 (p114)")
    data = xf.write_to_bytes(settings=st, drop_comments=False)
    name = output_name(n.cfg["output"], e, _stem(n) + "_panel")
    n.artifacts.append(("drill_panel", name, data))
    notes.insert(0, f"{name} ← steps/panel/{rel}（{changed} 孔套预大表）")
    return _manual_cs(call.op, rel, {"step": PANEL_STEP, "output": name, "oversized_holes": changed, "page": 158}, notes)
