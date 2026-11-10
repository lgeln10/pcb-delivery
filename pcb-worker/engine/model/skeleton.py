"""Mandatory-op skeleton: the steps the book requires on *every* job, findings or not.

``build_plan`` only collects ``Fix.op`` drafts, so a clean board used to produce a Genesis script
that skipped Contourize (p123/137), Teardrops (p125), SliverFill (p127), MaskOptimize (p142),
PatternFill/AddTooling (p153/155) … — the flow the book teaches is a fixed sequence per layer
type, with findings merely attaching parameters to it. This module is that sequence.

Every rule names the report stage it belongs to, which layers it applies to (``target``), the
profile-derived parameters and a COM draft copied from ``docs/genesis_op_mapping.md`` (the
contract; ``tests/test_skeleton.py`` checks every command name here appears there). A rule is
skipped when the reports already produced the same (op, layer) — the finding wins — and a call
whose key is already in ``applied_keys`` (native engine / Genesis result) is emitted as applied.

Placeholders the engine cannot fill stay ``<name>`` and the translator keeps that line out of
execution (the factory fills it in); never widen the whitelist for them.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from engine.adapters.base import OPS, CamOp

MIL = 0.0254
INCH = 25.4

Target = str  # stage | drill | inner_neg | inner_pos | outer | copper | mask | silk


def _mil(v: Any, nd: int = 1) -> str:
    return f"{float(v) / MIL:.{nd}f}".rstrip("0").rstrip(".")


def _inch(v_mm: Any, nd: int = 4) -> str:
    """Coordinates for the script (its head sets ``COM units,type=inch``)."""
    return f"{float(v_mm) / INCH:.{nd}f}".rstrip("0").rstrip(".") or "0"


def _panel(data: dict[str, Any] | None) -> dict[str, Any]:
    """Panel facts the drafts fill from (``registry._plan_data``): ``candidate`` (the native
    engine's ``steps/panel/panel.json`` or the panel stage's chosen candidate) and ``tooling``."""
    return (data or {}).get("panel") or {}


@dataclass(frozen=True)
class Rule:
    stage: str
    op: CamOp
    target: Target
    kind: str
    params: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
    script: Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], str]
    note: str  # why the book requires it (page)
    enabled: Callable[[dict[str, Any]], bool] | None = None  # factory-standard steps the profile switches on/off


def _cu(cfg: dict[str, Any], e: dict[str, Any]) -> dict[str, Any]:
    side = "inner" if e.get("type") == "inner_copper" else "outer"
    return cfg.get("copper", {}).get(side, {})


def _mask_of(lm: dict[str, Any], e: dict[str, Any]) -> str:
    """The mask layer on the same side as copper/silk entry ``e`` (Genesis reference layer)."""
    side = "bottom" if str(e.get("type", "")).startswith("bottom") else "top"
    for f in lm.get("files", []):
        if f.get("type") == f"{side}_mask":
            return str(f["file"])
    return f"<{side}_mask>"


def _drill_of(lm: dict[str, Any]) -> str:
    for f in lm.get("files", []):
        if str(f.get("type", "")).startswith("drill"):
            return str(f["file"])
    return "<drill>"


# ---- A0 job bootstrap (第2/4/5章 p53–66, p110–115): what Genesis needs before any edit op ------
_GENESIS_TYPE = {
    "top_copper": "signal", "inner_copper": "signal", "bottom_copper": "signal", "top_mask": "solder_mask", "bottom_mask": "solder_mask",
    "top_silk": "silk_screen", "bottom_silk": "silk_screen", "top_paste": "solder_paste", "bottom_paste": "solder_paste", "outline": "rout",
    "drill_pth": "drill", "drill_npth": "drill", "drill_unknown": "drill", "drill_blind": "drill", "drawing": "document",
}  # fmt: skip


def _import_files(cfg, e, lm):
    files = [f["file"] for f in lm.get("files", []) if f.get("type") in _GENESIS_TYPE]
    return (
        "# 从 <in_dir>（投递目录里的 <job>.in/，内容是 edit 副本）导入到 orig step，自动识别格式 (p53–66)\n"
        "COM create_entity,job=<job>,name=orig,type=step  【待验证】\n"
        "COM input_create,path=<in_dir>,job=<job>,step=orig  【待验证】\n"
        "COM input_identify  【待验证】\n"
        + "".join(f"# file: {f}\n" for f in files)
        + "COM input_translate  【待验证】"
    )


def _set_layer_types(cfg, e, lm):
    t = str(e.get("type", ""))
    pol = e.get("polarity") or "positive"
    return (
        f"COM matrix_layer_context,job=<job>,matrix=matrix,layer={e['file']},context=board  【待验证】\n"
        f"COM matrix_layer_type,job=<job>,matrix=matrix,layer={e['file']},type={_GENESIS_TYPE.get(t, 'document')}  【待验证】\n"
        f"COM matrix_layer_polar,job=<job>,matrix=matrix,layer={e['file']},polarity={pol}  【待验证】"
    )


def _copy_step(cfg, e, lm):
    return (
        "# p111: orig → net（削到 Profile，做网络比较用）、orig → edit（改图副本）\n"
        "COM copy_entity,type=step,source_job=<job>,source_name=orig,dest_job=<job>,dest_name=net,dest_database=  【待验证】\n"
        "COM copy_entity,type=step,source_job=<job>,source_name=orig,dest_job=<job>,dest_name=edit,dest_database=  【待验证】\n"
        "COM open_entity,job=<job>,type=step,name=net  【待验证】\n"
        "COM clip_area_strt  【待验证】\n"
        "COM clip_area_end,layers_mode=all,layer=,area=profile,area_type=rectangle,inout=outside,contour_cut=yes,margin=0  【待验证】\n"
        "COM open_entity,job=<job>,type=step,name=edit  【待验证】"
    )


def _drill_rows(data, rel):
    return [r for r in ((data or {}).get("drill_table") or {}).get("tools", []) if r.get("file") == rel]


def _set_drill_attrs(cfg, e, lm, data=None):
    rows = [r for r in _drill_rows(data, e["file"]) if r.get("attribute") in ("via", "via_plug", "non_plated")]
    if not rows:
        return f"# {e['file']}: 钻孔表里没有 via / non_plated 刀（全部按 plated 默认，p114）"
    out = [f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】"]
    for r in rows:
        out += [
            "COM filter_reset,filter_name=popup  【待验证】",
            f"COM filter_set,filter_name=popup,update_popup=no,feat_types=pad,symbol=r{_mil(r['dia_mm'])}  【待验证】",
            f"COM filter_area_strt  # 刀 {r['tool']} ⌀{r['dia_mm']} → {r['attribute']} (p114)",
            f"COM filter_area_end,layer={e['file']},filter_name=popup,operation=select  【待验证】",
            f"COM cur_atr_set,attribute=.drill,option={r['attribute']}  【待验证】",
            "COM sel_change_atr,mode=add  【待验证】",
            "COM cur_atr_reset  【待验证】",
        ]
    out.append("COM affected_layer,mode=all,affected=no  【待验证】")
    return "\n".join(out)


def _resize_drills(cfg, e, lm, data=None):
    rows = _drill_rows(data, e["file"])
    if not rows:
        return f"# {e['file']}: 没有钻孔表（drill stage 未跑或该文件无刀），预大表待填  【待验证】\nCOM tools_tab_add,num=1,type=hole,min_tol=0,max_tol=0,bit=,finish_size=<finish_mil>,drill_size=<drill_mil>,shape=hole  【待验证】"
    out = [f"COM open_entity,job=<job>,type=layer,name={e['file']}  【待验证】", "COM tools_tab_reset  【待验证】"]
    for i, r in enumerate(rows, 1):
        dd = r.get("drill_dia_mm") or r["dia_mm"]
        out.append(f"COM tools_tab_add,num={i},type={'slot' if r.get('slot') else 'hole'},min_tol=0,max_tol=0,bit=,finish_size={_mil(r['dia_mm'])},drill_size={_mil(dd)},shape=hole  # {r['tool']} {r.get('attribute')} +{r.get('oversize_mm', 0)} (p114)")
    out.append(f"COM tools_set,layer={e['file']},thickness=0,user_params=,slots=by_length  【待验证】")
    return "\n".join(out)


# ---- COM drafts (docs/genesis_op_mapping.md §9–§37, comments stripped) --------------------
def _drill_checks(cfg, e, lm):
    d = cfg.get("drill", {})
    return (
        "COM chklist_create,chklist=drill_checks  【待验证】\n"
        f"COM chklist_single,action=drill_checks,chklist=drill_checks,params=(layer={e['file']})(hole_size=yes)(extra_holes=yes)(hole_separation=yes)(pg_shorts=yes)(missing_holes=yes)(npth_to_rout={_mil(d.get('npth_to_rout_min_mm', 0.3))})  【待验证】\n"
        "COM chklist_run,chklist=drill_checks,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=drill_checks,nact=1  【待验证】"
    )


def _nfp(cfg, e, lm):
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=nfp  【待验证】\n"
        "COM chklist_single,action=nfp_removal,chklist=nfp,params=(erf=isolated_pads)(layers=.affected)(delete_isolated=yes)(delete_covered=no)(work_on=features)  【待验证】\n"
        "COM chklist_run,chklist=nfp,nact=1,area=profile  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _contourize(cfg, e, lm):
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM sel_select_drawn,type=mixed,analyze_thermal=yes  【待验证】\n"
        "COM sel_contourize,accuracy=6.35,break_to_islands=yes,clean_hole_size=76.2,clean_hole_mode=x_or_y  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _line_comp(cfg, e, lm):
    c = _cu(cfg, e)
    comp = _mil(c.get("line_compensation_mm", 0.0254))
    below = _mil(c.get("compensation_threshold_mm", 0.381))
    out = [
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】",
        "COM filter_reset,filter_name=popup  【待验证】",
        f"COM filter_set,filter_name=popup,update_popup=no,feat_types=line,slct_syms=r0-r{below}  【待验证：按线宽选 <{below}mil】",
        "COM filter_area_strt  【待验证】",
        f"COM filter_area_end,layer={e['file']},filter_name=popup,operation=select  【待验证】",
        f"COM sel_resize,size={comp},corner_ctl=no  【待验证】",
    ]
    if e.get("type") in ("top_copper", "bottom_copper"):
        out += [
            "# p138 步骤5: SMD PAD 同样加大",
            "COM filter_reset,filter_name=popup  【待验证】",
            "COM filter_set,filter_name=popup,update_popup=no,feat_types=pad  【待验证】",
            "COM filter_atr_set,filter_name=popup,condition=yes,attribute=.smd  【待验证】",
            "COM filter_area_strt  【待验证】",
            f"COM filter_area_end,layer={e['file']},filter_name=popup,operation=select  【待验证】",
            f"COM sel_resize,size={comp},corner_ctl=no  【待验证】",
        ]
    out.append("COM affected_layer,mode=all,affected=no  【待验证】")
    return "\n".join(out)


def _cutout(cfg, e, lm):
    c = _cu(cfg, e)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM sel_select_drawn,type=mixed,analyze_thermal=yes  【待验证】\n"
        "COM sel_move_other,target_layer=cusurface,invert=no,dx=0,dy=0  【待验证】\n"
        "COM sel_ref_feat,layers=cusurface,use=filter,mode=disjoint,pads_as=shape  【待验证】\n"
        f"COM sel_copy_other,dest=layer_name,target_layer=cutout_tmp,invert=no,size={_mil(2 * c.get('min_spacing_mm', 0.1))}  【待验证】\n"
        "COM sel_copy_other,dest=layer_name,target_layer=cusurface,invert=yes  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _slo(cfg, e, lm):
    c = _cu(cfg, e)
    ar = _mil(c.get("min_annular_ring_mm", 0.2))
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=slo  【待验证】\n"
        f"COM chklist_single,action=signal_layer_opt,chklist=slo,params=(erf=inner_layers)(layers=.affected)(pth_ar_min={ar})(pth_ar_opt={ar})(via_ar_min={ar})(via_ar_opt={ar})(spacing_min=0.1)(drill_to_cu={_mil(c.get('drill_isolation_mm', 0.254))})  【待验证】\n"
        "COM chklist_run,chklist=slo,nact=1,area=profile  【待验证】\n"
        f"COM chklist_cupd,chklist=slo,nact=1,params=(spacing_min={_mil(c.get('min_spacing_mm', 0.1))})  【待验证】\n"
        "COM chklist_run,chklist=slo,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=slo,nact=1  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _teardrops(cfg, e, lm):
    c = _cu(cfg, e)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=teardrop  【待验证】\n"
        f"COM chklist_single,action=adv_teardrops,chklist=teardrop,params=(erf=long_teardrop)(layers=.affected)(type=straight)(ar_min={_mil(c.get('min_annular_ring_mm', 0.2))})(drill_spacing={_mil(c.get('drill_isolation_mm', 0.254))})(cu_spacing={_mil(c.get('min_spacing_mm', 0.1))})  【待验证】\n"
        "COM chklist_run,chklist=teardrop,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=teardrop,nact=1  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _sliver(cfg, e, lm):
    c = _cu(cfg, e)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=sliver  【待验证】\n"
        f"COM chklist_single,action=sliver_fill,chklist=sliver,params=(layers=.affected)(max_sliver={_mil(c.get('min_spacing_mm', 0.1))})(angle=30)(overlap=1)(max_pg_space={_mil(c.get('min_spacing_mm', 0.1))})(fix_cu=yes)  【待验证】\n"
        "COM chklist_run,chklist=sliver,nact=1,area=profile  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _border(cfg, e, lm):
    c = _cu(cfg, e)
    outline = next((f["file"] for f in lm.get("files", []) if f.get("type") == "outline"), "<outline>")
    return (
        f"COM open_entity,job=<job>,type=layer,name={outline}  【待验证】\n"
        "COM sel_all_feat  【待验证】\n"
        "COM sel_copy_other,dest=layer_name,target_layer=border_tmp,invert=no,dx=0,dy=0,size=0  【待验证】\n"
        "COM open_entity,job=<job>,type=layer,name=border_tmp  【待验证】\n"
        "COM sel_all_feat  【待验证】\n"
        f"COM sel_change_sym,symbol=r{_mil(2 * c.get('edge_clearance_mm', 0.381))}  【待验证】\n"
        "# 检查点：与要削的层比较，看是否削掉有用物件 (p121, p128)\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM sel_copy_other,dest=affected,target_layer=,invert=yes,dx=0,dy=0,size=0  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】\n"
        "COM delete_entity,job=<job>,type=layer,name=border_tmp  【待验证】"
    )


def _slc(cfg, e, lm):
    c = _cu(cfg, e)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=slc  【待验证】\n"
        f"COM chklist_single,action=signal_layer_checks,chklist=slc,params=(erf=std_6)(layers=.affected)(spacing={_mil(c.get('min_spacing_mm', 0.1))})(rout_to_cu={_mil(c.get('edge_clearance_mm', 0.254))})(drill_to_cu={_mil(c.get('hole_clearance_mm', 0.2032))})(sliver={_mil(c.get('min_spacing_mm', 0.1))})(pth_ar={_mil(c.get('min_annular_ring_mm', 0.1))})  【待验证】\n"
        "COM chklist_run,chklist=slc,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=slc,nact=1  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _construct_pads(cfg, e, lm):
    mask = _mask_of(lm, e)
    m = cfg.get("mask", {})
    lo, hi = _mil(m.get("construct_pads_min_mm", 0.254)), _mil(m.get("construct_pads_max_mm", 6.35))
    return (
        f"COM affected_layer,name={mask},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=cpads  【待验证】\n"
        "COM chklist_single,action=construct_pads_by_ref,chklist=cpads,params=(erf=affected_layer)(tolerance=1)  【待验证】\n"
        "COM chklist_run,chklist=cpads,nact=1,area=profile  【待验证】\n"
        f"COM chklist_single,action=construct_pads_auto,chklist=cpads,params=(erf=outers)(layer={e['file']})(reference_sm={mask})(tolerance=1)(minimum={lo})(maximum={hi})  【待验证】\n"
        "COM chklist_run,chklist=cpads,nact=2,area=profile  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _smd(cfg, e, lm):
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=smd  【待验证】\n"
        "COM chklist_single,action=set_smd_attr,chklist=smd,params=(erf=non_drilled)(layer=.affected)  【待验证】\n"
        "COM chklist_run,chklist=smd,nact=1,area=profile  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _smo(cfg, e, lm):
    m = cfg.get("mask", {})
    cov = _mil(m.get("coverage_mm", 2 * MIL))
    bridge = _mil((m.get("bridge_min_mm") or {}).get("green", 0.1) if isinstance(m.get("bridge_min_mm"), dict) else 0.1)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=smo  【待验证】\n"
        f"COM chklist_single,action=solder_mask_opt,chklist=smo,params=(layers=.affected)(clearance_min={cov})(clearance_opt={cov})(coverage={cov})(bridge={bridge})  【待验证】\n"
        "COM chklist_run,chklist=smo,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=smo,nact=1  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _smc(cfg, e, lm):
    m = cfg.get("mask", {})
    cov = _mil(m.get("coverage_mm", 2 * MIL))
    bridge = _mil((m.get("bridge_min_mm") or {}).get("green", 0.1) if isinstance(m.get("bridge_min_mm"), dict) else 0.1)
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=smc  【待验证】\n"
        f"COM chklist_single,action=solder_mask_checks,chklist=smc,params=(layers=.affected)(clearance={cov})(coverage={cov})(bridge={bridge})(spacing={cov})  【待验证】\n"
        "COM chklist_run,chklist=smc,nact=1,area=profile  【待验证】\n"
        "COM chklist_show,chklist=smc,nact=1  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _silk_checks(cfg, e, lm):
    s = cfg.get("silk", {})
    return (
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM chklist_create,chklist=silk  【待验证】\n"
        f"COM chklist_single,action=silk_screen_checks,chklist=silk,params=(layers=.affected)(min_line={_mil(s.get('min_line_width_mm', 0.127))})(min_height={_mil(s.get('min_height_mm', 0.762))})(silk_to_sm={_mil(s.get('clearance_to_opening_mm', 0.0762))})(sm_layer={_mask_of(lm, e)})  【待验证】\n"
        "COM chklist_run,chklist=silk,nact=1,area=profile  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _silk_clear(cfg, e, lm):
    mask = _mask_of(lm, e)
    grow = _mil(2 * cfg.get("silk", {}).get("clearance_to_opening_mm", 0.0762))
    return (
        f"COM copy_entity,type=layer,source_job=<job>,source_name={mask},dest_job=<job>,dest_name=sm_tmp,dest_database=  【待验证】\n"
        "COM open_entity,job=<job>,type=layer,name=sm_tmp  【待验证】\n"
        "COM filter_reset,filter_name=popup  【待验证】\n"
        "COM filter_set,filter_name=popup,update_popup=no,polarity=negative  【待验证】\n"
        "COM sel_delete  【待验证】\n"
        "COM sel_all_feat  【待验证】\n"
        f"COM sel_resize,size={grow},corner_ctl=no  【待验证】\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM sel_copy_other,dest=affected,target_layer=,invert=yes,dx=0,dy=0,size=0  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】\n"
        "COM delete_entity,job=<job>,type=layer,name=sm_tmp  【待验证】"
    )


def _net_extract(cfg, e, lm):
    return (
        "COM netlist_analyze,job=<job>,step=net,type=cur,recreate_cur=yes,use_cad_names=no  【待验证】\n"
        "COM netlist_analyze,job=<job>,step=edit,type=cur,recreate_cur=yes,use_cad_names=no  【待验证】"
    )


def _step_repeat(cfg, e, lm, data=None):
    gap = cfg.get("panel", {}).get("gap_mm", 2.0)
    c = _panel(data).get("candidate")
    head = (
        "COM create_entity,job=<job>,name=panel,type=step  【待验证】\n"
        "COM open_entity,job=<job>,type=step,name=panel  【待验证】\n"
        "COM sr_tab_reset  【待验证】\n"
    )
    if not c:  # panel stage not run yet: the factory fills the table
        return head + (
            f"COM sr_tab_add,line=1,step=edit,x=0,y=0,nx=<nx>,ny=<ny>,dx=<dx>,dy=<dy>,angle=0,mirror=no,flip=no  # 间距 {gap} mm 【待验证】\n"
            "COM profile_rect,x1=<x1>,y1=<y1>,x2=<x2>,y2=<y2>  【待验证】\n"
            "COM set_step_datum,x=0,y=0  【待验证】"
        )
    # same placement math as engine.panel.plan.unit_placements: block centred inside the rails
    off_x = (c["panel_w"] - c["used_w"]) / 2 + c["rail"]
    off_y = (c["panel_h"] - c["used_h"]) / 2 + c["rail"]
    src = "set" if _panel(data).get("from_set") else "edit"
    return head + (
        f"# p152 工作板 {c['panel_w']}×{c['panel_h']} mm，{c['nx']}×{c['ny']}={c['count']} 只，转 {c['rotation']}°，利用率 {round(c['utilization'] * 100, 1)}%（坐标 inch）\n"
        f"COM sr_tab_add,line=1,step={src},x={_inch(off_x)},y={_inch(off_y)},nx={c['nx']},ny={c['ny']},dx={_inch(c['unit_w'] + c['gap'])},dy={_inch(c['unit_h'] + c['gap'])},angle={int(c['rotation'])},mirror=no,flip=no  # 间距 {c['gap']} mm 【待验证】\n"
        f"COM profile_rect,x1=0,y1=0,x2={_inch(c['panel_w'])},y2={_inch(c['panel_h'])}  【待验证】\n"
        "COM set_step_datum,x=0,y=0  【待验证】"
    )


def _pattern_fill(cfg, e, lm, data=None):
    p = cfg.get("panel", {})
    fill = p.get("fill") or {}
    c = _panel(data).get("candidate") or {}
    um = _inch(fill.get("unit_margin_mm", 3.0))  # 离单只外形 (p153)
    pm = _inch(fill.get("panel_margin_mm", 3.0))  # 离工作板边
    # max distance = the whole panel: fill everything between the margins (inch; 100" when unknown)
    far_x, far_y = (_inch(c["panel_w"]), _inch(c["panel_h"])) if c else ("100", "100")
    return (
        "COM open_entity,job=<job>,type=step,name=panel  【待验证】\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        f"COM sr_fill,polarity=positive,step_margin_x={um},step_margin_y={um},step_max_dist_x={far_x},step_max_dist_y={far_y},sr_margin_x={pm},sr_margin_y={pm},sr_max_dist_x={far_x},sr_max_dist_y={far_y},nest_sr=yes,consider_feat=yes,feat_margin={um},dest=affected,attributes=no  # 阻流点 ⌀{fill.get('dot_mm', 1.5)} 间距 {fill.get('pitch_mm', 3.0)} mm 【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _tooling(cfg, e, lm, data=None):
    pd = _panel(data)
    tcfg = cfg.get("panel", {}).get("tooling") or {}
    holes: list[tuple[float, float, float]] = []
    layer = _drill_of(lm)
    for t in pd.get("tooling") or []:  # the native engine already put them in (AddTooling, B2.8)
        layer = t.get("file") or layer
        holes += [(x, y, float(t["dia_mm"])) for x, y in t.get("points", [])]
    c = pd.get("candidate")
    if not holes and c:  # four corners inside the rail, same rule as ops_panel.add_tooling
        dia, inset = float(tcfg.get("dia_mm", 3.175)), float(tcfg.get("inset_mm", c["rail"] / 2))
        holes = [(inset, inset, dia), (c["panel_w"] - inset, inset, dia), (c["panel_w"] - inset, c["panel_h"] - inset, dia), (inset, c["panel_h"] - inset, dia)]
    pads = [f"COM add_pad,attributes=no,x={_inch(x)},y={_inch(y)},symbol=r{_mil(d)},polarity=positive,angle=0,mirror=no  【待验证】" for x, y, d in holes] or [
        "COM add_pad,attributes=no,x=<x>,y=<y>,symbol=r<dia_mil>,polarity=positive,angle=0,mirror=no  【待验证】"
    ]
    return "\n".join([
        "COM open_entity,job=<job>,type=step,name=panel  【待验证】",
        f"COM affected_layer,name={layer},mode=single,affected=yes  【待验证】",
        "COM cur_atr_set,attribute=.drill,option=non_plated  【待验证】",
        *pads,
        "COM cur_atr_reset  【待验证】",
        "COM affected_layer,mode=all,affected=no  【待验证】",
        "# 完整板边（定位孔/挂孔/AOI 孔/板边标记 p155）：进场后索取工厂现有脚本（映射文档附 A ①）",
    ])


def _rout(cfg, e, lm, data=None):
    outline = next((f["file"] for f in lm.get("files", []) if f.get("type") == "outline"), "<outline>")
    r = cfg.get("rout", {})
    ri = (data or {}).get("rout") or {}
    # 起刀点只给提示,不填值:我们算的是外形折线的第几段(shapely，弧已打散),不是 Genesis 里的
    # feature 序号,填进去会指到别的地方。<first> 未填 → 翻译器把这行注释掉,由工程师指定。
    hint = f"# 起刀点选最长直边：外形第 {ri['first']}/{ri.get('edges', '?')} 段（p173，按我们折线的编号，非 Genesis feature 号）\n" if ri.get("first") else ""
    return (
        hint
        + (
        f"COM open_entity,job=<job>,type=layer,name={outline}  【待验证】\n"
        "COM sel_all_feat  【待验证】\n"
        "COM sel_copy_other,dest=layer_name,target_layer=rout,invert=no  【待验证】\n"
        "COM matrix_layer_type,job=<job>,matrix=matrix,layer=rout,type=rout  【待验证】\n"
        "COM matrix_layer_context,job=<job>,matrix=matrix,layer=rout,context=board  【待验证】\n"
        f"COM sel_design2rout,max_gap={_mil(r.get('design2rout_max_gap_mm', 0.05))},max_join={_mil(r.get('design2rout_max_join_mm', 0.05))},smooth_tol={_mil(r.get('design2rout_smooth_tol_mm', 0.0254))}  【待验证】\n"
        f"COM chain_add,layer=rout,chain=1,size={_mil(r.get('tool_mm', 2.0))},comp=right,first=<first>,flag=none  【待验证】")
    )


def _export_gerber(cfg, e, lm):
    return (
        "COM open_entity,job=<job>,type=step,name=panel  【待验证】\n"
        "COM output_layer_reset  【待验证】\n"
        f"COM output_layer_set,layer={e['file']},angle=0,mirror=no,x_scale=1,y_scale=1,comp=0,polarity=positive,setupfile=,setupfiletmp=,line_units=inch,gscl_file=  【待验证】\n"
        "COM output,job=<job>,step=panel,format=Gerber274x,dir_path=<out_dir>,prefix=,suffix=.gbr,break_sr=yes,break_symbols=no,break_arc=yes,scale_mode=all,surface_mode=contour,min_brush=25.4,units=inch,coordinates=absolute,zeroes=none,nf1=2,nf2=4  【待验证】"
    )


def _export_excellon(cfg, e, lm):
    return (
        "COM open_entity,job=<job>,type=step,name=panel  【待验证】\n"
        "COM output_layer_reset  【待验证】\n"
        f"COM output_layer_set,layer={e['file']},angle=0,mirror=no,x_scale=1,y_scale=1,comp=0,polarity=positive,setupfile=,setupfiletmp=,line_units=mm,gscl_file=  【待验证】\n"
        "COM output,job=<job>,step=panel,format=Excellon2,dir_path=<out_dir>,prefix=,suffix=.drl,break_sr=yes,break_symbols=yes,break_arc=yes,scale_mode=all,units=mm,coordinates=absolute,zeroes=none,nf1=3,nf2=3  【待验证】"
    )


def _p_none(cfg, e):
    return {}


def _rail_on(cfg: dict[str, Any]) -> bool:
    return bool(cfg.get("copper", {}).get("rail_fill", {}).get("enabled"))


def _p_rail(cfg, e):
    r = cfg.get("copper", {}).get("rail_fill", {})
    inner = e.get("type") == "inner_copper"
    return {"inset_mm": r.get("inner_inset_mm" if inner else "inset_mm"), "vcut_gap_mm": r.get("vcut_gap_mm")}


def _rail_fill(cfg, e, lm):
    r = cfg.get("copper", {}).get("rail_fill", {})
    inset = _mil(r.get("inner_inset_mm" if e.get("type") == "inner_copper" else "inset_mm", 0.6))
    return (
        f"# 工艺边铺铜（工厂标准）：在并入 Profile 的工艺边上铺实铜，离板边 {inset}mil、离 V-cut {_mil(r.get('vcut_gap_mm', 0.75))}mil，孔周留 {_mil(r.get('hole_clearance_mm', 0.5))}mil\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        f"COM sr_fill,polarity=positive,step_margin_x={inset},step_margin_y={inset},step_max_dist_x=100000,step_max_dist_y=100000,sr_margin_x=0,sr_margin_y=0,sr_max_dist_x=100000,sr_max_dist_y=100000,nest_sr=no,consider_feat=yes,feat_margin={_mil(r.get('copper_clearance_mm', 0.9))},consider_drill=yes,drill_margin={_mil(r.get('hole_clearance_mm', 0.5))},consider_rout=no,dest=affected_layers,attributes=no  【待验证：只填工艺边——进场用 Record 录 GUI 的「填充工艺边」做法】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _coupon_on(cfg: dict[str, Any]) -> bool:
    return bool(cfg.get("copper", {}).get("vcut_coupon", {}).get("enabled"))


def _p_coupon(cfg, e):
    c = cfg.get("copper", {}).get("vcut_coupon", {})
    return {"pad_mm": c.get("pad_mm", 1.05), "pitch_mm": c.get("pitch_mm", 1.779), "from_line_mm": c.get("from_line_mm", 1.415), "opening_mm": c.get("opening_mm", 1.30)}


def _coupon(cfg, e, lm):
    c = cfg.get("copper", {}).get("vcut_coupon", {})
    return (
        f"# 防 V-cut 测试点（工厂标准）：每条挨着工艺边的 V-cut 线上，两个 r{_mil(c.get('pad_mm', 1.05))} 盘相距 {_mil(c.get('pitch_mm', 1.779))}mil、离线 {_mil(c.get('from_line_mm', 1.415))}mil，"
        f"r{_mil(c.get('trace_mm', 0.35))} 线顶到 V-cut 线上；同面阻焊开 r{_mil(c.get('opening_mm', 1.30))} 窗\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "# 在 Genesis 里是 Add → Pad / Add → Line 手加，位置按 profile copper.vcut_coupon.at  【待验证】\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=no  【待验证】"
    )


def _vcut_on(cfg: dict[str, Any]) -> bool:
    return float(cfg.get("copper", {}).get("vcut_clearance_mm", 0) or 0) > 0


def _p_vcut(cfg, e):
    return {"clearance_mm": cfg.get("copper", {}).get("vcut_clearance_mm")}


def _vcut(cfg, e, lm):
    c = cfg.get("copper", {}).get("vcut_clearance_mm", 0.4)
    return (
        f"# V-cut 线两侧退铜（工厂标准）：{e['file']} 上离 V-cut/工艺边分界线 {c} mm 内的铜皮削掉（铺铜、线；PAD 不动）\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM sel_ref_feat,layers=<vcut>,use=filter,mode=touch,f_types=surface\\;line,pads_as=shape,polarity=positive\\;negative,include_syms=,exclude_syms=  【待验证：V-cut 线所在层先建】\n"
        f"COM sel_clip_area_strt  【待验证】\n"
        f"COM sel_clip_area_end,layers_mode=affected_layers,layer=,area=manual,mode=inside,size={c * 2 * 39.37:.1f},inside_mode=,use_mask=no  【待验证：用 V-cut 线两侧 {c} mm 的区域裁】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _term_on(cfg: dict[str, Any]) -> bool:
    return bool(cfg.get("copper", {}).get("terminal_pad", {}).get("enabled"))


def _p_term(cfg, e):
    t = cfg.get("copper", {}).get("terminal_pad", {})
    return {"min_hole_width_mm": t.get("min_hole_width_mm"), "grow_mm": t.get("grow_mm")}


def _term_pad(cfg, e, lm):
    t = cfg.get("copper", {}).get("terminal_pad", {})
    return (
        f"# 大端子焊盘（工厂标准）：≥{t.get('min_hole_width_mm', 4.0)} mm 宽的锣槽/方孔端子，焊盘总加大 {_mil(t.get('grow_mm', 3.0))}mil；订单指定 outer_pad_mm 的孔外层焊盘 Change Symbol\n"
        f"COM affected_layer,name={e['file']},mode=single,affected=yes  【待验证】\n"
        "COM filter_reset,filter_name=popup  【待验证】\n"
        "COM filter_set,filter_name=popup,update_popup=no,feat_types=pad  【待验证：先按孔位选出端子焊盘（Reference Selection: 与 ≥4 mm 槽/方孔相触的 PAD）】\n"
        f"COM sel_resize,size={_mil(t.get('grow_mm', 3.0))},corner_ctl=no  【待验证】\n"
        "COM affected_layer,mode=all,affected=no  【待验证】"
    )


def _p_cu(cfg, e):
    c = _cu(cfg, e)
    return {"min_spacing_mm": c.get("min_spacing_mm"), "min_annular_ring_mm": c.get("min_annular_ring_mm")}


def _p_border(cfg, e):
    return {"edge_clearance_mm": _cu(cfg, e).get("edge_clearance_mm")}


def _p_mask(cfg, e):
    return {"coverage_mm": cfg.get("mask", {}).get("coverage_mm")}


def _p_silk(cfg, e):
    s = cfg.get("silk", {})
    return {"min_line_width_mm": s.get("min_line_width_mm"), "min_height_mm": s.get("min_height_mm"), "clearance_to_opening_mm": s.get("clearance_to_opening_mm")}


def _p_step(cfg, e):
    return {"step": "panel"}


#: The skeleton, in book order (CANON_ORDER sorts inside a stage anyway).
RULES: tuple[Rule, ...] = (
    # A0 引导：Genesis 的 job 不继承本地 lite/native 的改动，脚本必须自己导入 edit 副本并建好 step / 属性
    Rule("intake", CamOp.IMPORT_FILES, "stage", "mandatory_import", _p_none, _import_files, "p53–66 导入 edit 副本到 orig step"),
    Rule("intake", CamOp.SET_LAYER_TYPES, "all", "mandatory_layer_types", _p_none, _set_layer_types, "p110 Matrix 层类型/极性"),
    Rule("align", CamOp.COPY_STEP, "stage", "mandatory_copy_step", _p_none, _copy_step, "p111 net/edit 两个 step，net 削到 Profile"),
    Rule("drill", CamOp.SET_DRILL_ATTRS, "drill", "mandatory_drill_attrs", _p_none, _set_drill_attrs, "p114 via / non_plated 属性"),
    Rule("drill", CamOp.RESIZE_DRILLS, "drill", "mandatory_resize_drills", _p_none, _resize_drills, "p114–115 钻嘴预大表"),
    Rule("drill", CamOp.DRILL_CHECKS, "drill", "mandatory_drill_checks", _p_none, _drill_checks, "p116 Drill Checks 六项（Genesis 复核）"),
    # 第6章 内层
    Rule("inner", CamOp.NFP_REMOVAL, "inner_pos", "mandatory_nfp", _p_none, _nfp, "p123/p134 内层正片删独立 PAD", lambda cfg: str(cfg.get("copper", {}).get("inner", {}).get("nfp_removal", True)).lower() not in ("false", "off")),
    Rule("inner", CamOp.CONTOURIZE, "inner_pos", "mandatory_contourize", _p_none, _contourize, "p123 大铜皮转 Surface"),
    Rule("inner", CamOp.LINE_COMPENSATION, "inner_pos", "mandatory_compensation", _p_cu, _line_comp, "p124 <15mil 线 +1mil"),
    Rule("inner", CamOp.COPPER_CUTOUT, "inner_pos", "mandatory_cutout", _p_cu, _cutout, "p131–134 线路掏铜（铜皮与不相连物件/孔的间距）"),
    Rule("inner", CamOp.SIGNAL_LAYER_OPTIMIZE, "inner_pos", "mandatory_slo", _p_cu, _slo, "p124 SLO 两遍 0.1 → 4"),
    Rule("inner", CamOp.TEARDROPS, "inner_pos", "mandatory_teardrops", _p_cu, _teardrops, "p125 内层加泪滴"),
    Rule("inner", CamOp.SLIVER_FILL, "inner_pos", "mandatory_sliver", _p_cu, _sliver, "p127 同网络极小间隙填实"),
    Rule("inner", CamOp.RAIL_FILL, "inner_pos", "factory_rail_fill", _p_rail, _rail_fill, "工厂标准：工艺边铺铜（教材无此步；copper.rail_fill.enabled）", _rail_on),
    Rule("inner", CamOp.TERMINAL_PAD, "inner_pos", "factory_terminal_pad", _p_term, _term_pad, "工厂标准：大端子焊盘加大（教材无此步；copper.terminal_pad.enabled）", _term_on),
    Rule("inner", CamOp.VCUT_CLEARANCE, "inner_pos", "factory_vcut_clearance", _p_vcut, _vcut, "工厂标准：V-cut 线两侧退铜（教材无此步；copper.vcut_clearance_mm）", _vcut_on),
    Rule("inner", CamOp.BORDER_CLEARANCE, "inner_all", "mandatory_border", _p_border, _border, "p121/p128 内层削外围（负片/正片都要）"),
    Rule("inner", CamOp.SIGNAL_LAYER_CHECKS, "inner_all", "mandatory_slc", _p_cu, _slc, "p129 Signal Layer Checks（Genesis 复核）"),
    # 第7章 外层（p135–139）
    Rule("outer", CamOp.MASK_CONSTRUCT_PADS, "outer", "mandatory_construct_pads", _p_none, _construct_pads, "p135–136 转绿油 PAD / 转线路 PAD（每次一层）"),
    Rule("outer", CamOp.SET_SMD_ATTRIBUTE, "outer", "mandatory_smd", _p_none, _smd, "p136 设 SMD 属性"),
    Rule("outer", CamOp.CONTOURIZE, "outer", "mandatory_contourize", _p_none, _contourize, "p137 外层大铜皮转 Surface"),
    Rule("outer", CamOp.LINE_COMPENSATION, "outer", "mandatory_compensation", _p_cu, _line_comp, "p138 步骤5 加大线路和 SMD PAD（电金板不预大）"),
    Rule("outer", CamOp.COPPER_CUTOUT, "outer", "mandatory_cutout", _p_cu, _cutout, "p138 步骤6 掏铜皮（与内层一样）"),
    Rule("outer", CamOp.SIGNAL_LAYER_OPTIMIZE, "outer", "mandatory_slo", _p_cu, _slo, "p138 外层 SLO 两遍"),
    Rule("outer", CamOp.SLIVER_FILL, "outer", "mandatory_sliver", _p_cu, _sliver, "p138 外层填实（同 p127）"),
    Rule("outer", CamOp.RAIL_FILL, "outer", "factory_rail_fill", _p_rail, _rail_fill, "工厂标准：工艺边铺铜（教材无此步；copper.rail_fill.enabled）", _rail_on),
    # always planned on the outer layers: the order's outer_pad_mm holes (压接/压铆 5.5 → 6.0) are an order term,
    # not a factory option — turning terminal_pad off must not lose them (C09 2026-09-19: 15 pads went back to 5.5)
    Rule("outer", CamOp.TERMINAL_PAD, "outer", "factory_terminal_pad", _p_term, _term_pad, "工厂标准：大端子焊盘加大（copper.terminal_pad.enabled）/ 订单指定孔外层焊盘（总是做）", None),
    Rule("outer", CamOp.VCUT_COUPON, "outer", "factory_vcut_coupon", _p_coupon, _coupon, "工厂标准：防 V-cut 测试点（教材 p135「V-CUT是否需要加防V-CUT测试点」；copper.vcut_coupon.enabled）", _coupon_on),
    Rule("outer", CamOp.VCUT_CLEARANCE, "outer", "factory_vcut_clearance", _p_vcut, _vcut, "工厂标准：V-cut 线两侧退铜（教材无此步；copper.vcut_clearance_mm）", _vcut_on),
    Rule("outer", CamOp.SIGNAL_LAYER_CHECKS, "outer", "mandatory_slc", _p_cu, _slc, "p139 外层 Signal Layer Checks（Genesis 复核）"),
    # 第8章 阻焊（p141–144）
    Rule("mask", CamOp.MASK_OPTIMIZE, "mask", "mandatory_smo", _p_mask, _smo, "p142 阻焊优化（只做一次）"),
    Rule("mask", CamOp.MASK_CHECKS, "mask", "mandatory_smc", _p_mask, _smc, "p143 Solder Mask Checks（Genesis 复核）"),
    # 第9章 字符（p145–147）
    Rule("silk", CamOp.SILK_CHECKS, "silk", "mandatory_silk_checks", _p_silk, _silk_checks, "p145 Silk Screen Checks（Genesis 复核）"),
    Rule("silk", CamOp.SILK_CLEAR_BY_MASK, "silk", "mandatory_silk_clear", _p_silk, _silk_clear, "p146 步骤4 用阻焊开窗削字符"),
    # 第6章收尾（p130）
    Rule("net_compare", CamOp.NETLIST_EXTRACT, "stage", "mandatory_net_extract", _p_none, _net_extract, "p130 net/edit 两个 step 抽网表"),
    # 第10/13章 拼板与锣带（p148–155, p170–174）
    Rule("panel", CamOp.STEP_REPEAT, "stage", "mandatory_step_repeat", _p_none, _step_repeat, "p148 set 拼板"),
    Rule("panel", CamOp.PATTERN_FILL, "copper", "mandatory_pattern_fill", _p_none, _pattern_fill, "p153 工作板铺阻流块"),
    Rule("panel", CamOp.ADD_TOOLING, "stage", "mandatory_tooling", _p_none, _tooling, "p155 板边定位孔/挂孔/AOI 孔"),
    Rule("panel", CamOp.ROUT_DESIGN, "stage", "mandatory_rout", _p_none, _rout, "p170–174 锣带"),
    # 第11章 输出（p156–158）：生产版从 panel step 出
    Rule("output", CamOp.EXPORT_GERBER, "copper_mask_silk", "mandatory_export_gerber", _p_step, _export_gerber, "p156 生产版 Gerber 从 panel 输出"),
    Rule("output", CamOp.EXPORT_EXCELLON, "drill", "mandatory_export_excellon", _p_step, _export_excellon, "p158 钻带从 panel 输出"),
)

_TARGET_TYPES: dict[Target, tuple[str, ...]] = {
    "all": tuple(_GENESIS_TYPE),
    "drill": ("drill_pth", "drill_npth", "drill_unknown", "drill_blind"),
    "inner_pos": ("inner_copper",),
    "inner_all": ("inner_copper",),
    "outer": ("top_copper", "bottom_copper"),
    "copper": ("top_copper", "inner_copper", "bottom_copper"),
    "mask": ("top_mask", "bottom_mask"),
    "silk": ("top_silk", "bottom_silk"),
    "copper_mask_silk": ("top_copper", "inner_copper", "bottom_copper", "top_mask", "bottom_mask", "top_silk", "bottom_silk"),
}


def targets(rule: Rule, layer_map: dict[str, Any] | None) -> list[dict[str, Any] | None]:
    """Layer entries a rule applies to; ``[None]`` for stage-level rules; ``[]`` when the job has
    no such layer (or no layer map yet — per-layer rules wait for intake)."""
    if rule.target == "stage":
        return [None]
    if not layer_map:
        return []
    out = []
    for e in layer_map.get("files", []):
        if e.get("type") not in _TARGET_TYPES[rule.target]:
            continue
        pol = e.get("polarity") or "positive"
        if rule.target == "inner_pos" and pol == "negative":
            continue
        out.append(e)
    return out


def default_profile() -> dict[str, Any]:
    from engine.profiles import load_profile

    return load_profile(None)


def skeleton_calls(stages: list[str], layer_map: dict[str, Any] | None, cfg: dict[str, Any] | None, data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Every mandatory call for the stages that have run, as plain dicts (``build_plan`` turns them
    into ``OpCall``): op, stage, layer, params, script, kind, note, pages. ``data`` carries job
    facts a draft needs beyond the profile (today: the drill stage's ``drill_table``)."""
    import inspect

    cfg = cfg or default_profile()
    lm = layer_map or {}
    out: list[dict[str, Any]] = []
    for rule in RULES:
        if rule.stage not in stages:
            continue
        if rule.enabled is not None and not rule.enabled(cfg):
            continue
        for e in targets(rule, layer_map):
            entry = e or {"file": None}
            params = {k: v for k, v in rule.params(cfg, entry).items() if v is not None}
            script = rule.script(cfg, entry, lm, data) if "data" in inspect.signature(rule.script).parameters else rule.script(cfg, entry, lm)
            out.append({
                "op": rule.op.value, "stage": rule.stage, "layer": entry.get("file"), "params": params,
                "script": script, "kind": rule.kind, "note": rule.note, "pages": OPS[rule.op].pages,
            })  # fmt: skip
    return out
