"""M6o（2026-09-20）：按「人有我们没有 / 我们有人没有」逐点看分层图定出来的处理。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from shapely.geometry import box

from engine.cad.model import BOTTOM, MULTI, TOP, Pad
from engine.native.ops_construct import coupon_shapes, coupon_spots

ROOT = Path(__file__).resolve().parents[1]
PROTEL = ROOT / "cases/C12_real_4l_protel99/input/CPU191.pcb"


def test_bottom_only_pad_reads_its_size_from_the_bottom_stack_slot():
    """Protel 99 底面单层 pad：top 0×0、bottom ⌀1.27（C12 的 212 个测试点）。按 top 槽读就没了。"""
    p = Pad(0, 0, BOTTOM, "round", 0.0, 0.0, bot_shape="round", bot_w=1.27, bot_h=1.27)
    assert p.size_on(BOTTOM) == ("round", 1.27, 1.27)
    assert p.size_on(TOP) == ("round", 0.0, 0.0)  # 顶面没有它
    # 多层 pad 不受影响：bottom 槽为空时用 top
    m = Pad(0, 0, MULTI, "rect", 1.0, 2.0)
    assert m.size_on(BOTTOM) == ("rect", 1.0, 2.0)


def test_c12_zero_size_test_points_have_a_bottom_size():
    import pytest

    if not PROTEL.is_file():
        pytest.skip("real board not present")
    from engine.cad.protel99 import read_protel99

    b = read_protel99(PROTEL)
    zero = [p for p in b.pads if p.layer == BOTTOM and p.hole < 0.01 and p.w < 0.01]
    assert len(zero) == 212
    assert all(p.size_on(BOTTOM)[1] > 0.9 for p in zero)


def test_coupon_goes_on_rail_lines_only_and_points_into_the_rail():
    # 板 0..100 × 0..50，下工艺边 y 0..3（V-cut y=3），上工艺边 47..50；中间 y=25 是单元之间的线（两侧都不是工艺边）
    rails = [box(0, 0, 100, 3), box(0, 47, 100, 50)]
    lines = [[(0.0, 3.0), (100.0, 3.0)], [(0.0, 47.0), (100.0, 47.0)], [(0.0, 25.0), (100.0, 25.0)]]
    spots = coupon_spots(lines, rails, [{"y": 3.0, "x": 72.33}])
    assert [(round(x, 2), round(y, 2), k) for x, y, _, _, k in spots] == [(72.33, 3.0, "lambda"), (50.0, 47.0, "lambda")]
    (_, _, d, into, _), (_, _, _, into2, _) = spots
    assert into == (0.0, -1.0) and into2 == (0.0, 1.0)  # 朝工艺边那边
    # 线两侧都是工艺边（中间 V-cut 把一条 10 mm 的工艺边一分为二）→ 跨线式
    mid = coupon_spots([[(50.0, 0.0), (50.0, 50.0)]], [box(45, 0, 55, 50)], [{"x": 50.0, "y": 20.0}])
    assert [(x, y, k) for x, y, _, _, k in mid] == [(50.0, 20.0, "straight")]
    pads, poly = coupon_shapes(72.33, 3.0, d, into, 1.05, 1.779, 1.415, 0.23)
    assert [(round(x, 3), round(y, 3)) for x, y in pads] == [(71.441, 1.585), (73.219, 1.585)]  # 终稿 71.438 / 73.217, y 1.586
    assert poly[0] == pads[0] and poly[-1] == pads[1]
    assert all(abs(y - 3.0) < 1e-9 for _, y in poly[1:3])  # 顶点顶在 V-cut 线上


def test_vcut_end_holes_sit_before_each_unit_on_unit_to_unit_lines_only():
    from shapely.geometry import box as _box
    from shapely.ops import unary_union

    from engine.stages.drill import vcut_end_hole_spots

    # 板 0..100 × 0..50：下工艺边 y 0..3；两只单元 x 3..46 和 52..97（之间 6 mm 锣通道），y 3..47 分两行，行间 V-cut y=25
    rails = [_box(0, 0, 100, 3), _box(0, 47, 100, 50)]
    units = unary_union([_box(3, 3, 46, 47), _box(52, 3, 97, 47)])
    lines = [[(0.0, 3.0), (100.0, 3.0)], [(0.0, 25.0), (100.0, 25.0)]]
    holes = [{"dia_mm": 1.201, "from_edge_mm": 1.112}, {"dia_mm": 0.6, "from_edge_mm": 1.785}]
    got = vcut_end_hole_spots(lines, rails, units, holes)
    # 只有线下方那只单元（顶边在线上）；按单元外框左边量
    assert got == [(4.112, 25.0, 1.201), (4.785, 25.0, 0.6), (53.112, 25.0, 1.201), (53.785, 25.0, 0.6)]
    # 右上角有 11.7×2.65 的挖口：材料在线上到 34.3 就断了 → 从挖口角 (34.3, 25) 往回 0.43、进单元 0.541 再一组
    cut = unary_union([_box(3, 3, 46, 25).difference(_box(34.3, 22.35, 46, 25)), _box(3, 25, 46, 47)])
    got2 = vcut_end_hole_spots(lines, rails, cut, holes, exit_holes=[{"dia_mm": 1.201, "along_mm": -0.43, "into_mm": 0.541}])
    assert (33.87, 24.459, 1.201) in got2 and len(got2) == 3


# ---- 第 4 批（第 9 轮数点后）：工艺边铜带各层同一块、留空段坐标系、测试点过线、光学点开窗 ----------------
def _rail_job(tmp_path, monkeypatch, layers, entries, cfg_edit=None, shift=(0.0, -200.0)):
    """一块 100×50 的板放在 Profile 坐标 y 200..250：下工艺边 y 200..203（V-cut y=203），输出坐标要减 200。"""
    import copy
    import json
    from types import SimpleNamespace

    from shapely import to_wkb

    from engine.native import ops_construct
    from engine.profiles import load_profile

    cfg = copy.deepcopy(load_profile(None))
    cfg["copper"]["rail_fill"].update({"enabled": True, "inset_mm": 0.5, "inner_inset_mm": 0.5, "vcut_gap_mm": 0.5, "hole_clearance_mm": 0.5, "copper_clearance_mm": 0.25, "corner_radius_mm": 0})
    if cfg_edit:
        cfg_edit(cfg)
    rail = box(0, 200, 100, 203)
    (tmp_path / "rails.wkb").write_bytes(to_wkb(rail))
    (tmp_path / "profile.json").write_text(json.dumps({"rail_lines": [[[0.0, 203.0], [100.0, 203.0]]]}), "utf-8")
    monkeypatch.setattr(ops_construct, "_holes", lambda n: [])
    monkeypatch.setattr("engine.stages.drill.origin_shift", lambda ctx: shift)
    return SimpleNamespace(entry=lambda rel: next((e for e in entries if e["file"] == rel), None), entries=lambda: entries,
                           layer=lambda rel: layers[rel], cfg=cfg, profile=box(0, 200, 100, 250),
                           ctx=SimpleNamespace(work_dir=tmp_path, profile=cfg))  # fmt: skip


def _cu_layer(rel, ltype):
    from gerbonara.rs274x import GerberFile

    from engine.geom.features import FeatureLayer

    return FeatureLayer(GerberFile(), rel, ltype)


def _ring(layer, cx, cy, r, w, n=8):
    """一圈 n 条线画的环（客户光学点环是弧线画的，不是面）。"""
    import math

    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM

    from engine.geom.symbols import Symbol

    ap = Symbol("r", (w,)).to_aperture(unit=MM)
    pts = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n + 1)]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        layer.add(go.Line(x1, y1, x2, y2, ap, unit=MM, polarity_dark=True), "ring")


def _copper(layer):
    from shapely.ops import unary_union

    return unary_union([f.geom for f in layer.features if f.polarity_dark])


def test_rail_gaps_are_written_in_the_output_frame(tmp_path, monkeypatch):
    """C12：留空段 y 49.745..53.030 是输出坐标；工艺边在 Profile 坐标 y 202..395，第 8/9 轮的缺口根本没落下。"""
    from engine.model.plan import OpCall
    from engine.native.ops_construct import rail_fill

    top = _cu_layer("top.gtl", "top_copper")
    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top}, [{"file": "top.gtl", "type": "top_copper"}], lambda c: c["copper"]["rail_fill"].update({"gaps_mm": [{"x": [40.0, 50.0]}]}), shift=(-300.0, -200.0))
    rail_fill(n, OpCall(n=1, stage="outer", op="RailFill", layer="top.gtl", kind="factory_rail_fill", key="k"))
    cu = _copper(top)
    from shapely.geometry import Point

    assert not cu.intersects(Point(345, 201.5).buffer(0.2)), "输出坐标 x 40..50 = Profile 340..350，这里要空"
    assert cu.contains(Point(45, 201.5)), "不能把输出坐标当 Profile 坐标去挖"


def test_inner_rail_band_carries_the_outer_layers_cutouts(tmp_path, monkeypatch):
    """终稿三块板每层工艺边铜都是同一块（内层只少了外层独有的环/盘/测试点）：内层铜带要按外层的光学点环挖 ⌀（环外径 + 2×0.25），
    环里面不铺（原来在环和中心盘之间铺了一圈铜）；测试点的位置内层也挖（内层阶段先跑，测试点还没画，按算出来的形状挖）。"""
    from shapely.geometry import Point

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_construct import rail_fill

    top = _cu_layer("top.gtl", "top_copper")
    top.begin("seed")
    _ring(top, 20, 201.5, 1.45, 0.3)  # 环 ⌀2.6..3.2
    top.add_pad(20, 201.5, Symbol("r", (1.0,)))
    top.commit()
    l2 = _cu_layer("in2.g2", "inner_copper")
    entries = [{"file": "top.gtl", "type": "top_copper"}, {"file": "in2.g2", "type": "inner_copper"}]

    def edit(c):
        c["copper"]["vcut_coupon"].update({"enabled": True, "at": [{"y": 3.0, "x": 70.0}]})

    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top, "in2.g2": l2}, entries, edit)
    for rel, stage in (("in2.g2", "inner"), ("top.gtl", "outer")):
        rail_fill(n, OpCall(n=1, stage=stage, op="RailFill", layer=rel, kind="factory_rail_fill", key="k"))
    from shapely.ops import unary_union

    ring = unary_union([f.geom for f in top.features if f.attrs.get(".string") != "rail_fill"])  # 环 + 中心盘
    for layer in (top, l2):
        band = unary_union([f.geom for f in layer.features if f.attrs.get(".string") == "rail_fill"])
        assert band.distance(ring) >= 0.25 - 1e-3, f"{layer.rel}: 环外 0.25 内不能有铜带"
        assert not band.intersects(Point(20, 201.5).buffer(1.0)), f"{layer.rel}: 环里面不铺"
        assert band.intersects(Point(20, 201.5).buffer(2.0).exterior), f"{layer.rel}: 环外就是铜带"
        # 测试点：两盘 ⌀1.05 在 (70±0.89, 201.585)，铜带离它 0.38
        assert not band.intersects(Point(70.89, 201.585).buffer(0.525 + 0.38 - 0.01)), f"{layer.rel}: 测试点旁 0.38 内不能有铜带"
    # 内层不画测试点本身
    assert not _copper(l2).intersects(Point(70.89, 201.585).buffer(0.3))


def test_vcut_clearance_leaves_the_coupon_trace_across_the_line(tmp_path, monkeypatch):
    """C12 终稿跨线式测试点的 1.0 线从 94.6 到 98.6 连着穿过 V-cut y=96.6；我们退铜 0.4 把它在线两侧切断了（gtl #17/#18 ×4）。"""
    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_construct import vcut_clearance

    top = _cu_layer("top.gtl", "top_copper")
    top.begin("seed")
    ap = Symbol("r", (1.0,)).to_aperture(unit=MM)
    top.add(go.Line(30, 201.5, 30, 204.5, ap, unit=MM, polarity_dark=True, attrs={".string": "vcut_coupon"}), "coupon trace")
    top.add(go.Line(60, 201.5, 60, 204.5, ap, unit=MM, polarity_dark=True), "customer trace")
    top.commit()
    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top}, [{"file": "top.gtl", "type": "top_copper"}], lambda c: c["copper"].update({"vcut_clearance_mm": 0.4}))
    vcut_clearance(n, OpCall(n=1, stage="outer", op="VcutClearance", layer="top.gtl", kind="factory_vcut_clearance", key="k"))
    from shapely.geometry import Point

    cu = _copper(top)
    assert cu.contains(Point(30, 203.0)), "测试点的线要连着过线"
    assert not cu.intersects(Point(60, 203.0).buffer(0.3)), "别的铜照退"


def test_fiducial_window_shrinks_one_step_clear_of_its_ring(tmp_path, monkeypatch):
    """C12 工艺边 16 个光学点：客户 ⌀2.6 窗（厚弧画的环 + 中心）压在环铜上（环内缘 ⌀2.57），终稿一个 ⌀2.3968 flash =
    缩 4 mil/边一档、离环 ≥3 mil（p144 例外）。"""
    from shapely.geometry import Point

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_basic import mask_resize

    cu = _cu_layer("top.gtl", "top_copper")
    cu.begin("seed")
    _ring(cu, 20, 201.5, 1.45, 0.33, n=64)  # 补偿后的环 2.57..3.23
    cu.add_pad(20, 201.5, Symbol("r", (1.025,)))
    cu.add_pad(60, 201.5, Symbol("r", (1.025,)))  # 普通盘：照常 盘 + 2 mil
    cu.commit()
    ms = _cu_layer("top.gts", "top_mask")
    ms.begin("seed")
    ms.add_surface(Point(20, 201.5).buffer(1.3).difference(Point(20, 201.5).buffer(0.5)), polarity_dark=True, note="客户画的环形窗")
    ms.add_pad(20, 201.5, Symbol("r", (1.127,)))  # MaskConstructPads 补的中心窗
    ms.add_pad(60, 201.5, Symbol("r", (1.2,)))
    ms.commit()
    entries = [{"file": "top.gtl", "type": "top_copper"}, {"file": "top.gts", "type": "top_mask"}]

    def edit(c):
        c["mask"].update({"regenerate_openings": True, "fiducial_opening_shrink_mm": 0.1016, "coverage_on_pour": None})

    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": cu, "top.gts": ms}, entries, edit)
    mask_resize(n, OpCall(n=1, stage="mask", op="MaskResize", layer="top.gts", kind="opening_larger_than_pad", key="k", params={"coverage_mm": 0.0508}))
    at20 = [f for f in ms.features if f.geom.distance(Point(20, 201.5)) < 0.5]
    assert len(at20) == 1 and at20[0].kind == "pad" and at20[0].symbol.params[0] == pytest.approx(2.3968, abs=1e-4)
    at60 = [f for f in ms.features if f.geom.distance(Point(60, 201.5)) < 0.5]
    assert len(at60) == 1 and at60[0].symbol.params[0] == pytest.approx(1.025 + 2 * 0.0508, abs=1e-4)


def test_via_window_centred_on_its_via_is_not_merged_into_the_neighbours_big_window(tmp_path, monkeypatch):
    """C09 排针旁：⌀1.2 塞孔过孔的 ⌀2 窗一半压在端子大窗上。按重叠面积归给大盘 → 并进大窗的面 → MaskDams 删不掉；
    终稿这些窗全删了。圆心在过孔盘上的窗归过孔盘，重做成 盘 + 2 mil 的独立 flash，后面照删。"""
    from shapely.geometry import Point, box as _box

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_basic import mask_resize

    cu = _cu_layer("top.gtl", "top_copper")
    cu.begin("seed")
    cu.add_pad(20, 210, Symbol("rect", (4.0, 10.0)))  # 端子大盘 18..22 × 205..215
    cu.add_pad(23.2, 210, Symbol("r", (1.2,)))  # 过孔盘，窗 ⌀2 → 22.2..24.2，压在大窗上
    cu.commit()
    ms = _cu_layer("top.gts", "top_mask")
    ms.begin("seed")
    ms.add_pad(20, 210, Symbol("rect", (4.2, 10.2)))
    ms.add_pad(23.2, 210, Symbol("r", (2.0,)))
    ms.commit()
    entries = [{"file": "top.gtl", "type": "top_copper"}, {"file": "top.gts", "type": "top_mask"}]
    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": cu, "top.gts": ms}, entries, lambda c: c["mask"].update({"regenerate_openings": True, "coverage_on_pour": None}))
    mask_resize(n, OpCall(n=1, stage="mask", op="MaskResize", layer="top.gts", kind="opening_larger_than_pad", key="k", params={"coverage_mm": 0.0508}))
    via_win = [f for f in ms.features if f.kind == "pad" and f.xy is not None and Point(*f.xy).distance(Point(23.2, 210)) < 0.01]
    assert len(via_win) == 1 and via_win[0].symbol.params[0] == pytest.approx(1.2 + 2 * 0.0508, abs=1e-4)
    big = [f for f in ms.features if f.geom.contains(Point(20, 210))]
    assert len(big) == 1 and big[0].kind == "pad" and not big[0].geom.contains(Point(23.9, 210))


def test_cut_round_splits_the_band_clean_at_a_wide_cutout_and_rounds_its_ends(tmp_path, monkeypatch):
    """C12 第 10 轮：光学点环 + 0.25 的挖空 ⌀3.75 只比铜带 3.834 窄 0.08，两边各剩 0.04 的细条 → 内层 net_compare
    33 处「缩铜后断」。终稿：细条没了、端头 R0.25 圆角（圆心离带边 0.24）；定位孔旁 0.537 的桥原样留着；
    留空段端头和四角直角 —— 就是挖空周围做一次 R0.25 的开运算。"""
    from shapely.geometry import Point

    from engine.model.plan import OpCall
    from engine.native.ops_construct import rail_fill

    top = _cu_layer("top.gtl", "top_copper")
    top.begin("seed")
    _ring(top, 20, 201.5, 0.55, 0.3, n=64)  # 环外径 1.4；+0.25 → 挖 ⌀1.9，铜带宽 2.0 → 两边各剩 0.05 的细条
    _ring(top, 40, 201.5, 0.35, 0.3, n=64)  # 环外径 1.0；挖 ⌀1.5 → 两边各剩 0.25 的桥（≥ 2R 留下）
    top.commit()

    def edit(c):
        c["copper"]["rail_fill"].update({"cut_round_mm": 0.1, "gaps_mm": [{"x": [60.0, 62.0]}]})

    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top}, [{"file": "top.gtl", "type": "top_copper"}], edit, shift=(0.0, 0.0))
    rail_fill(n, OpCall(n=1, stage="outer", op="RailFill", layer="top.gtl", kind="factory_rail_fill", key="k"))
    band = [f.geom for f in top.features if f.attrs.get(".string") == "rail_fill"]
    assert len(band) == 3, "环处断成两段 + 留空段再断一次；桥留着"
    left = next(b for b in band if b.bounds[2] < 20)
    mid = next(b for b in band if 20 < b.bounds[0] < 60)
    assert not left.intersects(Point(20, 201.5).buffer(0.94)) and not mid.intersects(Point(20, 201.5).buffer(0.94)), "没有细条（离环 0.25 之内没铜）"
    # 端头 = 挖空后再做 R0.1 开运算的形状（圆角，不是凸出的半圆）
    cut = box(0.5, 200.5, 99.5, 202.5).difference(Point(20, 201.5).buffer(0.95))
    want = cut.buffer(-0.1).buffer(0.1).intersection(box(0, 200, 20, 203))
    assert left.symmetric_difference(want).area < 0.02
    # 桥原样：hole ⌀1.5，桥 0.25
    hole = [Point(40, 201.5).buffer(0.75)]
    assert mid.contains(Point(40, 202.4)) and mid.contains(Point(40, 200.6)) and not mid.intersects(hole[0].buffer(-0.01))
    # 留空段端头和外角仍直角
    assert mid.contains(Point(mid.bounds[2] - 0.02, 202.5 - 0.02)) and left.contains(Point(0.5 + 0.02, 200.5 + 0.02))


def test_coupon_position_comes_from_the_rail_layout_not_from_the_finished_job():
    """测试点沿线的位置按规则定：该线旁工艺边上「放得下、离孔/铜够远」的空档里，取中点离线中点最近的那个。
    3×3 真板终稿把它画在 x=72.33，规则算出来 72.325（差 5 µm）。"""
    from shapely.geometry import Point

    from engine.native.ops_construct import clear_stretches, coupon_spots

    # 3×3 真板下工艺边：y 0..3，V-cut 线 y=3；边上四个 ⌀1.55 定位孔（8.0 / 44.0 / 100.0 / 138.65）
    rails = [box(0, 0, 146.65, 3.0)]
    lines = [[(0.0, 3.0), (146.65, 3.0)]]
    obst = [Point(x, 1.5).buffer(0.775) for x in (8.0, 44.0, 100.0, 138.65)]
    spots = coupon_spots(lines, rails, "auto", obst, need=1.779 + 1.05 + 1.0, keep=0.5)
    assert len(spots) == 1
    assert spots[0][0] == pytest.approx((44.775 + 0.5 + 99.225 - 0.5) / 2, abs=0.01)  # 两孔之间那段的中点
    # 空档本身：孔各自 ±(半径 + keep)
    st = clear_stretches(rails[0], obst, 0, 0.5)
    assert st[0] == pytest.approx((0.0, 6.725), abs=1e-6) and (45.275, 98.725) in [(round(a, 3), round(b, 3)) for a, b in st]
    # 放不下就不放（need 比任何空档都长）
    assert coupon_spots(lines, rails, "auto", obst, need=200.0, keep=0.5)[0][0] == pytest.approx(146.65 / 2)


def test_compensation_skips_only_a_real_short_not_merely_close_copper():
    """3×3 真板：27 段客户走线旁边 0.029–0.033 处有铜面，我们的护栏（comp/2 + 0.02）把它们判成
    「会短路」不补偿，终稿这 27 段全补了（0.254 → 0.284）。整层补偿本来就吃掉 comp 的间距，工厂照做
    （Genesis sel_all_feat + sel_resize），间距不够是后面 DRC 的事；只有补完真的压到**别的网**才跳过。

    网名不知道时不许跳（六层板 gbl 25 段 0.5 线因此漏补，终稿 1197 段全是 0.6，其中两段本来就是
    同一条走线首尾差 0.024）——照补，记 ``grown_unknown_net`` 留给 SignalLayerChecks。"""
    from types import SimpleNamespace

    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_basic import line_compensation
    from engine.profiles import load_profile

    def run(add_mm, gap, nets=None):
        layer = _cu_layer("top.gtl", "top_copper")
        layer.begin("seed")
        layer.add(go.Line(0, 0, 10, 0, Symbol("r", (0.254,)).to_aperture(unit=MM), unit=MM, polarity_dark=True), "线")
        layer.add_surface(box(0, 0.127 + gap, 10, 1.5), polarity_dark=True, note="旁边的铜面")
        layer.commit()
        if nets:
            for f, net in zip(layer.features, nets):
                f.obj.attrs = {".N": net}
        cfg = load_profile(None)
        cfg["copper"].update({"compensation_scope": "all", "compensation_by_oz": [{"oz": 1, "add_mm": add_mm}]})
        n = SimpleNamespace(entry=lambda rel: {"file": rel, "type": "top_copper"}, entries=lambda: [{"file": "top.gtl", "type": "top_copper"}],
                            layer=lambda rel: layer, cfg=cfg, profile=box(-1, -1, 11, 3),
                            ctx=SimpleNamespace(request=SimpleNamespace(order_spec={"copper_outer_um": 35})))  # fmt: skip
        cs = line_compensation(n, OpCall(n=1, stage="outer", op="LineCompensation", layer="top.gtl", kind="line_compensation", key="k"))
        return round(next(f.width_mm for f in layer.lines()), 4), cs.params

    # 1oz +0.03：每边长 0.015，离 0.033 的铜面碰不上 → 补（这就是 3×3 板那 27 段）
    w, params = run(0.03, 0.033)
    assert w == pytest.approx(0.284, abs=1e-4) and params["compensation_mm"] == pytest.approx(0.03)
    # 3oz +0.1：每边长 0.05，离 0.033 真碰上了 —— 但两边网名都不知道 → 照补，记一笔
    w, params = run(0.1, 0.033)
    assert w == pytest.approx(0.354, abs=1e-4)
    assert params.get("grown_unknown_net") and not params.get("skipped_would_short")
    # 同样的距离，明确是两个网 → 这才是真短路，跳过
    w, params = run(0.1, 0.033, nets=["NET_A", "NET_B"])
    assert w == pytest.approx(0.254, abs=1e-4) and params.get("skipped_would_short")
    # 同一个网靠得再近也补
    w, _ = run(0.1, 0.033, nets=["NET_A", "NET_A"])
    assert w == pytest.approx(0.354, abs=1e-4)


def test_compensation_uses_the_factory_default_when_the_order_does_not_give_the_copper_weight():
    """2×2 真板客户的《加工工艺要求说明书》「6.铜箔厚度」栏是空的 → order_spec 里是 null。
    原来会悄悄退回教材的 +1 mil（0.254 → 0.2794），终稿是 +0.03（0.284）。厂 profile 写明
    默认铜厚就按那一档，并在报告里注明「按厂默认」。"""
    from engine.checks.copper import compensation_for

    cfg = {"compensation_scope": "all", "compensation_by_oz": [{"oz": 1, "add_mm": 0.03}, {"oz": 3, "add_mm": 0.1}]}
    thr = {"line_compensation_mm": 0.0254, "compensation_threshold_mm": 0.381}
    assert compensation_for(cfg, thr, {"copper_outer_um": 105}, "outer")[0] == pytest.approx(0.1)   # 订单写了 3oz
    assert compensation_for(cfg, thr, {"copper_outer_um": None}, "outer")[0] == pytest.approx(0.0254)  # 没写、厂也没默认 → 不猜
    with_default = {**cfg, "compensation_default_oz": 1}
    assert compensation_for(with_default, thr, {"copper_outer_um": None}, "outer")[0] == pytest.approx(0.03)
    assert compensation_for(with_default, thr, {"copper_outer_um": 105}, "outer")[0] == pytest.approx(0.1)  # 订单写了就以订单为准


def test_short_outline_stroke_in_the_rail_breaks_the_band_across_its_whole_width(tmp_path, monkeypatch):
    """3×3 板下工艺边：客户在工艺边里画的短外形线（U 口的两个端头、锣通道那条线）不是在铜带边上咬一口，
    是把铜带**整条**断开 —— 终稿上这几笔横跨 x 42.494…52.556，铜带止于 42.038、53.017 起（0.447 / 0.461），
    整个带高都没铜。原来按局部 buffer 算，那几笔在 y≈3.0、铜带只到 2.398，根本够不着，等于没这条规则。"""
    import json

    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM
    from shapely.geometry import Point

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_construct import rail_fill

    top = _cu_layer("top.gtl", "top_copper")
    gko = _cu_layer("board.gko", "outline")
    ap = Symbol("r", (0.0127,)).to_aperture(unit=MM)
    gko.begin("seed")
    gko.add(go.Line(40.0, 202.99, 40.0, 203.1, ap, unit=MM, polarity_dark=True), "端头")   # 连接筋的端头
    gko.add(go.Line(42.0, 203.0, 48.0, 203.0, ap, unit=MM, polarity_dark=True), "锣线")     # 6 mm，短线
    gko.add(go.Line(0.0, 203.0, 35.0, 203.0, ap, unit=MM, polarity_dark=True), "长边")      # 35 mm，长线不算
    gko.commit()
    # Altium 还会导出 GM1 之类的机械层，扩展名也被认成 outline，上面是尺寸线和注记 —— 不许让它断铜带
    gm1 = _cu_layer("board.gm1", "outline")
    gm1.begin("seed")
    gm1.add(go.Line(22.0, 201.0, 23.0, 201.0, ap, unit=MM, polarity_dark=True), "注记")
    gm1.commit()
    entries = [{"file": "top.gtl", "type": "top_copper"}, {"file": "board.gko", "type": "outline"}, {"file": "board.gm1", "type": "outline"}]
    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top, "board.gko": gko, "board.gm1": gm1}, entries,
                  lambda c: c["copper"]["rail_fill"].update({"outline_clearance_mm": 0.45, "outline_segment_max_mm": 10}))
    (tmp_path / "profile.json").write_text(json.dumps({"file": "board.gko", "rail_lines": [[[0.0, 203.0], [100.0, 203.0]]]}), "utf-8")
    rail_fill(n, OpCall(n=1, stage="outer", op="RailFill", layer="top.gtl", kind="factory_rail_fill", key="k"))
    cu = _copper(top)

    for x in (40.0, 45.0, 48.3):
        assert not cu.intersects(Point(x, 200.7).buffer(0.05)), f"x={x} 处铜带要整条断开，带底也不能有铜"
        assert not cu.intersects(Point(x, 202.3).buffer(0.05)), f"x={x} 处铜带要整条断开，带顶也不能有铜"
    assert cu.contains(Point(38.0, 201.5)), "离短线 0.45 以外照铺"
    assert cu.contains(Point(22.5, 201.5)), "机械层上的注记不是锣路，不许断铜带"
    assert cu.contains(Point(20.0, 201.5)), "长边只管 inset/vcut_gap，不许当短线整条断开"
    x0, _, x1, _ = cu.bounds
    left = [p for p in cu.geoms if p.bounds[2] < 41]
    assert abs(max(p.bounds[2] for p in left) - (40.0 - 0.45 - 0.0127 / 2)) < 0.01  # 41 左边那段止于短线 −0.45


def test_a_rout_channel_only_breaks_the_rail_it_is_actually_drawn_through(tmp_path, monkeypatch):
    """3×3 板列与列之间的锣通道：客户把通道的边**画进**下工艺边（竖线 x 49.55 从 y −0.004 画到 5.996），
    终稿铜带在下边断开；上工艺边一条竖线都没有，终稿铜带 34.476…50.913 整条跨过通道。
    原来两条边一律断，上边白挖了一个 2.9 mm 的口。"""
    import json

    from gerbonara import graphic_objects as go
    from gerbonara.utils import MM
    from shapely import to_wkb
    from shapely.geometry import Point
    from shapely.ops import unary_union

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native.ops_construct import rail_fill

    top = _cu_layer("top.gtl", "top_copper")
    gko = _cu_layer("board.gko", "outline")
    ap = Symbol("r", (0.15,)).to_aperture(unit=MM)
    gko.begin("seed")
    gko.add(go.Line(49.0, 199.9, 49.0, 206.0, ap, unit=MM, polarity_dark=True), "通道边穿过下工艺边")
    gko.add(go.Line(51.0, 199.9, 51.0, 206.0, ap, unit=MM, polarity_dark=True), "通道另一边")
    gko.add(go.Line(0.0, 247.0, 100.0, 247.0, ap, unit=MM, polarity_dark=True), "单元上边：压在上工艺边内沿上")
    gko.commit()
    entries = [{"file": "top.gtl", "type": "top_copper"}, {"file": "board.gko", "type": "outline"}]
    n = _rail_job(tmp_path, monkeypatch, {"top.gtl": top, "board.gko": gko}, entries,
                  lambda c: c["copper"]["rail_fill"].update({"channel_gap_max_mm": 7, "outline_clearance_mm": 0.45,
                                                            "outline_segment_max_mm": 4}))
    # 上下两条工艺边 + 两只单元，中间一条 2 mm 的锣通道
    rails = [box(0, 200, 100, 203), box(0, 247, 100, 250)]
    (tmp_path / "rails.wkb").write_bytes(to_wkb(unary_union(rails)))
    (tmp_path / "profile.json").write_text(json.dumps({"rail_lines": [[[0.0, 203.0], [100.0, 203.0]], [[0.0, 247.0], [100.0, 247.0]]]}), "utf-8")
    n.profile = unary_union(rails + [box(0, 203, 49, 247), box(51, 203, 100, 247)])
    rail_fill(n, OpCall(n=1, stage="outer", op="RailFill", layer="top.gtl", kind="factory_rail_fill", key="k"))
    cu = _copper(top)

    assert not cu.intersects(Point(50, 201.5).buffer(0.05)), "下工艺边：通道画穿过去了，铜带要断"
    assert cu.contains(Point(50, 248.5)), "上工艺边：通道没画进来，铜带要连着跨过去（单元边那条长线压在内沿上不算）"
    assert cu.contains(Point(40, 201.5)) and cu.contains(Point(40, 248.5))


def test_npth_clearance_ring_starts_from_the_drilled_size(monkeypatch):
    """3×3 板：画在外形层的 ⌀2.5 孔钻 2.55，终稿清孔圈 ⌀2.97 = 2.55 + 2×0.21。原来按孔的成品尺寸 2.5 起算，每边少 0.025。"""
    import copy

    from shapely.geometry import Point

    from engine.model.plan import OpCall
    from engine.native import ops_copper
    from engine.native.ops_copper import npth_clearance
    from engine.profiles import load_profile
    from engine.stages.drill import Hole
    from tests.test_native_b3 import _ctx, _layer

    cu = _layer("in2.gbr", "inner_copper")
    cu.begin("seed")
    cu.add_surface(box(0, 0, 30, 30), polarity_dark=True, note="铺铜")
    cu.commit()
    monkeypatch.setattr(ops_copper, "_holes", lambda n: [Hole(15, 15, 2.5, False, "d", tool="T1", attribute="non_plated", drill_dia=2.55)])
    n = _ctx({"in2.gbr": cu}, [{"file": "in2.gbr", "type": "inner_copper"}])
    n.cfg = copy.deepcopy(load_profile(None))
    n.cfg["copper"]["inner"]["npth_clearance_mm"] = 0.21
    npth_clearance(n, OpCall(n=1, stage="inner", op="NpthClearance", layer="in2.gbr", kind="npth_clearance", key="k"))
    ring = next(f for f in cu.pads() if not f.polarity_dark)
    assert ring.symbol.params[0] == pytest.approx(2.55 + 2 * 0.21, abs=1e-6)  # 2.97，不是 2.5 + 0.42 = 2.92
    assert ring.geom.contains(Point(15 + 2.97 / 2 - 0.005, 15)) and not ring.geom.contains(Point(15 + 2.97 / 2 + 0.005, 15))


def test_mask_strokes_use_one_width_for_the_panel_edge_and_another_for_rout_paths(tmp_path):
    """终稿 2×2 / 3×3 板两面阻焊：拼板外缘描 0.15，V-cut 线 / 单元边界 / 锣槽 / 缺口轮廓描 0.2（六层板全 0.2）。
    第 16 轮把 V-cut 线也画成 0.15，两块板阻焊 B 档各涨 35 mm² —— 终稿 2×2 板每只单元描一圈 0.2。"""
    import json

    from shapely import to_wkb

    from engine.stages.output import _profile_strokes

    (tmp_path / "profile.wkb").write_bytes(to_wkb(box(0, 0, 100, 50).difference(box(70, 20, 80, 30))))  # 带一个板内挖空
    (tmp_path / "profile.json").write_text(json.dumps({"rail_lines": [[[0.0, 3.0], [100.0, 3.0]]], "drawn_slots": [[[[40.0, 20.0], [60.0, 20.0]], 2.0]], "edge_notches": [[50.0, 0.0, 3.0]]}), "utf-8")
    ctx = SimpleNamespace(work_dir=tmp_path, profile={"output": {"outline_source": "profile"}})
    got = [(round(w, 3), len(pts)) for pts, w in _profile_strokes(ctx, 0.15, 0.2)]
    assert got[0] == (0.15, 5), got                                    # Profile 外圈 0.15（矩形闭合 5 点）
    assert all(w == 0.2 for w, _ in got[1:]), got                      # 板内挖空、V-cut 线、槽轮廓、缺口圆全 0.2
    assert len(got) >= 5
    # 有工艺边时：每只单元描一圈 0.2（终稿三块板都这样），V-cut 线不再单独画
    (tmp_path / "rails.wkb").write_bytes(to_wkb(box(0, 0, 100, 3)))
    from shapely.geometry import Polygon

    strokes = _profile_strokes(ctx, 0.15, 0.2, units=True)
    unit = [pts for pts, w in strokes if w == 0.2 and len(pts) > 3 and Polygon(pts).is_valid and abs(Polygon(pts).area - 100 * 47) < 1]  # 单元外圈 100×47（内圈另算）
    assert len(unit) == 1, [(w, round(Polygon(pts).area, 1)) for pts, w in strokes if len(pts) > 3]
    assert any(len(pts) == 2 and w == 0.2 for pts, w in strokes), "V-cut 线（rail_lines）照画，行间的线不是单元的边"
    assert not any(Polygon(pts).is_valid and abs(Polygon(pts).area - 100 * 47) < 1 for pts, w in _profile_strokes(ctx, 0.15, 0.2) if len(pts) > 3), "外形层不画单元圈"
    assert all(w == 0.15 for _, w in _profile_strokes(ctx, 0.15))        # 不给锣槽宽度就同外缘


def test_gatekeeper_counts_the_same_mask_strokes_the_output_stage_draws(tmp_path):
    """回读校验算阻焊「源面积」用的描边，必须和输出阶段画上去的是同一份(mask_profile_strokes)。
    2026-09-22 两边各算各的：回读只用了外缘那个宽度(0.15)，锣路/单元圈实际画的是 0.2 ——
    3×3 板 gts/gbs 回读面积比源大 1.99%/1.40%、2×2 板 2.07%/4.47%，双双卡死在 gate_area_mismatch(阈值 1%)。"""
    import json

    from shapely import to_wkb

    from engine.geom.from_gerbonara import camfile_to_geometry
    from engine.output.gerber_writer import gerber_from_geometry
    from engine.stages.gatekeeper import TOL_RATIO
    from engine.stages.output import _profile_strokes, mask_profile_strokes

    (tmp_path / "profile.wkb").write_bytes(to_wkb(box(0, 0, 100, 50)))
    (tmp_path / "rails.wkb").write_bytes(to_wkb(box(0, 0, 100, 3)))
    (tmp_path / "profile.json").write_text(json.dumps({"rail_lines": [[[0.0, 3.0], [100.0, 3.0]]], "drawn_slots": [[[[40.0, 20.0], [60.0, 20.0]], 2.0]]}), "utf-8")
    ctx = SimpleNamespace(work_dir=tmp_path, profile={"output": {"outline_source": "profile", "outline_on_mask_mm": 0.15, "rout_on_mask_mm": 0.2}})

    spec = mask_profile_strokes(ctx)
    assert spec == _profile_strokes(ctx, 0.15, 0.2, units=True)
    assert {round(w, 3) for _, w in spec} == {0.15, 0.2}, spec       # 外缘一个宽度、锣路/单元圈另一个

    area = lambda st: camfile_to_geometry(gerber_from_geometry(st))[0].area  # noqa: E731
    old = _profile_strokes(ctx, 0.15, units=True)                    # 改之前回读那边的算法:全按外缘宽度
    assert (area(spec) - area(old)) / area(spec) > TOL_RATIO, "少算的那块要大到能触发 gate_area_mismatch，否则这个用例挡不住回归"

    # 不在阻焊上画外形的板(六层板 outline_on_mask_mm 不设)：两边都是空
    assert mask_profile_strokes(SimpleNamespace(work_dir=tmp_path, profile={"output": {}})) == []


def test_slo_gives_a_free_standing_via_the_optimal_ring_and_a_connected_one_the_minimum(monkeypatch):
    """六层板终稿外层：钻 0.45 的过孔，孤立的（不连线、不在铺铜里）盘 ⌀1.062 = 12 mil 环，连着线或在铺铜里的 ⌀0.96 = 10 mil。
    gbl 167/169、gtl 213 个孤立的全是 12 mil；0.96 的 3193 个全连着铜。"""
    import copy

    from engine.geom.symbols import Symbol
    from engine.model.plan import OpCall
    from engine.native import ops_optimize
    from engine.native.ops_optimize import signal_layer_optimize
    from engine.profiles import load_profile
    from engine.stages.drill import Hole
    from tests.test_native_b3 import _ctx, _layer, _line, _pad

    layer = _layer("top.gtl", "top_copper")
    layer.begin("seed")
    _pad(layer, 5, 5, Symbol("r", (0.9,)))        # 孤立 → 12 mil：0.45 + 2×0.3048 = 1.0596
    _pad(layer, 15, 5, Symbol("r", (0.9,)))       # 连着一条线 → 10 mil：0.45 + 2×0.254 = 0.958
    _line(layer, 15, 5, 15, 9, 0.3)
    _pad(layer, 25, 5, Symbol("r", (0.9,)))       # 在铺铜里 → 10 mil
    layer.add_surface(box(23, 3, 27, 7), polarity_dark=True, note="铺铜")
    layer.commit()
    holes = [Hole(x, 5, 0.45, True, "d", tool="T1", attribute="via", drill_dia=0.45) for x in (5, 15, 25)]
    monkeypatch.setattr(ops_optimize, "_holes", lambda n: holes)
    n = _ctx({"top.gtl": layer}, [{"file": "top.gtl", "type": "top_copper"}])
    n.cfg = copy.deepcopy(load_profile(None))
    n.cfg["copper"]["outer"].update({"via_annular_ring_mm": 0.254, "via_isolated_annular_ring_mm": 0.3048, "pad_up_base": "drill", "pad_enlarge_limit_mm": 0.8})
    cs = signal_layer_optimize(n, OpCall(n=1, stage="outer", op="SignalLayerOptimize", layer="top.gtl", kind="mandatory_slo", key="k"))
    sizes = {round(f.xy[0]): round(f.symbol.params[0], 3) for f in layer.pads()}
    assert sizes[5] == pytest.approx(1.06, abs=0.008)
    assert sizes[15] == pytest.approx(0.958, abs=0.008) and sizes[25] == pytest.approx(0.958, abs=0.008)
    assert cs.params["via_isolated_ar_mm"] == pytest.approx(0.3048)
