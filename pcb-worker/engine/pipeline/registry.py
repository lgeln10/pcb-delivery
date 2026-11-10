"""Stage name -> implementation. Unimplemented stages return a harmless placeholder report."""

from __future__ import annotations

import time
import traceback
from collections.abc import Callable

from engine.model.report import Fix, ReportItem, StageReport
from engine.pipeline import progress
from engine.pipeline.context import JobContext

STAGE_NAMES = [
    "intake", "order_spec", "align", "drill", "inner", "outer", "mask", "silk",
    "net_compare", "panel", "output", "gatekeeper",
]  # fmt: skip

StageFn = Callable[[JobContext], StageReport]


def _implemented() -> dict[str, StageFn]:
    from engine.stages.align import run_align
    from engine.stages.drill import run_drill
    from engine.stages.gatekeeper import run_gatekeeper
    from engine.stages.inner import run_inner
    from engine.stages.intake import run_intake
    from engine.stages.mask import run_mask
    from engine.stages.net_compare import run_net_compare
    from engine.stages.order_spec import run_order_spec
    from engine.stages.outer import run_outer
    from engine.stages.output import run_output
    from engine.stages.panel import run_panel
    from engine.stages.silk import run_silk

    return {
        "intake": run_intake, "order_spec": run_order_spec, "align": run_align, "drill": run_drill,
        "inner": run_inner, "outer": run_outer, "mask": run_mask, "silk": run_silk,
        "net_compare": run_net_compare, "panel": run_panel, "output": run_output, "gatekeeper": run_gatekeeper,
    }  # fmt: skip


def is_known_stage(stage: str) -> bool:
    return stage in STAGE_NAMES


def run_stage(ctx: JobContext) -> StageReport:
    """Run a stage; exceptions become a ``failed`` report instead of a 500."""
    t0 = time.perf_counter()
    fn = _implemented().get(ctx.stage)
    progress.emit(ctx.work_dir, ctx.stage, "stage_start", f"开始 {ctx.stage}", attempt=ctx.request.attempt)
    if fn is None:
        rep = StageReport(stage=ctx.stage, status="ok", summary="本步骤由 AIOS 侧完成，引擎无操作")
    else:
        try:
            pre = _reconcile_genesis(ctx) if ctx.stage == STAGE_NAMES[-1] else []
            rep = fn(ctx)
            rep.items = pre + rep.items
            if any(i.severity == "error" or i.eq_question for i in pre) and rep.status == "ok":
                rep.status = "needs_review"
        except Exception as e:  # noqa: BLE001
            rep = StageReport(
                stage=ctx.stage,
                status="failed",
                summary=f"{type(e).__name__}: {e}",
                items=[
                    ReportItem(
                        id="exception",
                        kind="worker_exception",
                        severity="error",
                        message="".join(traceback.format_exception(e))[-4000:],
                    )
                ],
            )
    rep.duration_ms = int((time.perf_counter() - t0) * 1000)
    _persist_and_assemble(ctx, rep)
    progress.emit(ctx.work_dir, ctx.stage, "stage_end", f"{ctx.stage} {rep.status}", status=rep.status,
                  errors=sum(1 for i in rep.items if i.severity == "error"), warns=sum(1 for i in rep.items if i.severity == "warn"),
                  decisions=sum(1 for i in rep.items if i.needs_decision), ms=int((time.perf_counter() - t0) * 1000))
    return rep


def _reconcile_genesis(ctx: JobContext) -> list[ReportItem]:
    """A1.4: before the gatekeeper runs, fold a Genesis host result (if any) back into the job so
    the gatekeeper sees ``Fix.applied`` and the pulled outputs. Never raises."""
    try:
        from engine.adapters.genesis import GenesisAdapter, engine_from_env

        eng = engine_from_env()
        if not isinstance(eng, GenesisAdapter) or not eng.configured:
            return []
        r = eng.reconcile(ctx.job_id, ctx.work_dir)
        if r is None:
            if not eng.delivered(ctx.job_id):
                return []  # first gatekeeper run: the delivery happens when this stage ends (below)
            st = eng.status(ctx.job_id)
            return [ReportItem(id="genesis_pending", kind="genesis_pending", severity="warn",
                               message=f"Genesis 主机还没返回结果（已投递 {len(st.get('parts', []))} 段，待跑 {len(st.get('parts_pending', []))} 段）",
                               eq_question="等 Genesis 主机跑完这批脚本后放行，系统会回读主机结果并核对成果物",
                               fix=Fix(type="genesis_wait", auto_fixable=False, params={}))]  # fmt: skip
        if r["failed"]:
            f = r["failed"][0]
            part = r.get("failed_part") or 1
            return [ReportItem(id="genesis_failed", kind="genesis_result_fail", severity="error",
                               message=f"Genesis 执行失败：{f.get('op')} {f.get('layer') or ''}（第 {part} 段）；已应用 {len(r['applied'])} 项",
                               eq_question=f"第 {part} 段在 Genesis 上失败：请工程师在 Genesis 里处理后放行，系统从第 {part} 段重投",
                               fix=Fix(type="genesis_resume", auto_fixable=False, params={"from_part": part, "total_parts": r.get("total_parts")}))]  # fmt: skip
        if r.get("paused_part"):
            part = r["paused_part"]
            return [ReportItem(id="genesis_paused", kind="genesis_paused", severity="warn",
                               message=f"Genesis 在第 {part}/{r.get('total_parts')} 段末尾的确认点停下；已应用 {len(r['applied'])} 项",
                               eq_question=f"请核对第 {part} 段（该阶段的报告和 Genesis 结果）后放行，系统投递第 {part + 1} 段继续",
                               fix=Fix(type="genesis_resume", auto_fixable=False, params={"from_part": part + 1, "total_parts": r.get("total_parts")}))]  # fmt: skip
        return [ReportItem(id="genesis_ok", kind="genesis_result", severity="info",
                           message=f"Genesis 执行完成：{len(r['applied'])} 项修复已回填为已执行，回拉成果物 {len(r['outputs'])} 个")]  # fmt: skip
    except Exception as e:  # noqa: BLE001
        return [ReportItem(id="genesis_reconcile_error", kind="genesis_result", severity="warn", message=f"Genesis 结果回填失败：{type(e).__name__}: {e}")]


def _execute_native(ctx: JobContext, rep: StageReport, plan, rdir) -> None:
    """B line: run this stage's plan calls through the configured executor (``PCB_CAM_ENGINE=native``
    / ``hybrid``); applied calls flip ``Fix.applied`` on their report items (this stage in memory,
    earlier stages on disk) and the ChangeSets become a ``dfm_report`` artifact."""
    from engine.adapters.genesis import executor_for
    from engine.model.plan import OpPlan

    eng = executor_for(ctx)
    if eng is None or not plan.ok:
        return
    mine = [c for c in plan.calls if c.stage == ctx.stage and not c.applied]
    if not mine:
        return
    results = eng.execute(OpPlan(job=plan.job, stages=plan.stages, calls=mine))
    applied = {r.key: r for r in results if r.applied and r.mode == "native"}
    failed = [r for r in results if r.detail.startswith("native op failed")]
    for r in failed:  # never silent: a crashing op is a bug to see in the report
        rep.items.append(ReportItem(id=f"native_fail_{r.n}", kind="native_failed", severity="warn", layer=r.layer, message=f"{r.op}: {r.detail}"))
    by_key = {c.key: c for c in mine}
    for r in results:  # the op refused on purpose (would cut useful copper …) → a person decides
        if r.mode == "skipped" and not (by_key[r.key].item_ids and by_key[r.key].needs_human):  # a finding with its own EQ already asks
            rep.items.append(ReportItem(id=f"native_skip_{r.n}", kind="native_skipped", severity="warn", layer=r.layer, message=f"{r.op}: {r.detail}",
                                        eq_question=f"{r.op} {r.layer or ''}：本地引擎判断需人工确认后再做（{r.detail.removeprefix('needs human: ')}）"))  # fmt: skip
    if not applied:
        return
    items_by_key = {c.key: set(c.item_ids) for c in mine}
    op_by_key = {c.key: c.op for c in mine}
    touched = 0
    for key in applied:
        ask = _ask_mode(ctx.profile, op_by_key.get(key, ""))
        for it in rep.items:
            if it.fix and it.id in items_by_key.get(key, ()) and not it.fix.applied:
                it.fix.applied = True
                it.message += "（本地引擎已执行）"
                if ask:  # the factory wants a person to sign this kind of change off: stays an EQ although done
                    it.fix.confirm = True
                    it.message += "，待确认"
                    it.eq_question = it.eq_question or f"{op_by_key.get(key)} 已按厂规执行（{it.message.split('（')[0]}），请确认；不要的话把 profile 里对应开关改成 off 后重跑本步"
                touched += 1
    for c in mine:  # flip the plan too so the script draft emits these as comments
        if c.key in applied:
            c.applied = True
    (rdir / f"{ctx.stage}.json").write_text(rep.model_dump_json(), encoding="utf-8")
    native = getattr(eng, "native", None)
    for kind, name, data in getattr(getattr(native, "nctx", None), "artifacts", []):  # panel-step exports (B2.8)
        rep.artifacts.append(ctx.write_artifact(kind, name, data))
    changes = getattr(native, "changes", [])
    if changes:
        import json

        _snapshot_history(ctx, changes)
        docs = [json.loads(p.read_text(encoding="utf-8")) for _, _, p in changes]
        rep.artifacts.append(ctx.write_artifact("dfm_report", f"changes_{ctx.stage}.json", json.dumps(docs, ensure_ascii=False, indent=1)))
        rep.items.append(ReportItem(id=f"native_{ctx.stage}", kind="native_applied", severity="info", measured=len(changes),
                                    message="本地几何引擎已执行 " + "、".join(f"{c.op}({c.layer or '-'}: {r.detail})" for (c, _, _), r in ((x, applied[x[0].key]) for x in changes))))  # fmt: skip
    if rep.status == "needs_review" and not any(i.needs_decision for i in rep.items):
        rep.status = "ok"
    elif rep.status == "ok" and any(i.needs_decision for i in rep.items):
        rep.status = "needs_review"  # an ask-mode change was applied above: the person must sign it off
    # the stage wrote its summary before the engine ran: the "N need decision" tail is stale now
    import re

    n_eq = sum(1 for i in rep.items if i.needs_decision)
    rep.summary = re.sub(r"\d+ need decision$", f"{n_eq} need decision", rep.summary or "")


def _snapshot_history(ctx: JobContext, changes) -> None:
    """Freeze this stage's result per changed layer under ``steps/history/<stage>/`` (页面「时间轴刷写」:
    从客户原稿拖到生产稿，一步一帧). ``ops.json`` next to the copies lists what the frame changed.
    Never raises — a missing frame only means the scrubber skips it."""
    import json
    import shutil

    try:
        hdir = ctx.work_dir / "steps" / "history" / ctx.stage
        hdir.mkdir(parents=True, exist_ok=True)
        rels = {cs.layer for _, cs, _ in changes if cs.layer}
        for rel in rels:
            src = ctx.edit_path(rel)
            if src.is_file():
                dst = hdir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
        ops = [{"n": c.n, "op": c.op, "layer": cs.layer, "kind": c.kind, "key": c.key, "added": cs.n_added, "deleted": cs.n_deleted,
                "modified": cs.n_modified, "ms": cs.params.get("duration_ms"), "log": p.name} for c, cs, p in changes]  # fmt: skip
        (hdir / "ops.json").write_text(json.dumps({"stage": ctx.stage, "layers": sorted(rels), "ops": ops}, ensure_ascii=False, indent=1), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


def _applied_keys(ctx: JobContext) -> set[str]:
    """Plan keys an executor already applied: the native engine's ``edit_log/applied.json`` and
    the Genesis host's OK ops in ``genesis/result.json`` — so re-built plans (and the script
    draft) do not ask for them again."""
    import json

    keys: set[str] = set()
    p = ctx.work_dir / "edit_log" / "applied.json"
    if p.is_file():
        keys |= set(json.loads(p.read_text(encoding="utf-8")))
    r = ctx.work_dir / "genesis" / "result.json"
    if r.is_file():
        for o in json.loads(r.read_text(encoding="utf-8")).get("ops", []):
            if o.get("status") == "OK" and o.get("key"):
                keys.add(o["key"])
                keys.add(f"{o.get('op')}@{o.get('layer') or '-'}")  # layer-wide token, same as the native engine's
    return keys


def _plan_data(ctx: JobContext, reports: dict[str, StageReport]) -> dict:
    """Job facts the skeleton drafts need beyond the profile: the drill stage's tool table (A0
    SetDrillAttrs / ResizeDrills), the panel (StepRepeat / PatternFill / AddTooling: the native
    engine's ``steps/panel/panel.json`` when it ran, else the panel stage's chosen candidate) and
    the outline's longest straight edge (RoutDesign start point, p173)."""
    import json

    out: dict = {}

    def _artifact(stage: str, name: str):
        rep = reports.get(stage)
        art = next((a for a in rep.artifacts if a.filename == name), None) if rep else None
        if art is None:
            return None
        try:
            return json.loads(ctx.storage.read_object(art.path).decode("utf-8"))
        except Exception:  # noqa: BLE001 — the draft degrades to placeholders
            return None

    dt = _artifact("drill", "drill_table.json")
    if dt is not None:
        out["drill_table"] = dt
    pj = ctx.work_dir / "steps" / "panel" / "panel.json"
    if pj.is_file():
        try:
            out["panel"] = json.loads(pj.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    if "panel" not in out:
        pp = _artifact("panel", "panel.json")
        if pp and pp.get("chosen"):
            out["panel"] = {"candidate": pp["chosen"], "from_set": bool(pp.get("set"))}
    pw = ctx.work_dir / "profile.wkb"
    if pw.is_file():
        try:
            from shapely import from_wkb

            prof = from_wkb(pw.read_bytes())
            poly = prof if prof.geom_type == "Polygon" else max(prof.geoms, key=lambda g: g.area)
            pts = list(poly.exterior.coords)
            segs = [((pts[i][0] - pts[i + 1][0]) ** 2 + (pts[i][1] - pts[i + 1][1]) ** 2) for i in range(len(pts) - 1)]
            if segs:
                out["rout"] = {"first": segs.index(max(segs)) + 1, "edges": len(segs)}
        except Exception:  # noqa: BLE001
            pass
    return out


def _persist_and_assemble(ctx: JobContext, rep: StageReport) -> None:
    """Keep every stage report in the job work dir, rebuild the job's ``OpPlan`` from all of them
    (``plan/plan.json`` + artifact ``op_plan``) and regenerate the Genesis script draft
    (``genesis_<job>.csh``) from the plan — both are artifacts of every stage so the latest one
    always reflects everything found so far (docs/PLAN_TWO_TRACKS.md S0, genesis_op_mapping.md 附 C)."""
    try:
        rdir = ctx.work_dir / "reports"
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / f"{ctx.stage}.json").write_text(rep.model_dump_json(), encoding="utf-8")
        if rep.status == "failed":
            return
        from engine.model.plan import build_plan
        from engine.output.genesis_script import build_script, build_segments

        reports: dict[str, StageReport] = {}
        for st in STAGE_NAMES:
            f = rdir / f"{st}.json"
            if f.is_file():
                reports[st] = StageReport.model_validate_json(f.read_text(encoding="utf-8"))
        plan = build_plan(ctx.job_id, reports, ctx.layer_map(), cfg=ctx.profile, applied_keys=_applied_keys(ctx), data=_plan_data(ctx, reports))
        if not plan.calls:
            return
        pdir = ctx.work_dir / "plan"
        pdir.mkdir(parents=True, exist_ok=True)
        plan_json = plan.model_dump_json(indent=1)
        (pdir / "plan.json").write_text(plan_json, encoding="utf-8")
        rep.artifacts.append(ctx.write_artifact("op_plan", f"plan_{ctx.job_id}.json", plan_json))
        for prob in plan.problems:
            rep.items.append(ReportItem(id=f"plan_{len(rep.items)}", kind="op_plan_invalid", severity="error", message=f"操作序列守卫未通过：{prob}",
                                        eq_question="操作序列违反教材硬约束，需人工调整后才能执行"))  # fmt: skip
        if plan.problems and rep.status == "ok":
            rep.status = "needs_review"
        _execute_native(ctx, rep, plan, rdir)
        if not any((c.script or "").strip() for c in plan.calls):
            return
        from engine.adapters.genesis import GenesisAdapter, engine_from_env

        eng = engine_from_env()
        genesis = eng if isinstance(eng, GenesisAdapter) and eng.configured else None
        fills = {"in_dir": genesis.host_in_dir(ctx.job_id), "out_dir": genesis.host_out_dir(ctx.job_id)} if genesis else None  # A0: host-side import / export dirs
        text = build_script(ctx.job_id, plan, fills=fills)
        rep.artifacts.append(ctx.write_artifact("genesis_script", f"genesis_{ctx.job_id}.csh", text))
        parts = build_segments(ctx.job_id, plan, fills=fills)
        if ctx.stage == STAGE_NAMES[-1] and len(parts) > 1:
            for name, ptext in parts:
                rep.artifacts.append(ctx.write_artifact("genesis_script", name, ptext))
        # PCB_CAM_ENGINE=genesis: deliver the script + the edit-copy layer files to the drop dir
        # (M4/A0) — once per job; a paused / failed job continues through GenesisAdapter.resume
        # (A4.2). The job then waits for the host: the delivery item is an EQ the engineer releases
        # when the host is done (aios re-runs the gatekeeper, which reconciles the result).
        if genesis is not None and ctx.stage == STAGE_NAMES[-1] and plan.ok and not genesis.delivered(ctx.job_id):
            lm = ctx.layer_map() or {}
            files = [(e["file"], ctx.layer_path(e["file"])) for e in lm.get("files", []) if e.get("type") and e["type"] not in ("unknown",) and ctx.layer_path(e["file"]).is_file()]
            r = genesis.deliver(ctx.job_id, text, ops=[{"n": c.n, "op": c.op, "layer": c.layer, "key": c.key} for c in plan.calls if not c.applied], parts=parts, files=files,
                                archive_dir=ctx.work_dir / "genesis" / "archive")  # fmt: skip
            if r.get("queued"):
                rep.items.append(ReportItem(id="genesis_queued", kind="genesis_queued", severity="warn", message=f"Genesis 脚本排队中：{r.get('reason')}",
                                            eq_question="Genesis 主机的许可证都在用；有空位后放行，系统重试投递",
                                            fix=Fix(type="genesis_wait", auto_fixable=False, params={"in_flight": r.get("in_flight", [])})))  # fmt: skip
            elif r.get("delivered"):
                rep.items.append(ReportItem(id="genesis_delivery", kind="genesis_delivery", severity="info",
                                            message=f"Genesis 脚本已投递到 {r.get('script')}（{len(r.get('parts', []))} 段，主机代理执行后写 {ctx.job_id}.result.json）",
                                            eq_question="等 Genesis 主机跑完这批脚本后放行，系统会回读主机结果并核对成果物",
                                            fix=Fix(type="genesis_wait", auto_fixable=False, params={"parts": len(r.get("parts", []))})))  # fmt: skip
            if rep.status == "ok" and any(i.needs_decision for i in rep.items):
                rep.status = "needs_review"
    except Exception as e:  # noqa: BLE001 - the plan / script draft must never fail a stage
        import os
        import traceback

        if os.environ.get("PCB_CAM_DEBUG"):
            traceback.print_exc()
        where = traceback.extract_tb(e.__traceback__)[-1]
        rep.items.append(
            ReportItem(id="genesis_script_error", kind="genesis_script_error", severity="info",
                       message=f"操作序列 / Genesis 脚本草稿未生成：{type(e).__name__}: {e}（{where.filename.rsplit('/', 1)[-1]}:{where.lineno} {where.name}）")
        )  # fmt: skip


# 厂规开关的三档（洲旭 2026-09-16 回复 C09 确认单：这几类改动「要人工处理 / 应设为可选项」）：
#   auto = 照做、报告里显示已自动；ask = 照做但报告项进 EQ，人点过才进下一站；off = 不做。
# 本地引擎执行完把 fix.applied 翻成 True 的那一刻，按 op 查一次 profile：ask 档就再给 fix.confirm。
_ASK_SWITCH: dict[str, tuple[str, ...]] = {
    "NfpRemoval": ("copper", "inner", "nfp_removal"),  # 内层删独立 PAD
    "MaskDams": ("mask", "via_opening_delete"),  # 删塞孔/盖油过孔的开窗
}


def _ask_mode(profile: dict, op: str) -> bool:
    path = _ASK_SWITCH.get(op)
    if not path:
        return False
    node = profile
    for k in path:
        node = (node or {}).get(k) if isinstance(node, dict) else None
    return str(node).lower() == "ask"
