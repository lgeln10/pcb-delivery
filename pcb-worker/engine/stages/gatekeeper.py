"""Stage ``gatekeeper``: read the produced artifacts back and compare them with the job.

Everything below is a *re-read of the files that will leave the system*, not a re-use of the
in-memory results: written Gerbers are parsed again and folded, drill tapes are counted from
their text, the IPC-D-356 is counted from its records. Any mismatch blocks the job
(MODULE.md invariant: gatekeeper mismatch → blocked).
"""

from __future__ import annotations

import json
import os

from engine.geom.from_gerbonara import (
    camfile_to_geometry,
)
from engine.geom.layers import fold_many
from engine.model.report import ReportItem, StageReport, derive_status, summarize
from engine.output.gerber_writer import read_gerber_bytes
from engine.output.ipc356 import count_records
from engine.pipeline.context import JobContext
from engine.stages.output import read_stage_report

TOL_RATIO = 0.01  # area ratio tolerance between written layer and source fold


def _read_manifest(ctx: JobContext):
    rep = read_stage_report(ctx, "output")
    if not rep:
        return None, None
    art = next((a for a in rep.artifacts if a.filename == "output_manifest.json"), None)
    if not art:
        return rep, None
    return rep, json.loads(ctx.storage.read_object(art.path).decode("utf-8"))


GENESIS_TOL_RATIO = 0.10  # Genesis edits (compensation, cutouts) legitimately move copper area a little


def _native_release_guard(ctx: JobContext, items: list[ReportItem]) -> None:
    """Never turn a native candidate into a release just because it has a permissive diff."""
    engine = os.environ.get("PCB_CAM_ENGINE", "native").lower()
    if engine not in ("native", "hybrid"):
        return
    if str((ctx.profile.get("release") or {}).get("mode", "review")).lower() == "certified":
        return
    items.append(ReportItem(
        id="gate_native_profile_review",
        kind="gate_release_profile",
        severity="warn",
        message="本地 B 线已生成候选终稿，但当前工厂 Profile 未认证，不能自动放行",
        eq_question="请核对自动修改和黄金样本差异；仅当已知规则、残差和门禁均确认后，才可将 release.mode 设为 certified",
    ))


def _check_genesis_outputs(ctx: JobContext, manifest: dict, folded: dict, items: list[ReportItem]) -> int:
    """Match every file under ``<work>/genesis_out/`` to a manifest layer by output name (or by
    source file name), re-read it and compare the copper area with the source fold."""
    gdir = ctx.work_dir / "genesis_out"
    if not gdir.is_dir():
        return 0
    by_name: dict[str, dict] = {}
    for l in manifest.get("layers", []):
        by_name[l["output"].lower()] = l
        by_name[l["file"].lower()] = l
    bad = 0
    n = 0
    for f in sorted(p for p in gdir.rglob("*") if p.is_file()):
        l = by_name.get(f.name.lower())
        if l is None:
            continue
        n += 1
        rel = l["file"]
        try:
            geom, _ = camfile_to_geometry(read_gerber_bytes(f.read_bytes()))
        except Exception as ex:  # noqa: BLE001
            bad += 1
            items.append(ReportItem(id=f"gate_genesis_{rel}", kind="gate_reread_error", severity="error", layer=rel, message=f"Genesis 成果物 {f.name} 回读失败：{type(ex).__name__}: {ex}"))
            continue
        src = folded.get(rel)
        if src is None or isinstance(src, Exception) or src.area < 1e-9:
            items.append(ReportItem(id=f"gate_genesis_{rel}", kind="gate_genesis_layer", severity="info", layer=rel, message=f"Genesis 成果物 {f.name} 回读 {geom.area:.2f} mm²（源层为空或未折叠，未比对）"))
            continue
        ratio = abs(geom.area - src.area) / src.area
        if ratio > GENESIS_TOL_RATIO or geom.is_empty:
            bad += 1
            items.append(ReportItem(id=f"gate_genesis_{rel}", kind="gate_genesis_layer", severity="error", layer=rel, measured=round(ratio, 5), threshold=GENESIS_TOL_RATIO,
                                    message=f"Genesis 成果物 {f.name} 回读铜面积 {geom.area:.2f} vs 源 {src.area:.2f} mm²（差 {ratio * 100:.1f}%，超过 {GENESIS_TOL_RATIO * 100:.0f}%）",
                                    eq_question="Genesis 输出与源资料铜面积差异过大，请工程师核对该层"))  # fmt: skip
        else:
            items.append(ReportItem(id=f"gate_genesis_{rel}", kind="gate_genesis_layer", severity="info", layer=rel, measured=round(ratio, 5), threshold=GENESIS_TOL_RATIO,
                                    message=f"Genesis 成果物 {f.name} 回读铜面积 {geom.area:.2f} vs 源 {src.area:.2f} mm²（差 {ratio * 100:.2f}%）"))  # fmt: skip
    if n:
        items.append(ReportItem(id="gate_genesis_summary", kind="gate_genesis_layer", severity="info", measured=n, message=f"Genesis 成果物回读 {n} 层，不一致 {bad} 层"))
    return bad


def run_gatekeeper(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="gatekeeper", status="failed", summary="no layer_map (run intake first)")
    out_rep, manifest = _read_manifest(ctx)
    if out_rep is None or manifest is None:
        items.append(ReportItem(id="no_output", kind="gate_no_output", severity="error", message="没有输出阶段的成果物清单，无法回读校验"))
        return StageReport(stage="gatekeeper", status="blocked", summary=summarize(items), items=items)
    files = lm.get("files", [])
    mismatches = 0

    # 1. every outputable layer has a Gerber that re-reads to the same copper area
    from engine.stages.align import chosen_outline
    from engine.stages.output import OUTPUT_TYPES

    picked = chosen_outline(ctx)
    expected = [e for e in files if e.get("type") in OUTPUT_TYPES and not (e["type"] == "outline" and picked and e["file"] != picked)]
    written = {l["file"]: l for l in manifest["layers"]}
    sx, sy = (manifest.get("origin_shift") or [0.0, 0.0])
    shift = (float(sx), float(sy))
    # 空过守卫:没有任何可输出的层,下面每一项检查都会"通过"(没东西可比),任务就以「已完成」收尾
    # 却一个生产文件都没有。守门员是最后一道线,宁可停下 —— 客户资料没解析出来(乱码/截断/
    # 只给了说明文件)时正是这种情况。
    if not expected:
        items.append(ReportItem(id="gate_no_layers", kind="gate_no_output", severity="error", measured=len(files),
                                message=f"这个任务没有任何可输出的层（识别到 {len(files)} 个文件，没有铜层/阻焊/外形），没有成果物可校验",
                                eq_question="资料里没有可用的生产层，请确认层识别结果或让客户重新提供 Gerber"))  # fmt: skip
        return StageReport(stage="gatekeeper", status="blocked", summary=summarize(items), items=items)
    missing = [e["file"] for e in expected if e["file"] not in written]
    if missing:
        mismatches += len(missing)
        items.append(ReportItem(id="gate_missing_layers", kind="gate_layer_missing", severity="error", measured=len(missing),
                                message=f"{len(missing)} 层没有输出 Gerber：{', '.join(missing[:5])}", eq_question="有层没有输出成功，需工程师处理后重跑输出"))  # fmt: skip
    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in expected if e["file"] in written])
    checked = 0
    for e in expected:
        rel = e["file"]
        l = written.get(rel)
        if not l:
            continue
        try:
            data = ctx.storage.read_object(l["path"])
            back = read_gerber_bytes(data)
            geom, _ = camfile_to_geometry(back)
        except Exception as ex:  # noqa: BLE001
            mismatches += 1
            items.append(ReportItem(id=f"gate_reread_{rel}", kind="gate_reread_error", severity="error", layer=rel, message=f"{l['output']} 回读失败：{type(ex).__name__}: {ex}"))
            continue
        src = folded.get(rel)
        if src is None or isinstance(src, Exception):
            continue
        checked += 1
        if src.area < 1e-9:
            continue  # empty layer (e.g. an unused silkscreen) re-reads as empty: nothing to compare
        if e["type"] == "outline":
            # the outline is re-drawn at the standard line width (and from the Profile when asked):
            # its *stroke* area legitimately changes — what must survive is the closed Profile (step 4)
            continue
        if shift != (0.0, 0.0):
            from shapely.affinity import translate

            src = translate(src, shift[0], shift[1])
        if e["type"] in ("top_mask", "bottom_mask"):
            # the output stage draws the Profile (+ V-cut lines, unit rings) on the mask layers: that stroke is
            # part of the source — ★同一个函数，别在这里自己算宽度（两边算法一漂就是 gate_area_mismatch）
            from shapely.affinity import translate

            from engine.output.gerber_writer import gerber_from_geometry
            from engine.stages.output import mask_profile_strokes

            spec = mask_profile_strokes(ctx)
            if spec:
                strokes, _ = camfile_to_geometry(gerber_from_geometry(spec))
                src = src.union(translate(strokes, shift[0], shift[1]))
        ratio = abs(geom.area - src.area) / max(src.area, 1e-9)
        if ratio > TOL_RATIO or len(back.objects) == 0:
            mismatches += 1
            items.append(ReportItem(id=f"gate_area_{rel}", kind="gate_area_mismatch", severity="error", layer=rel, measured=round(ratio, 5), threshold=TOL_RATIO,
                                    message=f"{l['output']} 回读铜面积 {geom.area:.2f} vs 源 {src.area:.2f} mm²（差 {ratio * 100:.2f}%）"))  # fmt: skip

    # 2. drill tapes: hole counts vs the drill table
    drill_rep = read_stage_report(ctx, "drill")
    table = None
    if drill_rep:
        art = next((a for a in drill_rep.artifacts if a.filename == "drill_table.json"), None)
        if art:
            table = json.loads(ctx.storage.read_object(art.path).decode("utf-8"))
    tape_holes = sum(d["holes"] for d in manifest.get("drills", []) if not d.get("gerber"))
    if table is not None:
        want = int(table.get("tape_holes_expected", table.get("total_holes", 0)))
        if manifest.get("drills") and tape_holes != want:
            mismatches += 1
            items.append(ReportItem(id="gate_holes", kind="gate_hole_count_mismatch", severity="error", measured=tape_holes, threshold=want,
                                    message=f"输出钻带共 {tape_holes} 孔，钻孔表 {want} 孔，不一致"))  # fmt: skip
        elif not manifest.get("drills") and want:
            mismatches += 1
            items.append(ReportItem(id="gate_no_tapes", kind="gate_drill_missing", severity="error", measured=0, threshold=want, message="钻孔表有孔但没有输出钻带"))

    # 3. IPC-D-356 records vs plated holes
    ipc = manifest.get("ipc356")
    if ipc:
        try:
            text = ctx.storage.read_object(ipc["path"]).decode("utf-8", "replace")
            rc = count_records(text)
            if rc["through"] != ipc["points"]:
                mismatches += 1
                items.append(ReportItem(id="gate_ipc", kind="gate_ipc_mismatch", severity="error", measured=rc["through"], threshold=ipc["points"],
                                        message=f"IPC-D-356 回读 {rc['through']} 条 317 记录，清单 {ipc['points']}"))  # fmt: skip
            else:
                items.append(ReportItem(id="gate_ipc_ok", kind="gate_ipc_ok", severity="info", measured=rc["through"], message=f"IPC-D-356 回读 {rc['through']} 条记录 / {rc['nets']} 网络，与清单一致"))
        except Exception as ex:  # noqa: BLE001
            mismatches += 1
            items.append(ReportItem(id="gate_ipc_err", kind="gate_reread_error", severity="error", message=f"IPC-D-356 回读失败：{ex}"))

    # 4. profile still closes on the written outline
    outline = next((e for e in expected if e["type"] == "outline"), None)
    if outline and outline["file"] in written:
        from engine.geom.profile import extract_profile

        try:
            pr = extract_profile(read_gerber_bytes(ctx.storage.read_object(written[outline["file"]]["path"])))
            if pr.profile is None:
                mismatches += 1
                items.append(ReportItem(id="gate_profile", kind="gate_profile_open", severity="error", layer=outline["file"], message="输出的外形层回读后无法闭合 Profile"))
            else:
                pw = ctx.work_dir / "profile.wkb"
                if pw.is_file():
                    from shapely import from_wkb

                    src_prof = from_wkb(pw.read_bytes())
                    r = abs(pr.profile.area - src_prof.area) / max(src_prof.area, 1e-9)
                    if r > TOL_RATIO:
                        mismatches += 1
                        items.append(ReportItem(id="gate_profile_area", kind="gate_area_mismatch", severity="error", layer=outline["file"], measured=round(r, 5), threshold=TOL_RATIO,
                                                message=f"输出外形层回读的 Profile 面积 {pr.profile.area:.1f} vs 定义的 Profile {src_prof.area:.1f} mm²（差 {r * 100:.2f}%）"))  # fmt: skip
                    else:
                        items.append(ReportItem(id="gate_profile_ok", kind="gate_profile_ok", severity="info", layer=outline["file"], measured=round(pr.profile.area, 1),
                                                message=f"输出外形层回读闭合，Profile 面积 {pr.profile.area:.1f} mm² 与定义一致"))  # fmt: skip
        except Exception as ex:  # noqa: BLE001
            mismatches += 1
            items.append(ReportItem(id="gate_profile_err", kind="gate_reread_error", severity="error", layer=outline["file"], message=f"外形层回读失败：{ex}"))

    # 5. A1.5: files a Genesis host produced (pulled to genesis_out/) must re-read as the same layers
    mismatches += _check_genesis_outputs(ctx, manifest, folded, items)

    # B line is the default executor, never an implicit release authorization.
    _native_release_guard(ctx, items)

    items.append(ReportItem(id="gate_summary", kind="gate_summary", severity="info", measured=mismatches,
                            message=f"回读校验：Gerber {checked}/{len(expected)} 层面积一致，钻带 {tape_holes} 孔{'（与钻孔表一致）' if table and tape_holes == int(table.get('total_holes', 0)) else ''}，{'IPC-D-356 一致' if ipc else '无 IPC-D-356'}；不一致 {mismatches} 项"))  # fmt: skip
    status = "blocked" if mismatches else derive_status(items)
    return StageReport(stage="gatekeeper", status=status, summary=summarize(items) + (f"; BLOCKED {mismatches} mismatches" if mismatches else ""), items=items)
