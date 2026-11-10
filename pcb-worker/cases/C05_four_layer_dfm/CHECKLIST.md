# C05 四层 DFM 缺陷 — 网页验收清单

输入：`input/board.zip`（C01 + 合成 In1（负片）/ In2 + 植入缺陷，`uv run python cases/C05_four_layer_dfm/make_input.py` 可重生成；缺陷坐标在 `expected/spots.json`）
预期：内层/外层/阻焊/字符四个步骤各命中植入的缺陷，每层每类 1 条决策；共 15 条问题点分四次出现；板外字符自动删除并产出清理后的层。
本地比对：`make verify CASE=C05_four_layer_dfm`（73 项）。

前置：三个服务已起；worker 是 M2 版本（`/health` 正常即可）。

## 操作 → 勾选

- [ ] 1. 新建项目 `C05-FourLayer` → 上传 `board.zip` → 「上传并开始」
- [ ] 2. 层确认表 **13 行**：`In1_Cu` = 内层线路 L2（极性列显示「负片」）、`In2_Cu` = L3、`B_Cu` = L4；全部 98% → 「确认层识别，继续」
- [ ] 3. 规格确认：无附件 → 直接确认
- [ ] 4. 步骤时间线走到「内层」停下，状态「待确认」「有问题点需要决策」；问题点面板 **5 条**（对照 `expected/eq.md` #1–#5）
- [ ] 5. 「检查报告」选「内层」：
  - [ ] 5a. `In1_Cu` 有 `partition_line_width`、`isolation_ring`、`negative_no_clearance`、`copper_to_edge` 各一条汇总 + 一条明细
  - [ ] 5b. `In2_Cu` 有 `isolated_pad`、`hole_to_copper`、`copper_to_edge`、`line_compensation`
  - [ ] 5c. 点 `isolation_ring` 明细行的「定位」→ 自动切到「层预览」`In1_Cu`，视图放大到孔 X (73.1, -67.5) 附近，红/琥珀框套在孔上；「全图」复位
- [ ] 6. 5 条决策全部选「接受现状」或「需 Genesis 修」→ 「全部处理完，继续」→ 走到「外层」停下，问题点 **6 条**（#6–#11）
- [ ] 7. 「检查报告」选「外层」，`F_Cu` 的「线宽不足」定位到 A 点 (26, -65) 横线、「线距不足」定位到 B 处那段平行缝（x 37–41 等距，定位落在左端 37, -65）、「焊盘环宽不足」定位到 C 点 (88, -65) 过孔
- [ ] 8. 处理完 → 「阻焊」停下，问题点 **3 条**（#12–#14）；`opening_smaller_than_pad` 定位到 E 点 (56, -60)，`mask_sliver` 定位到 G 点 (34, -57)
- [ ] 9. 处理完 → 「字符」停下，问题点 **1 条**（#15，字符压开窗，E 点）
- [ ] 10. 「检查报告」选「字符」：有 `silk_outside_profile` 一条，修复列显示「已自动」，说明里写清理后的文件名
- [ ] 11. 「成果物」里有 `Flashpads-F_Silkscreen_cleaned.gbr`（可下载）以及 `inner_checks.json / outer_checks.json / mask_checks.json / silk_checks.json`
- [ ] 12. 处理完最后 1 条 → 其余步骤占位通过 → 任务「已完成」；「流程单」板型 = 多层板（对照 `expected/mi_flow.md`），叠层图 4 层

## 不应出现

- 任何 `layer_parse_error`；`npth_in_pad`；内层的 `line_width` / `spacing`
- 同一层同一类型出现两条 error（说明聚合失效）
- B_Mask 的三类 error；`silk_crossing_profile`

## 页面用词

页面上「级别 / 类型 / 层类型 / 成果物类型」都显示中文，英文标识符在鼠标悬停的提示里（跟 worker 日志、Genesis 对照时用）。层类型下拉是「中文 (english)」双语。

## 仍待改进（不在本案例内）

- 字高按笔画聚类估算（本案例板上文字 32 mil 合格，只出「字高与笔画比偏小」的 info）；真实板需按 `DECISIONS_PENDING` 第 8 条校准
- 负片散热 PAD 已按几何识别（本案例负片只有隔离盘，不触发散热盘检查）
