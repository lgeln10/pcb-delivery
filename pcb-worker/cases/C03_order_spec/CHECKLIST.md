# C03 附件审单 — 网页验收清单

输入:`input/board.zip`(= C01)+ `input/制作要求.xlsx` + `input/制作要求.pdf`(两者同内容;钻孔表里 PTH T03 故意写 1.2,Excellon 是 1.0)
预期:层识别、对齐同 C01;规格候选正确读出 9 行钻孔表且 T03 = 1.2;钻孔阶段出 2 条「钻孔表与 Excellon 不一致」EQ。
重跑输入:`uv run --with openpyxl --with reportlab python cases/C03_order_spec/make_input.py`;本地比对:`make verify CASE=C03_order_spec`(用 `input/order_spec.json` 代替网页确认)。

前置:三个服务已起;租户最好配好 LLM(否则见第 6 步的替代路径)。

## 操作 → 勾选

- [ ] 1. 新建项目 `C03-OrderSpec` → 上传资料时**同时选** `board.zip`、`制作要求.xlsx`、`制作要求.pdf` → 「上传并开始」
- [ ] 2. 层确认表 **11 行**(xlsx/pdf 不占行,也不出「无法识别」),与 `expected/layer_map.json` 一致 → 「确认层识别,继续」
- [ ] 3. 「检查报告」选「资料整理」:0 item;**没有** `layer_unrecognized`(xlsx 不能被当 zip 解开成 `xl/worksheets/sheet1.xml` 之类)
- [ ] 4. 状态再次「待确认」,提示「请核对 AI 读出的制作规格」
- [ ] 5. 规格确认面板:候选与 `expected/order_spec.md` 对照——层数 2、板厚 1.6、铜厚 1oz、沉金、绿油白字、6/6 mil
- [ ] 6. 候选 `drill_table` **9 行**,PTH T03 孔径 **1.2**(LLM 应照抄附件,不要「聪明地」改成 1.0)
  - 若租户没配模型:候选显示 `_llm: unavailable` + 附件文字预览(能看到 xlsx 里的「1.20」和 pdf 文本)→ 手工把 9 行钻孔表(含 1.2)填进规格 → 也算通过,注明「无模型」
- [ ] 7. 「确认规格,继续」→ 处理中 → **钻孔 = 待确认**
- [ ] 8. 「检查报告」选「钻孔」:2 条 `drill_table_mismatch` error(1.2 在 Excellon 找不到 / Excellon 1.0×40 不在钻孔表),其余 11 条 info 同 C01;**没有** `drill_table_dia_diff`
- [ ] 9. 问题点决策:`eqTotal = 2`,与 `expected/eq.md` 一致 → 两条都「转人工」备注「附件 1.2 疑为笔误,待客户确认」→「全部处理完,继续」
- [ ] 10. 任务「已完成」;「流程单」同 C01;「成果物」同 C01
- [ ] 11. 项目/任务详情里能看到附件列表(xlsx、pdf)并可下载

## 不应出现

- 层确认表里出现 `_rels/.rels`、`[Content_Types].xml`、`docProps/…` 等 xlsx 内部文件
- 候选 drill_table 少于 9 行,或 T03 被读成 1.0(那样钻孔阶段就没有 EQ,案例失去意义)
- 确认规格时删空 drill_table 让 EQ 消失(不算通过)
