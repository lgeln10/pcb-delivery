"""残差分档与归属 —— 门禁从「XOR 百分比 < 自己设的线」换成「C 档无主簇 = 0」后的契约。

三块真板实测的两条依据（2026-09-18）：A 档只占 XOR 面积的 0.1%–13%，所以百分比里并不是噪声占大头；
腐蚀宽度 0.005 → 0.2 mm 扫下来分类几乎不动，所以 0.01 / 0.1 这两个档位不是挑出来的。"""

from __future__ import annotations

from shapely.geometry import box

from engine.geom import xordiff


def test_a_hairline_offset_is_noise_but_a_whole_missing_block_is_shape():
    gold = box(0, 0, 10, 10)
    ours = box(0, 0, 10, 10.004)  # 一条 4 µm 的边沿 —— 圆弧离散/坐标取整那个量级
    rep = xordiff.compare(ours, gold)
    assert rep["extra"].noise > 0 and rep["extra"].shape == 0
    assert rep["clusters"] == []

    ours2 = box(0, 0, 10, 10).difference(box(2, 2, 4, 4))  # 少了一整块 2×2
    rep2 = xordiff.compare(ours2, gold)
    assert rep2["missing"].shape > 3.9
    assert len(rep2["clusters"]) == 1 and rep2["clusters"][0].direction == "missing"


def test_a_uniform_size_step_lands_in_the_middle_band():
    """开窗 2 mil vs 4 mil / 补偿 0.03 vs 0.05 —— 同一个形体差一档，不该和「整块没做」混为一谈。"""
    gold = box(0, 0, 10, 10)
    ours = box(-0.04, -0.04, 10.04, 10.04)  # 每边多 0.04 → 差异带宽 0.04
    rep = xordiff.compare(ours, gold)
    assert rep["extra"].size > rep["extra"].shape
    assert rep["extra"].shape == 0  # 0.04 < 0.1，不是形体差
    assert rep["clusters"] == []


def test_nearby_pieces_are_one_difference_not_many():
    gold = box(0, 0, 50, 50)
    ours = gold.difference(box(10, 10, 11, 11)).difference(box(11.3, 10, 12.3, 11))  # 间距 0.3 < 0.6
    rep = xordiff.compare(ours, gold)
    assert len(rep["clusters"]) == 1 and rep["clusters"][0].n == 2
    far = gold.difference(box(10, 10, 11, 11)).difference(box(30, 30, 31, 31))
    assert len(xordiff.compare(far, gold)["clusters"]) == 2


def test_unattributed_clusters_are_what_the_gate_counts():
    gold = box(0, 0, 100, 100)
    ours = gold.difference(box(1, 1, 3, 3)).difference(box(50, 50, 52, 52))  # 一个贴边、一个在板中间
    rep = xordiff.compare(ours, gold)
    rail = {"id": "rail_fill", "edge_margin_mm": 5, "direction": "missing",
            "reason": "工艺边铺铜", "status": "open"}
    atts, unexplained = xordiff.attribute(rep["clusters"], [rail], ".gtl", tuple(gold.bounds))
    assert len(atts[0].matched) == 1  # 贴边那个有主
    assert len(unexplained) == 1 and unexplained[0].center == (51.0, 51.0)


def test_an_attribution_cannot_quietly_swallow_more_than_it_registered():
    gold = box(0, 0, 100, 100)
    holes = [box(1, 1, 3, 3), box(1, 10, 3, 12), box(1, 20, 3, 22)]
    ours = gold
    for h in holes:
        ours = ours.difference(h)
    rep = xordiff.compare(ours, gold)
    entry = {"id": "rail_fill", "edge_margin_mm": 5, "reason": "工艺边铺铜", "status": "open",
             "expect": {"clusters": 1, "tolerance": 0.0}}
    atts, unexplained = xordiff.attribute(rep["clusters"], [entry], ".gtl", tuple(gold.bounds))
    assert not unexplained  # 三簇都落进范围
    assert atts[0].overrun()  # 但登记的只有 1 簇 —— 门禁照样拦
    entry["expect"] = {"clusters": 3}
    atts2, _ = xordiff.attribute(rep["clusters"], [entry], ".gtl", tuple(gold.bounds))
    assert atts2[0].overrun() is None


def test_layer_and_direction_narrow_an_attribution():
    gold = box(0, 0, 100, 100)
    ours = gold.difference(box(50, 50, 52, 52))
    c = xordiff.compare(ours, gold)["clusters"]
    wrong_layer = {"id": "x", "layers": [".gbl"], "reason": "r"}
    wrong_dir = {"id": "x", "direction": "extra", "reason": "r"}
    right = {"id": "x", "layers": [".gtl"], "direction": "missing", "reason": "r"}
    assert xordiff.attribute(c, [wrong_layer], ".gtl")[1]
    assert xordiff.attribute(c, [wrong_dir], ".gtl")[1]
    assert not xordiff.attribute(c, [right], ".gtl")[1]


def _drill_gate(entries, diff):
    from engine.verify import Result, compare_drill_attribution

    res = Result()
    ours = {k: v[0] for k, v in diff.items()}
    gold = {k: v[1] for k, v in diff.items()}
    compare_drill_attribution({"attributions": entries}, ours, gold, diff, res)
    return res.rows[0]


def test_drill_mismatch_needs_a_name_not_a_tolerance():
    """``max_size_mismatch: 5`` 曾经同时放过 9 个骑线过孔和 36 个根本没打的 V-cut 端孔。"""
    diff = {(0.6, "hole"): (0, 12), (0.9, "hole"): (0, 12)}
    assert not _drill_gate([], diff).ok
    named = [{"id": "vcut_end_holes", "status": "open", "reason": "V-cut 线端三孔未做",
              "sizes": [{"dia_mm": 0.6, "kind": "hole"}, {"dia_mm": 0.9, "kind": "hole"}]}]
    row = _drill_gate(named, diff)
    assert row.ok and "vcut_end_holes" in row.detail


def test_a_drill_attribution_pinned_to_counts_stops_matching_when_they_move():
    entry = [{"id": "via_plug_23", "status": "open", "reason": "23 个过孔塞法不同",
              "sizes": [{"dia_mm": 0.45, "kind": "hole", "ours": 3339, "golden": 3362}]}]
    assert _drill_gate(entry, {(0.45, "hole"): (3339, 3362)}).ok
    assert not _drill_gate(entry, {(0.45, "hole"): (3300, 3362)}).ok  # 数目一变就不再是那条已知问题


def test_a_family_of_differences_can_be_named_by_shape_not_place():
    """阻焊里同一种开窗差同一个量，散在整板上 —— 按坐标框不住，只能按外框尺寸认。"""
    gold = box(0, 0, 200, 200)
    ours = gold
    for x, y in ((10, 10), (60, 10), (110, 10)):          # 同一种：7.4×15.9 的窗
        ours = ours.difference(box(x, y, x + 7.4, y + 15.9))
    ours = ours.difference(box(10, 100, 12, 102))          # 另一种：2×2
    rep = xordiff.compare(ours, gold)
    fam = {"id": "terminal_pad", "sizes_mm": [[7.4, 15.9]], "size_tol_mm": 0.05, "reason": "端子焊盘大窗"}
    atts, unexplained = xordiff.attribute(rep["clusters"], [fam], ".gts")
    assert len(atts[0].matched) == 3
    assert len(unexplained) == 1 and unexplained[0].size == (2.0, 2.0)
