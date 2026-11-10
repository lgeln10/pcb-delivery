"""Stage ``intake``: unpack customer data, identify layers, infer the stackup, detect %SR.

Rules referenced: knowledge/rules/layer_naming.yaml (p110 naming table, p111 "以钻孔层为基准").
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from engine.ingest.archive import extract_archive, is_archive
from engine.ingest.classify import COPPER_TYPES, DRILL_TYPES, LayerGuess, classify_file
from engine.model.report import ReportItem, StageReport, summarize
from engine.pipeline.context import JobContext
from engine.storage import UnsafeKeyError, safe_relpath

_UUID_PREFIX = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-")
_DRR_TOOL = re.compile(
    r"^T(\d+)\s+([\d.]+)\s*mm.*?\b(Round|Slot)\b\s+(\d+)\s+(PTH|NPTH)", re.MULTILINE | re.IGNORECASE
)
_LDP_LINE = re.compile(r"DrillFile=([^|]+)\|DrillLayers=([^\r\n]+)", re.IGNORECASE)

SR_EQ = "资料含 Step&Repeat 块，请客户提供展开后的 Gerber 或由工程师在 Genesis 处理"


# ---------------------------------------------------------------------------------------------
def _collect_inputs(ctx: JobContext, items: list[ReportItem]) -> list[str]:
    """Extract archives / copy loose files into ``src``; return relative file list."""
    files: list[str] = []
    seq = 0
    for key in ctx.request.input_keys:
        seq += 1
        try:
            p = ctx.storage.object_path(key)
        except UnsafeKeyError as e:
            items.append(ReportItem(id=f"input_{seq}", kind="input_invalid", severity="error", message=str(e)))
            continue
        if not p.is_file():
            items.append(
                ReportItem(id=f"input_{seq}", kind="input_missing", severity="error", message=f"input not found: {key}")
            )
            continue
        if is_archive(p):
            res = extract_archive(p, ctx.src_dir)
            for err in res.errors:
                items.append(ReportItem(id=f"extract_{seq}", kind="extract_error", severity="error", message=err))
            for orig, fixed in res.renamed.items():
                items.append(
                    ReportItem(
                        id=f"rename_{seq}_{len(files)}",
                        kind="filename_recoded",
                        severity="info",
                        message=f"zip member name re-decoded cp437->gbk: {orig!r} -> {fixed!r}",
                    )
                )
            files.extend(res.files)
        else:
            rel = safe_relpath(_UUID_PREFIX.sub("", p.name))
            dest = ctx.src_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dest)
            files.append(rel)
    # de-duplicate, keep order
    seen: set[str] = set()
    return [f for f in files if not (f in seen or seen.add(f))]


def _export_cad_sources(ctx: JobContext, files: list[str], items: list[ReportItem]) -> list[str]:
    """Altium ``.PcbDoc`` / Protel 99 SE ``.pcb`` in the package → export the Gerber/Excellon set the
    engineer would produce by hand (第1章 p42) into ``src/cad_export/`` and add it to the file list.
    Only runs when the package carries no Gerber copper of its own."""
    from engine.cad import export_gerbers, read_board, sniff

    srcs = [rel for rel in files if sniff(ctx.src_dir / rel)]
    if not srcs:
        return files
    has_copper = any(classify_file(ctx.src_path(rel), rel).type in COPPER_TYPES for rel in files if rel not in srcs)
    if has_copper:
        return files
    out: list[str] = list(files)
    for n, rel in enumerate(srcs, 1):
        try:
            board = read_board(ctx.src_dir / rel)
            stem = re.sub(r"[^A-Za-z0-9_-]+", "_", Path(rel).stem) or "board"
            names = export_gerbers(board, ctx.src_dir / "cad_export", stem)
        except Exception as e:  # noqa: BLE001 — a broken source file must show up as a finding, not a crash
            items.append(
                ReportItem(
                    id=f"cad_{n}", kind="cad_export_failed", severity="error", layer=rel,
                    message=f"{rel}：源文件解析失败（{type(e).__name__}: {e}）",
                    eq_question=f"资料包中的 {rel} 无法解析，请客户提供 RS-274X Gerber + Excellon，或由工程师用 EDA 软件导出后上传",
                )
            )  # fmt: skip
            continue
        out += [f"cad_export/{x}" for x in names]
        from engine.cad.altium import describe

        info = describe(board)
        rep = getattr(export_gerbers, "last_report", None) or {}
        items.append(
            ReportItem(
                id=f"cad_{n}", kind="cad_exported", severity="info", layer=rel,
                message=(
                    f"{rel}：{info['format']} 源文件，按 Altium 出 Gerber 的方式导出 {len(names)} 个文件到 cad_export/"
                    f"（{len(info['copper_layers'])} 层铜，{info['counts']['pads']} 焊盘 / {info['counts']['vias']} 过孔 / "
                    f"{info['counts']['texts']} 文字，阻焊开窗规则 {info['mask_expansion_mm']} mm）"
                ),
                measured=len(names),
            )
        )  # fmt: skip
        ctx.storage.write_json(ctx.job_id, f"cad_export_{n}.json", {"source": rel, "describe": info, "files": names, "report": rep, "notes": board.notes[-8:]})
    return out


def _order_spec_candidate(src: Path, files: list[str]) -> dict[str, Any] | None:
    """Altium ``.DRR`` drill report -> drill_table candidate (p113: 核对孔径大小及孔数)."""
    for rel in files:
        if rel.lower().endswith(".drr"):
            text = (src / rel).read_text("latin-1", errors="replace")
            table = [
                {
                    "tool": f"T{m.group(1)}",
                    "dia_mm": float(m.group(2)),
                    "slot": m.group(3).lower() == "slot",
                    "count": int(m.group(4)),
                    "plated": m.group(5).upper() == "PTH",
                }
                for m in _DRR_TOOL.finditer(text)
            ]
            if table:
                return {"drill_table": table, "source": rel}
    return None


def _apply_ldp_spans(src: Path, files: list[str], guesses: list[LayerGuess]) -> None:
    """Altium ``.LDP`` layer-pair file: DrillFile=...|DrillLayers=gtl,g1,...,gbl -> drill span."""
    for rel in files:
        if not rel.lower().endswith(".ldp"):
            continue
        text = (src / rel).read_text("latin-1", errors="replace")
        copper_by_ext = {
            Path(g.file).suffix.lower().lstrip("."): g.index for g in guesses if g.type in COPPER_TYPES
        }
        for m in _LDP_LINE.finditer(text):
            drill_name = m.group(1).strip().lower()
            exts = [e.strip().lower() for e in m.group(2).split(",")]
            idx = [copper_by_ext.get(e) for e in exts]
            idx = [i for i in idx if i is not None]
            for g in guesses:
                if g.type in DRILL_TYPES and Path(g.file).name.lower() == drill_name and idx:
                    g.drill_span = [min(idx), max(idx)]
                    g.reason += f"; span from {Path(rel).name}"


def _finalize_stackup(guesses: list[LayerGuess]) -> dict[str, Any]:
    copper = [g for g in guesses if g.type in COPPER_TYPES]
    n = len(copper)
    for g in copper:
        if g.type == "bottom_copper":
            g.index = n
    # inner layers without a known number get the free slots in file order
    used = {g.index for g in copper if g.index is not None}
    free = [i for i in range(1, n + 1) if i not in used]
    for g in copper:
        if g.index is None and free:
            g.index = free.pop(0)
    copper.sort(key=lambda g: (g.index if g.index is not None else 999, g.file))
    for g in guesses:
        if g.type in ("drill_pth", "drill_npth", "drill_unknown") and g.drill_span is None and n:
            g.drill_span = [1, n]
        if g.type == "drill_blind" and g.drill_span and n and g.drill_span == [1, n]:
            g.type = "drill_pth"  # a "1-N" span is a through drill after all
        elif g.type == "drill_pth" and g.drill_span and n > 1 and g.drill_span != [1, n]:
            g.type = "drill_blind"  # %TF.FileFunction,Plated,1,2 on a 6-layer board = blind/buried
            g.reason += f" span L{g.drill_span[0]}-L{g.drill_span[1]} (blind/buried)"
    return {
        "copper_layers": n,
        "order": [g.file for g in copper],
        "layer_numbers": {g.file: g.index for g in copper},
    }


# ---------------------------------------------------------------------------------------------
# non-Gerber sources: ODB++ / IPC-2581 / EDA project files (第1章 p42：RS-274X 靠文件名标层;
# 其他格式本系统只识别不解析 —— 计划：识别 + EQ「请提供 Gerber」)
# ---------------------------------------------------------------------------------------------
_EDA_EXT = {
    "kicad_pcb": "KiCad 源文件", "pcbdoc": "Altium 源文件", "prjpcb": "Altium 工程", "brd": "Eagle/Allegro 源文件 (.brd)",
    "dsn": "Specctra/Protel 源文件 (.dsn)", "pcb": "PADS/Protel 源文件 (.pcb)",
}


def source_kinds(src: Path, files: list[str]) -> list[tuple[str, str]]:
    """``[(file, kind)]`` for every non-Gerber design source in the package."""
    out: list[tuple[str, str]] = []
    for rel in files:
        low = rel.lower()
        ext = low.rsplit(".", 1)[-1] if "." in low.split("/")[-1] else ""
        if low.endswith("matrix/matrix") or low.split("/")[-1] == "matrix" and "/matrix" in low:
            out.append((rel, "ODB++ 目录"))
        elif ext in ("tgz", "tar", "gz") and "odb" in low:
            out.append((rel, "ODB++ 压缩包"))
        elif ext == "xml":
            try:
                head = (src / rel).read_bytes()[:4096].decode("utf-8", "ignore")
            except OSError:
                head = ""
            if "IPC-2581" in head or "ipc-2581" in head.lower():
                out.append((rel, "IPC-2581"))
        elif ext in _EDA_EXT:
            out.append((rel, _EDA_EXT[ext]))
    return out


def _source_items(src: Path, files: list[str], copper_layers: int, items: list[ReportItem]) -> None:
    found = [(f, k) for f, k in source_kinds(src, files) if not any(i.kind == "cad_exported" and i.layer == f for i in items)]
    if not found:
        return
    kinds = "、".join(sorted({k for _, k in found}))
    names = ", ".join(f for f, _ in found[:6]) + (" …" if len(found) > 6 else "")
    if copper_layers == 0:
        items.append(
            ReportItem(
                id="source_only", kind="source_only_no_gerber", severity="error",
                message=f"资料包只有 {kinds}（{names}），没有可解析的 Gerber/Excellon",
                eq_question=f"资料包为 {kinds}，本系统不直接解析该格式；请客户提供 RS-274X Gerber + Excellon 钻孔（含外形层），或由工程师用 EDA 软件导出后再上传",
            )
        )  # fmt: skip
    else:
        items.append(
            ReportItem(
                id="source_ignored", kind="source_files_ignored", severity="info",
                message=f"资料包附带 {kinds}（{names}），已忽略，以 Gerber/Excellon 为准；如需核对可用它对照",
            )
        )  # fmt: skip


def _sanity_items(guesses: list[LayerGuess], stackup: dict[str, Any], items: list[ReportItem]) -> None:
    types = {g.type for g in guesses}
    n = stackup["copper_layers"]
    if "outline" not in types:
        items.append(
            ReportItem(
                id="missing_outline", kind="missing_layer", severity="error", layer=None,
                message="未识别到外形层（outline/profile）",
                eq_question="资料中未找到外形层，请客户提供外形/板框文件或指明哪一层为外形",
            )
        )  # fmt: skip
    if not types & set(DRILL_TYPES):
        items.append(
            ReportItem(
                id="missing_drill", kind="missing_layer", severity="error",
                message="未识别到钻孔文件（Excellon）",
                eq_question="资料中未找到钻孔文件，请客户提供 Excellon 钻孔文件",
            )
        )  # fmt: skip
    if n == 0:
        items.append(
            ReportItem(
                id="missing_copper", kind="missing_layer", severity="error",
                message="未识别到任何铜层", eq_question="资料中未找到线路层，请客户确认文件是否齐全",
            )
        )  # fmt: skip
    elif n % 2 == 1:
        items.append(
            ReportItem(
                id="odd_copper", kind="stackup_odd", severity="error", measured=n,
                message=f"铜层数为奇数（{n}），叠层不合理",
                eq_question=f"识别到 {n} 层铜，请确认是否缺层或多识别了一层（层序：{stackup['order']}）",
            )
        )  # fmt: skip
    indices = [g.index for g in guesses if g.type in COPPER_TYPES]
    if len(set(indices)) != len(indices):
        items.append(
            ReportItem(
                id="dup_copper_index", kind="stackup_conflict", severity="error",
                message=f"多个铜层映射到同一层号: {indices}",
                eq_question="铜层层号冲突，请确认各文件对应的层序",
            )
        )  # fmt: skip


# ---------------------------------------------------------------------------------------------
def _wipe_edits(ctx: JobContext) -> None:
    """A fresh upload invalidates every edit copy and native edit log (第4章 三副本从头来)."""
    import shutil

    for d in (ctx.work_dir / "steps", ctx.work_dir / "edit_log"):
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)


def run_intake(ctx: JobContext) -> StageReport:
    _wipe_edits(ctx)
    items: list[ReportItem] = []
    files = _collect_inputs(ctx, items)
    files = _export_cad_sources(ctx, files, items)
    if not files:
        items.append(ReportItem(id="no_files", kind="no_input", severity="error", message="no usable input files"))
        return StageReport(stage="intake", status="failed", summary="no input files", items=items)

    guesses = [classify_file(ctx.src_path(rel), rel) for rel in files]
    layers = [g for g in guesses if not g.aux]
    unmapped = [g for g in guesses if g.aux or g.type == "unknown"]

    stackup = _finalize_stackup(layers)  # assigns copper numbers + default through spans
    _apply_ldp_spans(ctx.src_dir, files, layers)  # Altium layer pairs override the default

    # %SR: gerbonara 1.6.3 silently drops step&repeat content (docs/tech-verification.md 3b)
    sr_layers = [g.file for g in layers if g.sniff and g.sniff.has_sr]
    for f in sr_layers:
        items.append(
            ReportItem(
                id=f"sr_{len(items)}", kind="sr_not_expanded", severity="error", layer=f,
                message=f"{f} 含 %SR 步进重复块，当前解析器不展开，图形会缺失",
                eq_question=SR_EQ,
            )
        )  # fmt: skip

    for g in guesses:
        if g.aux:
            continue
        if g.type == "unknown":
            items.append(
                ReportItem(
                    id=f"unmapped_{len(items)}", kind="layer_unrecognized", severity="warn", layer=g.file,
                    measured=g.confidence, message=f"无法识别层类型: {g.file} ({g.reason})",
                )
            )  # fmt: skip
        elif g.needs_llm:
            items.append(
                ReportItem(
                    id=f"lowconf_{len(items)}", kind="layer_low_confidence", severity="info", layer=g.file,
                    measured=g.confidence, threshold=0.8,
                    message=f"{g.file} 识别为 {g.type}（置信度 {g.confidence}，{g.reason}），待确认",
                )
            )  # fmt: skip
    _sanity_items(layers, stackup, items)
    _source_items(ctx.src_dir, files, stackup["copper_layers"], items)

    layer_map = {
        "files": [g.as_map_entry() for g in layers if g.type != "unknown"],
        "stackup": stackup,
        "unmapped": [
            {"file": g.file, "reason": g.reason, "needs_llm": g.needs_llm, "confidence": g.confidence}
            for g in unmapped
        ],
        "generator": next((g.sniff.generator for g in layers if g.sniff and g.sniff.generator), None),
        "sr_layers": sr_layers,
    }
    ctx.storage.write_json(ctx.job_id, "layer_map.json", layer_map)
    artifacts = [ctx.write_artifact("layer_map", "layer_map.json", _json(layer_map))]
    candidate = _order_spec_candidate(ctx.src_dir, files)

    n_layers = len(layer_map["files"])
    # Node pauses for layer confirmation after intake anyway; an error item (unreadable archive,
    # %SR, odd stackup) must show as needs_review so the run is not painted green (M2 W6).
    status = "blocked" if sr_layers else ("needs_review" if any(i.severity == "error" for i in items) else "ok")
    summary = (
        f"{len(files)} files, {n_layers} layers identified, {stackup['copper_layers']} copper, "
        f"{len(unmapped)} unmapped; {summarize(items)}"
    )
    ctx.storage.update_progress(ctx.job_id, "intake", status=status, layers=n_layers)
    return StageReport(
        stage="intake", status=status, summary=summary, items=items, artifacts=artifacts,
        layer_map=layer_map, order_spec_candidate=candidate,
    )  # fmt: skip


def _json(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, indent=2)
