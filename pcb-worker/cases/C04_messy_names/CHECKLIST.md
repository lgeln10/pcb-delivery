# C04 命名混乱 — 网页验收清单

输入:`input/board.zip`(C01 改名:`top.art bot.art smt.gbr smb.gbr sst.gbr ssb.gbr spt.gbr spb.gbr outline.gbr drill.txt npth.txt`,并删掉所有 `%TF.` / `#@! TF` 行)
预期:规则路径识别——8 个缩写命名文件靠「主文件名 = 缩写」规则命中(85%,不是属性路径的 98%);外形、NPTH 90%;只有 `drill.txt` 低置信(65%,钻孔但不知镀孔)需要人工定成 PTH。改完后其余流程同 C01。
重跑输入:`uv run python cases/C04_messy_names/make_input.py`;本地比对:`make verify CASE=C04_messy_names`(用 `expected/layer_map.json` 的 `confirm_as` 代替手工确认)。

前置:三个服务已起。

## 操作 → 勾选

- [ ] 1. 新建项目 `C04-MessyNames` → 上传只选 `board.zip` → 「上传并开始」
- [ ] 2. 状态「待确认」;「检查报告」选「资料整理」:只有 1 条 `layer_low_confidence` info(drill.txt);**没有** `layer_unrecognized` / `missing_layer`
- [ ] 3. 层确认表 **11 行**,对照 `expected/layer_map.json`:
  - [ ] 3a. `top.art`=顶层线路 L1、`bot.art`=底层线路 L2、`smt/smb`=顶/底阻焊、`sst/ssb`=顶/底字符、`spt/spb`=顶/底锡膏,置信度 **85%**(绿),依据列写 `name 'smt' (.gbr)` 之类
  - [ ] 3b. `outline.gbr` = 外形 90%,`npth.txt` = 非金属化钻孔 90%
  - [ ] 3c. `drill.txt` = 钻孔(未知镀孔)65% —— **唯一的黄色高亮行**
  - [ ] 3d. 没有任何一行显示 98%(所有 %TF 已删掉)
- [ ] 4. 手工把 `drill.txt` 改成「金属化钻孔(PTH)」→「确认层识别,继续」
- [ ] 5. (可选反向验证)不改 drill.txt 直接确认 → 钻孔阶段**不再**出 `drill_plating_unknown` EQ:M2 起 worker 按「孔是否落在外层焊盘上」推断,报告里有 1 条 `drill_plating_inferred` info(76/76 孔落在焊盘 → 按 PTH),修复列「已自动」;孔表与改成 PTH 时一致。之后取消任务重传
- [ ] 6. 规格确认:无附件 → 直接「确认规格,继续」
- [ ] 7. 「检查报告」选「对齐/Profile」:2 info(`layer_empty` ssb.gbr、`profile_line_width` outline.gbr),0 error/warn
- [ ] 8. 「检查报告」选「钻孔」:11 info、0 error/warn,孔表同 C01(`expected/drill_table.md`);**没有** `drill_plating_unknown`
- [ ] 9. 「层预览」tab 选 `top.art`:能看到顶层铜(证明 .art 被按 Gerber 解析)
- [ ] 10. 「流程单」:双面正片,同 C01;「成果物」有 `drill_oversized.drl`、`npth_oversized.drl`
- [ ] 11. 问题点数为 0;任务「已完成」

## 不应出现

- 层确认表里有行显示 98% / 「%TF」依据
- `layer_unrecognized`、`missing_layer`、`stackup_odd`
- 手工改类型后确认,align 仍报「无外层铜」(说明确认的 layer_map 没被送到 worker)

## 仍待改进(不在本案例内)

- (已做,M2 W6)`drill.txt` 无镀孔线索时按「孔是否落在外层焊盘上」推断(≥80% 落盘 → PTH,≤20% → NPTH,中间仍问人)
