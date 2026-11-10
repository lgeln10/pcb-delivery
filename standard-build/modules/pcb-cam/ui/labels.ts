// 中文标签:worker 报告里的 kind / 层类型 / 成果物类型 / 级别都是英文标识符(跨语言稳定、日志可搜),
// 页面上一律显示中文。工程师要跟 Genesis、worker 日志对照时,英文标识符放在 title 提示里。
// 名词依据《CAM工程技能培训》,与 pcb 仓 knowledge/rules 用词一致。

export const SEVERITY_LABEL: Record<string, string> = { error: '错误', warn: '警告', info: '提示' }

export const LAYER_TYPE_LABEL: Record<string, string> = {
  top_copper: '顶层线路',
  inner_copper: '内层线路',
  bottom_copper: '底层线路',
  top_mask: '顶层阻焊',
  bottom_mask: '底层阻焊',
  top_silk: '顶层字符',
  bottom_silk: '底层字符',
  top_paste: '顶层锡膏(钢网)',
  bottom_paste: '底层锡膏(钢网)',
  outline: '外形',
  drill_pth: '钻孔·金属化(PTH)',
  drill_npth: '钻孔·非金属化(NPTH)',
  drill_blind: '钻孔·盲/埋孔',
  drill_unknown: '钻孔·属性未知',
  drawing: '图纸/说明',
  unknown: '未识别',
}

export const ARTIFACT_KIND_LABEL: Record<string, string> = {
  drill: '钻带',
  gerber_review: '审核版 Gerber',
  ipc356: 'IPC-D-356 网表',
  mi_sheet: '工艺流程单',
  stackup_svg: '叠层图',
  eq_report: '任务报告',
  dfm_report: '检查数据',
  genesis_script: 'Genesis 脚本草稿',
  op_plan: '操作序列',
  gerber_panel: '生产版 Gerber（工作板）',
  drill_panel: '生产版钻带（工作板）',
  rout: '锣带（Excellon-2 程序）',
  preview_svg: '层预览',
  archive: '过程文件',
}

/** 检查项类型 → 中文。缺失时回落到原始英文标识符。 */
export const ITEM_KIND_LABEL: Record<string, string> = {
  // 资料整理(第4章)
  layer_unrecognized: '层类型无法识别',
  layer_low_confidence: '层识别置信度低',
  layer_parse_error: '文件无法解析',
  layer_empty: '空层',
  layer_offset: '层间偏移',
  missing_layer: '缺层',
  stackup_odd: '叠层层数异常',
  stackup_conflict: '叠层冲突',
  filename_recoded: '文件名编码已修正',
  sr_not_expanded: '含步进重复块(%SR)未展开',
  source_only_no_gerber: '只有设计源文件,无 Gerber',
  source_files_ignored: '附带设计源文件(已忽略)',
  no_input: '没有可用输入',
  input_missing: '输入文件缺失',
  input_invalid: '输入文件非法',
  extract_error: '解压失败',
  cad_exported: '源文件已导出 Gerber',
  cad_export_failed: '源文件解析失败',
  // 审单(第1章)
  order_spec_layers_mismatch: '层数与资料包不符',
  order_spec_filled_from_gerber: '层数按 Gerber 补全',
  order_spec_blind_unstated: '有盲埋孔但附件未写明',
  order_spec_blind_missing_drill: '要求盲埋孔但缺钻带',
  order_spec_below_capability: '客户要求低于工厂能力',
  order_spec_special_implied: '特殊工艺已按附件补全',
  order_spec_gold_finger_bevel: '金手指倒角未写明',
  order_spec_missing: '规格必填项缺失',
  // 对齐 / 外形(第4章)
  profile_line_width: '外形线宽已规范',
  profile_not_closed: '外形未闭合',
  profile_extra_rings: '外形有多余环',
  profile_candidates: '多个外形层,已选 Profile',
  profile_set: '外形层是成品拼板,Profile 取整板',
  opening_larger_than_pad: '开窗按厂规重做为焊盘 + 2mil',
  outline_far_drawing: '外形层板外的图纸已忽略',
  outline_edge_notch: '外形层开口圆弧=打穿板边的孔,整圆锣出+开窗',
  outline_sketch: '外形层板内示意线已删',
  drill_outside_profile: 'Profile 外的孔不钻',
  via_plug_cover: '塞孔/盖油过孔的开窗已删',
  outline_slot_drawn: '外形层画的宽线=非金属化锣槽',
  drill_profile_predrill: '锣槽两端/挖空四角预钻',
  drill_via_min: '小于厂最小过孔的按最小过孔钻',
  outline_drawn_holes: '外形层上画的孔',
  outline_stray_segment: '外形层有悬空线段',
  outside_profile: '板外物件',
  no_drill_reference: '缺钻孔基准',
  // 钻孔(第5章)
  hole_size: '孔径统计',
  hole_separation: '孔间距(重叠/接触/过近)',
  extra_holes: '多余孔',
  missing_holes: '缺孔',
  npth_to_rout: '非金属孔距板边',
  power_ground_shorts: '与地电层短路',
  drill_oversize: '钻孔预大',
  drill_via_plug: '塞孔过孔分组',
  drill_override: '订单指定钻嘴',
  drill_second: '二钻',
  drill_rect_to_rout: '矩形孔改锣',
  drill_rect_corner_predrill: '矩形锣孔四角预钻',
  drill_drawn_holes: '外形层上的孔已加进钻带',
  drill_tooling: '板边定位孔',
  drill_predrill: '大孔预钻',
  drill_slot_predrill: '槽端预钻',
  drill_overlap_deleted: '重叠孔已删小孔',
  drill_plating_inferred: '孔属性按外层焊盘推断',
  drill_plating_unknown: '孔属性未知',
  drill_table_mismatch: '钻孔表与钻带不一致',
  drill_table_dia_diff: '钻孔表孔径有差异',
  drill_plug_tape: '塞孔钻带',
  drill_output: '钻带输出',
  rout_inner_output: '内锣带已输出',
  drill_output_missing: '钻带缺失',
  // 内层 / 外层(第6、7章)
  line_width: '线宽不足',
  partition_line_width: '分区线线宽不足',
  spacing: '线距不足',
  annular_ring: '焊盘环宽不足',
  hole_to_copper: '孔到铜距离不足',
  drill_isolation: '钻孔隔离不足(优化可处理)',
  npth_clearance: '非金属孔削铜不足',
  npth_in_pad: '非金属孔落在焊盘内',
  copper_to_edge: '铜到板边距离不足',
  isolated_pad: '独立焊盘(内层正片应删)',
  impedance_line: '阻抗线（按阻抗计算补偿）',
  line_compensation: '线路需补偿',
  smd_pads: 'SMD 属性候选',
  isolation_ring: '负片隔离环不足',
  negative_no_clearance: '负片孔位无隔离/散热盘',
  thermal_ring: '散热盘环宽不足',
  thermal_opening: '散热盘开口不足',
  // 金手指(第12章)
  gold_finger_spec: '金手指(倒角/硬金待确认)',
  gold_finger_copper_nearby: '金手指旁有其他铜',
  gold_finger_inner_copper: '金手指位内层未削铜',
  gold_finger_mask_not_full: '金手指阻焊未整块开窗',
  // 阻焊(第8章)
  opening_smaller_than_pad: '开窗小于焊盘',
  mask_expansion: '开窗比焊盘大得不够',
  missing_opening: '焊盘无开窗',
  opening_not_pad: '开窗对应的不是焊盘',
  mask_coverage: '盖线位不足',
  mask_sliver: '阻焊桥过细',
  mask_to_profile: '开窗距板边过近',
  mask_no_copper: '找不到同面线路层',
  mask_not_pad_objects: '阻焊层有非焊盘物件',
  npth_opening_small: '非金属孔开窗偏小',
  npth_covered: '非金属孔被阻焊盖住',
  via_dam_needed: '过孔需加挡点',
  via_plug_too_large: '待塞过孔超限',
  via_mask_summary: '过孔盖油统计',
  fiducial_opening: '光标点开窗(按原稿保留)',
  paste_without_opening: '锡膏层焊盘无阻焊开窗',
  // 字符(第9章)
  silk_line_width: '字符线宽不足',
  silk_height: '字高不足',
  silk_height_ratio: '字高与笔画比偏小',
  silk_add_text_required: '客户要求添加字符',
  silk_on_opening: '字符压阻焊开窗',
  silk_outside_profile: '板外字符(已自动删除)',
  silk_crossing_profile: '字符跨越板边',
  // 网络比较(第6章)
  net_short: '网络短路',
  net_open: '网络开路',
  net_open_after_reduce: '减铜后开路(细连铜)',
  net_open_after_reduce_outer: '减铜后开路(外层,仅提示)',
  net_reduce_capped: '减铜量已按最细线下调',
  net_unplaced_names: '未落位的网名',
  net_reference_from_orig: '设计网名取自客户原稿',
  no_reference_netlist: '无原稿网表可比对',
  net_summary: '网络统计',
  // 拼板 / 输出(第10、11章)
  panel_plan: '拼板方案',
  panel_alternatives: '备选拼板方案',
  panel_no_fit: '工作板放不下',
  panel_no_profile: '缺外形,无法拼板',
  punch_design: '模冲设计（定位孔/防爆孔）',
  panel_customer_spec: '客户指定拼板',
  gerber_output: 'Gerber 输出',
  gerber_write_error: 'Gerber 写出失败',
  ipc356_output: 'IPC-D-356 输出',
  roundtrip_diff: '写出回读有差异',
  genesis_delivery: 'Genesis 脚本投递',
  genesis_script_error: 'Genesis 脚本生成失败',
  op_plan_invalid: '操作序列守卫未通过',
  netlist_compare_required: '网络比较（必做两次）',
  genesis_result: 'Genesis 执行结果',
  genesis_result_fail: 'Genesis 执行失败',
  genesis_pending: 'Genesis 等待主机',
  genesis_paused: 'Genesis 段确认点',
  genesis_queued: 'Genesis 排队',
  gate_genesis_layer: 'Genesis 成果物回读',
  // 第 14 章 半孔 / 金属包边
  half_hole: '板边半孔（需确认工艺）',
  half_hole_min_dia: '半孔孔径不足 0.5mm',
  half_hole_gap: '半孔间距不足 0.4mm',
  half_hole_mask: '半孔位阻焊开窗',
  half_hole_copper_cut: '半孔位线路需掏铜',
  edge_plating_suspect: '疑似金属包边',
  edge_plating_ring: '包边焊环不足',
  edge_plating_to_pad: '焊盘距包边过近',
  edge_plating_mask: '包边槽阻焊需开窗',
  // 第 16 章 盲孔 / HDI
  hdi_laser_required: '需激光钻孔',
  hdi_stacked_vias: '盲埋孔叠加',
  hdi_mechanical_ok: '可机械钻孔',
  hdi_expose_method: '盲孔曝光方式',
  hdi_teardrop_advised: '盲孔建议加泪滴',
  hdi_aspect_ratio: '盲孔纵横比',
  hdi_error: 'HDI 分类未完成',
  native_applied: '本地几何引擎已执行',
  native_failed: '本地几何引擎执行失败',
  native_skipped: '本地几何引擎判断需人工确认',
  // 回读校验
  gate_summary: '回读校验结果',
  gate_release_profile: '工厂规则待认证',
  gate_area_mismatch: '回读面积不符',
  gate_hole_count_mismatch: '回读孔数不符',
  gate_layer_missing: '回读缺层',
  gate_drill_missing: '回读缺钻带',
  gate_ipc_mismatch: '回读 IPC 记录不符',
  gate_ipc_ok: '回读 IPC 记录一致',
  gate_profile_ok: '回读外形与定义一致',
  gate_profile_open: '回读外形未闭合',
  gate_no_output: '没有可回读的成果物',
  gate_reread_error: '回读失败',
  worker_exception: '引擎异常',
}

export function kindLabel(kind: string): string {
  return ITEM_KIND_LABEL[kind] ?? kind
}
/** 层类型:下拉和表格里用「中文 (english)」,工程师要跟 worker/Genesis 对照时用得上 */
export function layerTypeLabel(t: string): string {
  const zh = LAYER_TYPE_LABEL[t]
  return zh ? `${zh} (${t})` : t
}
export function artifactKindLabel(k: string): string {
  return ARTIFACT_KIND_LABEL[k] ?? k
}
/** 引擎的 40 个 CAM 操作(pcb 仓 engine/adapters/base.py CamOp;映射文档 docs/genesis_op_mapping.md 同名小节) */
export const OP_LABEL: Record<string, string> = {
  ImportFiles: '导入资料到 orig',
  SetLayerTypes: '设层类型/极性',
  AlignToDrill: '按钻孔对齐各层',
  SetProfile: '设外形 Profile',
  DeleteOutsideProfile: '删板外物件',
  CopyStep: '建 net / edit 副本',
  SetDrillAttrs: '设钻孔属性',
  ResizeDrills: '钻嘴预大',
  DrillChecks: '钻孔检查',
  NfpRemoval: '删独立 PAD',
  Contourize: '铜皮转 Surface',
  LineCompensation: '线路补偿(+1mil)',
  SignalLayerOptimize: '线路层优化 SLO',
  Teardrops: '加泪滴',
  NpthClearance: '非金属孔避空',
  SliverFill: '填细缝',
  BorderClearance: '削板边铜',
  SignalLayerChecks: '线路层检查',
  MaskConstructPads: '阻焊转 PAD',
  MaskResize: '阻焊开窗调整',
  MaskOptimize: '阻焊优化 SMO',
  MaskChecks: '阻焊检查',
  SilkChecks: '字符检查',
  SilkClearByMask: '字符避开窗',
  StepRepeat: '拼板 Step&Repeat',
  PanelBuild: '生成工作板',
  PatternFill: '铺阻流块',
  AddTooling: '加定位孔',
  ExportGerber: '输出 Gerber',
  ExportExcellon: '输出钻带',
  NetlistExtract: '抽网表',
  NetlistCompare: '网络比较',
  SetSmdAttribute: '设 SMD 属性',
  NegativePadReshape: '负片 PAD 改形',
  CopperCutout: '掏铜',
  MaskDams: '阻焊挡点',
  RoutDesign: '锣带',
  SilkTransform: '字符缩放',
  AddHolesFromDrawing: '按分孔图加孔',
  AddText: '加字符',
  // 厂规补的四步(教材无):pcb 仓 engine/adapters/base.py 的 note 就是这些字
  RailFill: '工艺边铺铜',
  VcutClearance: 'V-cut 线两侧退铜',
  TerminalPad: '大端子焊盘加大',
  VcutCoupon: '防 V-cut 测试点',
}
export function opLabel(op: string | null | undefined): string {
  if (!op) return '-'
  return OP_LABEL[op] ?? op
}

/** worker 的报告摘要是英文计数("2 error, 163 warn, 8 info; 2 need decision"),页面上翻成中文 */
export function summaryLabel(s: string | null | undefined): string {
  if (!s) return ''
  return s
    .replace(/(\d+) files?, (\d+) layers? identified, (\d+) copper, (\d+) unmapped/, '$1 个文件,识别 $2 层,铜层 $3,未识别 $4')
    .replace(/(\d+) layers? folded, ref=(\w+), profile=(\w+)/, (_m, n, ref, ok) => `折叠 ${n} 层,基准 ${ref === 'drill' ? '钻孔' : ref},外形 ${ok === 'ok' ? '正常' : ok}`)
    .replace(/(\d+) drill files?, (\d+) tools?, (\d+) holes?/, '钻孔文件 $1,刀 $2 把,孔 $3 个')
    .replace(/(\d+) error, (\d+) warn, (\d+) info; (\d+) need decision/, '错误 $1 · 警告 $2 · 提示 $3 · 需决策 $4')
}

export function severityLabel(s: string): string {
  return SEVERITY_LABEL[s] ?? s
}
/** 问题点条目 id 形如 `annular_ring_Flashpads-F_Cu.gbr_summary` → 中文类型名 */
export function eqItemLabel(itemId: string, kinds: string[]): string {
  const hit = kinds.filter((k) => itemId.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return hit ? kindLabel(hit) : itemId
}
