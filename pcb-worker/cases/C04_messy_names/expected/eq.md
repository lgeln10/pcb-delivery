# C04 预期 EQ

`eqTotal = 1`,来自 intake:

| # | kind | 问题 | 处理 |
|---|---|---|---|
| 1 | `missing_layer` | 资料中未找到线路层,请客户确认文件是否齐全 | 网页上先在层确认表把 top.art / bot.art 改成顶层/底层线路;这条 EQ 的决策选「已处理」备注「层确认时手工指定」 |

确认层之后 align / drill 不再产生 EQ(`by_stage: drill = 0`);若出现 `drill_plating_unknown`,说明 drill.txt 没有被确认成 drill_pth。

注:Node 侧 EQ 面板出现的时机取决于它在层确认前还是后收集 intake 的 item;两种都接受,只要确认层后任务能跑到「已完成」。
