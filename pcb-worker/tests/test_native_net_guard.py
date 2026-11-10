"""网络守门在 native 模式下必须照样守门(2026-09-07 回归)。

gerbonara 的 Gerber 写出器不输出 %TO 物件属性,所以 B 线写的 ``steps/edit/<层>`` 不带网名。
net_compare 原本从 ``ctx.layer_path()``(native 下就是 edit 副本)读设计网名,于是每个被本地引擎
改过的 job 都退化成「无参照网表,只做减铜比较」——客户设计里的短路/开路**静默测不出来**。
设计网名现在取自客户原稿(edit 副本带网名时仍优先用它),生产网表仍按改后的铜提取。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from engine.model.report import StageReport
from engine.storage import Storage
from engine.verify import _apply_confirmations, _load, _run

CASE = Path(__file__).resolve().parents[1] / "cases" / "C06_net_guard"
STAGES = ["align", "drill", "inner", "outer", "mask", "silk", "net_compare"]


@pytest.fixture(scope="module")
def c06_native(tmp_path_factory):
    base = tmp_path_factory.mktemp("c06native")
    os.environ["PCB_CAM_ENGINE"] = "native"
    try:
        storage = Storage(storage_root=base / "storage", work_root=base / "work")
        job = "c06-native"
        key = f"pcb-cam/verify/{job}/input/board.zip"
        storage.put_file(key, CASE / "input" / "board.zip")
        reps: dict[str, StageReport] = {"intake": _run(storage, job, "intake", [key])}
        lm = _apply_confirmations(reps["intake"].layer_map, _load(CASE / "expected" / "layer_map.json"))
        for st in STAGES:
            reps[st] = _run(storage, job, st, [key], layer_map=lm)
        yield storage, job, reps
    finally:
        os.environ.pop("PCB_CAM_ENGINE", None)


def test_short_and_open_still_found_after_native_edits(c06_native):
    storage, job, reps = c06_native
    rep = reps["net_compare"]
    kinds = {i.kind for i in rep.items}
    assert "no_reference_netlist" not in kinds, "设计网名没读到 —— 参照网表又丢了"
    assert {"net_short", "net_open"} <= kinds, sorted(kinds)
    assert rep.status == "needs_review" and any(i.needs_decision for i in rep.items)
    # 本地引擎确实改过铜层(否则这个测试测不到 edit 副本这条路径)
    work = storage.work_dir(job)
    edited = list((work / "steps" / "edit").glob("*.gbr"))
    assert edited, "native 模式没写出 edit 副本"
    # 客户原稿有网名、edit 副本没有 —— 正是这条路径要覆盖的场景
    import re

    src_to = sum(len(re.findall(r"^%TO", p.read_text(errors="replace"), re.M)) for p in (work / "src").glob("*.gbr"))
    assert src_to > 0
    assert any(i.kind == "net_reference_from_orig" for i in rep.items)


def test_gatekeeper_refuses_to_pass_a_job_with_no_output_layers(tmp_path):
    """守门员不能空过:客户资料没解析出任何生产层时,下面每项检查都"通过"(没东西可比),
    任务却以「已完成」收尾而一个生产文件都没有。2026-09-07 用乱码/截断/空 Gerber 测出来的。"""
    import zipfile

    from engine.storage import Storage

    src = tmp_path / "junk"
    src.mkdir()
    (src / "junk.gbr").write_bytes(bytes(range(256)) * 20)  # 二进制垃圾冒充 Gerber
    (src / "empty.drl").write_text("M48\nMETRIC,TZ\n%\nM30\n")
    zp = tmp_path / "board.zip"
    with zipfile.ZipFile(zp, "w") as z:
        for f in sorted(src.iterdir()):
            z.write(f, f.name)

    st = Storage(storage_root=tmp_path / "s", work_root=tmp_path / "w")
    job = "junk"
    key = f"pcb-cam/verify/{job}/input/board.zip"
    st.put_file(key, zp)
    lm = None
    rep = None
    for s in ["intake", "align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output", "gatekeeper"]:
        rep = _run(st, job, s, [key], layer_map=lm)
        if s == "intake":
            lm = rep.layer_map
    assert rep is not None and rep.status == "blocked", rep.summary
    gate = next(i for i in rep.items if i.kind == "gate_no_output")
    assert gate.severity == "error" and gate.eq_question
