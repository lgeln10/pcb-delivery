"""内锣带上的梅花孔（压接孔花键）：画出来的要和工程师成品一样，不是「画个 ⌀5 圆」。"""

from __future__ import annotations

from pathlib import Path

import pytest
from shapely.geometry import LineString, Polygon

from engine.geom.rout_shapes import PLUM_PROFILE, plum_hole_ring, rout_ring

GOLDEN = Path(__file__).resolve().parents[1] / "cases" / "C09_real_6l_3oz" / "golden" / "y6f085471a0.gko1"


def test_profile_is_a_full_period_with_flat_bottom_and_outer_arc():
    assert len(PLUM_PROFILE) == 90  # 45° / 0.5°
    assert PLUM_PROFILE[0] > 0.99 and min(PLUM_PROFILE) < 0.01
    flat = [f for f in PLUM_PROFILE[30:60] if f < 0.02]  # 15°..30° 是齿底同心弧
    assert len(flat) >= 25


@pytest.mark.skipif(not GOLDEN.is_file(), reason="真板 golden 不在（本地私有数据）")
def test_plum_ring_matches_the_engineers_fifteen_holes():
    from engine.geom.from_gerbonara import camfile_to_geometry
    from engine.geom.layers import open_camfile

    g, _ = camfile_to_geometry(open_camfile(GOLDEN, "outline"))
    plums = [p for p in getattr(g, "geoms", [g]) if isinstance(p, Polygon) and 4.5 < (p.bounds[2] - p.bounds[0]) < 5.6 and 4.5 < (p.bounds[3] - p.bounds[1]) < 5.6]
    assert len(plums) == 15
    worst = 0.0
    for p in plums:
        x0, y0, x1, y1 = p.bounds
        ring = LineString(plum_hole_ring((x0 + x1) / 2, (y0 + y1) / 2, 5.0, 4.35)).buffer(0.075)  # 0.15 mm 锣带线
        xor = ring.symmetric_difference(p).area / p.area
        worst = max(worst, xor)
    # 圆 vs 梅花的 XOR 是 100%+；量出来的齿形要在线宽的量级之内
    assert worst < 0.12, worst
    circle = LineString(rout_ring(0, 0, 5.0, None)).buffer(0.075)
    x0, y0, x1, y1 = plums[0].bounds
    from shapely.affinity import translate

    assert translate(circle, (x0 + x1) / 2, (y0 + y1) / 2).symmetric_difference(plums[0]).area / plums[0].area > 0.5


def test_rout_ring_falls_back_to_a_circle_and_scales_the_plum():
    circle = rout_ring(1, 2, 5.0, None)
    assert abs(Polygon(circle).area - 3.14159 * 2.5**2) < 0.05
    big = plum_hole_ring(0, 0, 10.0, 8.7)
    rs = [(x**2 + y**2) ** 0.5 for x, y in big]
    assert abs(max(rs) - 5.0) < 1e-6 and abs(min(rs) - 4.35) < 1e-6
    assert plum_hole_ring(0, 0, 5, 4.35)[0] == plum_hole_ring(0, 0, 5, 4.35)[-1]
