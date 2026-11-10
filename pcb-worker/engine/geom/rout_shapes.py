"""内锣带上的非圆锣形：梅花孔（压接孔花键）。

第一块真板（C09，六层 3oz）15 个 ⌀4.2 压接孔，工程师在内锣带上画的不是圆，是 **8 齿梅花**：
外圆 ⌀5.00、齿底 ⌀4.35，每 45° 一个齿，齿底是同心弧（约 15°），两侧是光滑过渡（各约 11.5°），
齿间留 ⌀5 的外圆弧约 7°。客户 Gerber 里这个位置只有孔和焊盘，形状不在图里——是厂里的压接孔做法。

``PLUM_PROFILE`` 是从 golden 的 15 个轮廓量出来的一个 45° 周期的**锣刀中线**半径（0.5° 一格，
在齿底 0 和外圆 1 之间归一化），按 outer/inner 直径缩放后复现工程师的形状；工程师给了作图规则再换。
2026-09-19，docs/ROADMAP §M6l。
"""

from __future__ import annotations

import math

PLUM_PERIOD_DEG = 45.0
PLUM_STEP_DEG = 0.5
PLUM_PROFILE = (1.000, 0.995, 0.990, 0.985, 0.980, 0.972, 0.960, 0.943, 0.926, 0.910, 0.889, 0.867, 0.841, 0.813, 0.782, 0.746, 0.712, 0.675, 0.633, 0.582, 0.531, 0.481, 0.425, 0.356, 0.286, 0.219, 0.167, 0.126, 0.085, 0.044, 0.006, 0.005, 0.004, 0.004, 0.005, 0.006, 0.007, 0.009, 0.008, 0.005, 0.003, 0.002, 0.001, 0.000, 0.000, 0.001, 0.002, 0.003, 0.005, 0.008, 0.008, 0.006, 0.004, 0.002, 0.001, 0.000, 0.000, 0.000, 0.001, 0.003, 0.006, 0.046, 0.087, 0.126, 0.168, 0.221, 0.289, 0.360, 0.426, 0.482, 0.533, 0.584, 0.636, 0.676, 0.712, 0.748, 0.784, 0.813, 0.842, 0.867, 0.890, 0.910, 0.927, 0.944, 0.960, 0.972, 0.979, 0.985, 0.991, 0.997)  # 0 = 齿底, 1 = 外圆; 0° 在齿间外圆弧的中央


def plum_hole_ring(cx: float, cy: float, outer_dia_mm: float, inner_dia_mm: float, teeth: int = 8, phase_deg: float = 0.0) -> list[tuple[float, float]]:
    """Cutter centre-line of a splined press-fit hole as a closed ring (last point == first).

    ``teeth`` other than 8 reuse the same profile compressed/stretched over ``360 / teeth`` — the
    golden only shows 8; anything else is a guess until the factory says how they draw it."""
    r_out, r_in = outer_dia_mm / 2, inner_dia_mm / 2
    period = 360.0 / teeth
    n = len(PLUM_PROFILE)
    pts: list[tuple[float, float]] = []
    steps = round(360.0 / (period / n))
    for i in range(steps):
        a = i * 360.0 / steps
        u = (a % period) / period * n
        j = int(u) % n
        t = u - int(u)
        f = PLUM_PROFILE[j] * (1 - t) + PLUM_PROFILE[(j + 1) % n] * t
        r = r_in + (r_out - r_in) * f
        ang = math.radians(a + phase_deg)
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    pts.append(pts[0])
    return pts


def rout_ring(cx: float, cy: float, dia_mm: float, shape: dict | None) -> list[tuple[float, float]]:
    """Ring for one order-specified rout circle: plain circle unless ``shape`` says plum."""
    if shape and str(shape.get("kind", "")).lower() == "plum":
        return plum_hole_ring(cx, cy, dia_mm, float(shape.get("inner_dia_mm", dia_mm * 0.87)), int(shape.get("teeth", 8)), float(shape.get("phase_deg", 0) or 0))
    from shapely.geometry import Point

    return list(Point(cx, cy).buffer(dia_mm / 2).exterior.coords)
