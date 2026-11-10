"""Panel plan: place N×M copies of the single board on each working-panel size (第10章 p152).

Inputs: the profile polygon (from align), the factory ``panel`` profile section (working-panel
sizes, rail = 到板边距离, gap = 板与板之间距离, allowed rotations) and the customer's own SET
text (order_spec.panelization) which is passed through for the engineer.

Output: ranked candidates (count desc, utilisation desc), the chosen one, an SVG preview and the
StepRepeat / PanelBuild COM draft (docs/genesis_op_mapping.md §25/§26). Nothing is built in
Genesis here — this is the plan the engineer reviews (plan: 方案 review).
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any

from shapely.affinity import rotate, translate
from shapely.geometry import Polygon
from shapely.geometry.base import BaseGeometry

from engine.geom.svg import _fmt, polygon_path

_NUM = r"(\d+(?:\.\d+)?)"


def parse_panelization(text: str | None) -> dict[str, Any] | None:
    """The customer's SET requirement as numbers (p148–151), when the sentence is simple enough:
    ``2×3 拼板``, ``2x3``, ``拼板 3*2``; optional ``间距 2mm`` / ``零间距``; ``工艺边 5mm`` (rails on
    top/bottom by default, ``两侧`` = left/right, ``四边`` = all); ``V-CUT`` / ``邮票孔``. Returns None
    when no N×M is found — then a person lays the SET out (StepRepeat → NeedsHuman)."""
    if not text:
        return None
    t = str(text).replace("Ｘ", "x").replace("×", "x").replace("＊", "*").lower()
    m = re.search(rf"{_NUM}\s*[x\*]\s*{_NUM}", t)
    if not m:
        return None
    nx, ny = int(float(m.group(1))), int(float(m.group(2)))
    if nx < 1 or ny < 1 or nx * ny > 400:
        return None
    out: dict[str, Any] = {"nx": nx, "ny": ny, "gap_mm": 0.0, "rail_mm": 0.0, "rails": "none", "vcut": "v-cut" in t or "vcut" in t or "v_cut" in t, "stamp": "邮票" in t, "text": str(text)[:200]}
    g = re.search(rf"间距\s*{_NUM}\s*(mm|毫米)?", t)
    if g:
        out["gap_mm"] = float(g.group(1))
    elif "零间距" in t or "无间距" in t:
        out["gap_mm"] = 0.0
    r = re.search(rf"工艺边\s*{_NUM}\s*(mm|毫米)?", t)
    if r:
        out["rail_mm"] = float(r.group(1))
        out["rails"] = "all" if "四边" in t else ("lr" if ("两侧" in t or "左右" in t) else "tb")
    return out


def set_size(parsed: dict[str, Any], unit_w: float, unit_h: float) -> tuple[float, float]:
    """Outer size of the customer SET block: units + gaps + rails on the sides the text names."""
    w = parsed["nx"] * unit_w + (parsed["nx"] - 1) * parsed["gap_mm"]
    h = parsed["ny"] * unit_h + (parsed["ny"] - 1) * parsed["gap_mm"]
    r = parsed.get("rail_mm", 0.0)
    if parsed.get("rails") in ("lr", "all"):
        w += 2 * r
    if parsed.get("rails") in ("tb", "all"):
        h += 2 * r
    return w, h


@dataclass
class Candidate:
    panel_w: float
    panel_h: float
    rotation: int  # 0 | 90 (degrees applied to the single board)
    unit_w: float
    unit_h: float
    nx: int
    ny: int
    rail: float
    gap: float
    count: int
    utilization: float  # board area × count / panel area
    used_w: float
    used_h: float

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d["utilization"] = round(self.utilization, 4)
        return d


def _fit(panel: float, rail: float, unit: float, gap: float) -> int:
    usable = panel - 2 * rail
    if usable < unit:
        return 0
    return int(math.floor((usable + gap) / (unit + gap) + 1e-9))


def plan_candidates(profile: BaseGeometry, cfg: dict[str, Any]) -> list[Candidate]:
    x0, y0, x1, y1 = profile.bounds
    bw, bh = x1 - x0, y1 - y0
    area = profile.area
    rail = float(cfg["rail_mm"])
    gap = float(cfg["gap_mm"])
    out: list[Candidate] = []
    for pw, ph in cfg["working_panels_mm"]:
        for rot in cfg.get("rotations", [0, 90]):
            uw, uh = (bw, bh) if rot % 180 == 0 else (bh, bw)
            nx, ny = _fit(pw, rail, uw, gap), _fit(ph, rail, uh, gap)
            n = nx * ny
            if n == 0:
                continue
            out.append(Candidate(
                panel_w=pw, panel_h=ph, rotation=rot, unit_w=round(uw, 3), unit_h=round(uh, 3), nx=nx, ny=ny,
                rail=rail, gap=gap, count=n, utilization=n * area / (pw * ph),
                used_w=round(2 * rail + nx * uw + (nx - 1) * gap, 3), used_h=round(2 * rail + ny * uh + (ny - 1) * gap, 3),
            ))  # fmt: skip
    out.sort(key=lambda c: (-c.count, -c.utilization, c.rotation))
    return out


def unit_placements(c: Candidate, profile: BaseGeometry) -> list[Polygon]:
    """Board outlines positioned on the panel (panel origin = bottom-left, rails on all sides)."""
    x0, y0, _, _ = profile.bounds
    base = translate(profile, -x0, -y0)
    if c.rotation % 180:
        base = rotate(base, c.rotation, origin=(0, 0))
        bx0, by0, _, _ = base.bounds
        base = translate(base, -bx0, -by0)
    # centre the block on the panel: leftover space split equally beyond the rails
    off_x = (c.panel_w - c.used_w) / 2 + c.rail
    off_y = (c.panel_h - c.used_h) / 2 + c.rail
    out: list[Polygon] = []
    for j in range(c.ny):
        for i in range(c.nx):
            out.append(translate(base, off_x + i * (c.unit_w + c.gap), off_y + j * (c.unit_h + c.gap)))
    return out


def panel_svg(c: Candidate, profile: BaseGeometry) -> str:
    units = unit_placements(c, profile)
    w, h = c.panel_w, c.panel_h
    m = 5.0
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_fmt(-m)} {_fmt(-h - m)} {_fmt(w + 2 * m)} {_fmt(h + 2 * m)}" '
        f'width="{_fmt(w + 2 * m)}mm" height="{_fmt(h + 2 * m)}mm" data-layer="_panel" data-type="panel">\n'
        '<g transform="scale(1,-1)" fill-rule="evenodd">\n'
        f'<rect x="0" y="0" width="{_fmt(w)}" height="{_fmt(h)}" fill="#f4efe3" stroke="#000" stroke-width="0.3"/>\n'
        f'<rect x="{_fmt(c.rail)}" y="{_fmt(c.rail)}" width="{_fmt(w - 2 * c.rail)}" height="{_fmt(h - 2 * c.rail)}" fill="none" stroke="#888" stroke-width="0.2" stroke-dasharray="2 1"/>\n'
    )
    body = []
    for k, u in enumerate(units):
        for poly in ([u] if isinstance(u, Polygon) else list(u.geoms)):
            body.append(f'<path data-id="_panel:{k}" d="{polygon_path(poly)}" fill="#c8322b" fill-opacity="0.25" stroke="#c8322b" stroke-width="0.2"/>')
    # 顶部图例 + 底部标注(中文:给工厂工程师看)
    legend = (
        f'<g transform="scale(1,-1)" font-size="2.6" fill="#333">'
        f'<rect x="{_fmt(c.rail)}" y="{_fmt(-c.rail + 1.2)}" width="3" height="2" fill="#c8322b" fill-opacity="0.25" stroke="#c8322b" stroke-width="0.2"/>'
        f'<text x="{_fmt(c.rail + 4)}" y="{_fmt(-c.rail + 2.9)}">单只板</text>'
        f'<rect x="{_fmt(c.rail + 20)}" y="{_fmt(-c.rail + 1.2)}" width="3" height="2" fill="none" stroke="#888" stroke-width="0.2" stroke-dasharray="2 1"/>'
        f'<text x="{_fmt(c.rail + 24)}" y="{_fmt(-c.rail + 2.9)}">工艺边 {_fmt(c.rail)} mm(放定位孔/mark 点)</text>'
        f'</g>'
    )
    label = (
        f'<text x="{_fmt(w / 2)}" y="{_fmt(-h - 1.5)}" transform="scale(1,-1)" font-size="3" text-anchor="middle" fill="#333">'
        f'工作板 {_fmt(w)}×{_fmt(h)} mm　排 {c.nx}×{c.ny}={c.count} 只　旋转 {c.rotation}°　板间距 {_fmt(c.gap)} mm　利用率 {c.utilization * 100:.1f}%</text>'
    )
    return head + "\n".join(body) + "\n" + legend + "\n" + label + "\n</g>\n</svg>\n"


def com_draft(job: str, c: Candidate, profile: BaseGeometry) -> str:
    x0, y0, _, _ = profile.bounds
    off_x = (c.panel_w - c.used_w) / 2 + c.rail
    off_y = (c.panel_h - c.used_h) / 2 + c.rail
    v = "【待验证：命令名/参数以工厂 Genesis 版本为准】"
    return "\n".join([
        f"# PanelBuild p152: 工作板 {c.panel_w}×{c.panel_h} mm, {c.nx}×{c.ny}={c.count} pcs, 旋转 {c.rotation}°, 板边 {c.rail}, 间距 {c.gap}",
        f"COM create_entity,job={job},name=panel,type=step                                # {v}",
        f"COM open_entity,job={job},type=step,name=panel                                  # {v}",
        f"COM profile_rect,x1=0,y1=0,x2={c.panel_w},y2={c.panel_h}                          # {v}",
        f"COM sr_tab_reset                                                                # {v}",
        f"COM sr_tab_add,line=1,step=edit,x={off_x - x0:.3f},y={off_y - y0:.3f},nx={c.nx},ny={c.ny},dx={c.unit_w + c.gap:.3f},dy={c.unit_h + c.gap:.3f},angle={c.rotation},mirror=no,flip=no  # {v}",
        "# 板边定位孔/挂孔/AOI 孔/铆钉孔：工厂脚本自动加 (p155)；Pattern Fill 阻流块 (p153) 参数取工厂标准",
    ])  # fmt: skip
