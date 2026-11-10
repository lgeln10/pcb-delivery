"""终稿对比：一个 job 的输出文件 vs 人工终稿（工程师改好的成品），逐层分档、标出差异。

页面上「终稿对比」页的后端。人工终稿是一套和输出同名的 Gerber（工厂习惯：``<单号>.gtl`` /
``.l2`` / ``.gts`` / ``.drl`` …），上传后按**文件后缀**和输出阶段的产物配对，每层跑
:mod:`engine.geom.xordiff` 出三档面积和 C 档簇；SVG 把人工终稿垫灰、我们的叠上层色，
「人有我们没有」涂红、「我们有人没有」涂蓝，C 档簇画框（带 ``data-cluster``，页面点清单就能
高亮 / 缩放到那一处）。

文件放 ``work/<job>/golden/``；对比结果缓存在 ``work/<job>/cache/compare.json``，
输出或终稿任何一个文件变了就重算。
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from gerbonara import graphic_objects as go
from gerbonara.excellon import ExcellonFile
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from engine.geom import xordiff
from engine.geom.layers import fold_cached
from engine.geom.svg import LAYER_COLORS, _fmt, iter_polygons, polygon_path
from engine.ingest.archive import extract_archive, is_archive
from engine.storage import Storage, safe_relpath

GOLDEN_DIR = "golden"
MAX_CLUSTERS = 400  # 页面清单最多列这么多簇（按面积降序）；再多是噪声，不是人能看的清单
SILK_TYPES = ("top_silk", "bottom_silk")


# ------------------------------------------------------------------ 终稿文件


def store_golden(storage: Storage, job_id: str, keys: list[str]) -> dict[str, Any]:
    """Copy the uploaded final files (archives unpacked) into ``work/<job>/golden/`` and match them.

    Re-uploading replaces the whole set: a partial second upload would otherwise leave stale layers
    from the first one next to the new ones and nobody would notice."""
    work = storage.work_dir(job_id)
    dest = work / GOLDEN_DIR
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    errors: list[str] = []
    for key in keys:
        src = storage.object_path(key)
        if not src.is_file():
            errors.append(f"missing object: {key}")
            continue
        if is_archive(src):
            res = extract_archive(src, dest)
            errors += res.errors
        else:
            shutil.copyfile(src, dest / safe_relpath(src.name).replace("/", "_"))
    # a stale compare.json must not survive a new golden set
    cache = work / "cache" / "compare.json"
    if cache.is_file():
        cache.unlink()
    m = manifest(storage, job_id)
    m["errors"] = errors
    return m


def _golden_files(work: Path) -> list[Path]:
    d = work / GOLDEN_DIR
    return sorted(p for p in d.rglob("*") if p.is_file()) if d.is_dir() else []


def _suffix(name: str) -> str:
    """``y6f085471a0.gtl`` → ``.gtl``; ``board-NPTH.TXT`` → ``.txt``. Lower-case, dot included."""
    i = name.rfind(".")
    return name[i:].lower() if i >= 0 else ""


def _output_manifest(storage: Storage, job_id: str) -> dict[str, Any]:
    """The output stage's ``output_manifest.json`` (``{}`` before the stage has run)."""
    work = storage.work_dir(job_id, create=False)
    rep = work / "reports" / "output.json"
    if not rep.is_file():
        return {}
    data = json.loads(rep.read_text("utf-8"))
    art = next((a for a in data.get("artifacts", []) if a.get("filename") == "output_manifest.json"), None)
    if not art:
        return {}
    try:
        return json.loads(storage.read_object(art["path"]).decode("utf-8"))
    except (OSError, ValueError):
        return {}


def _output_layers(storage: Storage, job_id: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(copper/mask/silk/outline layers, drill tapes) the output stage produced, from its manifest."""
    man = _output_manifest(storage, job_id)
    if not man:
        return [], []
    layers = [x for x in man.get("layers", []) if x.get("path") and x.get("output")]
    if (ir := man.get("inner_rout")) and ir.get("path"):
        layers.append({"file": None, "type": "inner_rout", "output": ir["output"], "path": ir["path"]})
    # 主钻带优先：.drl（工厂留档的 Gerber 钻孔层，每一钻的孔都在）> 其它 Gerber 钻带（.2nd 二钻只有几个孔）
    # > Excellon —— drill_sizes 两种都会数。C09 演示上第一次配成了 .2nd，钻孔对比变成「1 vs 1 孔」
    drills = sorted((x for x in man.get("drills", []) if x.get("path")),
                    key=lambda x: (_suffix(x["output"]) != ".drl", not x.get("gerber"), -int(x.get("holes") or 0)))
    return layers, drills


def manifest(storage: Storage, job_id: str) -> dict[str, Any]:
    """Which golden file pairs with which output file — by suffix, the factory's naming convention."""
    work = storage.work_dir(job_id, create=False)
    golden = _golden_files(work)
    by_name = {p.name.lower(): p for p in golden}
    by_suffix: dict[str, Path] = {}
    for p in golden:
        by_suffix.setdefault(_suffix(p.name), p)

    def pair(output: str) -> Path | None:
        # 同名优先（单号一样时终稿就是同名文件）；再按后缀 —— 只按后缀会把 job-NPTH.TXT 配给 job.TXT
        return by_name.get(output.lower()) or by_suffix.get(_suffix(output))

    layers, drills = _output_layers(storage, job_id)
    matched, unmatched_out = [], []
    for e in layers:
        s = _suffix(e["output"])
        g = pair(e["output"])
        (matched if g else unmatched_out).append({"suffix": s, "output": e["output"], "type": e["type"], "golden": g.name if g else None, "path": e["path"],
                                                  "file": e.get("file")})  # the customer's source layer (None for the inner rout we draw ourselves)
    drill = None
    if drills:
        d = drills[0]
        g = pair(d["output"])
        drill = {"suffix": _suffix(d["output"]), "output": d["output"], "golden": g.name if g else None, "path": d["path"]}
    used = {m["golden"] for m in matched} | ({drill["golden"]} if drill and drill["golden"] else set())
    return {
        "has_golden": bool(golden),
        "golden_files": [p.name for p in golden],
        "layers": matched,
        "unmatched_output": unmatched_out,
        "unmatched_golden": [p.name for p in golden if p.name not in used],
        "drill": drill,
        "has_output": bool(layers),
        # output frame = customer frame + this shift (output stage): lets the compare overlay draw the customer's original under ours
        "origin_shift": _output_manifest(storage, job_id).get("origin_shift") if layers else None,
    }


# ------------------------------------------------------------------ 对比


def _fingerprint(storage: Storage, job_id: str, m: dict[str, Any]) -> str:
    work = storage.work_dir(job_id, create=False)
    parts = []
    for e in m["layers"] + ([m["drill"]] if m["drill"] else []):
        parts.append(f"{e['output']}:{storage.object_path(e['path']).stat().st_mtime_ns}")
        if e["golden"]:
            parts.append(f"{e['golden']}:{(work / GOLDEN_DIR / e['golden']).stat().st_mtime_ns}")
    return "|".join(parts)


def _fold_pair(storage: Storage, job_id: str, e: dict[str, Any]) -> tuple[BaseGeometry, BaseGeometry]:
    work = storage.work_dir(job_id, create=False)
    cache = work / "cache"
    cache.mkdir(exist_ok=True)
    ltype = e["type"] if e["type"] in LAYER_COLORS or e["type"] == "inner_rout" else "unknown"
    if ltype == "inner_rout":
        ltype = "outline"
    ours = fold_cached(cache, storage.object_path(e["path"]), f"out:{e['output']}", ltype)
    gold = fold_cached(cache, work / GOLDEN_DIR / e["golden"], f"golden:{e['golden']}", ltype)
    return ours, gold


def _orig_geometry(storage: Storage, job_id: str, e: dict[str, Any], shift: list[float] | None) -> BaseGeometry | None:
    """The customer's original layer in the output frame (原稿): ``src/<file>`` folded, then moved by the
    output stage's origin shift. ``None`` when this output has no customer source (the inner rout)."""
    from shapely.affinity import translate

    work = storage.work_dir(job_id, create=False)
    rel = e.get("file")
    if not rel:
        return None
    src = work / "src" / rel
    if not src.is_file():
        return None
    cache = work / "cache"
    cache.mkdir(exist_ok=True)
    ltype = e["type"] if e["type"] in LAYER_COLORS else "unknown"
    g = fold_cached(cache, src, f"{rel}@orig", ltype)
    if shift and (shift[0] or shift[1]):
        g = translate(g, float(shift[0]), float(shift[1]))
    return g


def merge_changed(clusters: list[xordiff.Cluster], overlap: float = 0.5) -> list[dict[str, Any]]:
    """Pair a ``missing`` cluster with an ``extra`` one at the same place into one ``changed`` entry.

    梅花孔：工程师画带 8 个花瓣缺口的圆、我们画整圆 —— 同一个位置一红一蓝各算一处，页面上两个框叠在一起，
    人看了要猜「这是多了还是少了」。两边都有、只是形状不同，就是一处「改了」。判据：两个外框的交集占
    小的那个外框一半以上。门禁（verify）仍按原来的簇数走，这里只管给人看。"""
    miss = [c for c in clusters if c.direction == "missing"]
    ext = [c for c in clusters if c.direction == "extra"]
    out: list[dict[str, Any]] = []
    used: set[int] = set()

    def bx(c: xordiff.Cluster):
        return box(*c.bbox)

    tree = STRtree([bx(e) for e in ext]) if ext else None
    for m in miss:
        best, best_r = None, 0.0
        if tree is not None:
            mb = bx(m)
            for j in tree.query(mb, predicate="intersects"):
                j = int(j)
                if j in used:
                    continue
                eb = bx(ext[j])
                r = mb.intersection(eb).area / max(min(mb.area, eb.area), 1e-9)
                if r > best_r:
                    best, best_r = j, r
        if best is not None and best_r >= overlap:
            used.add(best)
            e = ext[best]
            x0, y0 = min(m.bbox[0], e.bbox[0]), min(m.bbox[1], e.bbox[1])
            x1, y1 = max(m.bbox[2], e.bbox[2]), max(m.bbox[3], e.bbox[3])
            out.append({"direction": "changed", "pieces": m.n + e.n, "area_mm2": round(m.area + e.area, 3),
                        "area_missing_mm2": round(m.area, 3), "area_extra_mm2": round(e.area, 3),
                        "bbox": [round(v, 3) for v in (x0, y0, x1, y1)],
                        "sample": list((m if m.area >= e.area else e).sample or (x0, y0, x1, y1))})
        else:
            out.append(_raw(m))
    out += [_raw(e) for j, e in enumerate(ext) if j not in used]
    out.sort(key=lambda d: -d["area_mm2"])
    for i, d in enumerate(out):
        x0, y0, x1, y1 = d["bbox"]
        d.update(id=i, size_mm=[round(x1 - x0, 3), round(y1 - y0, 3)], at=[round((x0 + x1) / 2, 2), round((y0 + y1) / 2, 2)])
    return out


def _raw(c: xordiff.Cluster) -> dict[str, Any]:
    return {"direction": c.direction, "pieces": c.n, "area_mm2": round(c.area, 3), "bbox": [round(v, 3) for v in c.bbox],
            "sample": list(c.sample or c.bbox)}  # the biggest piece: where a zoom window should look


def compare_layer(storage: Storage, job_id: str, e: dict[str, Any]) -> dict[str, Any]:
    ours, gold = _fold_pair(storage, job_id, e)
    rep = xordiff.compare(ours, gold)
    clusters = merge_changed(rep["clusters"])[:MAX_CLUSTERS]
    silk = e["type"] in SILK_TYPES
    return {
        "suffix": e["suffix"], "output": e["output"], "golden": e["golden"], "type": e["type"],
        "gold_area_mm2": round(rep["gold_area"], 2), "ours_area_mm2": round(rep["ours_area"], 2),
        "xor_pct": round(rep["xor_pct"], 3), "shape_pct": round(rep["shape_pct"], 3),
        "bands": {
            "missing": {"noise": round(rep["missing"].noise, 2), "size": round(rep["missing"].size, 2), "shape": round(rep["missing"].shape, 2)},
            "extra": {"noise": round(rep["extra"].noise, 2), "size": round(rep["extra"].size, 2), "shape": round(rep["extra"].shape, 2)},
        },
        # 簇数按合并后的算：一处「改了」= 1，不是 1 红 + 1 蓝
        "n_clusters": len(clusters),
        "n_missing": sum(1 for c in clusters if c["direction"] == "missing"),
        "n_extra": sum(1 for c in clusters if c["direction"] == "extra"),
        "n_changed": sum(1 for c in clusters if c["direction"] == "changed"),
        "clusters": clusters,
        # 字符层：我们用 Hershey 笔画字体，工程师用 CAD 自带字形 —— 几何比的是笔画不是内容，数字给看，不作评判
        "note": "字符层字体不同，几何差异不代表内容差异" if silk else None,
    }


def drill_sizes(path: Path) -> dict[tuple[float, str], int]:
    """Gerber drill layer → {(dia_mm, hole|slot): count} (C apertures = tools). An Excellon tape
    (T#C# tools, X/Y per hole, G85 slots) counts the same way.

    单位要认：这家厂的 .drl 是英寸 Gerber（%MOIN），Excellon 看 INCH/METRIC —— 2026-09-19 搬这段代码时
    丢过一次单位处理，C09 的钻孔对比变成「⌀0.018 我们 3339 工程师 3362」。"""
    text = path.read_text("latin-1")
    if "%ADD" not in text:  # Excellon
        tools: dict[str, float] = {}
        cnt_x: dict[tuple[float, str], int] = {}
        cur_t = None
        k = 25.4 if "INCH" in text.upper() and "METRIC" not in text.upper() else 1.0
        for raw in text.splitlines():
            line = raw.strip()
            if m := re.match(r"^T(\d+)C([\d.]+)", line):
                tools[m.group(1)] = round(float(m.group(2)) * k, 2)
            elif m := re.match(r"^T(\d+)$", line):
                cur_t = m.group(1)
            elif cur_t and line[:1] in "XY":
                key = (tools.get(cur_t, 0.0), "slot" if "G85" in line else "hole")
                cnt_x[key] = cnt_x.get(key, 0) + 1
        return cnt_x
    ap: dict[int, float] = {}
    cnt: dict[tuple[float, str], int] = {}
    cur = None
    unit = 25.4
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("%MOMM"):
            unit = 1.0
        if m := re.match(r"%ADD(\d+)C,([\d.]+)\*%", line):
            ap[int(m.group(1))] = round(float(m.group(2)) * unit, 2)
            continue
        if (m := re.match(r"(?:G54)?D(\d+)\*$", line)) and int(m.group(1)) >= 10:
            cur = int(m.group(1))
            continue
        if cur in ap and line.endswith("D03*"):
            cnt[(ap[cur], "hole")] = cnt.get((ap[cur], "hole"), 0) + 1
        elif cur in ap and line.endswith("D02*"):
            cnt[(ap[cur], "slot")] = cnt.get((ap[cur], "slot"), 0) + 1
    return cnt


def compare_drill(storage: Storage, job_id: str, d: dict[str, Any]) -> dict[str, Any]:
    work = storage.work_dir(job_id, create=False)
    ours = drill_sizes(storage.object_path(d["path"]))
    gold = drill_sizes(work / GOLDEN_DIR / d["golden"])
    rows = []
    for k in sorted(set(ours) | set(gold)):
        o, g = ours.get(k, 0), gold.get(k, 0)
        rows.append({"dia_mm": k[0], "kind": k[1], "ours": o, "golden": g, "same": o == g})
    return {"output": d["output"], "golden": d["golden"], "n_sizes_ours": len(ours), "n_sizes_golden": len(gold),
            "holes_ours": sum(ours.values()), "holes_golden": sum(gold.values()),
            "n_mismatch": sum(1 for r in rows if not r["same"]), "rows": rows}


def cached_compare(storage: Storage, job_id: str) -> dict[str, Any] | None:
    """The cached result if nothing it was computed from has changed since — no folding, no lock."""
    m = manifest(storage, job_id)
    cache = storage.work_dir(job_id, create=False) / "cache" / "compare.json"
    if not cache.is_file() or not (m["layers"] or m["drill"]):
        return None
    try:
        old = json.loads(cache.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return old if old.get("fingerprint") == _fingerprint(storage, job_id, m) else None


def compare_job(storage: Storage, job_id: str, *, force: bool = False) -> dict[str, Any]:
    """Every matched layer + the drill tape; cached until an output or golden file changes."""
    if not force and (old := cached_compare(storage, job_id)) is not None:
        return old
    m = manifest(storage, job_id)
    work = storage.work_dir(job_id, create=False)
    cache = work / "cache" / "compare.json"
    fp = _fingerprint(storage, job_id, m) if m["layers"] or m["drill"] else ""
    layers = [compare_layer(storage, job_id, e) for e in m["layers"]]
    drill = compare_drill(storage, job_id, m["drill"]) if m["drill"] and m["drill"]["golden"] else None
    out = {
        "fingerprint": fp,
        "has_golden": m["has_golden"], "has_output": m["has_output"],
        "golden_files": m["golden_files"], "unmatched_output": m["unmatched_output"], "unmatched_golden": m["unmatched_golden"],
        "layers": layers, "drill": drill,
        "summary": _summary(layers),
    }
    if m["layers"] or m["drill"]:
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps(out, ensure_ascii=False), "utf-8")
    return out


# ------------------------------------------------------------------ SVG


def _paths(geom: BaseGeometry, tag: str) -> str:
    return "\n".join(f'<path data-id="{tag}:{i}" d="{polygon_path(p)}"/>' for i, p in enumerate(iter_polygons(geom)))


def _holes_xy(path: Path) -> list[tuple[float, float, float]]:
    """(x, y, dia) of every hole on a drill tape — the Gerber drill layer's flashes (file units → mm)."""
    text = path.read_text("utf-8", errors="replace")[:4000]
    out: list[tuple[float, float, float]] = []
    try:
        if "%ADD" in text:
            gf = GerberFile.open(path)
            for o in gf.objects:
                if isinstance(o, go.Flash) and hasattr(o.aperture, "diameter"):
                    c = o.converted(MM)
                    out.append((c.x, c.y, MM.convert_from(o.aperture.unit, o.aperture.diameter)))
        else:
            ef = ExcellonFile.open(path)
            for o in ef.objects:
                if isinstance(o, go.Flash):
                    c = o.converted(MM)
                    out.append((c.x, c.y, MM.convert_from(o.tool.unit, o.tool.diameter)))
    except Exception:  # noqa: BLE001 — the overlay is decoration; a tape we cannot read just draws no holes
        return []
    return out


def compare_svg(storage: Storage, job_id: str, suffix: str) -> str | None:
    """Overlay for one layer: golden (grey) and the customer's original (amber) under ours (layer
    colour), then what only the engineer has (red) and what only we have (blue), then the C-band
    clusters as boxes. ``None`` = no such pair."""
    m = manifest(storage, job_id)
    e = next((x for x in m["layers"] if x["suffix"] == suffix.lower()), None)
    if e is None:
        return None
    ours, gold = _fold_pair(storage, job_id, e)
    orig = _orig_geometry(storage, job_id, e, m.get("origin_shift"))
    missing = gold.difference(ours)
    extra = ours.difference(gold)
    # 分档直接吃这两个差集（compare() 会再算一遍 symmetric_difference 和两个差集，这里省掉一半）；
    # 簇的编号和 compare.json 里的一致：两边都是按面积降序
    clusters = merge_changed(xordiff.split_one(missing, "missing").clusters + xordiff.split_one(extra, "extra").clusters)[:MAX_CLUSTERS]
    both = ours.union(gold)  # the frame is ours ∪ golden: the customer file may carry strays far off-board (C11: a via 300 mm out)
    x0, y0, x1, y1 = both.bounds if not both.is_empty else (0.0, 0.0, 10.0, 10.0)
    margin = 1.0
    x0 -= margin
    y0 -= margin
    x1 += margin
    y1 += margin
    w, h = x1 - x0, y1 - y0
    color = LAYER_COLORS.get(e["type"], "#333333")
    rects = []
    label = {"missing": "人有我们没有", "extra": "我们有人没有", "changed": "两边都有、形状不同"}
    for c in clusters:
        bx0, by0, bx1, by1 = c["bbox"]
        w_, h_ = c["size_mm"]
        rects.append(
            f'<rect class="cmp-cluster cmp-cluster--{c["direction"]}" data-cluster="{c["id"]}" x="{_fmt(bx0)}" y="{_fmt(by0)}" '
            f'width="{_fmt(max(bx1 - bx0, 0.05))}" height="{_fmt(max(by1 - by0, 0.05))}" vector-effect="non-scaling-stroke">'
            f'<title>#{c["id"] + 1} {label[c["direction"]]} {c["area_mm2"]:.2f}mm² {w_:.2f}×{h_:.2f}</title></rect>'
        )
    holes = _holes_xy(storage.object_path(m["drill"]["path"])) if m.get("drill") and m["drill"].get("path") else []
    hole_circles = "\n".join(f'<circle cx="{_fmt(hx)}" cy="{_fmt(hy)}" r="{_fmt(hd / 2)}"/>' for hx, hy, hd in holes)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_fmt(x0)} {_fmt(-y1)} {_fmt(w)} {_fmt(h)}" '
        f'width="{_fmt(w)}mm" height="{_fmt(h)}mm" data-layer="{e["output"]}" data-type="{e["type"]}" data-golden="{e["golden"]}">\n'
        f'<g class="cmp-gold" transform="scale(1,-1)" fill="#9ca3af" fill-rule="evenodd" stroke="none">\n{_paths(gold, "gold")}\n</g>\n'
        + (f'<g class="cmp-orig" transform="scale(1,-1)" fill="#f59e0b" fill-rule="evenodd" stroke="none">\n{_paths(orig, "orig")}\n</g>\n' if orig is not None else "")
        + f'<g class="cmp-ours" transform="scale(1,-1)" fill="{color}" fill-rule="evenodd" stroke="none">\n{_paths(ours, "ours")}\n</g>\n'
        f'<g class="cmp-missing" transform="scale(1,-1)" fill="#dc2626" fill-rule="evenodd" stroke="none">\n{_paths(missing, "missing")}\n</g>\n'
        f'<g class="cmp-extra" transform="scale(1,-1)" fill="#2563eb" fill-rule="evenodd" stroke="none">\n{_paths(extra, "extra")}\n</g>\n'
        f'<g class="cmp-holes" transform="scale(1,-1)" fill="none" stroke="#111827" stroke-width="0.04" vector-effect="non-scaling-stroke">\n{hole_circles}\n</g>\n'
        f'<g class="cmp-clusters" transform="scale(1,-1)" fill="none">\n{chr(10).join(rects)}\n</g>\n'
        "</svg>\n"
    )


def _summary(layers: list[dict[str, Any]]) -> dict[str, Any]:
    judged = [x for x in layers if not x["note"]]  # 字符层不进总数
    worst = max(judged, key=lambda x: x["shape_pct"], default=None)
    return {"n_layers": len(layers), "n_clusters": sum(x["n_clusters"] for x in judged), "worst": worst["suffix"] if worst else None}
