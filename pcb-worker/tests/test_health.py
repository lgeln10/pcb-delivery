from fastapi.testclient import TestClient

from engine.api.main import app
from engine.model.report import ReportItem, StageReport


def test_health():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["gerbonara_version"]
    assert body["shapely_version"].startswith("2.")


def test_stage_report_schema():
    rep = StageReport(
        stage="ingest",
        status="needs_review",
        summary="1 warn",
        items=[
            ReportItem(
                id="w1",
                kind="layer_unrecognized",
                severity="warn",
                layer="foo.gbr",
                message="could not classify layer",
            )
        ],
    )
    d = rep.model_dump()
    assert d["items"][0]["location"] is None
    assert StageReport.model_validate(d) == rep
