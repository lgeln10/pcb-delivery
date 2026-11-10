"""把 engine.snapshot 各轮的结果汇成一个「可翻的」目录：趋势表 + 每层跨轮并排图 + 每轮的放大拼图。

    uv run python -m engine.rounds                      # 全部案例，汇总到 data/snapshots/_逐轮对比/
    uv run python -m engine.rounds --case C09_real_6l_3oz
    uv run python -m engine.rounds --round 3 --note "第 3 轮结论.md"

每个案例的快照目录 data/snapshots/<case>/<日期时间>_<git 版本>/ 按时间排序 = 第 1 轮、第 2 轮…
产出（data/snapshots/_逐轮对比/）：
  趋势.md                       每案例每层 shape% / 簇数 逐轮一行，一眼看收敛
  第N轮/<case>_<层>_簇图.png     该轮最大 16 簇的放大拼图（从快照目录拷来，名字可读）
  逐层并排/<case>_<层>.png       同一层最近几轮的整层图横向并排，每格标轮次和数字
  README.md                     索引 + 每轮结论的链接
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAP = ROOT / "data" / "snapshots"
OUT = SNAP / "_逐轮对比"
# ★本机 macOS 26 没有 PingFang.ttc；Hiragino Sans GB 缺 ²。STHeiti Light 中西文都全。
FONT_CANDIDATES = ["/System/Library/Fonts/STHeiti Light.ttc", "/System/Library/Fonts/PingFang.ttc",
                   "/System/Library/Fonts/Hiragino Sans GB.ttc", "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"]


@dataclass
class Round:
    n: int
    case: str
    dir: Path
    stamp: str
    version: str
    layers: dict[str, dict]


def _load(case_dir: Path) -> list[Round]:
    out: list[Round] = []
    dirs = sorted(d for d in case_dir.iterdir() if d.is_dir() and re.match(r"^\d{8}-\d{4}_", d.name))
    for i, d in enumerate(dirs, 1):
        f = d / "summary.json"
        if not f.is_file():
            continue
        data = json.loads(f.read_text())
        rows = data["layers"] if isinstance(data, dict) and "layers" in data else data
        stamp, _, version = d.name.partition("_")
        out.append(Round(i, case_dir.name, d, stamp, version, {r["layer"]: r for r in rows}))
    return out


def rounds_by_case() -> dict[str, list[Round]]:
    if not SNAP.is_dir():
        return {}
    cases = sorted(d for d in SNAP.iterdir() if d.is_dir() and not d.name.startswith("_"))
    return {c.name: _load(c) for c in cases}


def _short(layer: str) -> str:
    """y6f085471a0.l2 → l2"""
    return layer.rsplit(".", 1)[-1]


def trend_md(by_case: dict[str, list[Round]]) -> str:
    lines = ["# 逐轮趋势（每层：C 档 shape% / 簇数）", ""]
    lines.append("shape% = 形状差异占该层铜面积；簇 = C 档差异簇数（含有主/无主）。越小越接近工程师终稿。")
    lines.append("字符层（gto/gbo）是字体不同，几何比无意义，只作参考。")
    for case, rounds in by_case.items():
        if not rounds:
            continue
        lines += ["", f"## {case}", ""]
        for r in rounds:
            lines.append(f"- 第 {r.n} 轮 `{r.stamp}` 版本 `{r.version}`")
        layers = sorted({k for r in rounds for k in r.layers}, key=lambda k: (_short(k) in ("gto", "gbo"), _short(k)))
        head = "| 层 | " + " | ".join(f"第{r.n}轮" for r in rounds) + " | 走向 |"
        lines += ["", head, "|" + "---|" * (len(rounds) + 2)]
        for layer in layers:
            cells, vals = [], []
            for r in rounds:
                e = r.layers.get(layer)
                if not e:
                    cells.append("—")
                    continue
                pct, n = e.get("shape_pct"), e.get("clusters")
                vals.append(pct)
                cells.append(f"{pct:.2f}% / {n}" if pct is not None else "—")
            arrow = ""
            if len(vals) >= 2 and vals[0] is not None and vals[-1] is not None:
                d = vals[-1] - vals[0]
                arrow = "持平" if abs(d) < 0.01 else (f"↓{-d:.2f}" if d < 0 else f"↑{d:.2f}")
            lines.append(f"| {_short(layer)} | " + " | ".join(cells) + f" | {arrow} |")
    return "\n".join(lines) + "\n"


def _label_font(size: int):
    from PIL import ImageFont

    for p in FONT_CANDIDATES:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def side_by_side(rounds: list[Round], layer: str, dest: Path, width: int = 1300, keep: int = 4) -> Path | None:
    """同一层最近 keep 轮的整层图横向并排，每格上方写轮次 + 数字。"""
    from PIL import Image, ImageDraw

    picks = [r for r in rounds if (r.dir / f"{layer}.png").is_file()][-keep:]
    if len(picks) < 2:
        return None
    bar = 54
    tiles = []
    for r in picks:
        im = Image.open(r.dir / f"{layer}.png").convert("RGB")
        h = max(1, round(im.height * width / im.width))
        tiles.append((r, im.resize((width, h), Image.LANCZOS)))
    h = max(t.height for _, t in tiles)
    canvas = Image.new("RGB", (width * len(tiles), h + bar), "white")
    d = ImageDraw.Draw(canvas)
    font = _label_font(26)
    for i, (r, t) in enumerate(tiles):
        x = i * width
        canvas.paste(t, (x, bar))
        e = r.layers.get(layer, {})
        pct, n = e.get("shape_pct"), e.get("clusters")
        txt = f"第 {r.n} 轮 {r.stamp}  {_short(layer)}  " + (f"{pct:.2f}% / {n} 簇" if pct is not None else "")
        d.text((x + 12, 14), txt, fill="#111827", font=font)
        if i:
            d.line([(x, 0), (x, h + bar)], fill="#9ca3af", width=2)
    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(dest)
    return dest


def build(only_case: str | None = None, keep: int = 4) -> Path:
    by_case = rounds_by_case()
    if only_case:
        by_case = {k: v for k, v in by_case.items() if k.startswith(only_case)}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "趋势.md").write_text(trend_md(by_case), encoding="utf-8")

    made: list[str] = []
    for case, rounds in by_case.items():
        if not rounds:
            continue
        last = rounds[-1]
        for layer in sorted(last.layers, key=_short):
            src = last.dir / f"{layer}_clusters.png"
            if src.is_file():
                dst = OUT / f"第{last.n}轮" / f"{case.split('_')[0]}_{_short(layer)}_簇图.png"
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
            p = side_by_side(rounds, layer, OUT / "逐层并排" / f"{case.split('_')[0]}_{_short(layer)}.png", keep=keep)
            if p:
                made.append(str(p.relative_to(OUT)))

    idx = ["# M6n 逐轮对比（看图收敛）", "", "- [趋势.md](趋势.md) —— 每层每轮的 shape% / 簇数，一眼看收敛", ""]
    notes = sorted(OUT.glob("第*轮_结论.md"))
    if notes:
        idx += ["## 每轮结论", ""] + [f"- [{n.name}]({n.name})" for n in notes] + [""]
    # 变化最大的几层：直接给图，省得一张张翻
    movers: list[tuple[float, str, str, str]] = []
    for case, rounds in by_case.items():
        if len(rounds) < 2:
            continue
        for layer in rounds[-1].layers:
            a = rounds[0].layers.get(layer, {}).get("shape_pct")
            b = rounds[-1].layers.get(layer, {}).get("shape_pct")
            if a is None or b is None or _short(layer) in ("gto", "gbo"):
                continue
            movers.append((b - a, case.split("_")[0], _short(layer), f"{a:.2f}% → {b:.2f}%"))
    if movers:
        movers.sort(key=lambda m: m[0])
        idx += ["## 变化最大的层（第 1 轮 → 最新一轮）", ""]
        for d, case, lay, txt in movers[:5]:
            idx.append(f"- **{case} {lay}** {txt}（{'好了' if d < 0 else '差了'} {abs(d):.2f}）— [并排图](逐层并排/{case}_{lay}.png)")
        worse = [m for m in movers if m[0] > 0.01][-3:]
        if worse:
            idx += [""] + [f"- ⚠️ **{c} {l}** {t}（差了 {d:.2f}）— [并排图](逐层并排/{c}_{l}.png)" for d, c, l, t in reversed(worse)]
        idx.append("")
    idx += ["## 图", "", "- `逐层并排/<案例>_<层>.png` —— 同一层最近几轮的整层对比图并排（红=人有我们没有，蓝=我们有人没有，土黄=我们，琥珀=客户原稿，细圈=孔）",
            "- `第N轮/<案例>_<层>_簇图.png` —— 该轮这层最大 16 簇的放大拼图", ""]
    (OUT / "README.md").write_text("\n".join(idx), encoding="utf-8")
    return OUT


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--case", help="只处理这个案例（前缀匹配，如 C09）")
    ap.add_argument("--keep", type=int, default=4, help="并排图保留最近几轮（默认 4）")
    args = ap.parse_args()
    out = build(args.case, args.keep)
    print(f"→ {out}")
    print((out / "趋势.md").read_text(encoding="utf-8")[:4000])


if __name__ == "__main__":
    main()
