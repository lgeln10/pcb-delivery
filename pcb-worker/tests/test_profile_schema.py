"""Factory-profile schema (= default.yaml shape): validation, docs, HTTP endpoints."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from engine.api.main import app
from engine.profiles.schema import default_docs, flatten, validate


def test_default_is_valid_and_documented():
    v = validate(None)
    assert v["ok"] and not v["errors"] and v["merged"]
    keys = {f["key"] for f in v["fields"]}
    assert {"drill.oversize_mm.plated", "copper.inner.min_spacing_mm", "mask.bridge_min_mm.green", "panel.rail_mm", "output.gerber.unit"} <= keys
    docs = default_docs()
    assert "p114" in docs["drill.oversize_mm.plated"] or "p114" in docs.get("drill.oversize_mm", "")
    assert "p122" in docs["copper.inner.min_spacing_mm"]
    assert all(not f["overridden"] for f in v["fields"])


def test_override_merges_and_flags():
    v = validate("copper:\n  inner:\n    min_spacing_mm: 0.127\nmask:\n  bridge_min_mm:\n    green: 0.1\n")
    assert v["ok"], v["errors"]
    f = {x["key"]: x for x in v["fields"]}
    assert f["copper.inner.min_spacing_mm"]["value"] == 0.127 and f["copper.inner.min_spacing_mm"]["overridden"]
    assert f["copper.inner.min_spacing_mm"]["default"] == 0.1
    assert f["mask.bridge_min_mm.green"]["value"] == 0.1 and not f["mask.bridge_min_mm.white_black"]["overridden"]
    assert flatten(v["merged"])["copper.inner.min_spacing_mm"] == 0.127


def test_errors_unknown_key_type_and_syntax():
    v = validate("drill:\n  oversize_mm:\n    plated: 'big'\n  nope: 1\n")
    assert not v["ok"]
    assert any("drill.nope" in e for e in v["errors"]) and any("plated" in e and "number" in e for e in v["errors"])
    assert v["merged"] is None
    assert not validate("drill: [1, 2")["ok"]
    assert not validate("- a\n- b\n")["ok"]
    assert not validate("release:\n  mode: ship_it\n")["ok"]
    assert not validate("copper:\n  vcut_coupon:\n    at: guess\n")["ok"]
    assert not validate("output:\n  rout_on_mask_mm: wide\n")["ok"]
    assert not validate("copper:\n  compensation_default_oz: thick\n")["ok"]


def test_optional_factory_rules_and_real_board_profiles_validate():
    """A null default means optional at runtime, not invalid in the profile editor."""
    optional = validate(
        "layer:\n  rail_vcut_notch_mm: [3.7, 1.5, 0.75]\n"
        "mask:\n  coverage_on_pour: {coverage_mm: 0.0254, ring_mm: 0.2, pour_coverage_min: 0.9}\n"
    )
    assert optional["ok"], optional["errors"]
    root = Path(__file__).resolve().parents[1] / "cases"
    for name in ("C09_real_6l_3oz", "C11_real_4l_altium", "C12_real_4l_protel99"):
        got = validate((root / name / "input" / "profile.yaml").read_text())
        assert got["ok"], (name, got["errors"])



def test_the_three_state_switches_and_the_by_finish_table_are_in_the_schema():
    """M6j 加了厂规开关三档和按表面处理分档的预大表，schema 没跟着改 —— 三块真板的 profile 从
    7bf71f9 起一直校验不过（校验只在 test 里跑，页面上会直接拦住工程师改 profile）。"""
    assert validate("copper:\n  inner:\n    nfp_removal: ask\n")["ok"]
    assert validate("copper:\n  inner:\n    nfp_removal: false\n")["ok"]
    bad = validate("copper:\n  inner:\n    nfp_removal: maybe\n")
    assert not bad["ok"] and "nfp_removal" in bad["errors"][0]

    assert validate("drill:\n  oversize_by_finish: {hasl: {plated: 0.15}, other: {plated: 0.10}}\n")["ok"]
    bad = validate("drill:\n  oversize_by_finish: {hasl: {bogus: 1}}\n")
    assert not bad["ok"] and "bogus" in bad["errors"][0]

    # extra_mm 在正常补偿上再加，add_mm 直接取值 —— drill.py 两种都读，schema 也得认
    assert validate("drill:\n  oversize_large: {min_dia_mm: 6.0, add_mm: 0.2}\n")["ok"]
    assert not validate("drill:\n  oversize_large: {add_mm: true}\n")["ok"]

def test_http_endpoints():
    c = TestClient(app)
    r = c.get("/profiles/default")
    assert r.status_code == 200 and r.json()["yaml"].startswith("#") and len(r.json()["fields"]) > 40
    r = c.post("/profiles/validate", json={"profile_yaml": "silk:\n  min_line_width_mm: 0.15\n"})
    assert r.status_code == 200 and r.json()["ok"] and any(f["key"] == "silk.min_line_width_mm" and f["overridden"] for f in r.json()["fields"])
    r = c.post("/profiles/validate", json={"profile_yaml": "silk:\n  bogus: 1\n"})
    assert r.status_code == 200 and not r.json()["ok"]
