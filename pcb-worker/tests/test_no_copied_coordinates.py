"""厂规里不许出现「从终稿抄来的绝对坐标」（yibing 2026-09-20）。

判定口径：**位置**（板上的某个 x/y）只能由规则算出来，不能写在 profile 里；
**参数**（距离、直径、比例、相对某个几何体的偏移）可以写，那是厂规。

这条测试是防线：加新开关时如果又想「把终稿量的位置填进去」就会在这里红掉。
真的需要人指定位置（客户/工程师明确要求的那种），改这个测试并在 DECISIONS 里写明原因。
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
PROFILES = sorted((ROOT / "cases").glob("*/input/profile.yaml"))

#: 值是「板上的绝对位置」的字段 —— 只能写 auto / 空，不能写坐标
POSITION_KEYS = {
    "at": "测试点位置：写 auto，由 coupon_spots 按「工艺边空档」算",
    "gaps_mm": "铺铜留空段：终稿上量到的位置不算规则，要么找出依据要么问工程师",
    "spots_mm": "任何「点位清单」",
    "positions_mm": "任何「位置清单」",
}


def _walk(node, path=""):
    """每个字典键一条 (点分路径, 原值) —— 值是列表就整块给出来，不再往里拆
    （否则 ``at: [{x: 53.03}]`` 只会露出末段 ``x``，键名匹配不到 ``at``）。"""
    if isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}" if path else str(k)
            yield here, v
            yield from _walk(v, here)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")


@pytest.mark.parametrize("path", PROFILES, ids=lambda p: p.parent.parent.name)
def test_profile_has_no_copied_coordinates(path: Path):
    cfg = yaml.safe_load(path.read_text("utf-8")) or {}
    bad = []
    for dotted, value in _walk(cfg):
        key = dotted.split(".")[-1].split("[")[0]
        why = POSITION_KEYS.get(key)
        if why is None or value in (None, [], {}, "auto"):
            continue
        bad.append(f"{dotted} = {value!r} —— {why}")
    assert not bad, f"{path.parent.parent.name} 的厂规里有抄来的坐标：\n  " + "\n  ".join(bad)


def test_the_guard_would_catch_a_copied_coordinate():
    """防线本身有效：塞一个坐标进去要能被抓出来。"""
    cfg = {"copper": {"vcut_coupon": {"at": [{"x": 53.03, "y": 11.0}]}}}
    hits = [d for d, v in _walk(cfg) if d.split(".")[-1].split("[")[0] in POSITION_KEYS and v not in (None, [], {}, "auto")]
    assert hits == ["copper.vcut_coupon.at"]
    ok = {"copper": {"vcut_coupon": {"at": "auto"}, "rail_fill": {"gaps_mm": [], "inset_mm": 0.583}}}
    assert not [d for d, v in _walk(ok) if d.split(".")[-1].split("[")[0] in POSITION_KEYS and v not in (None, [], {}, "auto")]
