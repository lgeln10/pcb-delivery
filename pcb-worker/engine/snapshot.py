"""``uv run python -m engine.snapshot <case>``: freeze one verify run's 终稿对比 as pictures.

For every output layer that has a golden twin: the compare SVG (customer original amber, ours in the
layer colour, what only the engineer has red, what only we have blue), a 4000 px rendering of the whole
layer, and a contact sheet of the biggest C-band clusters zoomed in — plus ``summary.json`` /
``index.md`` with the per-layer numbers. Everything lands in
``data/snapshots/<case>/<YYYYMMDD-HHMM>_<git version>/`` so two runs of the engine can be laid side by
side and the numbers tie back to a commit (the loop yibing asked for on 2026-09-19: snapshot every
layer of every case, read the differences, write rules, change the engine, snapshot again).

Needs a finished ``data/verify/<case>/`` (``make verify CASE=<case>``); the case's ``golden/`` is
copied into the verify work dir the way the page's golden upload would."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from engine.compare import GOLDEN_DIR, compare_job, compare_svg
from engine.storage import Storage

ROOT = Path(__file__).resolve().parents[1]
FULL_PX = 4000  # whole layer
CROP_PX = 420  # one cluster tile
SHEET_COLS = 4
MAX_TILES = 16


def git_version() -> str:
    try:
        v = subprocess.run(["git", "describe", "--always", "--dirty"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        v = "unknown"
    return v


def _viewbox(svg: Path) -> list[float]:
    head = svg.read_bytes()[:600].decode("utf8", "ignore")
    return [float(v) for v in re.search(r'viewBox="([^"]+)"', head).group(1).split()]


def render_full(svg: Path, png: Path, px: int = FULL_PX) -> None:
    import pymupdf

    pg = pymupdf.open(svg)[0]
    z = px / pg.rect.width
    pg.get_pixmap(matrix=pymupdf.Matrix(z, z), alpha=False).save(png)


MAX_HALF_MM = 8.0  # 单个窗口最多看多大（半宽 mm）；超过就整块缩进一格


def render_crop(pg: Any, vb: list[float], cx: float, cy: float, half: float, px: int, halfy: float | None = None) -> Any:
    """A ``px``-wide tile of the SVG page around (cx, cy) mm ± half (the SVG's y axis is flipped).
    ``halfy`` makes it a rectangle (a long thin cluster is shown whole instead of zoomed into its middle)."""
    import pymupdf

    hy = half if halfy is None else halfy
    sx, sy = pg.rect.width / vb[2], pg.rect.height / vb[3]
    x0, x1 = (cx - half - vb[0]) * sx, (cx + half - vb[0]) * sx
    y0, y1 = (-(cy + hy) - vb[1]) * sy, (-(cy - hy) - vb[1]) * sy
    clip = pymupdf.Rect(x0, y0, x1, y1) & pg.rect
    if clip.is_empty or clip.width < 1e-6:
        return None
    return pg.get_pixmap(matrix=pymupdf.Matrix(px / clip.width, px / clip.width), clip=clip, alpha=False)


def _font() -> Any:
    from PIL import ImageFont

    # ★字体挑能画全的：本机 macOS 26 没有 PingFang.ttc，Hiragino Sans GB 没有 ²（拼图标题上的 mm² 会变成方框）
    for p in ("/System/Library/Fonts/STHeiti Light.ttc", "/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"):
        try:
            return ImageFont.truetype(p, 15)
        except OSError:
            continue
    return ImageFont.load_default()


def contact_sheet(svg: Path, clusters: list[dict[str, Any]], png: Path) -> int:
    """The biggest clusters, one tile each, labelled ``#id 方向 面积 尺寸 @位置``. Returns the tile count."""
    import pymupdf
    from PIL import Image, ImageDraw

    label = {"missing": "人有我们没有", "extra": "我们有人没有", "changed": "两边都有形状不同"}
    pg = pymupdf.open(svg)[0]
    vb = _viewbox(svg)
    tiles = []
    font = _font()
    for c in clusters[:MAX_TILES]:
        bx0, by0, bx1, by1 = c["bbox"]
        # a chained cluster (the rail's outline stroke, 146 × 3 mm in 7 pieces) is looked at where its
        # biggest piece is, at a zoom that still shows a pad's neighbourhood; a lone pad fills the tile
        sx0, sy0, sx1, sy1 = c.get("sample") or c["bbox"]
        half = min(max(max(sx1 - sx0, sy1 - sy0, 0.5) * 0.75 + 0.6, 1.5), 8.0)
        cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        wide = max(sx1 - sx0, sy1 - sy0) > 2 * MAX_HALF_MM
        if wide:
            # 装不下：整块按比例缩进一格，看得到差异散在哪几处（C09 工艺边 491×9.5 的那条，
            # 以前窗口落在正中、一片铜，两处 8.7 mm 的留空根本看不见）
            mx, my = (sx1 - sx0) * 0.04 + 0.3, (sy1 - sy0) * 0.04 + 0.3
            hx, hy = (sx1 - sx0) / 2 + mx, (sy1 - sy0) / 2 + my
            pix = render_crop(pg, vb, cx, cy, hx, CROP_PX, halfy=hy)
            view = f"整块 {2 * hx:.0f}×{2 * hy:.0f}mm 缩进一格"
        else:
            pix = render_crop(pg, vb, cx, cy, half, CROP_PX)
            view = f"看 @({cx:.1f},{cy:.1f}) ±{half:.1f}mm"
        if pix is None:
            continue
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        if wide:  # letterbox 成正方形，拼图格子才对得齐
            sq = Image.new("RGB", (CROP_PX, CROP_PX), "white")
            im.thumbnail((CROP_PX, CROP_PX), Image.LANCZOS)
            sq.paste(im, ((CROP_PX - im.width) // 2, (CROP_PX - im.height) // 2))
            im = sq
        w, h = c["size_mm"]
        tiles.append((im, f"#{c['id'] + 1} {label.get(c['direction'], c['direction'])} {c['area_mm2']:.2f}mm² {c['pieces']}块\n"
                          f"框 {w:.1f}×{h:.1f}  {view}"))
    if not tiles:
        return 0
    tw = max(t[0].width for t in tiles)
    th = max(t[0].height for t in tiles)
    cols = min(SHEET_COLS, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    hdr = 42
    sheet = Image.new("RGB", (cols * (tw + 6), rows * (th + hdr + 4)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (im, text) in enumerate(tiles):
        x, y = (i % cols) * (tw + 6), (i // cols) * (th + hdr + 4)
        d.multiline_text((x + 3, y + 2), text, fill="black", font=font, spacing=2)
        sheet.paste(im, (x, y + hdr))
        d.rectangle([x, y + hdr, x + im.width - 1, y + hdr + im.height - 1], outline="#888")
    sheet.save(png)
    return len(tiles)


def snapshot(case: str, verify_root: Path, out_root: Path, layers: list[str] | None = None) -> Path:
    case_dir = ROOT / "cases" / case
    base = verify_root / case
    storage = Storage(storage_root=base / "storage", work_root=base / "work")
    work = storage.work_dir(case, create=False)
    if not (work / "reports" / "output.json").is_file():
        sys.exit(f"{case}: verify has no output stage yet ({work / 'reports' / 'output.json'} missing) — run `make verify CASE={case}` first")
    # the case's golden set, the way the page's upload puts it next to the job
    dest = work / GOLDEN_DIR
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(case_dir / "golden", dest)
    version = git_version()
    out = out_root / case / f"{time.strftime('%Y%m%d-%H%M')}_{version}"
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    cmp = compare_job(storage, case, force=True)
    rows = []
    for L in cmp["layers"]:
        suf = L["suffix"]
        if layers and suf not in layers:
            continue
        svg = out / f"{L['output']}.svg"
        # ours in one neutral tan on every layer: the page tints by layer type, but top copper's red and
        # the mask's purple fight with the red/blue difference colours on a still picture
        text = re.sub(r'(<g class="cmp-ours" transform="scale\(1,-1\)" fill=")#[0-9a-fA-F]{6}(")', r"\1#c9a97a\2", compare_svg(storage, case, suf) or "", count=1)
        svg.write_text(text, "utf-8")
        render_full(svg, out / f"{L['output']}.png")
        n_tiles = contact_sheet(svg, L["clusters"], out / f"{L['output']}_clusters.png")
        b = L["bands"]
        rows.append({
            "layer": L["output"], "type": L["type"], "clusters": L["n_clusters"], "missing": L["n_missing"], "extra": L["n_extra"], "changed": L["n_changed"],
            "shape_pct": L["shape_pct"], "xor_pct": L["xor_pct"],
            "shape_mm2": round(b["missing"]["shape"] + b["extra"]["shape"], 1), "size_mm2": round(b["missing"]["size"] + b["extra"]["size"], 1),
            "noise_mm2": round(b["missing"]["noise"] + b["extra"]["noise"], 1), "tiles": n_tiles, "note": L.get("note"),
        })
        print(f"  {L['output']:22s} {L['n_clusters']:4d} 簇（−{L['n_missing']} +{L['n_extra']} ~{L['n_changed']}）  C 档 {L['shape_pct']:.2f}%", flush=True)
    d = cmp.get("drill")
    summary = {"case": case, "version": version, "at": time.strftime("%Y-%m-%d %H:%M"), "layers": rows,
               "drill": {k: d[k] for k in ("holes_ours", "holes_golden", "n_mismatch")} if d else None, "seconds": round(time.time() - t0)}
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), "utf-8")
    md = [f"# {case} · {version} · {summary['at']}", "", "| 层 | 簇 | 少 | 多 | 改 | C 档 % | C 档 mm² | B 档 mm² | 备注 |", "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| [{r['layer']}]({r['layer']}.png) | {r['clusters']} | {r['missing']} | {r['extra']} | {r['changed']} | {r['shape_pct']:.2f} | {r['shape_mm2']} | {r['size_mm2']} | {r['note'] or ''} |")
    if d:
        md.append(f"\n钻孔：{d['holes_ours']} vs {d['holes_golden']} 孔，{d['n_mismatch']} 种孔径对不上")
    (out / "index.md").write_text("\n".join(md) + "\n", "utf-8")
    print(f"{case} → {out}  ({summary['seconds']} s)")
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("case", nargs="+", help="cases/<id>")
    ap.add_argument("--verify-root", default=str(ROOT / "data" / "verify"))
    ap.add_argument("--out", default=str(ROOT / "data" / "snapshots"))
    ap.add_argument("--layer", action="append", help="only these suffixes (e.g. .gts); repeatable")
    a = ap.parse_args(argv)
    for case in a.case:
        snapshot(case, Path(a.verify_root), Path(a.out), a.layer)


if __name__ == "__main__":
    main()
