"""Intake on the three sample boards + archive / classifier unit checks."""

import zipfile

import pytest
from fastapi.testclient import TestClient

from engine.api.main import app
from engine.ingest.archive import extract_archive, fix_zip_name
from engine.ingest.classify import classify_file
from engine.stages.intake import SR_EQ
from tests.conftest import BOARDS


def _by_file(rep):
    return {f["file"].rsplit("/", 1)[-1]: f for f in rep.layer_map["files"]}


def test_kicad_all_layers_identified(pipeline):
    rep = pipeline.run("kicad-x2ap", "intake")
    assert rep.status == "ok"
    files = _by_file(rep)
    expect = {
        "Flashpads-F_Cu.gbr": "top_copper", "Flashpads-B_Cu.gbr": "bottom_copper",
        "Flashpads-F_Mask.gbr": "top_mask", "Flashpads-B_Mask.gbr": "bottom_mask",
        "Flashpads-F_Silkscreen.gbr": "top_silk", "Flashpads-B_Silkscreen.gbr": "bottom_silk",
        "Flashpads-F_Paste.gbr": "top_paste", "Flashpads-B_Paste.gbr": "bottom_paste",
        "Flashpads-Edge_Cuts.gbr": "outline",
        "Flashpads-PTH.drl": "drill_pth", "Flashpads-NPTH.drl": "drill_npth",
    }  # fmt: skip
    assert {k: v["type"] for k, v in files.items()} == expect
    assert all(f["confidence"] >= 0.9 and not f["needs_llm"] for f in files.values())
    assert files["Flashpads-PTH.drl"]["drill_span"] == [1, 2]
    assert files["Flashpads-F_Mask.gbr"]["polarity"] == "negative"
    assert rep.layer_map["stackup"]["copper_layers"] == 2
    assert [o.rsplit("/", 1)[-1] for o in rep.layer_map["stackup"]["order"]] == ["Flashpads-F_Cu.gbr", "Flashpads-B_Cu.gbr"]
    assert rep.layer_map["unmapped"] == []
    assert not [i for i in rep.items if i.severity == "error"]
    assert rep.artifacts[0].kind == "layer_map" and rep.artifacts[0].path.endswith("/intake/layer_map.json")
    assert pipeline.storage.object_exists(rep.artifacts[0].path)
    assert pipeline.storage.read_json(pipeline.job_id("kicad-x2ap"), "layer_map.json")["stackup"]["copper_layers"] == 2


def test_altium_stackup_and_drill_span(pipeline):
    rep = pipeline.run("altium-limesdr", "intake")
    assert rep.status == "ok"
    files = _by_file(rep)
    st = rep.layer_map["stackup"]
    assert st["copper_layers"] == 14  # GTL + G1..G12 + GBL
    order = [o.rsplit(".", 1)[-1] for o in st["order"]]
    assert order == ["GTL"] + [f"G{i}" for i in range(1, 13)] + ["GBL"]
    for name in ("LimeSDR-QPCIe_1v2-RoundHoles.TXT", "LimeSDR-QPCIe_1v2-SlotHoles.TXT"):
        assert files[name]["type"] == "drill_pth" and files[name]["mixed_plating"]
        assert files[name]["drill_span"] == [1, 14]  # from .LDP layer pairs
    assert files["LimeSDR-QPCIe_1v2.GM1"]["type"] == "outline"
    assert files["LimeSDR-QPCIe_1v2.GTS"]["type"] == "top_mask"
    assert files["LimeSDR-QPCIe_1v2.GPT"]["type"] == "drawing"
    unmapped = {u["file"].rsplit("/", 1)[-1] for u in rep.layer_map["unmapped"]}
    assert {"LimeSDR-QPCIe_1v2.DRR", "LimeSDR-QPCIe_1v2.LDP", "LimeSDR-QPCIe_1v2.REP"} <= unmapped
    # .DRR drill report becomes an order_spec candidate
    cand = rep.order_spec_candidate
    assert cand and cand["drill_table"][0] == {"tool": "T1", "dia_mm": 0.2, "slot": False, "count": 4171, "plated": True}
    assert not [i for i in rep.items if i.severity == "error"]


def test_eagle_layers_and_unknown_plating(pipeline):
    rep = pipeline.run("eagle-newer", "intake")
    files = _by_file(rep)
    assert files["copper_top.gbr"]["type"] == "top_copper"
    assert files["profile.gbr"]["type"] == "outline"
    assert files["drills.xln"]["type"] == "drill_unknown" and files["drills.xln"]["needs_llm"]
    assert files["drills.xln"]["drill_span"] == [1, 2]
    assert {u["file"] for u in rep.layer_map["unmapped"]} == {"gerber_job.gbrjob", "LICENSE"}
    assert any(i.kind == "layer_low_confidence" for i in rep.items)
    assert rep.layer_map["generator"].startswith("Autodesk")


@pytest.mark.parametrize("board", BOARDS)
def test_every_layer_has_reason_and_confidence(pipeline, board):
    rep = pipeline.run(board, "intake")
    for f in rep.layer_map["files"]:
        assert 0 < f["confidence"] <= 1 and f["reason"]
        assert f["needs_llm"] == (f["confidence"] < 0.8)


def test_step_repeat_blocks(tmp_path, pipeline):
    board = tmp_path / "sr.zip"
    gerber = "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.0*%\n%SRX2Y3I5.0J4.0*%\nD10*\nX0Y0D03*\n%SR*%\nM02*\n"
    with zipfile.ZipFile(board, "w") as zf:
        zf.writestr("panel.gtl", gerber)
        zf.writestr("panel.gbl", "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n")
    key = "pcb-cam/t1/job-sr/input/00000000-0000-0000-0000-000000000000-sr.zip"
    pipeline.storage.put_file(key, board)
    pipeline.storage_keys["sr"] = [key]
    rep = pipeline.run("sr", "intake")
    assert rep.status == "blocked"
    sr = [i for i in rep.items if i.kind == "sr_not_expanded"]
    assert sr and sr[0].layer == "panel.gtl" and sr[0].eq_question == SR_EQ
    # a 2-layer set with no outline and no drill also asks the human
    kinds = {i.kind for i in rep.items}
    assert "missing_layer" in kinds


def test_zip_cp437_gbk_name_fixed(tmp_path):
    # Windows WinRAR/Explorer zips store GBK bytes without the UTF-8 flag; python's zipfile
    # would set that flag for any non-ASCII name, so build the legacy header by byte-patching.
    name = "顶层.gtl"
    gbk = name.encode("gbk")
    placeholder = ("A" * (len(gbk) - 4) + ".gtl").encode()
    z = tmp_path / "cn.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr(placeholder.decode(), "%FSLAX46Y46*%\n%MOMM*%\nM02*\n")
    z.write_bytes(z.read_bytes().replace(placeholder, gbk))
    with zipfile.ZipFile(z) as zf:
        info = zf.infolist()[0]
        assert not info.flag_bits & 0x800 and info.filename == gbk.decode("cp437")
        assert fix_zip_name(info) == name
    res = extract_archive(z, tmp_path / "out")
    assert res.files == [name] and (tmp_path / "out" / name).is_file()
    g = classify_file(tmp_path / "out" / name, name)
    assert g.type == "top_copper"


def test_nested_dirs_flattened_and_traversal_refused(tmp_path):
    z = tmp_path / "n.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("proj/Gerber/a.GTL", "%FSLAX44Y44*%\n%MOMM*%\nM02*\n")
        zf.writestr("proj/NC Drill/a.TXT", "M48\nMETRIC\nT1C1.0\n%\nT1\nX1Y1\nM30\n")
        zf.writestr("proj/__MACOSX/._a.GTL", "junk")
    res = extract_archive(z, tmp_path / "out")
    assert sorted(res.files) == ["Gerber/a.GTL", "NC Drill/a.TXT"]
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("../../evil.gtl", "x")
    res = extract_archive(bad, tmp_path / "out2")
    assert not (tmp_path / "evil.gtl").exists()
    assert res.files == ["evil.gtl"]  # parent components dropped, file lands inside dest


@pytest.mark.parametrize(
    "name, expected",
    [
        ("board-F_Cu.gbr", "top_copper"), ("board-In2_Cu.gbr", "inner_copper"),
        ("board-B_Mask.gbr", "bottom_mask"), ("board-Edge_Cuts.gbr", "outline"),
        ("board-NPTH.drl", "drill_npth"), ("board-PTH.drl", "drill_pth"),
        ("x.GTO", "top_silk"), ("x.GBS", "bottom_mask"), ("x.GKO", "outline"), ("x.GP1", "inner_copper"),
        ("x.G3", "inner_copper"), ("底层阻焊.gbr", "bottom_mask"), ("顶层字符.art", "top_silk"),
        ("外形.gbr", "outline"), ("钻孔.drl", "drill_unknown"), ("L2-L5.drl", "drill_blind"),
        ("copper_top.gbr", "top_copper"), ("random.gbr", "unknown"),
    ],
)  # fmt: skip
def test_name_rules(tmp_path, name, expected):
    p = tmp_path / name
    body = "M48\nMETRIC\nT1C1.0\n%\nM30\n" if name.endswith(".drl") else "%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,1*%\nD10*\nX0Y0D03*\nX1Y1D03*\nM02*\n"
    p.write_text(body)
    g = classify_file(p, name)
    assert g.type == expected, g.reason
    if name == "board-In2_Cu.gbr":
        assert g.index == 3
    if name == "x.GP1":
        assert g.polarity == "negative" and g.index == 2
    if name == "L2-L5.drl":
        assert g.drill_span == [2, 5]


def test_http_intake_roundtrip(worker_env, pipeline):
    client = TestClient(app)
    key = pipeline.input_key("kicad-x2ap")
    body = {
        "tenant_id": "t1", "attempt": 1, "input_keys": [key], "layer_map": None, "order_spec": None,
        "profile_yaml": None, "output_prefix": "pcb-cam/t1/job-http/output/intake/",
    }  # fmt: skip
    r = client.post("/jobs/job-http/stages/intake", json=body)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["stage"] == "intake" and rep["status"] == "ok"
    assert isinstance(rep["duration_ms"], int)
    assert len(rep["layer_map"]["files"]) == 11
    # every stage is implemented (M3): a stage that needs earlier results says so instead of crashing
    r = client.post("/jobs/job-http/stages/panel", json=body)
    rep = r.json()
    assert r.status_code == 200 and rep["stage"] == "panel" and rep["status"] == "needs_review"
    assert [i["kind"] for i in rep["items"]] == ["panel_no_profile"] and isinstance(rep["duration_ms"], int)
    assert client.post("/jobs/job-http/stages/bogus", json=body).status_code == 404
    assert client.post("/jobs/../etc/stages/intake", json=body).status_code in (400, 404, 422)
    # layer SVG
    r = client.get("/jobs/job-http/layers/Flashpads-Edge_Cuts.svg")
    assert r.status_code == 200 and r.headers["content-type"].startswith("image/svg+xml")
    assert 'data-id="Flashpads-Edge_Cuts:0"' in r.text and "viewBox=" in r.text
    r = client.get("/jobs/job-http/layers/top_copper.svg")
    assert r.status_code == 200 and 'data-layer="Flashpads-F_Cu"' in r.text
    # rev=orig renders the customer file even once an edit copy exists (对原稿)
    work = worker_env.work_dir("job-http")
    edit = work / "steps" / "edit" / "Flashpads-Edge_Cuts.gbr"
    edit.parent.mkdir(parents=True, exist_ok=True)
    edit.write_bytes((work / "src" / "Flashpads-Edge_Cuts.gbr").read_bytes().replace(b"D01*", b"D01*", 1))
    r_edit = client.get("/jobs/job-http/layers/Flashpads-Edge_Cuts.svg?frame=board")
    r_orig = client.get("/jobs/job-http/layers/Flashpads-Edge_Cuts.svg?frame=board&rev=orig")
    assert r_edit.status_code == 200 and r_orig.status_code == 200 and (work / "cache" / "Flashpads-Edge_Cuts.gbr_orig.wkb").is_file()
    assert client.get("/jobs/job-http/layers/nope.svg").status_code == 404
    assert client.get("/jobs/job-none/layers/top_copper.svg").status_code == 404


def test_source_only_package_asks_for_gerber(tmp_path, pipeline):
    """ODB++ / EDA sources without Gerber: identify, do not parse, ask the customer (plan: 识别 + EQ)."""
    z = tmp_path / "src.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("board.kicad_pcb", "(kicad_pcb (version 20240108))")
        zf.writestr("odb/matrix/matrix", "LAYER { NAME=top }")
        zf.writestr("design.xml", '<?xml version="1.0"?><IPC-2581 revision="C"></IPC-2581>')
    key = "pcb-cam/t1/job-src/input/00000000-0000-0000-0000-000000000000-src.zip"
    pipeline.storage.put_file(key, z)
    pipeline.storage_keys["src"] = [key]
    rep = pipeline.run("src", "intake")
    assert rep.status == "needs_review"
    it = next(i for i in rep.items if i.kind == "source_only_no_gerber")
    assert it.eq_question and "Gerber" in it.eq_question
    assert "KiCad" in it.message and "ODB++" in it.message and "IPC-2581" in it.message


def test_source_files_next_to_gerber_are_just_noted(pipeline):
    from engine.stages.intake import source_kinds
    assert source_kinds(__import__("pathlib").Path("."), ["a/b.gtl", "proj.PcbDoc", "x.tgz"]) == [("proj.PcbDoc", "Altium 源文件")]
