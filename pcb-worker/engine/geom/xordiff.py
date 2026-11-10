"""对标残差的分档与归属 —— 把「XOR 占百分之几」换成「有几条差异、每条归谁」。

一个 XOR 百分比同时装着两种完全不同的东西：客户原稿圆弧离散出来的发丝，和整块没铺的铜。
把差异按**带宽**切开就分得干净（判据是腐蚀：``buffer(-w/2)`` 之后还在，就说明这块至少有 w 宽）：

============  ==============  ====================================================
档            带宽            含义
============  ==============  ====================================================
A ``noise``   < 0.01 mm       坐标取整、圆弧离散、光圈端点。工艺本身也保证不了这个量级。
B ``size``    0.01 – 0.1 mm   两边画的是同一个形体，只是大小差一档（补偿 0.03 vs 0.05、
                              开窗 2 mil vs 4 mil）。一条厂规就能改对。
C ``shape``   > 0.1 mm        一边有一个东西另一边没有：整块铺铜、整个开窗、整个孔。
============  ==============  ====================================================

三块真板实测（2026-09-18，30 个层）：A 档只占 XOR 面积的 0.1%–13%，所以「百分比里大半是噪声」
并不成立；而把腐蚀宽度从 0.005 扫到 0.2 mm，分类几乎不动，所以档位也不是挑出来的。

C 档才是待办清单。门禁只问一句：**每一簇 C 档差异，能不能归到一条已知原因上**
（``cases/<id>/expected/diff_attribution.json``）。归不了的必须为 0 —— 归不了就是还没查清。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

NOISE_MM = 0.01  # A|B 分界：比这更细的差异物理上不存在
SHAPE_MM = 0.10  # B|C 分界：比这更宽的差异不是"大小差一档"，是形体本身有无
CLUSTER_GAP_MM = 0.6  # 这个距离内的碎块算同一处差异（一个焊盘的环会碎成几片）


@dataclass(frozen=True)
class Cluster:
    """一处 C 档差异。``direction`` 是 ``missing``（人有我们没有）或 ``extra``（我们有人没有）。"""

    direction: str
    n: int
    area: float
    bbox: tuple[float, float, float, float]
    sample: tuple[float, float, float, float] | None = None  # the biggest piece's own bbox: where to point a zoom window

    @property
    def center(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return ((x0 + x1) / 2, (y0 + y1) / 2)

    @property
    def size(self) -> tuple[float, float]:
        x0, y0, x1, y1 = self.bbox
        return (x1 - x0, y1 - y0)

    def describe(self) -> str:
        w, h = self.size
        x, y = self.center
        side = "人有我们没有" if self.direction == "missing" else "我们有人没有"
        # n>1 时外框是多块串起来的包络，不是一整块 —— 不写出来会把 18 mm² 看成 347×60
        piece = f"{self.n}块串" if self.n > 1 else "整块"
        return f"{side} {self.area:.2f}mm²（{piece}，框 {w:.2f}×{h:.2f}）@({x:.1f},{y:.1f})"


@dataclass
class BandSplit:
    """一个方向（missing / extra）的三档面积。"""

    noise: float = 0.0
    size: float = 0.0
    shape: float = 0.0
    clusters: list[Cluster] = field(default_factory=list)

    @property
    def total(self) -> float:
        return self.noise + self.size + self.shape


def _polys(g: BaseGeometry | None) -> list[Polygon]:
    if g is None or g.is_empty:
        return []
    return [p for p in getattr(g, "geoms", [g]) if isinstance(p, Polygon) and p.area > 1e-12]


def _survivors(comps: list[Polygon], tree: STRtree, diff: BaseGeometry, width: float) -> set[int]:
    """Indices of ``comps`` that still have a core after eroding by ``width / 2``."""
    alive: set[int] = set()
    for core in _polys(diff.buffer(-width / 2)):
        for i in tree.query(core, predicate="intersects"):
            if comps[int(i)].intersects(core):
                alive.add(int(i))
    return alive


def cluster(pieces: list[Polygon], gap: float = CLUSTER_GAP_MM) -> list[tuple[int, float, tuple[float, float, float, float], tuple[float, float, float, float]]]:
    """Group pieces closer than ``gap`` into one difference. Returns (n, area, bbox, biggest piece's bbox) per group."""
    if not pieces:
        return []
    grown = [p.buffer(gap) for p in pieces]
    tree = STRtree(grown)
    seen: set[int] = set()
    out = []
    for i in range(len(pieces)):
        if i in seen:
            continue
        stack, group = [i], []
        seen.add(i)
        while stack:
            k = stack.pop()
            group.append(k)
            for j in tree.query(grown[k], predicate="intersects"):
                j = int(j)
                if j not in seen and grown[j].intersects(grown[k]):
                    seen.add(j)
                    stack.append(j)
        geo: BaseGeometry = MultiPolygon([pieces[k] for k in group]) if len(group) > 1 else pieces[group[0]]
        big = max((pieces[k] for k in group), key=lambda q: q.area)
        out.append((len(group), sum(pieces[k].area for k in group), tuple(round(v, 3) for v in geo.bounds), tuple(round(v, 3) for v in big.bounds)))  # type: ignore[arg-type]
    out.sort(key=lambda t: -t[1])
    return out


def split_one(diff: BaseGeometry, direction: str, *, gap: float = CLUSTER_GAP_MM) -> BandSplit:
    """Band-split one direction of the difference and cluster the C band."""
    comps = _polys(diff)
    if not comps:
        return BandSplit()
    tree = STRtree(comps)
    above_noise = _survivors(comps, tree, diff, NOISE_MM)
    above_shape = _survivors(comps, tree, diff, SHAPE_MM)
    a = set(range(len(comps))) - above_noise
    b = above_noise - above_shape
    res = BandSplit(
        noise=sum(comps[i].area for i in a),
        size=sum(comps[i].area for i in b),
        shape=sum(comps[i].area for i in above_shape),
    )
    res.clusters = [
        Cluster(direction, n, round(area, 3), bbox, sample)
        for n, area, bbox, sample in cluster([comps[i] for i in sorted(above_shape)], gap)
    ]
    return res


def compare(ours: BaseGeometry, gold: BaseGeometry, *, gap: float = CLUSTER_GAP_MM) -> dict[str, Any]:
    """Full band report for one layer: ``{"missing": BandSplit, "extra": BandSplit, ...}``."""
    base = max(gold.area, 1e-9)
    missing = split_one(gold.difference(ours), "missing", gap=gap)
    extra = split_one(ours.difference(gold), "extra", gap=gap)
    return {
        "gold_area": gold.area,
        "ours_area": ours.area,
        "xor_pct": ours.symmetric_difference(gold).area / base * 100,
        "missing": missing,
        "extra": extra,
        "shape_pct": (missing.shape + extra.shape) / base * 100,
        "clusters": missing.clusters + extra.clusters,
    }


# --------------------------------------------------------------------------- 归属


class Attribution:
    """``diff_attribution.json`` 里的一条：一类已知差异，以及它允许覆盖的范围。

    ``expect`` 是防止一条归属把新冒出来的问题悄悄吃掉 —— 它盖住的簇数/面积超出预期就照样报错。
    """

    def __init__(self, raw: dict[str, Any], layer_bounds: tuple[float, float, float, float] | None = None):
        self.id = str(raw.get("id") or "?")
        self.reason = str(raw.get("reason") or "")
        # open      已经知道怎么改，待修
        # question  现象认得出、规则不知道，已带坐标问工程师 —— 不是「不知道所以放过」，
        #           而是「这一类差异是什么已经定性了，只差他给的数」
        # customer  客户设计 / wontfix 不打算做 / accepted 已决定照此
        self.status = str(raw.get("status") or "open")
        self.ref = raw.get("ref")
        self.layers = raw.get("layers")  # 输出后缀列表，缺省 = 所有层
        self.direction = raw.get("direction")  # missing / extra / 缺省两者
        regions = raw.get("regions") or ([raw["region"]] if raw.get("region") else [])
        self.regions = [box(*r) for r in regions]  # 命中任意一块就算（工艺边有好几条）
        self.edge_margin_mm = raw.get("edge_margin_mm")  # 距板边这么近的都算（工艺边用）
        self.min_area = float(raw.get("min_area_mm2", 0.0))
        self.max_area = raw.get("max_area_mm2")
        # 一「类」差异：阻焊里同一种开窗差同一个量，散在整板上，按位置框不住，只能按外框尺寸认
        self.sizes = [tuple(s) for s in (raw.get("sizes_mm") or [])]
        self.size_tol = float(raw.get("size_tol_mm", 0.05))
        self.expect = raw.get("expect") or {}
        self._bounds = layer_bounds
        self.matched: list[Cluster] = []

    def covers(self, c: Cluster, layer: str) -> bool:
        if self.layers and layer not in self.layers:
            return False
        if self.direction and self.direction != c.direction:
            return False
        if c.area < self.min_area:
            return False
        if self.max_area is not None and c.area > float(self.max_area):
            return False
        if self.sizes:
            # 外框或者「最大那块」的尺寸对上都算：串起来的簇外框是整排的长度，认不出单个的尺寸
            cand = [c.size]
            if c.sample:
                cand.append((c.sample[2] - c.sample[0], c.sample[3] - c.sample[1]))
            if not any(abs(w - a) <= self.size_tol and abs(h - b) <= self.size_tol for w, h in cand for a, b in self.sizes):
                return False
        # 位置按「最大的那块」判：一条串起来的簇（工艺边上一排标记 + 描边）外框能横跨整板，
        # 按外框判就永远落不进工艺边这条归属（C11 阻焊 16 mm² 的工艺边标记即如此）。
        # 拼图看图时也是对着 sample 看的，这里统一；覆盖量仍由 expect 卡住。
        where = box(*(c.sample or c.bbox))
        if self.regions:
            if not any(r.contains(where) for r in self.regions):
                return False
        if self.edge_margin_mm is not None and self._bounds:
            bx0, by0, bx1, by1 = self._bounds
            m = float(self.edge_margin_mm)
            core = box(bx0 + m, by0 + m, bx1 - m, by1 - m)  # 板内区域
            if core.intersects(where):  # 最大的那块伸进板内就不算工艺边的事
                return False
        return True

    def overrun(self) -> str | None:
        """归属盖住的东西比登记的多多少 —— 多出容差就是「这条归属已经不诚实了」。"""
        if not self.expect:
            return None
        tol = float(self.expect.get("tolerance", 0.25))
        n_exp, a_exp = self.expect.get("clusters"), self.expect.get("area_mm2")
        area = sum(c.area for c in self.matched)
        if n_exp is not None and len(self.matched) > math.ceil(float(n_exp) * (1 + tol)):
            return f"登记 {n_exp} 簇，实际盖住 {len(self.matched)} 簇"
        if a_exp is not None and area > float(a_exp) * (1 + tol):
            return f"登记 {a_exp} mm²，实际盖住 {area:.1f} mm²"
        return None


def attribute(
    clusters: list[Cluster], entries: list[dict[str, Any]], layer: str,
    layer_bounds: tuple[float, float, float, float] | None = None,
) -> tuple[list[Attribution], list[Cluster]]:
    """Assign each C-band cluster to the first attribution that covers it.

    Returns the attributions (each carrying what it matched) and the clusters nothing explained."""
    atts = [Attribution(e, layer_bounds) for e in entries]
    unexplained: list[Cluster] = []
    for c in clusters:
        for a in atts:
            if a.covers(c, layer):
                a.matched.append(c)
                break
        else:
            unexplained.append(c)
    unexplained.sort(key=lambda c: -c.area)
    return atts, unexplained
