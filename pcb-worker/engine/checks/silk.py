"""Silkscreen DFM checks (第9章 p145–147).

* silk_line_width      p145 要求1 字宽最小 5mil                    → SilkTransform（Change Symbol）
* silk_on_opening      p145 要求2 字符不能上阻焊开窗，离开窗 ≥3mil  → SilkClearByMask
* silk_outside_profile p147 注意4 板外字符一定要删掉 —— **自动删除**（lite 引擎唯一改图的 silk 修复）：
                       写出清理后的字符层 Gerber 作为成果物；跨板边的对象只报告
* 字高 (p145 30mil)    描边文字按笔画聚类估算字高（text_runs），低于 30mil → warn+EQ；字高/笔画 < 6:1 → info

Report only except the outside-profile delete. One decision per (layer, kind).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from gerbonara import graphic_objects as go
from shapely import shortest_line
from shapely.geometry import Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from engine.checks.common import aggregate, below, draft_fix, fmt_mm, load_profile, loc_of
from engine.checks.copper import CopperLayer, _bbox, _item, _width
from engine.geom.layers import fold_many, open_camfile, safe_stem
from engine.geom.svg import iter_polygons
from engine.model.report import Fix, ReportItem, StageReport, derive_status, summarize
from engine.pipeline.context import JobContext

SILK_TYPES = ("top_silk", "bottom_silk")
_SIDE_MASK = {"top_silk": "top_mask", "bottom_silk": "bottom_mask"}
_MIL = 0.0254


@dataclass
class SilkLayer:
    rel: str
    layer_type: str
    geom: BaseGeometry
    objects: list[Any]
    polys: list[Polygon] = field(default_factory=list)
    tree: STRtree | None = None

    def __post_init__(self) -> None:
        self.polys = list(iter_polygons(self.geom))
        self.tree = STRtree(self.polys) if self.polys else None

    @property
    def name(self) -> str:
        return self.rel


def _as_copper(s: SilkLayer) -> CopperLayer:
    """The shared ``_item`` helper only needs ``rel``/``name``; reuse it via a thin CopperLayer."""
    c = CopperLayer.__new__(CopperLayer)
    c.rel, c.layer_type, c.polarity, c.geom, c.objects, c.index, c.polys, c.tree = s.rel, "top_copper", "positive", Polygon(), [], None, [], None
    return c


def check_silk_width(s: SilkLayer, min_w: float, items: list[ReportItem]) -> int:
    new: list[ReportItem] = []
    L = _as_copper(s)
    for o in s.objects:
        if not isinstance(o, (go.Line, go.Arc)) or not o.polarity_dark:
            continue
        w = _width(o)
        bb = _bbox(o)
        if w is None or bb is None or not below(w, min_w):
            continue
        new.append(_item(L, "silk_line_width", len(new), Polygon.from_bounds(*bb), 0.2, round(w, 4), min_w,
                         f"{s.name} 字符线宽 {fmt_mm(w)} < {fmt_mm(min_w)}", None))  # fmt: skip
    return aggregate(items, new, kind="silk_line_width", layer=s.rel, severity="warn", threshold=min_w,
        message=f"{s.name} 字符线宽 < {fmt_mm(min_w)}（p145 要求1）",
        fix=draft_fix("SilkTransform", "silk_width", f"# {s.rel}: 物件查看器选线宽<{min_w / _MIL:.0f}mil 的线 → Change Symbol r{min_w / _MIL:.0f} (p146)\nCOM sel_change_sym,symbol=r{min_w / _MIL:.0f}  【待验证】"))  # fmt: skip


def check_silk_on_opening(s: SilkLayer, openings: BaseGeometry | None, clearance: float, items: list[ReportItem]) -> int:
    if openings is None or s.tree is None:
        return 0
    otree = STRtree(list(iter_polygons(openings)))
    opolys = list(iter_polygons(openings))
    if not opolys:
        return 0
    new: list[ReportItem] = []
    L = _as_copper(s)
    for si, sp in enumerate(s.polys):
        best = None
        for oi in otree.query(sp, predicate="dwithin", distance=clearance):
            d = opolys[int(oi)].distance(sp)
            if best is None or d < best[0]:
                best = (d, int(oi))
        if best is None or not below(best[0], clearance):
            continue
        d, oi = best
        geom = sp.intersection(opolys[oi]) if d == 0 else shortest_line(sp, opolys[oi])
        if geom.is_empty:
            geom = sp
        new.append(_item(L, "silk_on_opening", len(new), geom, 0.3, round(d, 4), clearance,
                         f"{s.name} 字符{'上阻焊开窗' if d == 0 else f'距开窗 {fmt_mm(d)}'} < {fmt_mm(clearance)}", None))  # fmt: skip
    return aggregate(items, new, kind="silk_on_opening", layer=s.rel, severity="warn", threshold=clearance,
        message=f"{s.name} 字符上/近阻焊开窗（p145 要求2，Genesis 用阻焊掏字符）",
        eq_question=f"{s.name} 有字符压到阻焊开窗（焊盘）上，CAM 会用阻焊掏掉压盘部分；若字符上的是大铜皮开窗请客户确认是否保留",
        fix=draft_fix("SilkClearByMask", "clear_by_mask", f"# {s.rel}: 复制阻焊层 → 清负性 → 加大 {clearance / _MIL:.0f}mil → 负性掏字符 (p146 步骤4)\nCOM sel_copy_other,dest=layer_name,target_layer={s.rel}_tmp\nCOM sel_resize,size={2 * clearance / _MIL:.0f}\nCOM sel_copy_other,dest=layer_name,target_layer={s.rel},invert=yes  【待验证】"))  # fmt: skip


def text_runs(s: SilkLayer, *, max_glyph_mm: float = 6.0, min_glyphs: int = 3) -> list[dict[str, float]]:
    """Heuristic text detection on stroke silkscreen: small connected pieces (glyphs) lined up on a
    common baseline with gaps < 1.5× glyph height form a *run* (≥ 3 glyphs: 2-piece marks are polarity/pin-1 symbols, not text). Returns one dict per run:
    ``{x0,y0,x1,y1,height,stroke,n}`` — height = median glyph bbox height (or width for vertical
    runs), stroke ≈ 2·area/perimeter of the glyphs (thin-stroke approximation)."""
    glyphs = []
    for p in s.polys:
        x0, y0, x1, y1 = p.bounds
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0 or max(w, h) > max_glyph_mm or min(w, h) < 0.05:
            continue
        if p.area / (w * h) > 0.85:  # solid block (logo / bar), not a stroked glyph
            continue
        glyphs.append((x0, y0, x1, y1, p))
    runs: list[dict[str, float]] = []
    used = [False] * len(glyphs)
    for horizontal in (True, False):
        # sort along the run direction, group by overlapping cross-extent
        order = sorted(range(len(glyphs)), key=lambda i: (glyphs[i][0] if horizontal else glyphs[i][1]))
        for i in order:
            if used[i]:
                continue
            x0, y0, x1, y1, _ = glyphs[i]
            group = [i]
            cur = (x0, y0, x1, y1)
            for j in order:
                if used[j] or j == i or j in group:
                    continue
                gx0, gy0, gx1, gy1, _ = glyphs[j]
                if horizontal:
                    overlap = min(cur[3], gy1) - max(cur[1], gy0)
                    gap = gx0 - cur[2]
                    size = max(cur[3] - cur[1], 0.05)
                else:
                    overlap = min(cur[2], gx1) - max(cur[0], gx0)
                    gap = gy0 - cur[3]
                    size = max(cur[2] - cur[0], 0.05)
                if overlap > 0.5 * size and -0.2 * size < gap < 1.5 * size:
                    group.append(j)
                    cur = (min(cur[0], gx0), min(cur[1], gy0), max(cur[2], gx1), max(cur[3], gy1))
            if len(group) < min_glyphs:
                continue
            for j in group:
                used[j] = True
            hs = sorted((glyphs[j][3] - glyphs[j][1]) if horizontal else (glyphs[j][2] - glyphs[j][0]) for j in group)
            height = hs[len(hs) // 2]
            strokes = [2 * glyphs[j][4].area / max(glyphs[j][4].length, 1e-9) for j in group]
            stroke = sorted(strokes)[len(strokes) // 2]
            runs.append({"x0": cur[0], "y0": cur[1], "x1": cur[2], "y1": cur[3], "height": round(height, 4), "stroke": round(stroke, 4), "n": len(group)})
    return runs


def check_silk_height(s: SilkLayer, min_h: float, min_ratio: float, items: list[ReportItem]) -> dict[str, int]:
    """p145 要求1 字高最小 30mil；要求2 字高与字宽（笔画）比一般 6:1 以上 — heuristic on stroke text."""
    low: list[ReportItem] = []
    ratio: list[ReportItem] = []
    cu = _as_copper(s)
    for r in text_runs(s):
        g = box(r["x0"], r["y0"], r["x1"], r["y1"])
        if below(r["height"], min_h):
            low.append(_item(cu, "silk_height", len(low), g, 0.3, r["height"], min_h,
                             f"{s.name} 一段 {int(r['n'])} 字的文字字高约 {fmt_mm(r['height'])} < {fmt_mm(min_h)}（估算）", None))  # fmt: skip
        elif r["stroke"] > 0 and r["height"] / r["stroke"] < min_ratio - 0.05:
            it = _item(cu, "silk_height_ratio", len(ratio), g, 0.3, round(r["height"] / r["stroke"], 2), min_ratio,
                       f"{s.name} 一段文字字高/笔画 ≈ {r['height'] / r['stroke']:.1f} < {min_ratio:g}:1（字高 {fmt_mm(r['height'])}，笔画 {fmt_mm(r['stroke'])}）", None)  # fmt: skip
            it.severity = "info"
            ratio.append(it)
    return {
        "silk_height": aggregate(items, low, kind="silk_height", layer=s.rel, threshold=min_h, severity="warn",
            message=f"{s.name} 字高 < {fmt_mm(min_h)}（p145 要求1，按笔画聚类估算）",
            eq_question=f"{s.name} 有文字字高低于 {fmt_mm(min_h)}（估算），印出来可能不清晰，请确认是否放大或按现状生产",
            fix=draft_fix("SilkTransform", "scale_text", f"# {s.rel}: 选中文字 Edit → Transform（Mode Anchor，Operation Scale）放大到 ≥{min_h / _MIL:.0f}mil (p146)\nCOM sel_transform,mode=anchor,oper=scale,x_scale=<k>,y_scale=<k>  【待验证】")),
        "silk_height_ratio": aggregate(items, ratio, kind="silk_height_ratio", layer=s.rel, threshold=min_ratio, severity="info", unit=":1",
            message=f"{s.name} 字高/笔画 < {min_ratio:g}:1（p145 要求2）",
            fix=draft_fix("SilkTransform", "scale_text", f"# {s.rel}: 放大字高或缩细笔画，使字高/字宽 ≥ {min_ratio:g}:1 (p145)")),
    }  # fmt: skip


def _obj_geom(o) -> Polygon | None:
    bb = _bbox(o)
    return Polygon.from_bounds(*bb) if bb else None


def split_outside(s: SilkLayer, profile: BaseGeometry, tol: float) -> tuple[list[Any], list[Any], list[Any]]:
    """(inside, fully_outside, crossing) by object bbox vs the profile grown by ``tol``."""
    grown = profile.buffer(tol)
    inside, outside, crossing = [], [], []
    for o in s.objects:
        g = _obj_geom(o)
        if g is None:
            inside.append(o)
        elif not g.intersects(grown):
            outside.append(o)
        elif grown.contains(g):
            inside.append(o)
        else:
            crossing.append(o)
    return inside, outside, crossing


def write_cleaned_gerber(gf, keep: list[Any]) -> bytes:
    """Serialise ``gf`` with only ``keep`` objects. gerbonara writes a bare ``G75`` (RS-274X
    wants ``G75*``); patch it so strict readers (and Genesis) accept the file."""
    import io

    gf.objects = keep
    buf = io.StringIO()
    gf.save(buf) if hasattr(gf, "save") and _accepts_stream(gf) else None
    text = buf.getvalue()
    if not text:
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "out.gbr"
            gf.save(p)
            text = p.read_text(encoding="utf-8", errors="replace")
    text = re.sub(r"^(G7[45])$", r"\1*", text, flags=re.MULTILINE)
    return text.encode("utf-8")


def _accepts_stream(gf) -> bool:
    return False  # gerbonara's save() takes a path; keep the tmpfile path (explicit for readers)


def check_outside_profile(ctx: JobContext, s: SilkLayer, gf, profile: BaseGeometry | None, tol: float, items: list[ReportItem], artifacts: list) -> dict[str, int]:
    if profile is None:
        return {"outside": 0, "crossing": 0}
    inside, outside, crossing = split_outside(s, profile, tol)
    L = _as_copper(s)
    if outside:
        boxes = [g for o in outside if (g := _obj_geom(o)) is not None]
        from shapely.ops import unary_union

        u = unary_union(boxes) if boxes else Polygon()
        cleaned = write_cleaned_gerber(gf, inside)
        fname = s.rel.rsplit("/", 1)[-1]
        stem, _, ext = fname.rpartition(".")
        ext = re.sub(r"[^A-Za-z0-9]+", "", ext)
        art = ctx.write_artifact("cleaned_layer", f"{safe_stem(stem or fname, 'silk')}_cleaned.{ext or 'gbr'}", cleaned)
        artifacts.append(art)
        from engine.adapters.genesis import executor_for

        self_applied = executor_for(ctx) is None  # lite: the cleaned artifact *is* the fix; native/hybrid: the engine edits the layer
        items.append(ReportItem(
            id=f"silk_outside_{s.rel}", kind="silk_outside_profile", severity="warn", layer=s.rel,
            location=loc_of(u, 0.5) if not u.is_empty else None, measured=len(outside), threshold=tol,
            message=f"{s.name} 板外字符 {len(outside)} 个对象{'已自动删除' if self_applied else '需删除'}（p147 注意4），清理后的层：{art.filename}",
            fix=Fix(type="delete", op="DeleteOutsideProfile", params={"count": len(outside), "artifact": art.path}, auto_fixable=True, applied=self_applied,
                    genesis_script=f"# {s.rel}: 选 Profile 外物件 → 删除 (p112/p147)\nCOM sel_delete  【待验证】"),
        ))  # fmt: skip
    if crossing:
        boxes = [g for o in crossing if (g := _obj_geom(o)) is not None]
        new = [_item(L, "silk_crossing_profile", i, g, 0.3, None, None, f"{s.name} 字符跨板边", None) for i, g in enumerate(boxes)]
        aggregate(items, new, kind="silk_crossing_profile", layer=s.rel, severity="warn",
            message=f"{s.name} 字符跨越板边（未自动删除）",
            eq_question=f"{s.name} 有字符/图形跨越板边，请客户确认是否删除或移入板内",
            fix=draft_fix("DeleteOutsideProfile", "move_or_delete", "# 跨板边对象需人工判断：移入板内或删除 (p147)"))  # fmt: skip
    return {"outside": len(outside), "crossing": len(crossing)}


# ---------------------------------------------------------------------------------------------
def run_silk_stage(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    artifacts = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="silk", status="failed", summary="no layer_map (run intake first)")
    files = lm.get("files", [])
    silks = [e for e in files if e.get("type") in SILK_TYPES]
    if not silks:
        return StageReport(stage="silk", status="ok", summary="无字符层")
    thr = ctx.profile["silk"]
    lcfg = ctx.profile["layer"]
    profile = load_profile(ctx)
    masks = {e["type"]: e for e in files if e.get("type") in ("top_mask", "bottom_mask")}
    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in silks + list(masks.values())])
    stats: dict[str, Any] = {"layers": {}, "height_check": "estimated (glyph clustering, p145)"}
    for e in silks:
        rel = e["file"]
        res = folded.get(rel)
        if isinstance(res, Exception) or res is None:
            items.append(ReportItem(id=f"parse_{rel}", kind="layer_parse_error", severity="error", layer=rel,
                                    message=f"无法解析 {rel}: {res}", eq_question=f"文件 {rel} 无法解析，请客户重新导出"))  # fmt: skip
            continue
        gf = open_camfile(ctx.layer_path(rel), e["type"])
        s = SilkLayer(rel=rel, layer_type=e["type"], geom=res, objects=list(gf.objects))
        m_entry = masks.get(_SIDE_MASK[e["type"]])
        openings = folded.get(m_entry["file"]) if m_entry else None
        if isinstance(openings, Exception):
            openings = None
        st: dict[str, Any] = {"objects": len(s.objects), "mask": m_entry["file"] if m_entry else None}
        st["silk_line_width"] = check_silk_width(s, thr["min_line_width_mm"], items)
        st["silk_on_opening"] = check_silk_on_opening(s, openings, thr["clearance_to_opening_mm"], items)
        st.update(check_silk_height(s, thr["min_height_mm"], thr.get("min_height_ratio", 6.0), items))
        st.update(check_outside_profile(ctx, s, gf, profile, lcfg["outside_profile_tolerance_mm"], items, artifacts))
        stats["layers"][rel] = st
    artifacts.append(ctx.write_artifact("check_summary", "silk_checks.json", json.dumps(stats, ensure_ascii=False, indent=1).encode()))
    report_add_text_requests(ctx.request.order_spec, silks[0]["file"], thr, items)
    return StageReport(stage="silk", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)


ADD_TEXT_HINTS = ("字符", "丝印", "ul", "周期", "日期", "date", "logo", "厂标", "料号", "mark", "标记", "标识", "text")


def report_add_text_requests(order_spec: dict[str, Any] | None, silk_rel: str, thr: dict[str, Any], items: list[ReportItem]) -> int:
    """p146 步骤5 / p147 注意2: the customer's notes ask for silk text (UL mark, date code, part
    number …). What and where is a person's decision → one EQ carrying an AddText draft."""
    notes = [str(n) for n in ((order_spec or {}).get("customer_notes") or []) if n]
    hits = [n for n in notes if any(k in n.lower() for k in ADD_TEXT_HINTS)]
    if not hits:
        return 0
    h_mil = thr.get("min_height_mm", 0.762) / _MIL
    w_mil = thr.get("min_line_width_mm", 0.127) / _MIL
    items.append(ReportItem(
        id="silk_add_text", kind="silk_add_text_required", severity="warn", layer=silk_rel, measured=len(hits),
        message="客户要求添加字符：" + "；".join(h[:80] for h in hits[:3]) + ("…" if len(hits) > 3 else ""),
        eq_question="客户资料要求添加字符（UL/周期/料号等），请工程师确认内容、位置、面别后在 Genesis 加字（p146 步骤5）",
        fix=draft_fix("AddText", "add_text", f"COM affected_layer,name={silk_rel},mode=single,affected=yes  【待验证】\n"
                      f"COM add_text,attributes=no,type=string,x=<x>,y=<y>,text=<text>,x_size={h_mil:.0f},y_size={h_mil:.0f},w_factor=1,polarity=positive,angle=0,mirror=no,fontname=standard  # 字宽 ≥{w_mil:.0f}mil (p145)  【待验证】\n"
                      "COM affected_layer,mode=all,affected=no  【待验证】", {"requests": hits}),
    ))  # fmt: skip
    return len(hits)
