"""量差异用的尺子：``uv run python tools/probe.py <子命令> <case> …``

对标循环里反复要问的几件事——「这一堆差异都是些什么」「人画了我们没画的是哪些」
「线宽/焊盘尺寸三边各是多少」「(x,y) 这一点上三边各有什么」「孔表差在哪」
「工艺边铜带在哪断开」——原来每次都在临时目录里现写脚本，机器一重启就没了
（2026-09-21 yibing：搬进 tools/）。这里一次写清楚，读 ``data/verify/<case>/``
（先 ``make verify CASE=<case>`` 或 ``make round N=…``）。

    tools/probe.py layers C12_real_4l_protel99                 有哪些层配上了终稿
    tools/probe.py piles  C12_real_4l_protel99 .gtl            差异按「方向+尺寸」归堆
    tools/probe.py gold   C11_real_4l_altium .gts --dir missing 人有我们没有的，按面积排
    tools/probe.py census C12_real_4l_protel99 .gtl            线宽/焊盘：客户|我们|终稿
    tools/probe.py at     C09_real_6l_3oz .gtl 51.39 3.2 -r 1  某一点上三边各有什么
    tools/probe.py fine   C12_real_4l_protel99 .gts            B 档细差异（0.02–0.1 mm）按尺寸归堆
    tools/probe.py holes  C09_real_6l_3oz                      孔表对比
    tools/probe.py rails  C12_real_4l_protel99 .gtl --y 0 3.5  一条工艺边上铜带的通断

三边一律按**输出帧**说话（客户原稿已经加过 origin_shift），报出来的坐标可以直接拿去
和 profile.yaml、终稿对比图对。"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path
from typing import Any

from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from engine.compare import (
    GOLDEN_DIR,
    _fold_pair,
    _orig_geometry,
    compare_layer,
    drill_sizes,
    manifest,
)
from engine.geom.features import FeatureLayer
from engine.storage import Storage

ROOT = Path(__file__).resolve().parents[1]
SIDES = ("客户原稿", "我们", "工程师终稿")


# ----------------------------------------------------------------- 打开一个跑完的 case


class Case:
    """一个跑完的 verify 结果：存储、配对清单、三边几何/要素都从这里拿。"""

    def __init__(self, case: str) -> None:
        self.name = case
        self.base = ROOT / "data" / "verify" / case
        if not (self.base / "work" / case).is_dir():
            raise SystemExit(f"{case}: data/verify 下没有跑过的结果，先 make verify CASE={case}")
        self.storage = Storage(storage_root=self.base / "storage", work_root=self.base / "work")
        self.man = manifest(self.storage, case)
        self.work = self.storage.work_dir(case, create=False)
        self.shift = self.man.get("origin_shift")

    # ---- 配对清单 ------------------------------------------------------------------
    def entries(self, suffixes: list[str] | None = None) -> list[dict[str, Any]]:
        want = {s.lower() for s in suffixes or []}
        out = [e for e in self.man["layers"] if e["golden"] and (not want or e["suffix"].lower() in want)]
        if want and not out:
            have = " ".join(e["suffix"] for e in self.man["layers"])
            raise SystemExit(f"{self.name}: 没有这个后缀，有的是：{have}")
        return out

    def entry(self, suffix: str) -> dict[str, Any]:
        return self.entries([suffix])[0]

    # ---- 几何（折叠后的整层，输出帧） ------------------------------------------------
    def folded(self, e: dict[str, Any]) -> tuple[BaseGeometry | None, BaseGeometry, BaseGeometry]:
        ours, gold = _fold_pair(self.storage, self.name, e)
        return _orig_geometry(self.storage, self.name, e, self.shift), ours, gold

    # ---- 要素（画出来的每一笔，输出帧） ----------------------------------------------
    def features(self, e: dict[str, Any]) -> list[tuple[str, FeatureLayer | None, float]]:
        """[(哪一边, 要素层, 换算系数)]；客户原稿已按 origin_shift 平移到输出帧，没有源层的给 None。

        系数是因为 ``Feature.width_mm`` / ``Feature.xy`` / ``Symbol.name`` 都按**文件自己的单位**
        取值（``f.geom`` 才一定是 mm）——我们导出的是英寸 Gerber，客户的常是毫米，不乘这个系数
        三边的线宽根本不在一个量纲上。"""
        out: list[tuple[str, FeatureLayer | None, float]] = []
        src = self.work / "src" / e["file"] if e.get("file") else None
        out.append((SIDES[0], _load_shifted(src, e["type"], self.shift) if src and src.is_file() else None, 0.0))
        out.append((SIDES[1], FeatureLayer.load(self.storage.object_path(e["path"]), e["output"], e["type"]), 0.0))
        out.append((SIDES[2], FeatureLayer.load(self.work / GOLDEN_DIR / e["golden"], e["golden"], e["type"]), 0.0))
        return [(name, fl, _to_mm(fl)) for name, fl, _ in out]


def _to_mm(fl: FeatureLayer | None) -> float:
    """文件单位 → mm 的系数（英寸 Gerber 是 25.4）。"""
    return 25.4 if fl is not None and str(getattr(fl.gf, "unit", "mm")).startswith("in") else 1.0


def _load_shifted(path: Path, ltype: str, shift: list[float] | None) -> FeatureLayer:
    """客户源层读进来，再整体挪到输出帧 —— 帧不对是这个项目最容易犯的错。"""
    fl = FeatureLayer.load(path, path.name, ltype)
    if shift and (shift[0] or shift[1]):
        fl.gf.offset(float(shift[0]), float(shift[1]))  # gerbonara 的 offset 默认按 mm
    return fl


def _sym_label(f: Any, k: float) -> str:
    """焊盘型号，尺寸一律按 mm 写 —— ``Symbol.name`` 是按文件单位算 mil 的，英寸文件上会小 25.4 倍。"""
    s = f.symbol
    if s is None:
        return "铺铜/面"
    p = "x".join(f"{v * k:g}" if i < 2 or s.kind in ("ths", "thr") else f"{v:g}" for i, v in enumerate(s.params))
    return f"{s.kind}{p}" + (f"孔{s.hole_mm * k:g}" if s.hole_mm else "")


# ----------------------------------------------------------------- 子命令


def cmd_layers(case: Case, args: argparse.Namespace) -> None:
    print(f"{case.name}：{len(case.man['layers'])} 层配上了终稿，origin_shift = {case.shift}")
    for e in case.man["layers"]:
        print(f"  {e['suffix']:<6} {e['type']:<14} 我们 {e['output']:<26} 终稿 {e['golden']:<26} 客户 {e.get('file') or '—'}")
    for name in case.man["unmatched_golden"]:
        print(f"  （终稿里没配上的：{name}）")


def _size_key(c: dict[str, Any], step: float) -> tuple[float, float]:
    x0, y0, x1, y1 = c["bbox"]
    def q(v: float) -> float:
        return round(round(v / step) * step, 3)

    return q(x1 - x0), q(y1 - y0)


def cmd_piles(case: Case, args: argparse.Namespace) -> None:
    """差异按「方向 + 外框尺寸」归堆 —— 一堆就是一种没做对的处理，逐堆定规则。"""
    for e in case.entries(args.suffix):
        rep = compare_layer(case.storage, case.name, e)
        piles: dict[tuple[str, tuple[float, float]], list[dict[str, Any]]] = defaultdict(list)
        for c in rep["clusters"]:
            piles[(c["direction"], _size_key(c, args.step))].append(c)
        print(f"\n{e['suffix']} {e['type']}：形状差 {rep['shape_pct']}%，{rep['n_clusters']} 簇"
              f"（人有我们没有 {rep['n_missing']} / 我们有人没有 {rep['n_extra']} / 形状不同 {rep['n_changed']}）")
        for (d, size), cs in sorted(piles.items(), key=lambda kv: -sum(c["area_mm2"] for c in kv[1])):
            area = sum(c["area_mm2"] for c in cs)
            s = cs[0]["sample"]
            print(f"  {d:<8} {size[0]:>7.3f}×{size[1]:<7.3f} ×{len(cs):<4} 合计 {area:>8.3f} mm²   例 ({(s[0]+s[2])/2:.3f},{(s[1]+s[3])/2:.3f})")


def cmd_gold(case: Case, args: argparse.Namespace) -> None:
    """按面积排出单个差异点，给坐标 —— 拿去 splitview 里对着看。"""
    for e in case.entries(args.suffix):
        rep = compare_layer(case.storage, case.name, e)
        cs = [c for c in rep["clusters"] if args.dir in ("all", c["direction"])]
        cs.sort(key=lambda c: -c["area_mm2"])
        print(f"\n{e['suffix']} {e['type']}：{args.dir} {len(cs)} 处")
        for i, c in enumerate(cs[: args.top], 1):
            x0, y0, x1, y1 = c["bbox"]
            print(f"  {i:>3} {c['direction']:<8} {c['area_mm2']:>8.3f} mm²  {x1-x0:>7.3f}×{y1-y0:<7.3f}"
                  f"  @({(x0+x1)/2:.3f},{(y0+y1)/2:.3f})  片 {c['pieces']}")


def _census(fl: FeatureLayer | None, k: float) -> tuple[Counter, Counter, int]:
    if fl is None:
        return Counter(), Counter(), 0
    widths = Counter(round(f.width_mm * k, 4) for f in fl.lines() if f.width_mm)
    pads = Counter(_sym_label(f, k) for f in fl.pads())
    return widths, pads, len(fl.surfaces())


def cmd_census(case: Case, args: argparse.Namespace) -> None:
    """线宽表 / 焊盘表，三边并排 —— 补偿有没有做对、焊盘有没有换型，看这张表最快。"""
    for e in case.entries(args.suffix):
        cols = [_census(fl, k) for _, fl, k in case.features(e)]
        print(f"\n{e['suffix']} {e['type']}   列＝{' | '.join(SIDES)}")
        print("  线宽 mm      " + "".join(f"{s:>14}" for s in SIDES))
        for w in sorted(set().union(*(c[0] for c in cols))):
            print(f"  {w:<12.4f}" + "".join(f"{c[0].get(w, 0):>14}" for c in cols))
        print("  焊盘         " + "".join(f"{s:>14}" for s in SIDES))
        for name in sorted(set().union(*(c[1] for c in cols)))[: args.top]:
            print(f"  {name:<12}" + "".join(f"{c[1].get(name, 0):>14}" for c in cols))
        print("  铺铜块       " + "".join(f"{c[2]:>14}" for c in cols))


def cmd_at(case: Case, args: argparse.Namespace) -> None:
    """(x,y) 这一点周围，三边各画了什么 —— 判一处差异是「缺/多/调」的第一手。"""
    win = box(args.x - args.r, args.y - args.r, args.x + args.r, args.y + args.r)
    for e in case.entries(args.suffix):
        print(f"\n{e['suffix']} {e['type']}  @({args.x},{args.y}) ±{args.r}mm")
        geoms = case.folded(e)
        for (side, fl, k), g in zip(case.features(e), geoms):
            if fl is None:
                print(f"  {side}：没有对应的源层")
                continue
            cov = g.intersection(win).area if g is not None else 0.0
            hits = sorted(fl.query(win), key=lambda f: -f.geom.area)
            print(f"  {side}：窗口内铜 {cov:.4f} mm²，{len(hits)} 笔")
            for f in hits[: args.top]:
                x, y = f.xy if f.kind == "surface" else (f.xy[0] * k, f.xy[1] * k)  # 面的 xy 取自 geom，本来就是 mm
                w = f"宽 {f.width_mm * k:.4f}" if f.width_mm else ("铺铜/面" if f.kind == "surface" else _sym_label(f, k))
                print(f"      {f.kind:<8} {w:<16} @({x:.3f},{y:.3f})  面积 {f.geom.area:.4f}"
                      f"{'  ' + str(f.attrs.get('.string')) if f.attrs.get('.string') else ''}")


def cmd_fine(case: Case, args: argparse.Namespace) -> None:
    """B 档（带宽 0.02–0.1 mm）的细差异落在哪：按侵蚀判带宽，按外框尺寸归堆 —— 补偿量、开窗余量、描边线宽这类
    「差一两 mil」的规则错都藏在这里，C 档的簇看不见它们（第 16 轮阻焊描边 0.15/0.2 就是这么量出来的）。"""
    for e in case.entries(args.suffix):
        _, ours, gold = case.folded(e)
        rows = []
        for direction, d in (("missing", gold.difference(ours)), ("extra", ours.difference(gold))):
            for p in getattr(d, "geoms", [d]):
                if p.is_empty or p.area < 0.01 or p.buffer(-0.01).is_empty:   # 噪声：< 0.02 宽
                    continue
                if not p.buffer(-0.05).is_empty:                             # C 档：> 0.1 宽
                    continue
                x0, y0, x1, y1 = p.bounds
                rows.append((p.area, direction, x0, y0, x1, y1))
        piles: dict[tuple[str, float, float], list[tuple[float, float, float]]] = defaultdict(list)
        for a, d, x0, y0, x1, y1 in rows:
            piles[(d, round((x1 - x0) * 4) / 4, round((y1 - y0) * 4) / 4)].append((a, (x0 + x1) / 2, (y0 + y1) / 2))
        print(f"\n{e['suffix']} {e['type']}：B 档合计 {sum(r[0] for r in rows):.1f} mm²，{len(rows)} 片")
        for (d, w, h), lst in sorted(piles.items(), key=lambda kv: -sum(a for a, *_ in kv[1]))[: args.top]:
            a = sum(x[0] for x in lst)
            print(f"  {d:<8} 框≈{w:>6.2f}×{h:<6.2f} ×{len(lst):<5} 合计 {a:7.2f} mm²  例 ({lst[0][1]:.2f},{lst[0][2]:.2f})")


def cmd_holes(case: Case, args: argparse.Namespace) -> None:
    d = case.man.get("drill")
    if not d or not d["golden"]:
        raise SystemExit(f"{case.name}: 没有配上终稿的钻带")
    ours = drill_sizes(case.storage.object_path(d["path"]))
    gold = drill_sizes(case.work / GOLDEN_DIR / d["golden"])
    print(f"{case.name} 钻带：我们 {d['output']} | 终稿 {d['golden']}")
    print("  孔径 mm  类型      我们    终稿     差")
    for k in sorted(set(ours) | set(gold)):
        o, g = ours.get(k, 0), gold.get(k, 0)
        print(f"  {k[0]:<8.3f} {k[1]:<8} {o:>6} {g:>7} {o - g:>+6}" + ("" if o == g else "   ←"))
    print(f"  合计     {'':<8} {sum(ours.values()):>6} {sum(gold.values()):>7}")


def cmd_rails(case: Case, args: argparse.Namespace) -> None:
    """一条带状区域上铜的通断：给出每一段铜的起止和中间留空段的起止、中点、长度。

    工艺边铜带在哪断开、测试点坐落在哪一段，都是从这里量出来的（留空段绝不许照抄，
    量出来是为了找出「为什么断在这」的规律）。"""
    lo, hi = args.y if args.axis == "x" else args.x
    for e in case.entries(args.suffix):
        _, ours, gold = case.folded(e)
        span = box(args.window[0], lo, args.window[1], hi) if args.axis == "x" else box(lo, args.window[0], hi, args.window[1])
        for side, g in ((SIDES[1], ours), (SIDES[2], gold)):
            cut = g.intersection(span)
            parts = sorted(getattr(cut, "geoms", [cut]), key=lambda p: p.bounds[0 if args.axis == "x" else 1])
            i0, i1 = (0, 2) if args.axis == "x" else (1, 3)
            runs = [(p.bounds[i0], p.bounds[i1]) for p in parts if not p.is_empty]
            merged: list[list[float]] = []
            for a, b in runs:
                if merged and a - merged[-1][1] <= args.join:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            print(f"\n{e['suffix']} {side} 带 {args.axis}∈[{args.window[0]},{args.window[1]}]"
                  f" {'y' if args.axis == 'x' else 'x'}∈[{lo},{hi}]：{len(merged)} 段铜")
            for a, b in merged:
                print(f"    铜 {a:>9.3f} → {b:<9.3f} 长 {b - a:>8.3f}")
            for (_, a), (b, _) in pairwise(merged):
                print(f"    留空 {a:>7.3f} → {b:<9.3f} 长 {b - a:>8.3f}  中点 {(a + b) / 2:.3f}")


# ----------------------------------------------------------------- CLI


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="tools/probe.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name: str, fn: Any, help_: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_)
        sp.add_argument("case")
        sp.set_defaults(fn=fn)
        return sp

    add("layers", cmd_layers, "配上终稿的层清单")

    sp = add("piles", cmd_piles, "差异按方向+尺寸归堆")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("--step", type=float, default=0.05, help="归堆时尺寸取整到多少 mm（默认 0.05）")

    sp = add("gold", cmd_gold, "单个差异点按面积排")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("--dir", choices=("missing", "extra", "changed", "all"), default="missing")
    sp.add_argument("--top", type=int, default=40)

    sp = add("census", cmd_census, "线宽/焊盘三边并排")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("--top", type=int, default=30)

    sp = add("at", cmd_at, "某一点上三边各有什么")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("x", type=float)
    sp.add_argument("y", type=float)
    sp.add_argument("-r", type=float, default=0.5, help="窗口半宽 mm")
    sp.add_argument("--top", type=int, default=12)

    sp = add("fine", cmd_fine, "B 档细差异按尺寸归堆")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("--top", type=int, default=20)

    add("holes", cmd_holes, "孔表对比")

    sp = add("rails", cmd_rails, "一条带上铜的通断")
    sp.add_argument("suffix", nargs="*")
    sp.add_argument("--axis", choices=("x", "y"), default="x", help="沿哪个轴看通断（默认 x，横向工艺边）")
    sp.add_argument("--window", type=float, nargs=2, default=[-1e4, 1e4], help="沿轴的取值范围")
    sp.add_argument("--x", type=float, nargs=2, default=[0.0, 5.0], help="axis=y 时带的横向范围")
    sp.add_argument("--y", type=float, nargs=2, default=[0.0, 5.0], help="axis=x 时带的纵向范围")
    sp.add_argument("--join", type=float, default=0.01, help="缝隙小于多少 mm 就当连着（默认 0.01）")

    a = p.parse_args(argv)
    a.fn(Case(a.case), a)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
