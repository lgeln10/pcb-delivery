"""``uv run python -m engine.splitview <case>``: 每一处差异的**分层三联图** —— 客户原稿 | 我们 | 工程师终稿，
三张各自单独画（同一裁剪、同一比例、同一种颜色，孔画细圈做参照），最右一格才是红/蓝叠加，只当索引用。

叠加图只能说明「这里不一样」，看不出人是怎么画的；要判断「缺了哪一步处理 / 多了哪一步 / 哪一步该调」得看人
画出来的东西本身（yibing 2026-09-20）。同一坐标相关的层（外层线路 ↔ 同面阻焊、外形 ↔ 顶层线路）各出一行、上下对齐。

产出 ``data/snapshots/_分层/<case>/<layer>/<NNN>.png`` 一点一图，``<layer>.md`` 按「方向 + 尺寸」归堆列出，
每堆一张代表图和点数，判定列留空给人填（缺 / 多 / 调）。需要跑完的 ``data/verify/<case>/``。"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from collections import OrderedDict
from pathlib import Path
from typing import Any

from engine.compare import GOLDEN_DIR, compare_job, compare_svg
from engine.snapshot import MAX_HALF_MM, _font, _viewbox, render_crop
from engine.storage import Storage

ROOT = Path(__file__).resolve().parents[1]
CELL = 360
INK = "#5b4630"  # 三张都用同一种颜色：一样的颜色才看得出形状差在哪
COLS = ("cmp-orig", "cmp-ours", "cmp-gold")
COL_NAMES = ("客户原稿", "我们", "工程师终稿")
COMPANION = {  # 同一坐标再看哪几层（自己总在第一行）
    "top_copper": ["top_mask"], "bottom_copper": ["bottom_mask"],
    "top_mask": ["top_copper"], "bottom_mask": ["bottom_copper"],
    "outline": ["top_copper"], "inner_rout": ["top_copper"], "inner_copper": [],
}
SKIP_TYPES = {"top_silk", "bottom_silk"}
DIR_ZH = {"missing": "人有我们没有", "extra": "我们有人没有", "changed": "形状不同"}


def _only(svg: str, keep: str) -> str:
    """The compare SVG with just one source group (+ holes), painted INK."""
    out = re.sub(r'<g class="cmp-(?!holes)(?!' + keep[4:] + r')[a-z]+"[^>]*>.*?</g>\n', "", svg, flags=re.S)
    return re.sub(r'(<g class="' + keep + r'"[^>]*fill=")#[0-9a-fA-F]{6}(")', r"\1" + INK + r"\2", out, count=1)


class Pages:
    """One pymupdf page per (layer, source), opened on demand."""

    def __init__(self, svgs: dict[str, str]):
        self.svgs = svgs
        self.cache: dict[tuple[str, str], Any] = {}
        self.vb = {k: _viewbox_text(v) for k, v in svgs.items()}

    def get(self, suffix: str, source: str) -> Any:
        import pymupdf

        key = (suffix, source)
        if key not in self.cache:
            text = self.svgs[suffix] if source == "overlay" else _only(self.svgs[suffix], source)
            self.cache[key] = pymupdf.open(stream=text.encode("utf-8"), filetype="svg")[0]
        return self.cache[key]


def _viewbox_text(svg: str) -> list[float]:
    return [float(v) for v in re.search(r'viewBox="([^"]+)"', svg[:600]).group(1).split()]


def _window(c: dict[str, Any]) -> tuple[float, float, float, float, str]:
    """(cx, cy, halfx, halfy, caption) — same framing rule as the contact sheet."""
    sx0, sy0, sx1, sy1 = c.get("sample") or c["bbox"]
    cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
    if max(sx1 - sx0, sy1 - sy0) > 2 * MAX_HALF_MM:
        hx, hy = (sx1 - sx0) / 2 + (sx1 - sx0) * 0.04 + 0.3, (sy1 - sy0) / 2 + (sy1 - sy0) * 0.04 + 0.3
        return cx, cy, hx, hy, f"整块 {2 * hx:.0f}×{2 * hy:.0f}mm"
    half = min(max(max(sx1 - sx0, sy1 - sy0, 0.5) * 0.75 + 0.6, 1.5), MAX_HALF_MM)
    return cx, cy, half, half, f"@({cx:.1f},{cy:.1f}) ±{half:.1f}mm"


def _tile(pages: Pages, suffix: str, source: str, cx: float, cy: float, hx: float, hy: float) -> Any:
    from PIL import Image

    pix = render_crop(pages.get(suffix, source), pages.vb[suffix], cx, cy, hx, CELL, halfy=hy)
    if pix is None:
        return Image.new("RGB", (CELL, CELL), "#eee")
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if im.size != (CELL, CELL):
        sq = Image.new("RGB", (CELL, CELL), "white")
        im.thumbnail((CELL, CELL), Image.LANCZOS)
        sq.paste(im, ((CELL - im.width) // 2, (CELL - im.height) // 2))
        im = sq
    return im


def point_figure(pages: Pages, rows: list[str], c: dict[str, Any], title: str, png: Path) -> None:
    from PIL import Image, ImageDraw

    cx, cy, hx, hy, view = _window(c)
    font = _font()
    hdr, lab = 44, 22
    w = len(COLS) * (CELL + 4) + CELL + 4 + 90
    h = hdr + lab + len(rows) * (CELL + 4)
    sheet = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(sheet)
    d.text((4, 4), f"{title}   {view}", fill="black", font=font)
    for j, name in enumerate(COL_NAMES + ("叠加(索引)",)):
        d.text((90 + j * (CELL + 4) + 4, hdr), name, fill="#444", font=font)
    for i, suf in enumerate(rows):
        y = hdr + lab + i * (CELL + 4)
        d.text((4, y + CELL // 2 - 8), suf, fill="black", font=font)
        for j, src in enumerate(COLS + ("overlay",)):
            im = _tile(pages, suf, src, cx, cy, hx, hy)
            x = 90 + j * (CELL + 4)
            sheet.paste(im, (x, y))
            d.rectangle([x, y, x + CELL - 1, y + CELL - 1], outline="#999")
    sheet.save(png)


def _group_key(c: dict[str, Any]) -> tuple[str, float, float]:
    w, h = c["size_mm"]
    return c["direction"], round(w, 1), round(h, 1)


def splitview(case: str, verify_root: Path, out_root: Path, layers: list[str] | None = None) -> Path:
    case_dir = ROOT / "cases" / case
    base = verify_root / case
    storage = Storage(storage_root=base / "storage", work_root=base / "work")
    work = storage.work_dir(case, create=False)
    if not (work / "reports" / "output.json").is_file():
        sys.exit(f"{case}: verify has no output stage yet — run `make verify CASE={case}` first")
    dest = work / GOLDEN_DIR
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(case_dir / "golden", dest)
    cmp = compare_job(storage, case, force=False)
    by_type: dict[str, str] = {L["type"]: L["suffix"] for L in cmp["layers"]}
    svgs: dict[str, str] = {}
    for L in cmp["layers"]:
        if L["type"] in SKIP_TYPES:
            continue
        svgs[L["suffix"]] = compare_svg(storage, case, L["suffix"]) or ""
    pages = Pages(svgs)
    out = out_root / case
    out.mkdir(parents=True, exist_ok=True)
    for L in cmp["layers"]:
        suf = L["suffix"]
        if L["type"] in SKIP_TYPES or (layers and suf not in layers) or not L["clusters"]:
            continue
        rows = [suf] + [by_type[t] for t in COMPANION.get(L["type"], []) if t in by_type and by_type[t] in svgs]
        ldir = out / suf.lstrip(".")
        ldir.mkdir(exist_ok=True)
        groups: "OrderedDict[tuple[str, float, float], list[dict[str, Any]]]" = OrderedDict()
        for c in L["clusters"]:
            n = c["id"] + 1
            title = f"{case} {suf} #{n} {DIR_ZH.get(c['direction'], c['direction'])} {c['area_mm2']:.2f}mm² 框 {c['size_mm'][0]:.2f}×{c['size_mm'][1]:.2f} {c['pieces']}块"
            point_figure(pages, rows, c, title, ldir / f"{n:03d}.png")
            groups.setdefault(_group_key(c), []).append(c)
        md = [f"# {case} {suf} · {len(L['clusters'])} 点 · C 档 {L['shape_pct']:.2f}%", "",
              f"每点一图：`{suf.lstrip('.')}/NNN.png`，行 = {' / '.join(rows)}，列 = 客户原稿 / 我们 / 终稿 / 叠加。", "",
              "## 按方向 + 尺寸归堆", "", "| 堆 | 方向 | 框尺寸 | 点数 | 代表 | 全部 | 判定（缺 / 多 / 调） |", "|---|---|---|---|---|---|---|"]
        for k, (key, cs) in enumerate(sorted(groups.items(), key=lambda kv: -len(kv[1])), 1):
            ids = [c["id"] + 1 for c in cs]
            md.append(f"| {k} | {DIR_ZH[key[0]]} | {key[1]}×{key[2]} | {len(cs)} | [#{ids[0]}]({suf.lstrip('.')}/{ids[0]:03d}.png) | "
                      f"{' '.join(f'#{i}' for i in ids[:30])}{' …' if len(ids) > 30 else ''} |  |")
        md += ["", "## 逐点", "", "| # | 方向 | 面积 | 框 | 位置 | 图 |", "|---|---|---|---|---|---|"]
        for c in L["clusters"]:
            n = c["id"] + 1
            md.append(f"| {n} | {DIR_ZH.get(c['direction'], c['direction'])} | {c['area_mm2']:.2f} | {c['size_mm'][0]:.1f}×{c['size_mm'][1]:.1f} | "
                      f"({c['at'][0]:.1f},{c['at'][1]:.1f}) | [{n:03d}]({suf.lstrip('.')}/{n:03d}.png) |")
        (out / f"{suf.lstrip('.')}.md").write_text("\n".join(md) + "\n", "utf-8")
        print(f"  {case} {suf:6s} {len(L['clusters']):4d} 点 → {len(groups)} 堆", flush=True)
    return out


def window_figure(case: str, verify_root: Path, layers: list[str], x0: float, y0: float, x1: float, y1: float, png: Path, px: int = 1400) -> None:
    """任意窗口的分层三联图（客户 / 我们 / 终稿 竖着排，每层一组），查一段工艺边、一个区域时用。"""
    from PIL import Image, ImageDraw

    base = verify_root / case
    storage = Storage(storage_root=base / "storage", work_root=base / "work")
    cmp = compare_job(storage, case, force=False)
    svgs = {L["suffix"]: compare_svg(storage, case, L["suffix"]) or "" for L in cmp["layers"] if L["suffix"] in layers}
    pages = Pages(svgs)
    cx, cy, hx, hy = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    tiles = []
    for suf in layers:
        for src, name in zip(COLS, COL_NAMES):
            pix = render_crop(pages.get(suf, src), pages.vb[suf], cx, cy, hx, px, halfy=hy)
            if pix is None:
                continue
            tiles.append((f"{suf} {name}  x {x0}..{x1}  y {y0}..{y1}", Image.frombytes("RGB", (pix.width, pix.height), pix.samples)))
    font = _font()
    th = max(t[1].height for t in tiles)
    sheet = Image.new("RGB", (px + 8, len(tiles) * (th + 26)), "white")
    d = ImageDraw.Draw(sheet)
    for i, (text, im) in enumerate(tiles):
        y = i * (th + 26)
        d.text((4, y + 4), text, fill="black", font=font)
        sheet.paste(im, (4, y + 24))
        d.rectangle([4, y + 24, 4 + im.width - 1, y + 24 + im.height - 1], outline="#999")
    png.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(png)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("case", nargs="+")
    ap.add_argument("--verify-root", default=str(ROOT / "data" / "verify"))
    ap.add_argument("--out", default=str(ROOT / "data" / "snapshots" / "_分层"))
    ap.add_argument("--layer", action="append")
    ap.add_argument("--window", help="x0,y0,x1,y1（mm）：只出这一个窗口的分层图，配 --layer 和 --png")
    ap.add_argument("--png")
    ap.add_argument("--px", type=int, default=1400)
    a = ap.parse_args(argv)
    for case in a.case:
        if a.window:
            x0, y0, x1, y1 = (float(v) for v in a.window.split(","))
            window_figure(case, Path(a.verify_root), a.layer or [], x0, y0, x1, y1, Path(a.png), a.px)
        else:
            splitview(case, Path(a.verify_root), Path(a.out), a.layer)


if __name__ == "__main__":
    main()
