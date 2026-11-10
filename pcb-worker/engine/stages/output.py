"""Stage ``output``: 第11章 文件输出 —— 审核版 Gerber（工厂格式回写）+ 钻带 + IPC-D-356（实验）+ round-trip 自检。

The lite engine writes what it *has*: every input layer re-serialised in the factory Gerber
format (units/format from the profile, 校对用), the oversized drill tapes made by the drill
stage under the factory file names, and an experimental IPC-D-356 built from the production
netlist. Production Gerbers after Genesis editing come from Genesis (M5).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from gerbonara.utils import MM
from shapely import from_wkb
from shapely.affinity import translate
from shapely.geometry import Point

from engine.checks.common import aggregate, load_holes
from engine.geom.from_gerbonara import camfile_to_geometry
from engine.geom.layers import fold_many, open_camfile, safe_stem
from engine.ingest.classify import COPPER_TYPES, DRILL_TYPES
from engine.model.report import Fix, ReportItem, StageReport, derive_status, summarize
from engine.netlist.extract import HoleLink, extract_nets, layers_from_geoms
from engine.output.gerber_writer import (
    gerber_from_geometry,
    roundtrip,
    settings_from_profile,
    write_gerber,
)
from engine.output.ipc356 import TestPoint, write_ipc356
from engine.pipeline.context import JobContext
from engine.stages.align import chosen_outline
from engine.stages.drill import origin_shift

OUTPUT_TYPES = (
    "top_copper", "inner_copper", "bottom_copper", "top_mask", "bottom_mask",
    "top_silk", "bottom_silk", "top_paste", "bottom_paste", "outline",
)  # fmt: skip


def read_stage_report(ctx: JobContext, stage: str) -> StageReport | None:
    p = ctx.work_dir / "reports" / f"{stage}.json"
    return StageReport.model_validate_json(p.read_text(encoding="utf-8")) if p.is_file() else None


def output_name(cfg: dict[str, Any], entry: dict[str, Any], stem: str) -> str:
    t = entry["type"]
    tpl = cfg["naming"].get(t) or "{stem}_" + t
    span = entry.get("drill_span") or [1, 1]
    return tpl.format(stem=stem, n=entry.get("index") or 0, span=f"{span[0]}-{span[1]}")


def run_output(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    artifacts = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="output", status="failed", summary="no layer_map (run intake first)")
    cfg = ctx.profile["output"]
    spec = ctx.request.order_spec or {}
    stem = cfg["stem"].format(job=ctx.job_id, order=spec.get("order_no") or ctx.job_id)
    settings = settings_from_profile(cfg["gerber"])
    files = lm.get("files", [])
    picked = chosen_outline(ctx)
    # several outline layers: only the one align made the Profile from is a production layer
    entries = [e for e in files if e.get("type") in OUTPUT_TYPES and not (e["type"] == "outline" and picked and e["file"] != picked)]
    shift = origin_shift(ctx)
    sx, sy = shift
    from_profile = bool(cfg.get("outline_from_profile")) and (ctx.work_dir / "profile.wkb").is_file()
    mask_strokes = mask_profile_strokes(ctx)  # 阻焊上要画的那套描边（回读校验按同一份算源面积）
    manifest: dict[str, Any] = {"stem": stem, "gerber": cfg["gerber"], "layers": [], "drills": [], "ipc356": None, "origin_shift": [sx, sy], "outline_from_profile": from_profile}

    # 1. Gerber layers in factory format + round trip
    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in entries])
    rt_bad: list[ReportItem] = []
    for e in entries:
        rel = e["file"]
        orig = folded.get(rel)
        if isinstance(orig, Exception) or orig is None:
            items.append(ReportItem(id=f"parse_{rel}", kind="layer_parse_error", severity="error", layer=rel, message=f"无法解析 {rel}: {orig}",
                                    eq_question=f"文件 {rel} 无法解析，请客户重新导出"))  # fmt: skip
            continue
        try:
            if e["type"] == "outline" and from_profile:
                gf, orig = _outline_from_profile(ctx, cfg, shift)
                data = write_gerber(gf, settings)
            else:
                gf = open_camfile(ctx.layer_path(rel), e["type"])
                if shift != (0.0, 0.0):
                    gf.offset(sx, sy, unit=MM)
                if e["type"] in ("top_mask", "bottom_mask") and mask_strokes:
                    # 工厂习惯：阻焊层上画出外形线 + V-cut 线（work/ 两面阻焊都有 0.1 mm 的 Profile 描边）
                    strokes = gerber_from_geometry(mask_strokes, [], shift)
                    gf.objects.extend(strokes.objects)
                    orig = orig.union(camfile_to_geometry(gerber_from_geometry(mask_strokes))[0])
                data = write_gerber(gf, settings)
            if shift != (0.0, 0.0):
                orig = translate(orig, sx, sy)
            rt = roundtrip(orig, data, settings)
        except Exception as ex:  # noqa: BLE001
            items.append(ReportItem(id=f"write_{rel}", kind="gerber_write_error", severity="error", layer=rel,
                                    message=f"{rel} 回写失败：{type(ex).__name__}: {ex}", eq_question=f"{rel} 无法按工厂格式回写，请工程师检查该层（可能含 gerbonara 不支持的宏）"))  # fmt: skip
            continue
        name = output_name(cfg, e, stem)
        art = ctx.write_artifact("gerber_review", name, data)
        artifacts.append(art)
        manifest["layers"].append({"file": rel, "type": e["type"], "output": name, "roundtrip": rt, "path": art.path})
        # allowed = the bigger of the ratio limit and the format's own quantisation loss (perimeter × step)
        limit_mm2 = max(float(cfg["roundtrip_max_ratio"]) * orig.area, rt["allowed_mm2"])
        if rt["xor_mm2"] > limit_mm2 + 1e-6:
            rt_bad.append(ReportItem(id=f"rt_{rel}", kind="roundtrip_diff", severity="error", layer=rel, measured=rt["xor_mm2"], threshold=round(limit_mm2, 4),
                                     message=f"{rel} → {name} 回读 XOR {rt['xor_mm2']} mm²（{rt['ratio'] * 100:.2f}%）超过量化允许 {limit_mm2:.3f} mm²"))  # fmt: skip
    aggregate(items, rt_bad, kind="roundtrip_diff", layer="*", threshold=cfg["roundtrip_max_ratio"],
              message="Gerber 回写后回读与原图差异过大（round-trip）",
              eq_question="有层按工厂格式回写后与原图差异超限（宏/弧线/精度），请工程师核对该层是否需要在 Genesis 中输出",
              fix=Fix(type="reexport", op="ExportGerber", auto_fixable=False, applied=False, genesis_script="# 该层由 Genesis Output → Gerber274x 输出 (p156)  【待验证】"))  # fmt: skip
    items.append(ReportItem(id="gerber_out", kind="gerber_output", severity="info", measured=len(manifest["layers"]),
                            message=f"审核版 Gerber {len(manifest['layers'])} 层（{cfg['gerber']['unit']} {cfg['gerber']['number_format'][0]}.{cfg['gerber']['number_format'][1]} {cfg['gerber']['notation']} zeros={cfg['gerber']['zeros']}，p157），最大 round-trip 差异 {max((l['roundtrip']['ratio'] for l in manifest['layers']), default=0) * 100:.3f}%",
                            fix=Fix(type="export", op="ExportGerber", auto_fixable=True, applied=True)))  # fmt: skip

    # 2. drill tapes (from the drill stage) under factory names
    drill_rep = read_stage_report(ctx, "drill")
    drill_entries = {e["file"]: e for e in files if e.get("type") in DRILL_TYPES}
    taken: dict[str, int] = {}  # several source programs map to one factory name: number the later ones
    if drill_rep:
        for a in drill_rep.artifacts:
            if a.kind != "drill" or not a.filename:
                continue
            # the drill stage names its tapes after the sanitised source stem (safe_stem), so match on that
            src_rel = next((rel for rel in drill_entries if a.filename.startswith(safe_stem(Path(rel).stem, "drill"))), None)
            e = drill_entries.get(src_rel) if src_rel else None
            name = output_name(cfg, e, stem) if e else a.filename
            if a.filename.endswith("_plug.drl"):  # 塞孔钻带 (p140): its own file next to the layer's tape
                name = f"{Path(name).stem}_plug{Path(name).suffix or '.drl'}"
            elif a.filename.endswith("_2nd.drl"):  # 二钻
                name = output_name(cfg, {"type": "drill_second"}, stem)
            try:
                data = ctx.storage.read_object(a.path)
            except Exception:  # noqa: BLE001
                continue
            seen = taken.get(name, 0)
            taken[name] = seen + 1
            if seen:
                name = f"{Path(name).stem}_{seen + 1}{Path(name).suffix}"
            art = ctx.write_artifact("drill", name, data)
            artifacts.append(art)
            is_gerber = b"%FS" in data[:400] or b"%ADD" in data[:4000]  # the .2nd is a Gerber when drill_as_gerber (the factory's habit)
            manifest["drills"].append({"source": a.filename, "output": name, "path": art.path, "gerber": is_gerber,
                                       "holes": sum(1 for ln in data.decode("utf-8", "replace").splitlines() if ln[:1] == "X")})  # fmt: skip
    if drill_rep:  # 钻孔层 Gerber（工程资料）/ 内锣带（矩形孔 + 外形内挖空）
        for a in drill_rep.artifacts:
            if a.kind == "drill_gerber":
                try:
                    from gerbonara.rs274x import GerberFile

                    gf = GerberFile.open(_tmp_gerber(ctx.storage.read_object(a.path)))
                    name = output_name(cfg, {"type": "drill_gerber"}, stem)
                    art = ctx.write_artifact("drill", name, write_gerber(gf, settings))
                    artifacts.append(art)
                    manifest["drills"].append({"source": a.filename, "output": name, "path": art.path, "holes": 0, "gerber": True})
                except Exception as ex:  # noqa: BLE001
                    items.append(ReportItem(id="drill_gerber_err", kind="gerber_write_error", severity="warn", message=f"钻孔层 Gerber 回写失败：{type(ex).__name__}: {ex}"))
        inner = _inner_rout(ctx, cfg, drill_rep, shift)
        if inner is not None:
            name = output_name(cfg, {"type": "inner_rout"}, stem)
            art = ctx.write_artifact("rout", name, write_gerber(inner[0], settings))
            artifacts.append(art)
            manifest["inner_rout"] = {"output": name, "path": art.path, "contours": inner[1]}
            items.append(ReportItem(id="inner_rout", kind="rout_inner_output", severity="info", measured=inner[1], message=f"内锣带 {name}：{inner[1]} 条轮廓（矩形孔 / 外形内挖空，0.15 mm 线）"))
    if not manifest["drills"]:
        items.append(ReportItem(id="no_drill_out", kind="drill_output_missing", severity="warn", message="没有可输出的钻带（钻孔阶段未产出预大钻带）"))
    else:
        items.append(ReportItem(id="drill_out", kind="drill_output", severity="info", measured=len(manifest["drills"]),
                                message=f"钻带 {len(manifest['drills'])} 套（Excellon2 METRIC 3.3 TZ，p158）：{', '.join(d['output'] for d in manifest['drills'])}",
                                fix=Fix(type="export", op="ExportExcellon", auto_fixable=True, applied=True)))  # fmt: skip

    # 3. IPC-D-356 (experimental) from the production netlist
    copper = [e for e in files if e.get("type") in COPPER_TYPES]
    if copper:
        cu_folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in copper])
        geoms = {e["file"]: g for e in copper if (g := cu_folded.get(e["file"])) is not None and not isinstance(g, Exception)}
        n_layers = len(copper)
        spans = {e["file"]: tuple(e.get("drill_span") or (1, n_layers)) for e in files if e.get("type") in DRILL_TYPES}
        holes = [h for h in load_holes(ctx, lm) if h.attribute in ("plated", "via", "via_plug")]
        links = [HoleLink(h.x, h.y, h.dia, spans.get(h.file, (1, n_layers)), h.tool) for h in holes]
        nl = extract_nets(layers_from_geoms(copper, geoms), links)
        pts = []
        for k, h in enumerate(holes):
            net = nl.hole_net.get(k)
            name = f"N{net + 1:05d}" if net is not None else "N/C"
            pts.append(TestPoint(net=name, x_mm=h.x + sx, y_mm=h.y + sy, hole_mm=h.dia, ref="VIA" if h.attribute in ("via", "via_plug", "via_tent") else "TH", pin=h.tool or "-"))
        text = write_ipc356(ctx.job_id, pts)
        name = cfg["naming"]["ipc356"].format(stem=stem)
        art = ctx.write_artifact("ipc356", name, text)
        artifacts.append(art)
        manifest["ipc356"] = {"output": name, "points": len(pts), "nets": len({p.net for p in pts}), "path": art.path}
        items.append(ReportItem(id="ipc_out", kind="ipc356_output", severity="info", measured=len(pts),
                                message=f"IPC-D-356 {name}：{len(pts)} 个通孔测试点，{len({p.net for p in pts})} 个网络（实验性，网名为编号，仅供测试机核对数量）"))  # fmt: skip

    artifacts.append(ctx.write_artifact("dfm_report", "output_manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1).encode()))

    # 4. human-readable job report (HTML; print to PDF from the browser)
    from engine.output.report_html import build_report_html
    from engine.pipeline.registry import STAGE_NAMES

    reports = {st: r for st in STAGE_NAMES if (r := read_stage_report(ctx, st)) is not None}
    reports["output"] = StageReport(stage="output", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)
    html_text = build_report_html(ctx.job_id, reports, layer_map=lm, order_spec=spec)
    artifacts.append(ctx.write_artifact("eq_report", f"report_{ctx.job_id}.html", html_text))
    return StageReport(stage="output", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)


def _tmp_gerber(data: bytes) -> Path:
    """gerbonara reads from a path: park the bytes in a temp file (removed with the temp dir at exit)."""
    import atexit
    import shutil
    import tempfile

    d = Path(tempfile.mkdtemp(prefix="pcb-drl-"))
    atexit.register(shutil.rmtree, d, True)
    p = d / "drill_layer.gbr"
    p.write_bytes(data)
    return p


def _outline_from_profile(ctx: JobContext, cfg: dict[str, Any], shift: tuple[float, float]):
    """Outline layer redrawn from the Profile: exterior + cut-outs as ``layer.profile_line_width_mm``
    strokes, plus the factory tooling holes as flashes (what a Genesis operator exports as the
    rout/outline layer). Returns (GerberFile, geometry used for the round trip)."""
    from engine.stages.drill import tooling_rows

    width = float(ctx.profile["layer"]["profile_line_width_mm"])
    lines = _profile_strokes(ctx, width)
    flashes = [(h.x, h.y, r.dia_mm) for r in tooling_rows(ctx, ctx.profile["drill"], "outline") for h in r.holes if r.dia_mm >= 3.0]  # small tooling holes live in the drill only (3×3 job: ⌀1.5 not on gko)
    meta_path = ctx.work_dir / "profile.json"
    if meta_path.is_file():  # tooling-size circles the customer drew on the outline layer stay visible on it
        meta = json.loads(meta_path.read_text("utf-8"))
        rails_path = ctx.work_dir / "rails.wkb"
        rails = from_wkb(rails_path.read_bytes()) if rails_path.is_file() else None
        for x, y, d in meta.get("drawn_holes") or []:
            # customer-drawn tooling-size holes on the *rails* stay on the outline layer (6-layer job:
            # ⌀3.5 on the rails, golden flashes them); holes drawn inside the units (3×3: ⌀2.5/1.5,
            # 2×2: ⌀3.4) and small ones on the rails (2×2: ⌀2.0) go to the drill only
            if d >= 3.0 and rails is not None and rails.buffer(0.01).contains(Point(x, y)):
                flashes.append((x, y, d))
    gf = gerber_from_geometry(lines, flashes, shift)
    geom, _ = camfile_to_geometry(gf)
    return gf, translate(geom, -shift[0], -shift[1])


def _on_material(pts: list, prof: Any) -> list[list[tuple[float, float]]]:
    """A rail / V-cut line as the pieces that lie on board material, the first and last piece
    extended to the Profile's bounding box (through the rounded board corners). A line entirely off
    the material (empty / odd Profile) comes back whole — better one line too many than one lost."""
    from shapely.geometry import LineString

    line = LineString([tuple(pt) for pt in pts])
    try:
        got = line.intersection(prof)
    except Exception:  # noqa: BLE001 - 拓扑异常时不改变行为
        return [[tuple(pt) for pt in pts]]
    parts = [g for g in (got.geoms if hasattr(got, "geoms") else [got]) if g.geom_type == "LineString" and g.length > 0.2]
    if not parts:
        return [[tuple(pt) for pt in pts]] if prof.is_empty else []
    x0, y0, x1, y1 = prof.bounds
    (ax, ay), (bx, by) = pts[0], pts[-1]
    out = [list(g.coords) for g in sorted(parts, key=lambda g: g.project(Point(ax, ay)))]
    horizontal = abs(bx - ax) >= abs(by - ay)
    first, last = out[0], out[-1]
    if horizontal:
        lo, hi = (x0, x1) if ax <= bx else (x1, x0)
        first[0] = (lo, first[0][1])
        last[-1] = (hi, last[-1][1])
    else:
        lo, hi = (y0, y1) if ay <= by else (y1, y0)
        first[0] = (first[0][0], lo)
        last[-1] = (last[-1][0], hi)
    return out


def _customer_outline_strokes(ctx: JobContext, width: float, prof: Any) -> list[tuple[list[tuple[float, float]], float]]:
    """The customer's own outline drawing as strokes (``output.outline_source: customer``): when the
    customer drew the complete panel (3×3 Altium job: units, rails, the 1.59 mm strip, tabs and the
    U channels under the edge notches on Keep-Out / Mechanical 1), the engineer's gko *is* that
    drawing — rebuilding rails from the Profile drew lines he never drew (gko 12–15 %). Lines and
    arcs of the customer's *source* file (``src/``: same frame as the Profile; the edit copy already
    carries the rails / notches SetProfile drew), anything outside the Profile bounds (legend,
    title block) dropped."""
    import math

    from gerbonara import graphic_objects as go
    from gerbonara.rs274x import GerberFile
    from gerbonara.utils import MM

    lm = ctx.layer_map() or {}
    rel = next((e["file"] for e in lm.get("files", []) if e.get("type") == "outline"), None)
    if rel is None:
        return []
    x0, y0, x1, y1 = prof.bounds
    m = 1.0
    out: list[tuple[list[tuple[float, float]], float]] = []
    for o in GerberFile.open(ctx.orig_path(rel)).objects:
        try:
            c = o.converted(MM)
        except Exception:  # noqa: BLE001 — a region on the outline layer is not a stroke
            continue
        if isinstance(o, go.Line):
            pts = [(c.x1, c.y1), (c.x2, c.y2)]
        elif isinstance(o, go.Arc):
            cx, cy = c.x1 + c.cx, c.y1 + c.cy  # gerbonara: the centre is relative to the start point
            r = math.hypot(c.x1 - cx, c.y1 - cy)
            a0, a1 = math.atan2(c.y1 - cy, c.x1 - cx), math.atan2(c.y2 - cy, c.x2 - cx)
            if c.clockwise:
                while a1 > a0:
                    a1 -= 2 * math.pi
            else:
                while a1 < a0:
                    a1 += 2 * math.pi
            if abs(a1 - a0) < 1e-9:
                a1 = a0 + (-2 * math.pi if c.clockwise else 2 * math.pi)
            n = max(8, int(abs(a1 - a0) * r / 0.05))
            pts = [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
        else:
            continue
        if all(x0 - m <= x <= x1 + m and y0 - m <= y <= y1 + m for x, y in pts):
            out.append((pts, width))
    return out


def mask_profile_strokes(ctx: JobContext) -> list[tuple[list[tuple[float, float]], float]]:
    """阻焊层上要画的那一套描边：拼板外缘 ``outline_on_mask_mm``、锣路 / 挖空 / V-cut 线 / 每只单元的圈
    ``rout_on_mask_mm``（不给就同外缘）。``[]`` = 这块板不在阻焊上画外形。

    ★输出阶段画它、回读校验(gatekeeper)按它算源面积 —— 必须是同一份。
    2026-09-22 就是因为两边各算各的（回读只用了外缘那个宽度）：3×3 / 2×2 板阻焊回读面积比源大 1.4–4.5%，
    两块板都卡在 gate_area_mismatch。"""
    cfg = ctx.profile.get("output") or {}
    on_mask = float(cfg.get("outline_on_mask_mm", 0) or 0)
    if on_mask <= 0 or not (ctx.work_dir / "profile.wkb").is_file():
        return []
    # 锣槽 / 缺口的描边可以另一个宽度：终稿 2×2 板和 3×3 板拼板外缘 + V-cut 线都是 0.15、锣槽轮廓 0.2，六层板全 0.2
    return _profile_strokes(ctx, on_mask, float(cfg.get("rout_on_mask_mm") or on_mask or 0), units=True)


def _profile_strokes(ctx: JobContext, width: float, rout_width: float | None = None, units: bool = False) -> list[tuple[list[tuple[float, float]], float]]:
    """The Profile as strokes: exterior, cut-outs and — when rails were merged in — the rail/board
    boundaries (V-cut lines) the factory draws on the outline and mask layers. ``rout_width`` (default
    ``width``) is for the rout paths inside the board — slots and edge notches — which the 2×2 / 3×3
    jobs' finished masks stroke at 0.2 while the panel edge and the V-cut lines are 0.15."""
    # 第 16 轮量错过一次：V-cut 线 / 单元边界（rail_lines）终稿也是 0.2（2×2 板每只单元描一圈 0.2、3×3 板 30/40 长的那些），
    # 只有 Profile 自己的外圈（和内圈）是 0.15 —— profile.json 里来的东西一律按 rout_width
    rw = float(rout_width) if rout_width else width
    from shapely import from_wkb

    prof = from_wkb((ctx.work_dir / "profile.wkb").read_bytes())
    if str((ctx.profile.get("output") or {}).get("outline_source", "profile")) == "customer":
        return _customer_outline_strokes(ctx, width, prof)
    lines: list[tuple[list[tuple[float, float]], float]] = []
    for pg in (list(prof.geoms) if hasattr(prof, "geoms") else [prof]):
        lines.append((list(pg.exterior.coords), width))
        for ring in pg.interiors:  # 板内的挖空 / 单元切口是锣路：3×3 板终稿 13/26 长的那些竖边 0.2，只有外圈 0.15
            lines.append((list(ring.coords), rw))
    meta_path = ctx.work_dir / "profile.json"
    rails_path = ctx.work_dir / "rails.wkb"
    if units and rails_path.is_file():  # 只有阻焊层这么画；外形层（gko）终稿就是外框 + V-cut 线，第 18 轮把单元圈画上去 gko 13.1% → 21.6%
        # 每只单元描一圈（rout_width）：三块板终稿的阻焊都是这么画的 —— 2×2 板四个 73×83 的框、3×3 板每只单元
        # 带 L 形切口的轮廓（30/40 长的横边 + 13/26 的竖边）、六层单板就是板材外框。单元 = Profile − 工艺边；
        # 单元与工艺边 / 单元与单元的边界（V-cut 线）就是单元的边，不用再单独画 rail_lines
        from shapely.geometry import LineString

        rails = from_wkb(rails_path.read_bytes())
        board = prof.difference(rails)
        for u in (list(board.geoms) if hasattr(board, "geoms") else [board]):
            if u.is_empty or u.area < 1.0:
                continue
            lines.append((list(u.exterior.coords), rw))
            for ring in u.interiors:
                lines.append((list(ring.coords), rw))
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text("utf-8"))
        # V-cut 线：只画在板材上，但两头拉到 Profile 外框。六层板终稿 x 0..500 而板材是 3..497（线头伸出
        # 圆角板角 3 mm）；3×3 板终稿在两只单元之间的 6 mm 锣通道处是断开的。同一条规则两块板都对：
        # 锣掉的通道没有板材 → 断；板角外只是圆角 → 端头延到外框
        # 单元圈画了 V-cut 线也照画：Profile − 工艺边只分出列，行与行之间的 V-cut 线不是单元的边（第 18 轮漏了 y=96.6 那两条，
        # 2×2 板 gts C 档 0.48% → 1.62%）；重叠的线段无害
        for ln in meta.get("rail_lines") or []:
            if len(ln) >= 2:
                for piece in _on_material(ln, prof):
                    lines.append((piece, rw))
        # every other rout path is outlined the same way (2×2 job: gko 0.15 / masks 0.2 around the
        # keep-out slots and the edge notches): slots drawn as wide strokes → their outline; a hole
        # breaking through the edge → a full circle
        from shapely.geometry import LineString

        for pts, w in meta.get("drawn_slots") or []:
            if len(pts) >= 2 and w > 0:
                ring = LineString([tuple(pt) for pt in pts]).buffer(w / 2, join_style="round")
                lines.append((list(ring.exterior.coords), rw))
        for x, y, d in meta.get("edge_notches") or []:
            n = 64
            lines.append(([(x + d / 2 * math.cos(2 * math.pi * i / n), y + d / 2 * math.sin(2 * math.pi * i / n)) for i in range(n + 1)], rw))
    return lines


def _inner_rout(ctx: JobContext, cfg: dict[str, Any], drill_rep: StageReport, shift: tuple[float, float]):
    """Inner rout layer (gko1): rectangle holes the drill stage handed over + the Profile's own
    cut-outs, as closed 0.15 mm contours. None when there is nothing to rout inside the board."""
    from shapely import from_wkb
    from shapely.geometry import LineString

    from engine.geom.rout_shapes import rout_ring

    width = float(ctx.profile["layer"]["profile_line_width_mm"])
    lines: list[tuple[list[tuple[float, float]], float]] = []
    art = next((a for a in drill_rep.artifacts if a.filename == "rect_rout.json"), None)
    if art:
        doc = json.loads(ctx.storage.read_object(art.path).decode("utf-8"))
        over = float(doc.get("oversize_mm", 0) or 0)  # drill.rect_rout_oversize_mm: the factory draws 4×11 as 4.1×11.1
        for c in doc.get("contours", []):
            # the routed path with square ends: the rectangle the tool actually cuts
            rect = LineString([(c["x1"], c["y1"]), (c["x2"], c["y2"])]).buffer((c["width_mm"] + over) / 2, cap_style=3, join_style=2)
            lines.append((list(rect.exterior.coords), width))
        for c in doc.get("circles", []):  # order-specified circles / 梅花 at hole positions (压接孔 ⌀5)
            x, y, d = c[0], c[1], c[2]
            shape = c[3] if len(c) > 3 else None
            lines.append((rout_ring(x, y, d, shape), width))
    pw = ctx.work_dir / "profile.wkb"
    if pw.is_file() and cfg.get("outline_from_profile"):
        prof = from_wkb(pw.read_bytes())
        for pg in (list(prof.geoms) if hasattr(prof, "geoms") else [prof]):
            for ring in pg.interiors:
                lines.append((list(ring.coords), width))
    if not lines:
        return None
    return gerber_from_geometry(lines, [], shift), len(lines)
