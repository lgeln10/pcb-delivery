# C03 预期 EQ

`eqTotal = 2`,都来自 drill stage、kind `drill_table_mismatch`,同一个植入(钻孔表 T03 写 1.2,Excellon 是 1.0)的两面:

| # | 问题 | 建议决策(验收时) |
|---|---|---|
| 1 | 钻孔表与 Excellon 不一致:钻孔表孔径 1.2 mm 在钻孔文件中不存在,请客户确认以哪个为准 | 转人工(客户确认) |
| 2 | 钻孔表与 Excellon 不一致:钻孔文件多出 1.0 mm ×40,请客户确认 | 转人工(客户确认) |

前提:确认规格里带了 drill_table(LLM 候选或手填)。若确认时把 drill_table 删空,则 `eqTotal = 0`,任务直接跑完——这不是通过。

两条都处理完 →「全部处理完,继续」→ 已完成。
