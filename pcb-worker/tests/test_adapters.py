"""CamEngine implementations: lite (report-only), fake (simulated), genesis (dry-run delivery)."""

from __future__ import annotations

from engine.adapters.base import CamOp
from engine.adapters.fake import FakeEngine
from engine.adapters.genesis import GenesisAdapter, engine_from_env
from engine.adapters.lite import LiteEngine


def test_lite_reports_only_except_zero_risk_fixes():
    e = LiteEngine()
    assert e.supports(CamOp.DRILL_CHECKS) and not e.supports(CamOp.MASK_OPTIMIZE)
    assert e.run(CamOp.RESIZE_DRILLS, {})["applied"] is True
    assert e.run(CamOp.MASK_OPTIMIZE, {})["applied"] is False


def test_fake_records_calls():
    e = FakeEngine()
    e.run(CamOp.NFP_REMOVAL, {"layer": "l2"})
    assert e.calls == [(CamOp.NFP_REMOVAL, {"layer": "l2"})] and e.run(CamOp.TEARDROPS, {})["applied"]


def test_genesis_dry_run_delivery(tmp_path):
    g = GenesisAdapter(drop_dir=tmp_path / "drop", host="genesis01")
    r = g.deliver("job-1", "#!/bin/csh -f\nCOM open_job,job=job-1\n", ops=[{"n": 1, "op": "NfpRemoval"}])
    assert r["delivered"] and (tmp_path / "drop" / "job-1.csh").read_text().startswith("#!/bin/csh")
    env = (tmp_path / "drop" / "job-1.json").read_text()
    assert '"host": "genesis01"' in env and '"NfpRemoval"' in env
    assert g.read_result("job-1") is None
    (tmp_path / "drop" / "job-1.result.json").write_text('{"ok": true, "ops": [{"n": 1, "op": "NfpRemoval", "status": "OK"}]}')
    assert g.read_result("job-1")["ok"] is True
    assert g.run(CamOp.NFP_REMOVAL, {})["mode"] == "delivered"
    assert GenesisAdapter(drop_dir=None).deliver("j", "x") == {"delivered": False, "reason": "PCB_GENESIS_DROP_DIR not set"} or not GenesisAdapter(drop_dir=None).configured


def test_engine_from_env(monkeypatch):
    monkeypatch.delenv("PCB_CAM_ENGINE", raising=False)
    monkeypatch.delenv("PCB_GENESIS_DROP_DIR", raising=False)
    assert engine_from_env().name == "lite"
    monkeypatch.setenv("PCB_CAM_ENGINE", "fake")
    assert engine_from_env().name == "fake"
    monkeypatch.setenv("PCB_CAM_ENGINE", "genesis")
    assert engine_from_env().name == "genesis" and not engine_from_env().configured
