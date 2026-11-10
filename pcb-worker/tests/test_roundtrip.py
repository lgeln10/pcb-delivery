"""Read -> write -> read round-trip on real fixture boards, compared geometrically."""

from dataclasses import replace
from pathlib import Path

import pytest
from gerbonara.cam import FileSettings
from gerbonara.excellon import ExcellonFile
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM, Inch

from engine.geom.from_gerbonara import camfile_to_geometry

FIXTURES = Path(__file__).parent / "fixtures"


def xor_ratio(a, b) -> float:
    return a.symmetric_difference(b).area / max(a.area, 1e-9)


@pytest.mark.parametrize(
    "rel, settings, tol",
    [
        # mm / 4.6 / no zero suppression: lossless for KiCad's nm-resolution coordinates
        ("kicad-x2ap/Flashpads-F_Cu.gbr", FileSettings(unit=MM, number_format=(4, 6), zeros=None), 1e-6),
        # inch / 2.4 / absolute / no zero suppression: 2.54 um quantisation -> sub-percent XOR
        ("kicad-x2ap/Flashpads-F_Cu.gbr", FileSettings(unit=Inch, number_format=(2, 4), zeros=None), 5e-3),
        # mm / 4.6 / trailing-zero suppression
        ("kicad-x2ap/Flashpads-F_Cu.gbr", FileSettings(unit=MM, number_format=(4, 6), zeros="trailing"), 1e-6),
        # Altium mask layer, lots of macros, LPC objects
        ("altium-limesdr/Gerber/LimeSDR-QPCIe_1v2.GTS", FileSettings(unit=Inch, number_format=(2, 4), zeros=None), 5e-3),
        # Eagle X2-in-comments; source is 3.4 mm so re-quantisation jitters arc tessellation (~2e-4)
        ("eagle-newer/copper_top.gbr", FileSettings(unit=MM, number_format=(4, 6), zeros=None), 1e-3),
    ],
)
def test_gerber_roundtrip(tmp_path, rel, settings, tol):
    src = FIXTURES / rel
    g = GerberFile.open(src)
    geom0, _ = camfile_to_geometry(g)
    assert geom0.area > 0

    out = tmp_path / "out.gbr"
    g.save(out, settings=settings)
    head = out.read_text().splitlines()[:10]
    unit = "%MOIN*%" if settings.unit == Inch else "%MOMM*%"
    assert unit in head
    fs = f"%FS{'T' if settings.zeros == 'trailing' else 'L'}AX{settings.number_format[0]}{settings.number_format[1]}Y{settings.number_format[0]}{settings.number_format[1]}*%"
    assert fs in head

    g2 = GerberFile.open(out)
    assert len(g2.objects) == len(g.objects)
    geom1, _ = camfile_to_geometry(g2)
    assert xor_ratio(geom0, geom1) < tol


def test_gerber_file_attrs_survive():
    g = GerberFile.open(FIXTURES / "kicad-x2ap/Flashpads-F_Cu.gbr")
    assert g.file_attrs[".FileFunction"] == ("Copper", "L1", "Top")
    data = g.write_to_bytes(FileSettings(unit=MM, number_format=(4, 6), zeros=None)).decode()
    assert "%TF.FileFunction,Copper,L1,Top*%" in data


@pytest.mark.parametrize(
    "rel",
    ["kicad-x2ap/Flashpads-PTH.drl", "eagle-newer/drills.xln", "altium-limesdr/NC Drill/LimeSDR-QPCIe_1v2-RoundHoles.TXT"],
)
def test_excellon_roundtrip(tmp_path, rel):
    x = ExcellonFile.open(FIXTURES / rel)
    geom0, _ = camfile_to_geometry(x)
    out = tmp_path / "out.drl"
    with pytest.warns(SyntaxWarning) if x.is_mixed_plating else _nullcontext():
        x.save(out, settings=FileSettings(unit=MM, number_format=(3, 3), zeros="trailing"))
    text = out.read_text()
    assert "METRIC" in text
    x2 = ExcellonFile.open(out)
    assert len(x2.objects) == len(x.objects)
    geom1, _ = camfile_to_geometry(x2)
    # 3 decimals in the output vs 4 in the Altium source -> 0.5 um jitter, ~6e-4 XOR
    assert xor_ratio(geom0, geom1) < 1e-3
    # plating info survives a save when it was known
    assert x2.plating_type == x.plating_type


def test_excellon_tool_oversize(tmp_path):
    x = ExcellonFile.open(FIXTURES / "kicad-x2ap/Flashpads-PTH.drl")
    before = sorted({round(o.tool.diameter, 3) for o in x.objects})
    cache = {}
    for o in x.objects:
        t = o.tool
        cache.setdefault(id(t), replace(t, diameter=t.diameter + 0.15))
        o.tool = cache[id(t)]
    out = tmp_path / "pre.drl"
    x.save(out, settings=FileSettings(unit=MM, number_format=(3, 3), zeros="trailing"))
    x2 = ExcellonFile.open(out)
    after = sorted({round(o.tool.diameter, 3) for o in x2.objects})
    assert after == [round(d + 0.15, 3) for d in before]


class _nullcontext:
    def __enter__(self):
        return None

    def __exit__(self, *exc):
        return False
