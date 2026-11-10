"""The CAM op vocabulary and the engine interface.

Single source of truth for *which* CAM operations exist.  Three consumers must stay in sync
with this file, and ``tests/test_cam_ops.py`` checks the first two:

* ``docs/genesis_op_mapping.md`` — one ``## N. <op>`` section per op (menu path, params, COM draft)
* ``engine/pipeline/registry.py`` — every op belongs to exactly one stage (``STAGE_OPS``)
* aios ``modules/pcb-cam/MODULE.md`` — the "op 词汇表" paragraph points here; ``Fix.op`` values
  that the UI shows must be members of ``CamOp``

Adding an op = add the enum member, its ``OpSpec`` row, and a doc section.  Never rename: op
names appear in persisted ``StageReport.items[].fix.op`` and in generated scripts.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from engine.model.plan import ExecResult, OpPlan

LiteStatus = Literal["implemented", "report_only", "partial", "not_implemented"]


class CamOp(StrEnum):
    """Names are stable identifiers (see module docstring). Order = section order in the mapping doc."""

    # 第4章 文件初步整理
    IMPORT_FILES = "ImportFiles"
    SET_LAYER_TYPES = "SetLayerTypes"
    ALIGN_TO_DRILL = "AlignToDrill"
    SET_PROFILE = "SetProfile"
    DELETE_OUTSIDE_PROFILE = "DeleteOutsideProfile"
    COPY_STEP = "CopyStep"
    # 第5章 钻孔
    SET_DRILL_ATTRS = "SetDrillAttrs"
    RESIZE_DRILLS = "ResizeDrills"
    DRILL_CHECKS = "DrillChecks"
    # 第6/7章 内外层
    NFP_REMOVAL = "NfpRemoval"
    CONTOURIZE = "Contourize"
    LINE_COMPENSATION = "LineCompensation"
    SIGNAL_LAYER_OPTIMIZE = "SignalLayerOptimize"
    TEARDROPS = "Teardrops"
    NPTH_CLEARANCE = "NpthClearance"
    SLIVER_FILL = "SliverFill"
    BORDER_CLEARANCE = "BorderClearance"
    SIGNAL_LAYER_CHECKS = "SignalLayerChecks"
    # 第8章 阻焊
    MASK_CONSTRUCT_PADS = "MaskConstructPads"
    MASK_RESIZE = "MaskResize"
    MASK_OPTIMIZE = "MaskOptimize"
    MASK_CHECKS = "MaskChecks"
    # 第9章 字符
    SILK_CHECKS = "SilkChecks"
    SILK_CLEAR_BY_MASK = "SilkClearByMask"
    # 第10章 拼板
    STEP_REPEAT = "StepRepeat"
    PANEL_BUILD = "PanelBuild"
    PATTERN_FILL = "PatternFill"
    ADD_TOOLING = "AddTooling"
    # 第11章 输出 / 第6章 网表
    EXPORT_GERBER = "ExportGerber"
    EXPORT_EXCELLON = "ExportExcellon"
    NETLIST_EXTRACT = "NetlistExtract"
    NETLIST_COMPARE = "NetlistCompare"
    # --- 2026-09-05 补：映射文档写作时发现文档有、词汇表没有的 6 个操作 ---
    SET_SMD_ATTRIBUTE = "SetSmdAttribute"  # 第7章 p137
    NEGATIVE_PAD_RESHAPE = "NegativePadReshape"  # 第6章 p119–120 散热 PAD / 隔离 PAD 整形
    COPPER_CUTOUT = "CopperCutout"  # 第6章 p131–134 线路掏铜（Select Drawn → surface → 削）
    MASK_DAMS = "MaskDams"  # 第8章 p144 NPTH / ≥0.6mm 过孔盖油加挡点
    ROUT_DESIGN = "RoutDesign"  # 第13章 p170–174 锣带 Design To Rout / Chains
    SILK_TRANSFORM = "SilkTransform"  # 第9章 p146 Edit → Transform 缩放字高
    # --- 2026-09-07 二次审计补：教材有步骤、词汇表没有的 2 个操作 ---
    ADD_HOLES_FROM_DRAWING = "AddHolesFromDrawing"  # 第5章 p113 分孔图/外形层上有、钻孔层没有的孔和槽复制到钻孔层
    ADD_TEXT = "AddText"  # 第9章 p146 步骤5 / p147 注意2 客户要求添加的字符（UL/周期/料号）
    # --- 2026-09-09 第一块真板（六层 3oz）对标补：工厂标准里有、教材没有的操作 ---
    RAIL_FILL = "RailFill"  # 工艺边铺铜：每个线路层在并入 Profile 的工艺边上铺实铜（离板边/V-cut/孔/客户铜留空）
    VCUT_CLEARANCE = "VcutClearance"  # V-cut 线两侧退铜：每个线路层上离 V-cut/工艺边分界线不足 clearance 的铜（铺铜/线）削掉——第二/三块真板（四层 1oz 拼板）看图反推，教材无此步
    TERMINAL_PAD = "TerminalPad"
    VCUT_COUPON = "VcutCoupon"


@dataclass(frozen=True)
class OpSpec:
    op: CamOp
    stage: str  # one of engine.pipeline.registry.STAGE_NAMES
    chapter: str  # 培训文档章节
    pages: tuple[int, ...]  # PDF 物理页
    lite: LiteStatus
    mutates: bool  # True = 改图（Genesis 才能做）; False = 检查/输出
    note: str = ""


# fmt: off
OPS: dict[CamOp, OpSpec] = {s.op: s for s in [
    OpSpec(CamOp.IMPORT_FILES,            "intake",      "第2章", (53, 66),         "implemented",     False),
    OpSpec(CamOp.SET_LAYER_TYPES,         "intake",      "第2/4章", (41, 110),      "implemented",     False),
    OpSpec(CamOp.ALIGN_TO_DRILL,          "align",       "第4章", (111,),           "report_only",     True),
    OpSpec(CamOp.SET_PROFILE,             "align",       "第4章", (111,),           "implemented",     True, "线宽 0.15mm 只报告"),
    OpSpec(CamOp.DELETE_OUTSIDE_PROFILE,  "align",       "第4章", (112,),           "partial",         True, "字符层已删；其余层 B1.1"),
    OpSpec(CamOp.COPY_STEP,               "align",       "第4章", (111, 112),       "implemented",     False),
    OpSpec(CamOp.SET_DRILL_ATTRS,         "drill",       "第5章", (114,),           "implemented",     True, "启发式"),
    OpSpec(CamOp.RESIZE_DRILLS,           "drill",       "第5章", (114, 115),       "implemented",     True),
    OpSpec(CamOp.DRILL_CHECKS,            "drill",       "第5章", (116, 117),       "partial",         False, "5/6"),
    OpSpec(CamOp.NEGATIVE_PAD_RESHAPE,    "inner",       "第6章", (119, 120),       "report_only"    , True, "负片散热/隔离 PAD Change Symbol"),
    OpSpec(CamOp.NFP_REMOVAL,             "inner",       "第6章", (123, 134),       "report_only"    , True),
    OpSpec(CamOp.CONTOURIZE,              "inner",       "第6/7章", (123, 137),     "not_implemented", True),
    OpSpec(CamOp.LINE_COMPENSATION,       "inner",       "第6/7章", (124, 138),     "report_only"    , True),
    OpSpec(CamOp.SIGNAL_LAYER_OPTIMIZE,   "inner",       "第6/7章", (124, 125, 138), "report_only"    , True),
    OpSpec(CamOp.TEARDROPS,               "inner",       "第6章", (126,),           "not_implemented", True),
    OpSpec(CamOp.NPTH_CLEARANCE,          "inner",       "第6章", (121, 127),       "report_only"    , True),
    OpSpec(CamOp.SLIVER_FILL,             "inner",       "第6章", (127,),           "not_implemented", True),
    OpSpec(CamOp.BORDER_CLEARANCE,        "inner",       "第6章", (121, 128),       "report_only"    , True),
    OpSpec(CamOp.COPPER_CUTOUT,           "inner",       "第6/7章", (131, 132, 133, 134), "report_only"    , True, "Select Drawn → surface → 削铜"),
    OpSpec(CamOp.SIGNAL_LAYER_CHECKS,     "inner",       "第6章", (128, 129),       "implemented",     False, "M2 checks"),
    OpSpec(CamOp.SET_SMD_ATTRIBUTE,       "outer",       "第7章", (137,),           "report_only"    , True, "光学点/BGA 圆 PAD 需人工"),
    OpSpec(CamOp.MASK_CONSTRUCT_PADS,     "mask",        "第7/8章", (136, 141),     "report_only"    , True),
    OpSpec(CamOp.MASK_RESIZE,             "mask",        "第8章", (141,),           "report_only"    , True),
    OpSpec(CamOp.MASK_OPTIMIZE,           "mask",        "第8章", (142,),           "report_only"    , True, "至多一次"),
    OpSpec(CamOp.MASK_CHECKS,             "mask",        "第8章", (143,),           "implemented",     False, "M2 checks"),
    OpSpec(CamOp.MASK_DAMS,               "mask",        "第8章", (144,),           "report_only"    , True, "NPTH 及 ≥0.6mm 过孔加挡点"),
    OpSpec(CamOp.SILK_CHECKS,             "silk",        "第9章", (145, 146, 147),  "implemented",     False, "M2 checks"),
    OpSpec(CamOp.SILK_TRANSFORM,          "silk",        "第9章", (146,),           "report_only"    , True, "字高不足时 Scale"),
    OpSpec(CamOp.SILK_CLEAR_BY_MASK,      "silk",        "第9章", (146,),           "report_only"    , True),
    OpSpec(CamOp.NETLIST_EXTRACT,         "net_compare", "第6章", (130,),           "implemented",     False, "M3"),
    OpSpec(CamOp.NETLIST_COMPARE,         "net_compare", "第6章", (130,),           "implemented",     False, "M3, 必须两次"),
    OpSpec(CamOp.STEP_REPEAT,             "panel",       "第10章", (148, 149, 150), "report_only",     True, "方案已算，未出层"),
    OpSpec(CamOp.PANEL_BUILD,             "panel",       "第10/2章", (152, 51),     "report_only",     True, "方案已算，未出层"),
    OpSpec(CamOp.PATTERN_FILL,            "panel",       "第10章", (153, 154),      "not_implemented", True),
    OpSpec(CamOp.ADD_TOOLING,             "panel",       "第10章", (151, 155),      "not_implemented", True),
    OpSpec(CamOp.ROUT_DESIGN,             "panel",       "第13章", (170, 171, 172, 173, 174), "report_only"    , True, "锣带由 Genesis 出"),
    OpSpec(CamOp.EXPORT_GERBER,           "output",      "第11章", (156, 157, 158), "implemented",     False, "M3 审核版"),
    OpSpec(CamOp.EXPORT_EXCELLON,         "output",      "第11/5/13章", (158, 118, 174), "partial",         False, "单 step 钻带"),
    OpSpec(CamOp.ADD_HOLES_FROM_DRAWING,  "drill",       "第5章", (113,),           "report_only",     True, "分孔图/外形层的孔槽补到钻孔层"),
    OpSpec(CamOp.ADD_TEXT,                "silk",        "第9章", (146, 147),       "report_only",     True, "客户要求添加字符"),
    OpSpec(CamOp.RAIL_FILL,               "inner",       "第7章", (137,),           "report_only",     True, "工艺边铺铜（工厂标准，教材无此步）"),
    OpSpec(CamOp.TERMINAL_PAD,            "inner",       "第7章", (138,),           "report_only",     True, "大端子焊盘加大 / 订单指定孔焊盘（工厂标准，教材无此步）"),
    OpSpec(CamOp.VCUT_CLEARANCE,          "inner",       "第7章", (137,),           "report_only",     True, "V-cut 线两侧退铜（工厂标准，教材无此步）"),
    OpSpec(CamOp.VCUT_COUPON,             "outer",       "第7章", (135,),           "report_only",     True, "防 V-cut 测试点（工厂标准；教材 p135 只问是否需要）"),
]}
# fmt: on

assert set(OPS) == set(CamOp), "every CamOp needs an OpSpec row"

STAGE_OPS: dict[str, tuple[CamOp, ...]] = {}
for _spec in OPS.values():
    STAGE_OPS.setdefault(_spec.stage, ())
    STAGE_OPS[_spec.stage] += (_spec.op,)


def ops_for_stage(stage: str) -> tuple[CamOp, ...]:
    return STAGE_OPS.get(stage, ())


class CamEngine(ABC):
    """An executor for a sequence of ops on a job.

    ``LiteEngine`` (this repo) only *checks and reports*; mutating ops produce a
    ``Fix.genesis_script`` draft.  ``GenesisAdapter`` (M4 skeleton / M5 real) sends the
    generated script to a Genesis host.  Both speak ``CamOp``.
    """

    name: str

    @abstractmethod
    def supports(self, op: CamOp) -> bool: ...

    @abstractmethod
    def run(self, op: CamOp, params: dict[str, Any]) -> dict[str, Any]:
        """Execute one op and return an ``applied`` record for ``Fix.applied``."""

    def execute(self, plan: OpPlan) -> list[ExecResult]:
        """Execute a whole ``OpPlan`` (S0). Default: ``run`` per call, mapped onto ``ExecResult``;
        engines that need cross-op state (native geometry, Genesis sessions) override this."""
        from engine.model.plan import ExecResult

        out: list[ExecResult] = []
        for c in plan.calls:
            op = c.cam_op
            if c.applied or op is None or not self.supports(op):
                mode = "already_applied" if c.applied else "report_only"
                out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=self.name, mode=mode, applied=c.applied))
                continue
            r = self.run(op, c.params)
            mode = r.get("mode", "report_only")
            if mode == "auto":
                mode = "native"
            out.append(ExecResult(n=c.n, op=c.op, layer=c.layer, key=c.key, engine=str(r.get("engine", self.name)),
                                  mode=mode if mode in ("already_applied", "native", "delivered", "simulated", "report_only", "skipped") else "report_only",
                                  applied=bool(r.get("applied")), detail=str(r.get("detail", ""))))  # fmt: skip
        return out
