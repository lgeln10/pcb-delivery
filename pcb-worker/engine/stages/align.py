"""Stage ``align``: fold layers to geometry, check registration against the drill layer,
define the profile, count board-outside objects and lay out the orig/net/edit steps.

Rules referenced (knowledge/rules/layer_naming.yaml):
- layer.prep.align_to_drill (p111)   资料对齐以钻孔层为基准
- layer.prep.profile_line_width (p111) 把外形线变成 0.15MM，定义 Profile
- layer.prep.backup_plus1 / net_step / edit_step (p111-112) 三副本 orig / net / edit
"""

from __future__ import annotations

import json
import math
import re
import shutil
from typing import Any

from shapely import to_wkb
from shapely.geometry import LineString, MultiPolygon, Point
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from engine.geom.layers import fold_many, open_camfile
from engine.geom.profile import extract_profile
from engine.geom.svg import iter_polygons
from engine.ingest.classify import DRILL_TYPES
from engine.model.report import Fix, Location, ReportItem, StageReport, derive_status, summarize
from engine.pipeline.context import JobContext

FOLDABLE = {
    "top_copper", "inner_copper", "bottom_copper", "top_mask", "bottom_mask", "top_silk",
    "bottom_silk", "top_paste", "bottom_paste", "outline", *DRILL_TYPES,
}  # fmt: skip
STEP_NAMES = ("orig", "net", "edit")


def _bbox(geom: BaseGeometry) -> tuple[float, float, float, float] | None:
    if geom.is_empty:
        return None
    x0, y0, x1, y1 = geom.bounds
    return (round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4))


def _center(b: tuple[float, float, float, float]) -> tuple[float, float]:
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def _copy_steps(ctx: JobContext, layer_files: list[str]) -> dict[str, int]:
    """M1: the three Genesis steps are plain file copies.

    orig = everything as received; net/edit = layer files only (p111/p112).
    """
    counts = {}
    steps = ctx.work_dir / "steps"
    for name in STEP_NAMES:
        dest = steps / name
        if dest.exists() and name != "edit":  # edit keeps the B line's edits across re-runs (intake wipes it)
            shutil.rmtree(dest)
        if name == "orig":
            shutil.copytree(ctx.src_dir, dest)
            counts[name] = sum(1 for p in dest.rglob("*") if p.is_file())
        else:
            n = 0
            for rel in layer_files:
                src = ctx.src_path(rel)
                if src.is_file():
                    out = dest / rel
                    if name == "edit" and out.is_file():
                        n += 1
                        continue
                    out.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, out)
                    n += 1
            counts[name] = n
    return counts


def run_align(ctx: JobContext) -> StageReport:
    items: list[ReportItem] = []
    lm = ctx.layer_map()
    if not lm:
        return StageReport(stage="align", status="failed", summary="no layer_map (run intake first)")
    cfg = ctx.profile["layer"]
    entries = [f for f in lm.get("files", []) if f.get("type") in FOLDABLE]

    # 1. fold every layer (cached as WKB)
    geoms: dict[str, BaseGeometry] = {}
    bboxes: dict[str, tuple[float, float, float, float] | None] = {}
    folded = fold_many(ctx.cache_dir, [(ctx.layer_path(e["file"]), e["file"], e["type"]) for e in entries])
    for e in entries:
        rel = e["file"]
        res = folded.get(rel)
        if isinstance(res, Exception) or res is None:
            ex = res or RuntimeError("not folded")
            items.append(
                ReportItem(
                    id=f"parse_{len(items)}", kind="layer_parse_error", severity="error", layer=rel,
                    message=f"无法解析 {rel}: {type(ex).__name__}: {ex}",
                    eq_question=f"文件 {rel} 无法解析，请客户确认文件是否损坏或重新导出",
                )
            )  # fmt: skip
            continue
        geoms[rel] = res
        bboxes[rel] = _bbox(geoms[rel])
        if bboxes[rel] is None:
            items.append(
                ReportItem(
                    id=f"empty_{len(items)}", kind="layer_empty", severity="info", layer=rel,
                    message=f"{rel} 无图形",
                )
            )  # fmt: skip

    # 2. registration: every layer's bbox centre vs. the drill layers' (p111 以钻孔层为基准)
    drill_boxes = [bboxes[e["file"]] for e in entries if e["type"] in DRILL_TYPES and bboxes.get(e["file"])]
    ref_name = "drill"
    if drill_boxes:
        ref = (
            min(b[0] for b in drill_boxes), min(b[1] for b in drill_boxes),
            max(b[2] for b in drill_boxes), max(b[3] for b in drill_boxes),
        )  # fmt: skip
    else:
        outline_boxes = [bboxes[e["file"]] for e in entries if e["type"] == "outline" and bboxes.get(e["file"])]
        ref = outline_boxes[0] if outline_boxes else None
        ref_name = "outline"
        items.append(
            ReportItem(
                id="no_drill_ref", kind="no_drill_reference", severity="warn",
                message="没有钻孔层可作对齐基准，改用外形层",
            )
        )  # fmt: skip
    offsets: dict[str, float] = {}
    if ref:
        rcx, rcy = _center(ref)
        tol = cfg["align_offset_warn_mm"]
        for e in entries:
            rel = e["file"]
            b = bboxes.get(rel)
            if not b or e["type"] in DRILL_TYPES:
                continue
            cx, cy = _center(b)
            d = math.hypot(cx - rcx, cy - rcy)
            offsets[rel] = round(d, 3)
            # a sparse layer (paste, a few silk marks) that sits entirely inside the drilled
            # area cannot be shown misaligned by its bbox centre; only layers reaching outside
            # the reference box by more than the tolerance are suspicious
            inside_ref = (
                b[0] >= ref[0] - tol and b[1] >= ref[1] - tol and b[2] <= ref[2] + tol and b[3] <= ref[3] + tol
            )
            if d > tol and not inside_ref:
                # a clean shift = same extents as the reference (within tol): the whole layer is displaced
                clean = abs((b[2] - b[0]) - (ref[2] - ref[0])) <= tol and abs((b[3] - b[1]) - (ref[3] - ref[1])) <= tol
                dx, dy = round(rcx - cx, 4), round(rcy - cy, 4)
                items.append(
                    ReportItem(
                        id=f"offset_{len(items)}", kind="layer_offset", severity="warn", layer=rel,
                        location=Location(x=cx, y=cy, bbox=b), measured=round(d, 3),
                        threshold=cfg["align_offset_warn_mm"],
                        message=f"{rel} 中心相对{ref_name}层偏移 {d:.2f} mm（{'整层平移，可对齐' if clean else '外框尺寸不同，未自动移动'}）",
                        # only a clean whole-layer shift is an AlignToDrill fix; a layer with other extents is
                        # just reported (its bbox centre says nothing about alignment)
                        fix=Fix(type="translate", op="AlignToDrill", params={"dx": dx, "dy": dy, "clean_shift": True}, auto_fixable=False, applied=False,
                                genesis_script=f"# p111 以钻孔层为基准对齐：{rel} 平移 ({dx}, {dy}) mm\nCOM affected_layer,name={rel},mode=single,affected=yes  【待验证】\nCOM sel_all_feat  【待验证】\nCOM sel_move,dx={dx},dy={dy}  【待验证】\nCOM affected_layer,mode=all,affected=no  【待验证】") if clean else None,
                    )
                )  # fmt: skip

    # 3. profile from the outline layer (p111 定义 Profile, 外形线 0.15MM)
    profile = None
    outline_entries = [e for e in entries if e["type"] == "outline"]
    artifacts = []
    chosen = choose_outline(ctx, outline_entries, entries, bboxes, cfg, items)
    if chosen is not None:
        oe, pr = chosen
        if pr.profile is None:
            items.append(
                ReportItem(
                    id="profile_open", kind="profile_not_closed", severity="error", layer=oe["file"],
                    message=f"外形层 {oe['file']} 无法闭合成 Profile（{pr.reason}，{pr.n_objects} 个对象）",
                    eq_question="外形层线段不闭合，无法定义 Profile，请客户确认外形或由工程师手工闭合",
                )
            )  # fmt: skip
        else:
            profile = pr.profile
            (ctx.work_dir / "profile.wkb").write_bytes(to_wkb(profile))
            artifacts.append(ctx.write_artifact("profile", "profile.wkb", to_wkb(profile)))
            target = cfg["profile_line_width_mm"]
            bad = sorted(w for w in pr.widths if abs(w - target) > 0.005)
            if bad:
                mil = target / 0.0254
                items.append(
                    ReportItem(
                        id="profile_line_width", kind="profile_line_width", severity="info", layer=oe["file"],
                        measured=", ".join(f"{w:.3f}" for w in bad), threshold=target,
                        message=f"外形线宽 {bad} mm ≠ {target} mm，建议在 Genesis 中改为 {target} mm",
                        fix=Fix(
                            type="set_profile_line_width", op="SetProfile",
                            params={"from": bad, "to": target, "layer": oe["file"]},
                            auto_fixable=False, applied=False,
                            genesis_script=f"COM sel_change_sym,symbol=r{mil:.3f}",
                        ),
                    )
                )  # fmt: skip
            if pr.n_rings > 1:
                items.append(
                    ReportItem(
                        id="profile_rings", kind="profile_extra_rings", severity="info", layer=oe["file"],
                        measured=pr.n_rings,
                        message=f"外形层含 {pr.n_rings} 个闭合环：最大者为板外形" + (f"，{pr.attached_rings} 个贴着板边的并入 Profile（工艺边）" if pr.attached_rings else "") + (f"，{len(pr.drawn_holes)} 个小圆按画在外形层上的孔处理（p113，复制到钻孔层）" if pr.drawn_holes else "") + "，其余按挖空处理",
                    )
                )  # fmt: skip
            if pr.set_info:
                si = pr.set_info
                rails_txt = "、".join(f"{k[5:-3]} {v}" for k, v in si.items() if k.startswith("rail_") and k.endswith("_mm"))
                items.append(
                    ReportItem(
                        id="profile_set", kind="profile_set", severity="info", layer=oe["file"], measured=si.get("units"),
                        message=(
                            f"外形层是 {si.get('nx')}×{si.get('ny')}={si.get('units')} 只的成品拼板（单只 {si.get('unit_w')}×{si.get('unit_h')}，列距 {si.get('gap_x')} / 行距 {si.get('gap_y')}），"
                            + (f"客户自己画了 {si['customer_rails']} 条工艺边，" if si.get("customer_rails") else "")
                            + (f"按订单拼板尺寸 {si['set_w']}×{si['set_h']} 补工艺边（{rails_txt}）" if si.get("spec_rails") else f"整体 {si.get('drawn_w')}×{si.get('drawn_h')}")
                            + "；相邻单元/工艺边的公共边作 V-cut 线（p148–151 客户 SET）"
                        ),
                        fix=Fix(type="set_profile", op="SetProfile", params={k: v for k, v in si.items()}, auto_fixable=True, applied=True,
                                genesis_script=f"# p149 客户 SET：{si.get('nx')}×{si.get('ny')}，profile 取整个拼板" + (f"，补工艺边 {rails_txt}" if si.get("spec_rails") else "")),
                    )
                )  # fmt: skip
            if pr.drawn_holes:
                dias = sorted({d for _x, _y, d in pr.drawn_holes})
                items.append(
                    ReportItem(
                        id="outline_drawn_holes", kind="outline_drawn_holes", severity="info", layer=oe["file"], measured=len(pr.drawn_holes),
                        message=f"外形层上画了 {len(pr.drawn_holes)} 个圆（⌀{', '.join(f'{d:g}' for d in dias)}），钻孔层没有：按 NPTH 加进钻带（p113 分孔图/外形层上的孔复制到钻孔层）",
                        fix=Fix(type="add_holes", op="AddHolesFromDrawing", params={"count": len(pr.drawn_holes), "dias_mm": dias, "plated": False}, auto_fixable=True, applied=True,
                                genesis_script=f"# p113 外形层 {oe['file']} 上的圆复制到钻孔层（NPTH）\nCOM sel_copy_other,dest=layer_name,target_layer=<drl>,invert=no,dx=0,dy=0,size=0  【待验证】"),
                    )
                )  # fmt: skip
            if pr.edge_notches:
                dias = sorted({d for _x, _y, d in pr.edge_notches})
                nb = unary_union([Point(x, y).buffer(d / 2) for x, y, d in pr.edge_notches]).bounds
                items.append(
                    ReportItem(
                        id="outline_edge_notch", kind="outline_edge_notch", severity="info", layer=oe["file"], measured=len(pr.edge_notches),
                        location=Location(x=(nb[0] + nb[2]) / 2, y=(nb[1] + nb[3]) / 2, bbox=[round(v, 3) for v in nb]),
                        message=f"外形层上 {len(pr.edge_notches)} 个画开口的圆弧（⌀{', '.join(f'{d:g}' for d in dias)}）贴着板边/V-cut 线：是打穿板边的孔，按整圆画进外形层锣出、阻焊开窗，不钻（工厂 2×2 拼板 set/ 的做法）",
                        fix=Fix(type="add_notch", op="AddHolesFromDrawing", params={"count": len(pr.edge_notches), "dias_mm": dias, "kind": "notch"}, auto_fixable=True, applied=True,
                                genesis_script=f"# 外形层 {oe['file']} 上开口的圆弧补成整圆留在外形层（锣），阻焊按 NPTH 开窗；不复制到钻孔层"),
                    )
                )  # fmt: skip
            if pr.drawn_slots:
                sl = unary_union([LineString(pts).buffer(w / 2) for pts, w in pr.drawn_slots]).bounds
                ws = sorted({w for _pts, w in pr.drawn_slots})
                items.append(
                    ReportItem(
                        id="outline_slot_drawn", kind="outline_slot_drawn", severity="info", layer=oe["file"], measured=len(pr.drawn_slots),
                        location=Location(x=(sl[0] + sl[2]) / 2, y=(sl[1] + sl[3]) / 2, bbox=[round(v, 3) for v in sl]),
                        message=f"外形层在板内画了 {len(pr.drawn_slots)} 条 {', '.join(f'{w:g}' for w in ws)} mm 宽的线：按非金属化锣槽做——轮廓画进外形层/阻焊层，两端先钻（工厂 2×2 拼板 set/ 的做法；客户说明「KEEPOUT 层上的孔及开槽为非金属孔」）",
                        fix=Fix(type="slot", op="AddHolesFromDrawing", params={"count": len(pr.drawn_slots), "widths_mm": ws, "kind": "slot"}, auto_fixable=True, applied=True,
                                genesis_script=f"# 外形层 {oe['file']} 上 ≥ min_slot 宽的线 = 锣槽：Rout → Chains；两端预钻按 slot_end_predrill  【待验证】"),
                    )
                )  # fmt: skip
            if pr.sketches:
                sb = unary_union(pr.sketches).bounds
                items.append(
                    ReportItem(
                        id="outline_sketch", kind="outline_sketch", severity="info", layer=oe["file"], measured=len(pr.sketches),
                        location=Location(x=(sb[0] + sb[2]) / 2, y=(sb[1] + sb[3]) / 2, bbox=[round(v, 3) for v in sb]),
                        message=f"外形层在板内还有 {len(pr.sketches)} 段不闭合、不挨着任何边/挖空的线（元件示意/说明图），不进外形层（p112 删板外物）",
                        fix=Fix(type="delete", op="DeleteOutsideProfile", params={"count": len(pr.sketches), "layer": oe["file"], "kind": "sketch"}, auto_fixable=True, applied=True,
                                genesis_script=f"# p112 外形层 {oe['file']} 上的示意线不进 Profile（外形按 Profile 重画）"),
                    )
                )  # fmt: skip
            if pr.stray:
                from engine.checks.common import aggregate, loc_of

                near = profile.buffer(1.0)
                inside = [seg for seg in pr.stray if seg.intersects(near)]
                far = [seg for seg in pr.stray if not seg.intersects(near)]
                if far:
                    fb = unary_union(far).bounds
                    items.append(
                        ReportItem(
                            id="outline_far_drawing", kind="outline_far_drawing", severity="info", layer=oe["file"], measured=len(far),
                            location=Location(x=(fb[0] + fb[2]) / 2, y=(fb[1] + fb[3]) / 2, bbox=[round(v, 3) for v in fb]),
                            message=f"外形层在 Profile 外还有 {len(far)} 段线（{fb[2] - fb[0]:.1f}×{fb[3] - fb[1]:.1f} mm 的图纸/细节图，例如工艺边缺口详图），不进生产层；若是工艺边/缺口的做法说明，请工程师按图修改外形",
                        )
                    )  # fmt: skip
                details = [
                    ReportItem(
                        id=f"outline_stray_{i}", kind="outline_stray_segment", severity="warn", layer=oe["file"],
                        location=loc_of(seg, 0.5), measured=round(seg.length, 3),
                        message=f"外形层悬空线段 {seg.length:.2f} mm（不属于任何闭合环）",
                    )
                    for i, seg in enumerate(inside)
                ]  # fmt: skip
                if details:
                    aggregate(
                        items, details, kind="outline_stray_segment", layer=oe["file"], severity="warn",
                        message=f"外形层 {oe['file']} 有不闭合的悬空线段（可能是画在外形层的槽）",
                        eq_question="外形层有不闭合的线段：若是槽请提供槽孔钻带或确认按锣槽处理，若是多余线请确认删除（p112 删板外物 / p170 锣带）",
                        fix=Fix(type="slot_or_delete", op="AddHolesFromDrawing", params={"count": len(inside)}, auto_fixable=False, applied=False,
                                genesis_script=f"# p113 外形层上能用钻孔钻出来的槽复制到钻孔层（否则 Rout → Chains 做锣槽 / 删除）\nCOM open_entity,job=<job>,type=layer,name={oe['file']}  【待验证】\nCOM sel_copy_other,dest=layer_name,target_layer=<drl>,invert=no,dx=0,dy=0,size=0  【待验证】"),
                    )  # fmt: skip

    # 4. board-outside objects (p112 删掉板外物)
    outside_counts: dict[str, int] = {}
    if profile is not None:
        buf = profile.buffer(cfg["outside_profile_tolerance_mm"])
        for e in entries:
            rel = e["file"]
            g = geoms.get(rel)
            if g is None or g.is_empty or e["type"] == "outline":
                continue
            polys = list(iter_polygons(g))
            if not polys:
                continue
            tree = STRtree(polys)
            inside = set(tree.query(buf, predicate="intersects").tolist())
            outside = [p for i, p in enumerate(polys) if i not in inside]
            if outside:
                outside_counts[rel] = len(outside)
                first = outside[0]
                c = first.representative_point()
                items.append(
                    ReportItem(
                        id=f"outside_{len(items)}", kind="outside_profile", severity="warn", layer=rel,
                        location=Location(x=c.x, y=c.y, bbox=_bbox(first)), measured=len(outside),
                        threshold=cfg["outside_profile_tolerance_mm"],
                        message=f"{rel} 有 {len(outside)} 个对象在 Profile 外（p112 删板外物）",
                        fix=Fix(type="delete", op="DeleteOutsideProfile", params={"count": len(outside), "layer": rel},
                                auto_fixable=True, applied=False),
                    )
                )  # fmt: skip

    # 5. three steps
    step_counts = _copy_steps(ctx, [e["file"] for e in lm.get("files", [])])

    summary_doc: dict[str, Any] = {
        "reference": ref_name,
        "reference_bbox": ref,
        "bboxes": bboxes,
        "offsets_mm": offsets,
        "profile_bbox": _bbox(profile) if profile is not None else None,
        "profile_area_mm2": round(profile.area, 3) if profile is not None else None,
        "outside_profile": outside_counts,
        "steps": step_counts,
    }
    artifacts.append(ctx.write_artifact("dfm_report", "align.json", json.dumps(summary_doc, indent=2)))
    status = derive_status(items)
    ctx.storage.update_progress(ctx.job_id, "align", status=status)
    return StageReport(
        stage="align", status=status, artifacts=artifacts, items=items,
        summary=f"{len(geoms)} layers folded, ref={ref_name}, profile={'ok' if profile is not None else 'none'}; "
        + summarize(items),
    )  # fmt: skip


def choose_outline(
    ctx: JobContext,
    outline_entries: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    bboxes: dict[str, tuple[float, float, float, float] | None],
    cfg: dict[str, Any],
    items: list[ReportItem],
) -> tuple[dict[str, Any], Any] | None:
    """Pick the outline layer that defines the Profile and remember it in ``<work>/profile.json``.

    Customers often ship two: an EDA "Profile"/keep-out (the bare board) and a mechanical layer
    on which they drew the rails/工艺边 they want built, with copper and silk extending onto them
    (first real 6-layer job, 2026-09-09: GM 500×425 vs GM1 500×447). Taking the first one deletes
    the rails' copper at DeleteOutsideProfile. Rule (``layer.outline_choice: auto``): the
    candidate that leaves the fewest production layers with objects outside it wins; a tie goes
    to the higher-confidence entry. A file name in the profile / ``order_spec.outline_layer`` /
    a human's earlier choice in profile.json overrides. Several candidates → an EQ so the
    engineer confirms."""
    if not outline_entries:
        return None
    meta_path = ctx.work_dir / "profile.json"
    prev = json.loads(meta_path.read_text("utf-8")) if meta_path.is_file() else {}
    forced = (ctx.request.order_spec or {}).get("outline_layer") or (cfg.get("outline_choice") if cfg.get("outline_choice", "auto") != "auto" else None) or prev.get("confirmed")
    cands: list[dict[str, Any]] = []
    tol = cfg["outside_profile_tolerance_mm"]
    prod = [e for e in entries if e["type"] not in ("outline", "drawing", "unknown") and not e["type"].startswith("drill")]
    for e in outline_entries:
        try:
            pr = extract_profile(open_camfile(ctx.layer_path(e["file"]), "outline"), _set_size(ctx), cfg.get("rail_vcut_notch_mm") or None,
                                 float((ctx.profile.get("drill") or {}).get("min_slot_width_mm", 0.5) or 0.5))
        except Exception as ex:  # noqa: BLE001
            cands.append({"file": e["file"], "ok": False, "reason": f"{type(ex).__name__}: {ex}", "pr": None, "entry": e})
            continue
        if pr.profile is None:
            cands.append({"file": e["file"], "ok": False, "reason": pr.reason, "pr": pr, "entry": e})
            continue
        x0, y0, x1, y1 = pr.profile.bounds
        outside = [
            p["file"] for p in prod
            if (b := bboxes.get(p["file"])) and (b[0] < x0 - tol or b[1] < y0 - tol or b[2] > x1 + tol or b[3] > y1 + tol)
        ]  # fmt: skip
        cands.append({"file": e["file"], "ok": True, "pr": pr, "entry": e, "bbox": [round(v, 3) for v in (x0, y0, x1, y1)],
                      "size": f"{x1 - x0:.1f}×{y1 - y0:.1f}", "outside_layers": outside, "confidence": float(e.get("confidence") or 0)})  # fmt: skip
    good = [c for c in cands if c["ok"]]
    if not good:
        c = cands[0]  # let the caller report "profile_not_closed" on the first one as before
        return (c["entry"], c["pr"]) if c["pr"] is not None else None
    pick = None
    if forced:
        pick = next((c for c in good if c["file"] == forced), None)
    if pick is None:
        pick = min(good, key=lambda c: (len(c["outside_layers"]), -c["confidence"]))
    meta = {
        "file": pick["file"], "bbox": pick["bbox"], "confirmed": prev.get("confirmed"),
        "attached_rings": pick["pr"].attached_rings, "drawn_holes": [list(h) for h in pick["pr"].drawn_holes],
        "edge_notches": [list(h) for h in pick["pr"].edge_notches],
        "drawn_slots": [[[list(pt) for pt in pts], w] for pts, w in pick["pr"].drawn_slots],
        "set": pick["pr"].set_info, "units": [[round(v, 4) for v in u.bounds] for u in pick["pr"].units],
        "rail_lines": [[list(pt) for pt in ln] for ln in pick["pr"].rail_lines],
        "candidates": [{k: v for k, v in c.items() if k not in ("pr", "entry")} for c in cands],
    }  # fmt: skip
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    rails_path = ctx.work_dir / "rails.wkb"  # the rails as polygons: copper fill (RailFill) and the V-cut lines need them
    if pick["pr"].rails:
        rails_path.write_bytes(to_wkb(MultiPolygon(pick["pr"].rails)))
    elif rails_path.is_file():
        rails_path.unlink()
    if len(cands) > 1:
        desc = "；".join(
            f"{c['file']} {c['size']}（{len(c['outside_layers'])} 层有物件在外" + ("" if c["ok"] else "，不闭合") + "）" if c["ok"] else f"{c['file']}（不闭合：{c['reason']}）"
            for c in cands
        )
        items.append(
            ReportItem(
                id="profile_candidates", kind="profile_candidates", severity="warn", layer=pick["file"], measured=len(cands),
                message=f"资料里有 {len(cands)} 个外形层：{desc}。按「包住最多层物件」选 {pick['file']} 作 Profile" + ("（订单/人工指定）" if forced else ""),
                eq_question=f"资料里有 {len(cands)} 个外形层，已按 {pick['file']}（{pick['size']}）定义 Profile；若客户要的是另一个（例如不含工艺边的裸板外形），请改选后从「对齐/Profile」重跑",
                fix=Fix(type="choose_outline", op="SetProfile", params={"chosen": pick["file"], "candidates": [c["file"] for c in cands]}, auto_fixable=True, applied=True,
                        genesis_script=f"# p111 定义 Profile：用 {pick['file']} 的外形（其余外形层只作图纸）"),
            )
        )  # fmt: skip
    return pick["entry"], pick["pr"]


def _set_size(ctx: JobContext) -> tuple[float, float] | None:
    """``order_spec.set_size_mm`` — the customer's 拼板尺寸 including rails (p148–151 客户 SET)."""
    v = (ctx.request.order_spec or {}).get("set_size_mm")
    try:
        if isinstance(v, str):
            v = [float(x) for x in re.split(r"[x×*,]", v.lower()) if x.strip()]
        if v and len(v) == 2 and float(v[0]) > 0 and float(v[1]) > 0:
            return (float(v[0]), float(v[1]))
    except (TypeError, ValueError):
        pass
    return None


def chosen_outline(ctx: JobContext) -> str | None:
    """File name of the outline layer align picked (``profile.json``), if any."""
    p = ctx.work_dir / "profile.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text("utf-8")).get("file")
    except Exception:  # noqa: BLE001
        return None


def point_in_profile(profile: BaseGeometry, x: float, y: float) -> bool:
    return profile.contains(Point(x, y))
