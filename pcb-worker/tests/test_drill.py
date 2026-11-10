"""Drill stage on the three sample boards + Excellon writer round-trip."""

import json
import warnings

import pytest
from gerbonara.excellon import ExcellonFile

from engine.output.excellon_writer import DrillTool, format_coord, write_excellon
from engine.stages.drill import round_to_step
from tests.conftest import BOARDS


def _tools(pipeline, board):
    rep = pipeline.run(board, "drill")
    art = next(a for a in rep.artifacts if a.filename == "drill_table.json")
    return rep, json.loads(pipeline.storage.read_object(art.path))


@pytest.mark.parametrize("board", BOARDS)
def test_drill_runs(pipeline, board):
    rep, table = _tools(pipeline, board)
    assert rep.status in ("ok", "needs_review"), rep.summary
    assert table["total_holes"] > 0
    kinds = {i.kind for i in rep.items}
    assert {"hole_size", "power_ground_shorts", "drill_oversize"} <= kinds
    assert "layer_parse_error" not in kinds
    located = ("extra_holes", "hole_separation", "missing_holes", "npth_to_rout")
    for i in rep.items:
        if i.kind in located and not i.id.endswith("_more") and i.severity != "info":
            assert i.location is not None
    drills = [a for a in rep.artifacts if a.kind == "drill"]
    assert drills and all(a.filename.endswith("_oversized.drl") for a in drills)


def test_kicad_plating_attributes_and_oversize(pipeline):
    rep, table = _tools(pipeline, "kicad-x2ap")
    by_file = {}
    for t in table["tools"]:
        by_file.setdefault(t["file"].rsplit("/", 1)[-1], []).append(t)
    pth = by_file["Flashpads-PTH.drl"]
    npth = by_file["Flashpads-NPTH.drl"]
    assert all(t["plated"] is True for t in pth) and all(t["plated"] is False for t in npth)
    assert any(t["slot"] for t in pth)  # 16 G85 slots
    assert sum(t["count"] for t in pth if t["slot"]) == 16
    for t in pth:
        exp = "via" if t["dia_mm"] <= 0.5 and not t["slot"] else "plated"
        assert t["attribute"] == exp
        assert t["oversize_mm"] == (0.0 if exp == "via" else 0.15)
        assert t["drill_dia_mm"] == pytest.approx(round_to_step(t["dia_mm"] + t["oversize_mm"], 0.05))
    for t in npth:
        assert t["attribute"] == "non_plated" and t["oversize_mm"] == 0.05
    # no unknown plating on KiCad (X2 comment parsed)
    assert not [i for i in rep.items if i.kind == "drill_plating_unknown"]
    over = [i for i in rep.items if i.kind == "drill_oversize"]
    assert over and all(i.fix.applied and i.fix.auto_fixable and i.fix.type == "resize" for i in over)
    # holes in the KiCad board sit on pads, and we know its board geometry, so no NPTH near the edge
    assert not [i for i in rep.items if i.kind == "npth_to_rout"]


def test_kicad_oversized_tape_readable(pipeline):
    rep, table = _tools(pipeline, "kicad-x2ap")
    art = next(a for a in rep.artifacts if a.filename == "Flashpads-PTH_oversized.drl")
    text = pipeline.storage.read_object(art.path).decode()
    assert text.startswith("M48\n") and "METRIC,TZ" in text and ";TYPE=PLATED" in text
    assert "." not in text.split("%", 1)[1].split("T0\n")[0]  # body has no decimal points (TZ)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x = ExcellonFile.open(pipeline.storage.object_path(art.path))
    assert len(x.objects) == sum(t["count"] for t in table["tools"] if t["file"].endswith("PTH.drl") and "NPTH" not in t["file"])
    dias = sorted({round(o.tool.diameter, 3) for o in x.objects})
    assert dias == sorted({t["drill_dia_mm"] for t in table["tools"] if t["file"].endswith("-PTH.drl")})
    assert x.plating_type == "plated"


def test_eagle_unknown_plating_asks(pipeline):
    rep, table = _tools(pipeline, "eagle-newer")
    q = [i for i in rep.items if i.kind == "drill_plating_unknown"]
    assert q and q[0].eq_question and q[0].severity == "error"
    assert all(t["attribute"] == "unknown" and t["oversize_mm"] == 0 for t in table["tools"])
    assert rep.status == "needs_review"


def test_altium_mixed_plating_per_tool(pipeline):
    rep, table = _tools(pipeline, "altium-limesdr")
    rows = [t for t in table["tools"] if "RoundHoles" in t["file"]]
    assert {t["plated"] for t in rows} == {True, False}
    assert not [i for i in rep.items if i.kind == "drill_plating_unknown"]
    vias = [t for t in rows if t["attribute"] == "via"]
    assert vias and vias[0]["dia_mm"] == 0.2 and vias[0]["count"] == 4171
    slots = [t for t in table["tools"] if t["slot"]]
    assert sum(t["count"] for t in slots) == 3
    assert table["total_holes"] == 4255 + 3


def test_order_spec_drill_table_compare(pipeline):
    ok_spec = {
        "drill_table": [
            {"dia_mm": 0.2, "count": 4171, "plated": True},
        ]
    }
    rep = pipeline.run("altium-limesdr", "drill", order_spec=ok_spec)
    mism = [i for i in rep.items if i.kind == "drill_table_mismatch"]
    # every Excellon tool that is not in the spec is reported
    assert all(i.id.startswith("spec_extra_") for i in mism) and mism
    bad_spec = {"drill_table": [{"dia_mm": 0.25, "count": 4171}, {"dia_mm": 0.381, "count": 9}]}
    rep = pipeline.run("altium-limesdr", "drill", order_spec=bad_spec)
    mism = [i for i in rep.items if i.kind == "drill_table_mismatch" and i.id in ("spec_0", "spec_1")]
    assert len(mism) == 2 and all("钻孔表与 Excellon 不一致" in i.eq_question for i in mism)
    assert mism[1].measured == 10 and mism[1].threshold == 9


def test_profile_yaml_override(pipeline):
    rep = pipeline.run("kicad-x2ap", "drill", profile_yaml="drill:\n  oversize_mm:\n    plated: 0.2\n  via_max_mm: 0\n")
    over = [i for i in rep.items if i.kind == "drill_oversize" and "PTH.drl" in i.layer and "NPTH" not in i.layer]
    assert over and all(i.fix.params["to"] == round_to_step(i.fix.params["from"] + 0.2, 0.05) for i in over)


# ---- writer unit tests ------------------------------------------------------------------------
def test_format_coord():
    assert format_coord(12.345, unit="METRIC", zeros="TZ", fmt=(3, 3)) == "12345"
    assert format_coord(-0.5, unit="METRIC", zeros="TZ", fmt=(3, 3)) == "-500"
    assert format_coord(12.3, unit="METRIC", zeros="LZ", fmt=(3, 3)) == "0123"
    assert format_coord(12.3, unit="METRIC", zeros="DECIMAL", fmt=(3, 3)) == "12.300"
    assert format_coord(25.4, unit="INCH", zeros="TZ", fmt=(2, 4)) == "10000"
    with pytest.raises(ValueError):
        format_coord(1234.0, unit="METRIC", zeros="TZ", fmt=(3, 3))


def test_writer_roundtrip_via_gerbonara(tmp_path):
    tools = [
        DrillTool(1, 0.75, True, holes=[(1.0, 2.0), (3.5, -4.25)]),
        DrillTool(2, 3.05, False, holes=[(10.0, 10.0)], slots=[(20.0, 20.0, 25.0, 20.0)]),
    ]
    text = write_excellon(tools, unit="METRIC", zeros="TZ", fmt=(3, 3))
    assert "T01C0.750" in text and "T02C3.050" in text and "X1000Y2000" in text and "G85X25000Y20000" in text
    p = tmp_path / "t.drl"
    p.write_text(text)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        x = ExcellonFile.open(p)
    assert len(x.objects) == 4
    assert x.is_mixed_plating
    xs = sorted(round(getattr(o, "x", getattr(o, "x1", 0)), 3) for o in x.objects)
    assert xs == [1.0, 3.5, 10.0, 20.0]
    text_lz = write_excellon(tools, unit="METRIC", zeros="LZ", fmt=(3, 3))
    assert "X001Y002" in text_lz
