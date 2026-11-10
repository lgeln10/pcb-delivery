# C05 四层 DFM 缺陷 — 应报出的项

板子 = C01（KiCad 双面板）+ 程序合成的两个内层（`make_input.py`）：`In1_Cu` 负片电源层（每个孔一个隔离 PAD，槽孔用长圆）、`In2_Cu` 正片信号层。缺陷都放在 8 个 5×5 mm 无铜无阻焊无字符的位置（`expected/spots.json`：A…G、P），每类**恰好命中一次**。

报告约定（M2 起）：每层每类**只有 1 条决策行**（error/warn + 问题点），明细行都是 warn 并带图上定位；所以下表「条数」= 明细 1 + 汇总 1。

## 内层（inner）

| 层 | 类型 | 级别 | 位置 | 数值 | 来源 |
|---|---|---|---|---|---|
| In1（负片） | `partition_line_width` | error + EQ | P 点横线 | 0.150 < 0.254 mm (10 mil) | p121 分区线 |
| In1（负片） | `isolation_ring` | error + EQ | 孔 X (73.114, -67.536) | 隔离环 0.199 < 0.254 | p120 隔离 PAD 10 mil |
| In1（负片） | `negative_no_clearance` | warn + EQ | 孔 Y (76.314, -67.536) | 无隔离 PAD | p120 |
| In1（负片） | `copper_to_edge` | warn（无 EQ） | 板边一圈 | 未削外围 15 mil | p121 削外围 |
| In2（正片） | `isolated_pad` | warn（无 EQ） | D 点 ⌀1.0 PAD | 无孔无连线 | p122 独立 PAD → NFP Removal |
| In2（正片） | `hole_to_copper` | error + EQ | 孔 H (75.514, -65.786) 上方的线 | 0.100 < 0.203 mm (8 mil) | p122 孔到线 |
| In2（正片） | `copper_to_edge` | warn + EQ | 左板边 x=20.2 的竖线 | 0.100 < 0.381 | p122 削外围 |
| In2（正片） | `line_compensation` | info | 全层 | 2 段 < 15 mil 需 +1 mil | p122 |

## 外层（outer）

| 层 | 类型 | 级别 | 位置 | 数值 | 来源 |
|---|---|---|---|---|---|
| F_Cu | `line_width` | error + EQ | A 点横线 | 0.076 (3 mil) < 0.100 | p135 / profile |
| F_Cu | `spacing` | error + EQ | B 点双线 | 0.050 < 0.100 | p135 间距 |
| F_Cu / B_Cu | `annular_ring` | error + EQ ×2 | C 点过孔 ⌀0.3 / PAD ⌀0.4 | 环宽 0.049 < 0.100 | p135 RING 环 |
| F_Cu / B_Cu | `npth_clearance` | error + EQ ×2 | C01 固有：NPTH 安装孔 | 0.183 < 0.305 | p122/p135 |
| F_Cu | `smd_pads` | info | 全层 | 158 + 新加 4 个无孔焊盘 | p137 |

## 阻焊（mask）

| 层 | 类型 | 级别 | 位置 | 数值 | 来源 |
|---|---|---|---|---|---|
| F_Mask | `opening_smaller_than_pad` | error + EQ | E 点 1.0×1.0 PAD / 0.6×0.6 开窗 | 露铜 0.64 mm² | p141 步骤 3 |
| F_Mask | `missing_opening` | error + EQ | F 点 1.0×1.0 PAD | 无开窗 | p143 Missing |
| F_Mask | `mask_sliver` | error + EQ | G 点两开窗 | 桥 0.050 < 0.076（绿油 3 mil） | p141 要求 5 |
| F/B_Mask | `mask_expansion` | warn | C01 固有：KiCad 开窗 = 焊盘 | 0 < 2 mil | p141 要求 1 |
| F/B_Mask | `npth_opening_small` | warn | C01 固有 | NPTH 开窗未预大 0.1 | p141 要求 1 |
| F/B_Mask | `via_mask_summary` | info | 过孔开窗 1 / 盖油 0（C 点过孔有开窗） | | p144 |

## 字符（silk）

| 层 | 类型 | 级别 | 位置 | 数值 | 来源 |
|---|---|---|---|---|---|
| F_Silkscreen | `silk_on_opening` | warn + EQ | E 点横穿开窗的线 | 距开窗 0 | p145 要求 2 |
| F_Silkscreen | `silk_line_width` | warn | A 点上方 0.10 线 + KiCad 固有 0.12 线 | < 0.127 (5 mil) | p145 要求 1 |
| F_Silkscreen | `silk_outside_profile` | warn，**已自动删除** | x=105 的 3 条线（板宽到 100） | 3 个对象 | p147 注意 4 |

成果物应出现 `Flashpads-F_Silkscreen_cleaned.gbr`（板外 3 条已删）。

## 也会出现但属预期

- align：`layer_offset` warn（板外字符把 F_Silk 的包围盒中心拉偏了）、`outside_profile` warn（同一 3 条线，M1 只计数）
- drill：10 把刀（多了 T7 ⌀0.3 via）、81 孔

## 不应出现

- 任何 `layer_parse_error`（合成的 In1/In2 必须能解析）
- inner 的 `line_width` / `spacing`（内层没有植入）、`npth_in_pad`
- B_Cu 的 `line_width` / `spacing`；B_Mask 的三类 error；`opening_not_pad`、`via_plug_too_large`
- silk 的 `silk_crossing_profile`（三条线完全在板外，不跨边）
