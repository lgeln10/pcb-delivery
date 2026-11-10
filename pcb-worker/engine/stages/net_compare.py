"""Stage ``net_compare``: 第6章 p130 网络分析 —— 生产网表提取 + 两次比较（正常 / 减铜）。"""

from __future__ import annotations

import json
from typing import Any

from engine.checks.common import aggregate, draft_fix, fmt_mm, load_holes, loc_of
from engine.geom.layers import fold_many, open_camfile
from engine.ingest.classify import COPPER_TYPES, DRILL_TYPES
from engine.model.report import ReportItem, StageReport, derive_status, summarize
from engine.netlist.extract import (
    HoleLink,
    apply_declared,
    compare_reduced,
    declared_points,
    extract_nets,
    find_shorts_and_opens,
    layers_from_geoms,
    netlist_json,
    reduce_layers,
)
from engine.pipeline.context import JobContext


def _line_widths(objects: list[Any]) -> list[float]:
    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM

    out = []
    for o in objects:
        if isinstance(o, (go.Line, go.Arc)) and o.polarity_dark:
            try:
                out.append(float(o.aperture.equivalent_width(unit=MM)))
            except Exception:  # noqa: BLE001
                pass
    return out


def run_net_compare(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="net_compare", status="failed", summary="no layer_map (run intake first)")
    files = lm.get("files", [])
    copper = [e for e in files if e.get("type") in COPPER_TYPES]
    if not copper:
        return StageReport(stage="net_compare", status="ok", summary="无铜层")
    cfg = ctx.profile["netlist"]
    ignore = set(cfg.get("ignore_nets", []))
    n_layers = len(copper)
    spans = {e["file"]: tuple(e.get("drill_span") or (1, n_layers)) for e in files if e.get("type") in DRILL_TYPES}

    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in copper])
    geoms = {}
    for e in copper:
        g = folded.get(e["file"])
        if isinstance(g, Exception) or g is None:
            items.append(ReportItem(id=f"parse_{e['file']}", kind="layer_parse_error", severity="error", layer=e["file"],
                                    message=f"无法解析 {e['file']}: {g}", eq_question=f"文件 {e['file']} 无法解析，请客户重新导出"))  # fmt: skip
            continue
        geoms[e["file"]] = g
    layers = layers_from_geoms(copper, geoms)
    holes = [
        HoleLink(h.x, h.y, h.dia, spans.get(h.file, (1, n_layers)), h.tool)
        for h in load_holes(ctx, lm)
        if h.attribute in ("plated", "via", "via_plug")
    ]
    nl = extract_nets(layers, holes)

    # 1. declared names (%TO.N)
    declared = {}
    drawn_widths: list[float] = []
    drawn_by_layer: dict[str, list[float]] = {}
    kind_of_layer = {e["file"]: e["type"] for e in copper}
    ref_from_orig: list[str] = []
    for e in copper:
        if e["file"] not in layers:
            continue
        objects = list(open_camfile(ctx.layer_path(e["file"]), e["type"]).objects)
        drawn_by_layer[e["file"]] = _line_widths(objects)
        drawn_widths.extend(drawn_by_layer[e["file"]])
        pts = declared_points(objects, ignore)
        # The reference netlist is the customer's *design intent*, so it comes from their file.
        # It has to: gerbonara's writer drops %TO object attributes, so the B line's edit copy
        # carries none — reading names off it silently turned short/open detection into "no
        # reference netlist" on every natively-edited job (2026-09-07). Coordinates match because
        # the edit copy is derived from the customer file in the same coordinate system.
        if not pts:
            op = ctx.orig_path(e["file"])
            if op.is_file() and op != ctx.layer_path(e["file"]):
                pts = declared_points(list(open_camfile(op, e["type"]).objects), ignore)
                if pts:
                    ref_from_orig.append(e["file"])
        if pts:
            declared[e["file"]] = pts
    has_ref = bool(declared)
    if ref_from_orig:
        items.append(ReportItem(id="net_ref_from_orig", kind="net_reference_from_orig", severity="info", measured=len(ref_from_orig),
                                message=f"设计网名取自客户原稿（{len(ref_from_orig)} 层）：本地引擎的改图副本不带 %TO 网名，生产网表仍按改后的铜提取"))  # fmt: skip
    stats: dict[str, Any] = {"declared_layers": len(declared), "holes_linking": len(holes)}
    if has_ref:
        unplaced = apply_declared(nl, declared)
        shorts, opens = find_shorts_and_opens(nl)
        sd = [
            ReportItem(id=f"net_short_{i}", kind="net_short", severity="error", layer=s.where[0],
                       location=loc_of(s.where[1], 0.3), measured=len(s.names),
                       message=f"短路：网络 {' / '.join(s.names[:4])} 在生产网表里连成一个（{len(s.net.nodes)} 块铜，{len(s.net.layers)} 层）")
            for i, s in enumerate(shorts)
        ]  # fmt: skip
        od = [
            ReportItem(id=f"net_open_{i}_{k}", kind="net_open", severity="error", layer=rel,
                       location=loc_of(poly, 0.3), measured=len(o.nets),
                       message=f"开路：网络 {o.name} 在生产网表里分成 {len(o.nets)} 段（此段在 {rel}）")
            for i, o in enumerate(opens) for k, (rel, poly) in enumerate(o.pieces)
        ]  # fmt: skip
        stats.update(shorts=len(shorts), opens=len(opens), unplaced_names=len(unplaced))
        aggregate(items, sd, kind="net_short", layer="*", message="生产网表短路（与设计网名比对，p130）",
                  eq_question="生产网表与设计网名比对发现短路（不同网名的铜连在一起），请客户确认是设计如此还是资料错误",
                  fix=draft_fix("NetlistCompare", "netlist_short", "# Actions → Netlist Analyzer → 比较原稿与生产网络，定位短路 (p130)  【待验证】"))  # fmt: skip
        aggregate(items, od, kind="net_open", layer="*", message="生产网表开路（与设计网名比对，p130）",
                  eq_question="生产网表与设计网名比对发现开路（同一网名的铜没有连通），请客户确认",
                  fix=draft_fix("NetlistCompare", "netlist_open", "# Actions → Netlist Analyzer → 比较，定位开路 (p130)  【待验证】"))  # fmt: skip
        if unplaced:
            items.append(ReportItem(id="net_unplaced", kind="net_unplaced_names", severity="info", measured=sum(len(v) for v in unplaced.values()),
                                    message=f"{sum(len(v) for v in unplaced.values())} 个带网名的对象落在铜以外（负片/清除区），未参与比对"))  # fmt: skip
    else:
        items.append(ReportItem(id="no_ref_netlist", kind="no_reference_netlist", severity="info",
                                message="Gerber 无 %TO.N 网名（非 X2 导出），无法与设计网表比对；只做减铜比较。如客户提供 IPC-D-356 可在 M3 输出阶段比对"))  # fmt: skip

    # 2. copper reduction (p130 第二次减铜). The book's 0.15 mm targets slivers between pours;
    # on a board drawn with 0.1 mm traces a 0.15 mm shrink erases every trace, so the shrink is
    # capped below the thinnest *drawn* line width (a designed trace is not a sliver).
    reduce_mm = float(cfg["reduce_mm"])
    # the reduction decision is an inner-layer rule: cap by the thinnest *inner* drawn line when
    # there are inner layers (a 3 mil outer trace must not weaken the inner-plane check)
    polarity_of = {e["file"]: e.get("polarity") or "positive" for e in copper}
    inner_widths = [w for rel, ws in drawn_by_layer.items() for w in ws if kind_of_layer.get(rel) == "inner_copper" and polarity_of[rel] != "negative"]
    min_drawn = min((w for w in (inner_widths or drawn_widths) if w > 0), default=None)
    capped = False
    if min_drawn is not None and reduce_mm > min_drawn * float(cfg.get("reduce_cap_ratio", 0.8)):
        reduce_mm = round(min_drawn * float(cfg.get("reduce_cap_ratio", 0.8)), 4)
        capped = True
        items.append(ReportItem(id="net_reduce_capped", kind="net_reduce_capped", severity="info", measured=reduce_mm, threshold=float(cfg["reduce_mm"]),
                                message=f"板上最细线宽 {fmt_mm(min_drawn)}，减铜量从 {fmt_mm(float(cfg['reduce_mm']))} 降到 {fmt_mm(reduce_mm)}（否则设计线路会被全部缩掉）"))  # fmt: skip
    # Negative films are clearances, not copper: shrinking them means nothing → positive layers only.
    kind_of = {e["file"]: e["type"] for e in copper}
    positive = {rel: L for rel, L in layers.items() if next((e.get("polarity") for e in copper if e["file"] == rel), "positive") != "negative"}
    nl_pos = extract_nets(positive, holes) if len(positive) != len(layers) else nl
    reduced = extract_nets(reduce_layers(positive, reduce_mm), holes)
    splits = compare_reduced(nl_pos, reduced)

    def _msg(s, rel):
        return f"网络 {sorted(s.net.names)[0] if s.net.names else '#' + str(s.net.id)} 缩铜 {fmt_mm(reduce_mm)} 后断成 {s.n_pieces} 段（此段在 {rel}）：有窄于 {fmt_mm(reduce_mm)} 的连铜"

    inner_d = [ReportItem(id=f"net_reduce_{i}_{k}", kind="net_open_after_reduce", severity="warn", layer=rel, location=loc_of(poly, 0.3), measured=s.n_pieces, threshold=reduce_mm, message=_msg(s, rel))
               for i, s in enumerate(splits) for k, (rel, poly) in enumerate(s.pieces) if kind_of.get(rel) == "inner_copper"]  # fmt: skip
    outer_d = [ReportItem(id=f"net_reduce_o_{i}_{k}", kind="net_open_after_reduce_outer", severity="info", layer=rel, location=loc_of(poly, 0.3), measured=s.n_pieces, threshold=reduce_mm, message=_msg(s, rel))
               for i, s in enumerate(splits) for k, (rel, poly) in enumerate(s.pieces) if kind_of.get(rel) != "inner_copper"]  # fmt: skip
    # The book's second compare is an *inner-layer* check (第6章 内层网络比较): planes joined by
    # slivers. On outer layers a 0.2 mm trace meeting a fine-pitch pad "splits" too, so those are
    # informative only. capped = board finer than the rule → shrink at the precision floor → info.
    aggregate(items, inner_d, kind="net_open_after_reduce", layer="*", severity="info" if capped else "warn", threshold=reduce_mm, unit=" 段",
              message=f"内层减铜 {fmt_mm(reduce_mm)} 后开路（p130 第二次比较{'，减铜量已按最细线宽下调，仅供参考' if capped else ''}）",
              eq_question=None if capped else f"内层有网络靠窄于 {fmt_mm(reduce_mm)} 的细铜连通，蚀刻偏差可能导致开路，请客户确认是否加宽",
              fix=draft_fix("NetlistCompare", "thin_connection", f"# 减铜比较：Edit → Resize → Global -{reduce_mm}mm 后 Netlist Analyzer 比较 (p130)  【待验证】"))  # fmt: skip
    aggregate(items, outer_d, kind="net_open_after_reduce_outer", layer="*", severity="info", threshold=reduce_mm, unit=" 段",
              message=f"外层减铜 {fmt_mm(reduce_mm)} 后断开（细线接窄焊盘处，仅供参考）",
              fix=draft_fix("NetlistCompare", "thin_connection_outer", "# 外层细连铜位置：Netlist Analyzer 减铜比较可复现 (p130)  【待验证】"))  # fmt: skip
    stats.update(nets=len(nl.nets), reduced_splits=len(splits))
    items.append(ReportItem(id="net_summary", kind="net_summary", severity="info", measured=len(nl.nets),
                            message=f"生产网表 {len(nl.nets)} 个网络（{sum(1 for n in nl.nets if len(n.layers) > 1)} 个跨层），镀孔连接 {len(holes)} 个；{'与设计网名比对：' + str(stats.get('shorts', 0)) + ' 短 ' + str(stats.get('opens', 0)) + ' 开' if has_ref else '无设计网名'}；减铜后断开 {len(splits)}"))  # fmt: skip
    artifacts = [ctx.write_artifact("dfm_report", "netlist.json", json.dumps({**netlist_json(nl, reduced_splits=splits), "stats2": stats}, ensure_ascii=False, indent=1).encode())]
    return StageReport(stage="net_compare", status=derive_status(items), summary=summarize(items), items=items, artifacts=artifacts)
