# C02 钻孔缺陷 — 网页验收清单

输入:`input/board.zip`(C01 的板,`make_input.py` 在 PTH/NPTH/Edge_Cuts 副本里植入:多余孔、重叠孔、NPTH 近板边、缺孔、外形层悬空线段;Gerber 铜/阻焊/字符/锡膏层原样)
预期:层识别、对齐同 C01;钻孔阶段 2 error(成 2 条 EQ)+ 3 warn;决策后任务能跑到「已完成」。
重跑输入:`uv run python cases/C02_drill_defects/make_input.py`;本地自动比对:`make verify CASE=C02_drill_defects`。

前置:三个服务已起,页面顶部「CAM 引擎在线」。

## 操作 → 勾选

- [ ] 1. 新建项目 `C02-DrillDefects` → 上传只选 `board.zip` → 「上传并开始」
- [ ] 2. 层确认表 11 行,与 `expected/layer_map.json` 一致(全部 ≥ 80%,无 unknown,和 C01 完全一样)→「确认层识别,继续」
- [ ] 3. 规格确认:无附件 → 空规格 → 「确认规格,继续」
- [ ] 4. 「步骤」tab:资料整理 ✓ 审单 ✓ 对齐/Profile ✓,**钻孔 = 待确认**(status needs_review),任务状态「待确认」,提示有问题点需要决策
- [ ] 5. 「检查报告」tab 选「对齐/Profile」:2 条 info(同 C01)+ `outline_stray_segment` 1 条 warn 明细(点「定位」→ 预览 Edge_Cuts 放大到 (60–63, −45) 的 3 mm 线)+ 1 条汇总;任务在「对齐」就停下,问题点 1 条「外形层有不闭合的线段…」;**没有** `profile_not_closed` / `profile_extra_rings`
- [ ] 6. 「检查报告」tab 选「钻孔」,对照 `expected/findings.md`:
  - [ ] 6a. `extra_holes` error:PTH ⌀0.7 @(30.000, −35.000)「不落在任何外层焊盘内」
  - [ ] 6b. `hole_separation` error:「touching holes … 边距 0.000 mm」@(40.259, −26.289)
  - [ ] 6c. `missing_holes` warn ×2:F_Cu 与 B_Cu 各一条,@(22.180, −66.213),ComponentPad 圆焊盘
  - [ ] 6d. `npth_to_rout` warn:NPTH ⌀0.65 @(20.475, −45.000)「距板边 0.150 mm(< 0.3 mm)」
  - [ ] 6e. 9 条 `drill_oversize` info,数量对照 `expected/drill_table.md`(0.65 NPTH ×4、0.7 PTH ×15、1.0 ×41、1.1 ×3)
- [ ] 7. 「层预览」tab 选 `Flashpads-PTH.drl`:能在左侧空白区 (30,−35) 看到一个孤立的孔;选 `Flashpads-F_Cu.gbr` 该处无铜
- [ ] 8. **问题点决策**面板:先在「对齐」停下 1 条(外形层悬空线段,M2),处理后到「钻孔」停下 2 条(多余孔 / 重叠孔),再到「外层」2 条(NPTH 削铜 F/B,C01 固有);共 5 条与 `expected/eq.md` 一致,每条能看到 stage、位置坐标、原始 message
- [ ] 9. 第 1 条(多余孔)选「转人工」,填备注「待客户确认是否删孔」→ 保存后该条显示已决策
- [ ] 10. 第 2 条(重叠孔)选「转人工」→ 保存 → 面板显示 2/2 已处理
- [ ] 11. 点「全部处理完,继续」→ 任务回到「处理中」→ 后续 stage 在 M1 显示「通过」(占位)→ 状态「已完成」
- [ ] 12. 「成果物」tab:`Flashpads-PTH_oversized.drl` / `Flashpads-NPTH_oversized.drl` / `drill_table.json`;下载 `drill_table.json` 看 `total_holes = 82`,`checks.extra_holes = 1`
- [ ] 13. 「流程单」tab:同 C01(双面正片,14 工序);EQ 不影响 MI 判定
- [ ] 14. 列表页刷新:状态「已完成」,问题点计数显示 2(已处理)

## 不应出现

- intake / align 任何 error 或 warn
- `drill_table_mismatch`(本案例无制作要求附件)
- 未决策就能点「继续」(应提示「还有问题点没有决策」)
- 决策后任务停在「待确认」不动

## M2 待做(本案例暂不勾)

- 小闭合环(客户把槽画成小闭合环)目前只在 `profile_extra_rings` 里计数,不单独定位
- `missing_holes` / `npth_to_rout` 是否升级为 EQ 由工厂 profile 决定
