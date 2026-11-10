"""StageReport must round-trip the JSON shapes the Node side (worker-client.ts zod) expects."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from engine.model.report import Artifact, Fix, Location, ReportItem, StageReport, derive_status

SAMPLES = Path(__file__).parent / "fixtures" / "report_samples"


@pytest.mark.parametrize("name", ["ok", "needs_review", "failed", "node_minimal"])
def test_samples_parse(name):
    data = json.loads((SAMPLES / f"{name}.json").read_text("utf-8"))
    rep = StageReport.model_validate(data)
    assert rep.stage == data["stage"]
    assert rep.status == data["status"]
    # dump -> parse is stable
    again = StageReport.model_validate(json.loads(rep.model_dump_json()))
    assert again == rep


def test_node_minimal_defaults():
    rep = StageReport.model_validate(json.loads((SAMPLES / "node_minimal.json").read_text()))
    assert rep.items == [] and rep.artifacts == []
    assert rep.layer_map is None and rep.order_spec_candidate is None and rep.duration_ms is None
    dumped = rep.model_dump()
    # every top-level key of the contract is present even when unset
    assert set(dumped) == {
        "stage", "status", "summary", "items", "artifacts", "layer_map",
        "order_spec_candidate", "duration_ms",
    }  # fmt: skip


def test_item_shape_matches_ts_contract():
    rep = StageReport.model_validate(json.loads((SAMPLES / "needs_review.json").read_text()))
    item = rep.items[1]
    d = item.model_dump()
    assert set(d) == {
        "id", "kind", "severity", "layer", "location", "measured", "threshold", "message", "fix",
        "eq_question",
    }  # fmt: skip
    assert d["location"] == {"x": 34.669, "y": -61.894, "bbox": (34.369, -62.744, 34.969, -61.044)}
    fix = rep.items[3].fix
    assert fix is not None and fix.genesis_script.startswith("COM ")
    assert set(fix.model_dump()) == {"type", "op", "params", "auto_fixable", "applied", "confirm", "genesis_script"}  # confirm: aios worker-types.ts ReportFix 同步加了
    art = rep.artifacts[0].model_dump()
    assert set(art) == {"kind", "path", "filename", "size", "content_type"}


def test_eq_rule_mirrors_node():
    applied = ReportItem(
        id="a", kind="k", severity="error", message="m",
        fix=Fix(type="resize", auto_fixable=True, applied=True),
    )  # fmt: skip
    unapplied = ReportItem(id="b", kind="k", severity="error", message="m")
    asked = ReportItem(id="c", kind="k", severity="info", message="m", eq_question="?")
    asked_done = ReportItem(id="d", kind="k", severity="warn", message="m", eq_question="?", fix=Fix(type="resize", auto_fixable=True, applied=True))
    assert not applied.needs_decision
    assert not asked_done.needs_decision  # the native engine did it before anyone had to answer
    assert unapplied.needs_decision
    assert asked.needs_decision
    assert derive_status([applied]) == "ok"
    assert derive_status([unapplied]) == "needs_review"
    assert derive_status([asked], blocked=True) == "blocked"


def test_invalid_status_rejected():
    with pytest.raises(ValidationError):
        StageReport(stage="x", status="done")
    with pytest.raises(ValidationError):
        Location(x=1, y=2, bbox=[1, 2, 3])
    assert Artifact(kind="drill", path="a/b.drl").filename is None
