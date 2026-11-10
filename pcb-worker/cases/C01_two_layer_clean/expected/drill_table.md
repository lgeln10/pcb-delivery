# C01 钻孔预期(stage = drill)

来源:`Flashpads-PTH.drl`(`TF.FileFunction,Plated,1,2,PTH`)与 `Flashpads-NPTH.drl`(`NonPlated`),KiCad 5.99,METRIC/decimal。
预大规则:plated +0.15 / non_plated +0.05 / via 不预大(《CAM工程技能培训》p114),钻嘴按 0.05 取整。
via 判定(M1 启发式):plated 且 ⌀ ≤ 0.5 mm 且非槽 —— 本板最小 plated 孔 0.6,所以**没有 via**,全部 plated 预大 +0.15。

| 文件 | 工具 | 属性 | 成品孔径 mm | 钻嘴 mm | 数量 | 槽 |
|---|---|---|---|---|---|---|
| NPTH | T01 | non_plated | 0.65 | 0.70 | 3 | |
| NPTH | T02 | non_plated | 0.95 | 1.00 | 1 | |
| PTH | T01 | plated | 0.70 | 0.85 | 14 | |
| PTH | T02 | plated | 0.85 | 1.00 | 2 | |
| PTH | T03 | plated | 1.00 | 1.15 | 40 | |
| PTH | T04 | plated | 1.10 | 1.25 | 4 | |
| PTH | T05 | plated | 0.60 | 0.75 | 10 | G85 槽 |
| PTH | T06 | plated | 0.65 | 0.80 | 2 | G85 槽 |
| PTH | T07 | plated | 0.70 | 0.85 | 4 | G85 槽 |

合计:9 工具、80 孔(plated 76 / non_plated 4),其中 16 个 G85 槽孔。

## 报告项(全部 info,0 error,0 warn)

- 9 条 `drill_oversize`,每条 `fix.type=resize`、`auto_fixable=true`、`applied=true`,params 含 from/to/tool
- 1 条 `hole_size` 汇总
- 1 条 `power_ground_shorts`:「M1 未实现,需在 Genesis 中运行 Drill Checks 复核」
- Extra Holes / Hole Separation / Missing Holes / NPTH to Rout:**0 命中**(不应出现任何一条)

## 成果物(drill stage)

- `Flashpads-NPTH_oversized.drl`(kind drill,~230 B)、`Flashpads-PTH_oversized.drl`(kind drill,~1.6 KB):自写 METRIC,TZ writer 写出的预大钻带,gerbonara 可回读
- `drill_table.json`(kind dfm_report)
