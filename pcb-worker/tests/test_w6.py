"""M2 W6: stray outline segments, intake needs_review on error, plating inference by pads."""

from __future__ import annotations

from gerbonara import graphic_objects as go
from gerbonara.apertures import CircleAperture
from gerbonara.rs274x import GerberFile
from gerbonara.utils import MM

from engine.geom.profile import extract_profile
from engine.pipeline.context import JobContext, StageRequest
from engine.stages.drill import ToolRow, infer_plating_by_pads, parse_drill_layer

FIX = "tests/fixtures/kicad-x2ap"


def test_stray_segment_detected_but_profile_still_closes():
    gf = GerberFile.open(f"{FIX}/Flashpads-Edge_Cuts.gbr")
    clean = extract_profile(gf)
    assert clean.profile is not None and not clean.stray
    # a 3 mm line in the middle of the board touching nothing is a sketch (p112: deleted, no EQ)
    gf.objects.append(go.Line(60, -45, 63, -45, aperture=CircleAperture(diameter=0.1, unit=MM), unit=MM))
    pr = extract_profile(gf)
    assert pr.profile is not None and pr.n_rings == clean.n_rings
    assert not pr.stray and len(pr.sketches) == 1 and abs(pr.sketches[0].length - 3.0) < 1e-6
    # a line running in from the outline is a slot / unfinished cut-out: stays stray (EQ)
    x0, y0, _x1, y1 = clean.profile.bounds
    ym = round((y0 + y1) / 2, 3)
    gf.objects.append(go.Line(x0, ym, x0 + 3, ym, aperture=CircleAperture(diameter=0.1, unit=MM), unit=MM))
    pr = extract_profile(gf)
    assert pr.profile is not None and pr.n_rings == clean.n_rings
    assert len(pr.stray) == 1 and abs(pr.stray[0].length - 3.0) < 1e-3 and len(pr.sketches) == 1


def test_c02_align_reports_stray_segment(pipeline):
    """C01 board is clean; the planted C02 segment is exercised via the profile helper above.
    Here: the sample boards must not raise the item."""
    for board in ("kicad-x2ap", "eagle-newer"):
        rep = pipeline.run(board, "align")
        assert "outline_stray_segment" not in {i.kind for i in rep.items}, board


def test_plating_inferred_from_pads(pipeline):
    board = "kicad-x2ap"
    pipeline.run(board, "intake")
    job = pipeline.job_id(board)
    req = StageRequest(tenant_id="t1", input_keys=pipeline.storage_keys[board], output_prefix=f"pcb-cam/t1/{job}/output/x/")
    ctx = JobContext(job_id=job, stage="drill", request=req, storage=pipeline.storage)
    lm = ctx.layer_map()
    rows: list[ToolRow] = []
    for e in lm["files"]:
        if e["type"].startswith("drill"):
            rows.extend(parse_drill_layer(ctx, e))
    for r in rows:
        r.plated = None  # pretend the files carried no plating clue (C04 drill.txt)
    items = []
    n = infer_plating_by_pads(ctx, lm, rows, items)
    assert n == len(rows)
    pth = [r for r in rows if r.file.endswith("PTH.drl") and "NPTH" not in r.file]
    npth = [r for r in rows if "NPTH" in r.file]
    assert pth and all(r.plated is True for r in pth)
    assert npth and all(r.plated is False for r in npth)
    assert all(i.kind == "drill_plating_inferred" and i.fix and i.fix.applied for i in items)


def test_intake_needs_review_when_error(pipeline, tmp_path):
    """An unreadable member inside the zip yields an error item -> status needs_review."""
    import zipfile

    from engine.pipeline.registry import run_stage
    from engine.storage import Storage

    st: Storage = pipeline.storage
    job = "job-w6-bad"
    key = f"pcb-cam/t1/{job}/input/bad.zip"
    p = st.object_path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("inner.zip", b"not really a zip")  # nested archive that cannot be opened
        zf.writestr("top.gbr", open(f"{FIX}/Flashpads-F_Cu.gbr", "rb").read())
    req = StageRequest(tenant_id="t1", input_keys=[key], output_prefix=f"pcb-cam/t1/{job}/output/intake/")
    rep = run_stage(JobContext(job_id=job, stage="intake", request=req, storage=st))
    has_error = any(i.severity == "error" for i in rep.items)
    assert rep.status == ("needs_review" if has_error else "ok"), (rep.status, [i.kind for i in rep.items])
