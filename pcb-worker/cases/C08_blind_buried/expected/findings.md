# C08 盲埋孔 — 应报出的项

板 = C01 + 合成 4 个内层（L2–L5 正片）+ 三个 ⌀0.2 过孔（`make_input.py`，坐标在 `expected/spots.json`）：
- TH：通孔（PTH 文件 T7），六层都有 ⌀0.45 焊盘，网名 TH
- BV：盲孔 L1–L2（`Flashpads-L1-L2.drl`，`%TF.FileFunction,Plated,1,2,Blind`），L1/L2 焊盘网名 BV
- BUR：埋孔 L2–L5（`Flashpads-L2-L5.drl`，`Plated,2,5,Buried`），L2–L5 焊盘网名 BUR，**L1 也放了一个 BUR 焊盘** —— 埋孔够不到 L1

| 步骤 | 类型 | 级别 | 内容 | 说明 |
|---|---|---|---|---|
| intake | 层确认表 | — | 17 行：6 铜层 L1–L6；`L1-L2.drl` = 盲埋钻孔 span 1–2；`L2-L5.drl` = 盲埋钻孔 span 2–5；PTH/NPTH span 1–6 | 属性路径 98% |
| drill | 孔表 | info | 4 个钻孔文件、12 把刀、83 孔；三个 ⌀0.2 via 不预大 | p114 |
| net_compare | `net_open` | error + EQ | 网络 BUR 分成 2 段：L2–L5 一段（埋孔连通）、L1 一段（够不到） | 证明 span 生效 |
| net_compare | `net_summary` | info | TH 跨 6 层、BV 跨 L1–L2 各为一个网络 | |
| output | `drill_output` | info | 4 套钻带：`*.TXT`、`*-NPTH.TXT`、`*-1-2.TXT`、`*-2-5.TXT`（按 `output.naming.drill_blind`） | p158 |
| MI（网页） | 板型 | — | 六层板 盲埋孔（p216/p218 模板）；叠层图 6 层，钻孔 span 三条 | 第17章 |

## 不应出现
`net_short`、`no_reference_netlist`；inner 任何 error/warn（内层只有焊盘）；gatekeeper error；output `roundtrip_diff`
