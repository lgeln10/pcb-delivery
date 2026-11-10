"""B2.8: the working panel as real layers under ``steps/panel/`` + production exports from it."""

from __future__ import annotations

import json
import os

import pytest
from gerbonara import graphic_objects as go
from gerbonara.utils import MM
from shapely.geometry import Point

from engine.geom.features import FeatureLayer
from engine.geom.symbols import Symbol
from engine.native.ops_panel import _place
from engine.storage import Storage
from tests.conftest import Pipeline


@pytest.fixture
def native_pipe(tmp_path, monkeypatch):
    monkeypatch.setenv("PCB_CAM_ENGINE", "native")
    return Pipeline(Storage(storage_root=tmp_path / "storage", work_root=tmp_path / "work"))


def test_place_rotates_about_unit_corner_and_keeps_bbox_corner():
    ap = Symbol("rect", (2.0, 1.0)).to_aperture(unit=MM)
    f = go.Flash(3.0, 1.0, ap, unit=MM)  # unit bbox (0,0)-(10,4): pad at (3,1)
    o = _place(f, 100.0, 50.0, 0.0, 0, 0, 4)
    assert (float(o.x), float(o.y)) == (103.0, 51.0)
    r = _place(f, 100.0, 50.0, 90.0, 0, 0, 4)
    # CCW 90° about (0,0): (3,1) → (-1,3); shifted right by the unit height 4 → (3,3); then the panel offset
    assert (round(float(r.x), 6), round(float(r.y), 6)) == (103.0, 53.0)
    # the aperture turned with it (2×1 → 1×2)
    assert (float(r.aperture.w), float(r.aperture.h)) == (1.0, 2.0)


def test_panel_step_built_filled_tooled_and_exported(native_pipe):
    out = native_pipe.run("kicad-x2ap", "panel")
    job = native_pipe.job_id("kicad-x2ap")
    work = native_pipe.storage.work_dir(job)
    pdir = work / "steps" / "panel"
    meta = json.loads((pdir / "panel.json").read_text())
    c = meta["candidate"]
    assert c["nx"] * c["ny"] == len(meta["placements"]) >= 2 and meta["layers"]
    assert not any(i.kind in ("native_failed", "native_skipped") for i in out.items), [i.message for i in out.items if i.kind.startswith("native_")]
    lm = json.loads((work / "layer_map.json").read_text())
    cu = next(e for e in lm["files"] if e["type"] == "top_copper")
    drill = next(e for e in lm["files"] if e["type"].startswith("drill"))
    outline = next(e for e in lm["files"] if e["type"] == "outline")
    # every unit repeated: the panel copper has n× the edit copper's pads
    edit = FeatureLayer.load(work / "src" / cu["file"]) if not (work / "steps" / "edit" / cu["file"]).is_file() else FeatureLayer.load(work / "steps" / "edit" / cu["file"])
    panel_cu = FeatureLayer.load(pdir / cu["file"], cu["file"], "top_copper")
    n_units = len(meta["placements"])
    dots = [f for f in panel_cu.pads() if f.symbol and f.symbol.kind == "r" and abs(f.symbol.params[0] - 1.5) < 1e-6]
    assert len(panel_cu.pads()) - len(dots) == n_units * len(edit.pads())
    # PatternFill: thieving dots only in the rails, never on a unit
    x0, y0, x1, y1 = meta["unit_bbox"]
    assert dots
    for d in dots[:50]:
        for pl in meta["placements"]:
            w, h = (x1 - x0, y1 - y0) if pl["angle"] % 180 == 0 else (y1 - y0, x1 - x0)
            assert not Point(d.xy).within(__import__("shapely.geometry", fromlist=["box"]).box(x0 + pl["dx"], y0 + pl["dy"], x0 + pl["dx"] + w, y0 + pl["dy"] + h).buffer(2.5))
    # the outline layer carries the panel rectangle
    ol = FeatureLayer.load(pdir / outline["file"], outline["file"], "outline")
    bx0, by0, bx1, by1 = ol.dark_union().bounds
    assert abs(bx0) < 0.1 and abs(by0) < 0.1 and abs(bx1 - c["panel_w"]) < 0.1 and abs(by1 - c["panel_h"]) < 0.1
    # AddTooling: four corner holes on a drill layer of the panel
    from gerbonara.excellon import ExcellonFile

    holes = [(round(float(o.x), 2), round(float(o.y), 2), float(o.tool.diameter)) for f in pdir.glob("**/*") if f.is_file() and f.suffix.lower() in (".drl", ".xln", ".txt", ".exc")
             for o in ExcellonFile.open(f).objects if isinstance(o, go.Flash)]  # fmt: skip
    corners = [h for h in holes if abs(h[2] - 3.175) < 1e-6]
    assert len(corners) == 4 and {(h[0], h[1]) for h in corners} == {(4.0, 4.0), (c["panel_w"] - 4.0, 4.0), (c["panel_w"] - 4.0, c["panel_h"] - 4.0), (4.0, c["panel_h"] - 4.0)}
    tokens = set(json.loads((work / "edit_log" / "applied.json").read_text()))
    assert "PanelBuild@-" in tokens and f"PatternFill@{cu['file']}" in tokens and "AddTooling@-" in tokens
    # output stage: production files from the panel step, review files still from edit
    rep = native_pipe.run("kicad-x2ap", "output")
    kinds = {a.kind for a in rep.artifacts}
    assert {"gerber_panel", "drill_panel", "gerber_review", "drill"} <= kinds
    panel_gerbers = [a for a in rep.artifacts if a.kind == "gerber_panel"]
    assert len(panel_gerbers) == len([e for e in lm["files"] if e["type"] in ("top_copper", "inner_copper", "bottom_copper", "top_mask", "bottom_mask", "top_silk", "bottom_silk")])
    assert all("_panel" in a.filename for a in panel_gerbers)
    # second run: nothing rebuilt, nothing exported twice
    rep2 = native_pipe.run("kicad-x2ap", "panel", attempt=2)
    assert not any(i.kind == "native_applied" for i in rep2.items)
    assert drill["file"] in meta["layers"]


VIA_PROFILE = "drill:\n  via_max_mm: 0.75\n"  # the KiCad fixture's 0.6/0.7 plated holes count as vias


def _stage_all(pipe: Pipeline, board: str, spec: dict, upto: str):
    order = ["intake", "align", "drill", "inner", "outer", "mask", "silk", "net_compare", "panel", "output"]
    rep = None
    for st in order[: order.index(upto) + 1]:
        rep = pipe.run(board, st, order_spec=spec, profile_yaml=VIA_PROFILE)
        pipe.reports[(board, st)] = rep  # overrides are not cached by Pipeline.run; keep the chain consistent
    return rep


def test_panel_tape_carries_the_drill_bits_and_plug_tape(native_pipe):
    from gerbonara.excellon import ExcellonFile

    spec = {"via_plugging": "resin"}
    drill = _stage_all(native_pipe, "kicad-x2ap", spec, "drill")
    plug = [a for a in drill.artifacts if a.filename.endswith("_plug.drl")]
    assert plug and any(i.kind == "drill_plug_tape" for i in drill.items)
    table = json.loads(native_pipe.storage.read_object(next(a.path for a in drill.artifacts if a.filename == "drill_table.json")))
    # the mask-opening rule moves tented vias to ``via_plug``; the plug tape follows those rows (all vias when nothing was split)
    vias = [r for r in table["tools"] if r["attribute"] == "via_plug"] or [r for r in table["tools"] if r["attribute"] == "via"]
    assert vias, "fixture needs via holes for this test"
    ptxt = native_pipe.storage.read_object(plug[0].path).decode()
    assert sum(1 for ln in ptxt.splitlines() if ln.startswith("X")) == sum(r["count"] for r in vias if r["file"] == vias[0]["file"])
    assert f"C{vias[0]['dia_mm'] + 0.1:.3f}".rstrip("0") in ptxt.replace("C0", "C0")  # via + plug_oversize
    out = _stage_all(native_pipe, "kicad-x2ap", spec, "output")
    names = [a.filename for a in out.artifacts if a.kind == "drill"]
    assert any("_plug." in n for n in names) and len(set(names)) == len(names)  # factory naming template (.TXT) keeps the _plug tag
    # production tape from the panel: finished sizes swapped for the drill stage's bits, plug tape alongside
    panel_tapes = {a.filename: a for a in out.artifacts if a.kind == "drill_panel"}
    assert any("_plug." in n for n in panel_tapes) and any("_plug." not in n for n in panel_tapes)
    main = next(a for n, a in panel_tapes.items() if "_plug." not in n and "NPTH" not in n)
    tmp = native_pipe.storage.work_dir(native_pipe.job_id("kicad-x2ap")) / "panel_tape_check.drl"
    tmp.write_bytes(native_pipe.storage.read_object(main.path))
    dias = {round(float(o.tool.diameter), 3) for o in ExcellonFile.open(tmp).objects}
    rows = [r for r in table["tools"] if r["file"] == main.filename.split("_panel")[0] or True]
    bits = {round(r["drill_dia_mm"], 3) for r in rows}
    finished_only = {round(r["dia_mm"], 3) for r in rows if abs(r["drill_dia_mm"] - r["dia_mm"]) > 1e-6} - bits
    assert dias <= bits | {3.175} and not (dias & finished_only), (dias, bits, finished_only)


# ---- 二次审计 5d: 可解析的客户 SET（p148–151） ---------------------------------------------------
def test_parse_panelization_reads_the_simple_sentences():
    from engine.panel.plan import parse_panelization, set_size

    p = parse_panelization("客户要求：2×3 拼板，V-CUT，工艺边 5mm 两侧加 mark 点（参考上一版本）")
    assert p and (p["nx"], p["ny"], p["gap_mm"], p["rail_mm"], p["rails"], p["vcut"]) == (2, 3, 0.0, 5.0, "lr", True)
    assert set_size(p, 50, 40) == (2 * 50 + 10, 3 * 40)
    q = parse_panelization("拼板 3*2 间距 2mm 四边工艺边 4mm 邮票孔")
    assert q and (q["nx"], q["ny"], q["gap_mm"], q["rail_mm"], q["rails"], q["stamp"]) == (3, 2, 2.0, 4.0, "all", True)
    assert set_size(q, 10, 10) == (3 * 10 + 2 * 2 + 8, 2 * 10 + 2 + 8)
    assert parse_panelization("按客户上一版本拼板") is None and parse_panelization(None) is None


def test_customer_set_is_built_and_the_panel_repeats_it(native_pipe):
    spec = {"panelization": "2x2 拼板 间距 2mm 工艺边 5mm"}
    panel = _stage_all(native_pipe, "kicad-x2ap", spec, "panel")
    cust = next(i for i in panel.items if i.kind == "panel_customer_spec")
    assert "已解析" in cust.message and cust.fix.params["nx"] == 2 and cust.fix.applied
    assert not any(i.kind in ("native_failed", "native_skipped") for i in panel.items), [i.message for i in panel.items if i.kind.startswith("native_")]
    work = native_pipe.storage.work_dir(native_pipe.job_id("kicad-x2ap"))
    sm = json.loads((work / "steps" / "set" / "set.json").read_text())
    pm = json.loads((work / "steps" / "panel" / "panel.json").read_text())
    assert len(sm["placements"]) == 4 and sm["parsed"]["rails"] == "tb" and pm["from_set"] and pm["unit_bbox"][2] == sm["set_w"]
    lm = json.loads((work / "layer_map.json").read_text())
    cu = next(e for e in lm["files"] if e["type"] == "top_copper")
    edit = FeatureLayer.load(work / "steps" / "edit" / cu["file"]) if (work / "steps" / "edit" / cu["file"]).is_file() else FeatureLayer.load(work / "src" / cu["file"])
    set_cu = FeatureLayer.load(work / "steps" / "set" / cu["file"], cu["file"], "top_copper")
    assert len(set_cu.pads()) == 4 * len(edit.pads())
    panel_cu = FeatureLayer.load(work / "steps" / "panel" / cu["file"], cu["file"], "top_copper")
    dots = [f for f in panel_cu.pads() if f.symbol and f.symbol.kind == "r" and abs(f.symbol.params[0] - 1.5) < 1e-6]
    assert len(panel_cu.pads()) - len(dots) == len(pm["placements"]) * 4 * len(edit.pads())
    # the SET's own frame (工艺边) is on the set outline layer
    ol = next(e for e in lm["files"] if e["type"] == "outline")
    b = FeatureLayer.load(work / "steps" / "set" / ol["file"], ol["file"], "outline").dark_union().bounds
    assert abs(b[2] - sm["set_w"]) < 0.1 and abs(b[3] - sm["set_h"]) < 0.1


def test_panel_preview_reuses_the_unit_and_stays_fresh(native_pipe):
    """工作板层预览:单只折一次用 <use> 摆 nx×ny,只折工作板独有物件(板框/阻流点/定位孔)。

    2026-09-07 审查修掉的三处:① 本地引擎没改过的层没有 edit 副本,原来直接放弃 <use> 退回整层
    折叠(大多数层都走这条慢路)；② 用 bbox 包含判断归属,外形线的 bbox 会伸出单只轮廓半个线宽,
    于是每只板的外形都被当成"工作板独有"再折一遍；③ 缓存只看工作板文件的时间,改图或重拼板后
    还给旧图。
    """
    from engine.api.main import _panel_svg

    native_pipe.run("kicad-x2ap", "panel")
    job = native_pipe.job_id("kicad-x2ap")
    work = native_pipe.storage.work_dir(job)
    meta = json.loads((work / "steps" / "panel" / "panel.json").read_text())
    n_units = len(meta["placements"])
    lm = json.loads((work / "layer_map.json").read_text())
    outline = next(e for e in lm["files"] if e["type"] == "outline")

    svg = _panel_svg(work, outline, work / "steps" / "panel" / outline["file"])
    assert svg is not None and svg.count("<use ") == n_units
    # 外形不该被重复折进"工作板独有"里:defs 里单只的路径 + 板框,远少于 n_units 份外形
    assert svg.count("<path ") < n_units, svg.count("<path ")
    cache = work / "cache" / (outline["file"].replace("/", "_") + "@panel.svg")
    assert cache.is_file()

    # 单只副本被改动 → 预览要重画,不能给旧的
    unit_src = next(p for p in ((work / "steps" / "edit" / outline["file"]), (work / "src" / outline["file"])) if p.is_file())
    stale = "STALE-MARKER"
    cache.write_text(stale, encoding="utf-8")
    os.utime(unit_src, (cache.stat().st_mtime + 10, cache.stat().st_mtime + 10))
    assert _panel_svg(work, outline, work / "steps" / "panel" / outline["file"]) != stale

    # 本地引擎没改过的层(没有 edit 副本)照样走 <use>,不退回整层折叠
    paste = next((e for e in lm["files"] if e["type"] in ("top_paste", "bottom_paste")), None)
    if paste and (work / "steps" / "panel" / paste["file"]).is_file():
        edit_copy = work / "steps" / "edit" / paste["file"]
        if edit_copy.is_file():
            edit_copy.unlink()
        s2 = _panel_svg(work, paste, work / "steps" / "panel" / paste["file"])
        assert s2 is not None and s2.count("<use ") == n_units
