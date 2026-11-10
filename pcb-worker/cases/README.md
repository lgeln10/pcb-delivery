# 端到端验收案例

给 yibing 自己动手验证用:每个案例 = **拖进网页的输入** + **预期输出参照** + **逐步勾选的 CHECKLIST**。
缺陷都是故意植入的,所以预期结果是确定的。

```
cases/
  C01_two_layer_clean/
    input/            上传用的文件:board.zip(Gerber+Excellon)+ 制作要求.pdf/xlsx(若有)
                      order_spec.json(若有):网页确认后的规格,make verify 直接送给各 stage
                      profile.yaml(若有):该案例的工厂标准覆盖(网页上对应「工厂标准」),make verify 作为 profile_yaml 传给 worker
    make_input.py     (C02+)从 tests/fixtures 生成 input/ 的脚本,可重跑
    expected/
      layer_map.json  每个文件应识别成哪一层(type/index/min_confidence);needs_llm / unmapped 列表;
                      可带 confirm_as = 人工在层确认表里会改成的类型(verify 据此模拟确认)
      findings.json   机器可读:must / must_not / status(见下)
      eq.json         机器可读:EQ 条数 + kinds(+ by_stage)
      drill_table.json 机器可读:每把刀的 attribute / count / 钻嘴(按 file+dia+slot 匹配)
      drill_table.md  孔表(给人看)
      findings.md     应报出的违规(stage/类型/位置/数值)与"不应报"的项(给人看)
      eq.md           应生成的 EQ 问题点(为空则写"无")
      mi_flow.md      应判定的板型 + 工序链
      order_spec.md   (C03)网页上 LLM 候选应读出什么
    CHECKLIST.md      网页上逐步操作 + 勾选对照
```

## 自动验证

```bash
make verify CASE=C02_drill_defects       # 进程内跑 intake → align → drill → inner → outer → mask → silk,比对 expected/*.json
make verify-all                          # 遍历 cases/C0*;任一 FAIL 退出码 1
uv run python -m engine.verify tests/fixtures/kicad-x2ap   # 裸 fixture:只跑不比对
```

`engine/verify.py` 不起 HTTP:把 `input/` 里的文件(除 `order_spec.json`)放到临时 `PCB_STORAGE_ROOT`
(`data/verify/<case>/storage/pcb-cam/verify/<case>/input/`)当上传 key,直接调 stage 函数;
intake 的 layer_map 套上 `expected/layer_map.json` 的 `confirm_as` 后作为「已确认」map 传给 align/drill;
`input/order_spec.json` 作为 `StageRequest.order_spec`。每条比对一行 PASS/FAIL。

### expected/*.json 约定

- `layer_map.json`:`files[]` 每项 `file / type / index / min_confidence`(index 为 null 不比;type 为 `unknown` 表示应落在 unmapped);
  `needs_llm`、`unmapped` 为文件名列表(有则整体比对);`copper_layers`;`confirm_as`(+`confirm_index`)只用于模拟人工确认,不比对
- `findings.json`:`must: [{stage, kind, severity?, layer?, min_count?=1}]` 命中数 ≥ min_count;
  `must_not: [{stage|"*", kind?, severity?, layer?}]` 命中数 = 0;`status: {stage: ok|needs_review|blocked|failed}`
- `eq.json`:`count`(所有已实现 stage 合计,按 Node 的 needs_decision 规则:有 eq_question,或 error 且 fix 未自动应用)、`kinds`(去重排序)、`by_stage?`
- `drill_table.json`:`total_holes?`、`tools[]` 按 `(file, dia_mm, slot)` 匹配,比 `attribute / count / drill_dia_mm`;多出的工具算 FAIL(`"exact": false` 关闭)

## 手动验证(网页)

1. 启动:`pcb-worker`(8000)、`aios-api`(3005)、`aios-web`(5175)—— 三个配置都在 `.claude/launch.json`
2. 浏览器打开 http://127.0.0.1:5175 ,演示模式自动以「王老板」登录(超管,所有权限)
3. 左侧「制造工程 → PCB CAM」→ 新建项目 → 上传资料(选 `cases/<id>/input/` 下的文件)
4. 按该案例的 `CHECKLIST.md` 逐项勾选

| 案例 | 来源 | 植入 | 验证重点 | 里程碑 |
|---|---|---|---|---|
| C01 双面板·干净 | gerbonara 测试资源 KiCad 导出 | 无 | 层识别全对、孔表一致、零误报、MI=双面正片 | M1 |
| C02 钻孔缺陷 | C01 改造(`make_input.py`) | 多余孔 / 缺孔 / 两孔重叠 / NPTH 近板边 / 外形层悬空段(M2) | Drill Checks 各命中;2 条 EQ | M1 |
| C03 附件审单 | C01 + 手写制作要求 xlsx/pdf | 钻孔表 T03 写 1.2(实际 1.0) | 规格候选正确;`drill_table_mismatch` EQ ×2 | M1 |
| C04 命名混乱 | C01 重命名 `top.art / smt.gbr / drill.txt …` | 无 `%TF` | 规则识别 + 低置信高亮 + 手工确认层 | M1 |
| C05 四层 DFM 缺陷 | C01 + 合成 In1(负片)/In2(`make_input.py`) | 3mil 线/0.05 间距/环宽 0.05/负片隔离环 0.2 与无隔离/分区线 0.15/独立 PAD/孔到线 0.1/铜到板边 0.1/开窗小于 pad/缺开窗/阻焊桥 0.05/字符压开窗/板外字符 | Ch6-9 每类恰好命中 1 次;15 条 EQ 分四次;板外字符自动删除出 `_cleaned.gbr` | M2 |
| C06 网络守门 | C05 + `%TO.N` 网名文本注入（`make_input.py`） | NET_A–NET_B 连线 / 两个 NET_C 不连 / In2 两方块角接 0.05 | net_short、net_open、内层减铜后开路各 1 条 EQ + 定位 | M3 |
| C07 拼板+输出 | C01 + `input/profile.yaml`（406.4×508、板边 10、主名 C07）+ `order_spec.json` 客户拼板要求 | 无 | 4×9=36 只方案 + `_panel` 预览;客户要求 EQ;`C07.GTL…IPC` 工厂格式;round-trip;回读 0 不一致 | M3 |
| C08 盲埋孔 | C01 + 合成 L2–L5 + 盲 1-2 / 埋 2-5 钻带（`%TF Plated,1,2,Blind`） | L1 上一个与埋孔同名的焊盘 | span 识别 [1,2]/[2,5];net_open ×1 证明 span 生效;4 套钻带;盲埋孔流程单 | M3 |
| C09 真实客户板 | 工厂提供 | — | 与工程师手工结果对标 | M2+ |
