# C02 各 stage 预期报告

板 = C01,只改了 `Flashpads-PTH.drl` / `Flashpads-NPTH.drl` / `Flashpads-Edge_Cuts.gbr`(`make_input.py` 可重跑)。

| stage | status | items | 说明 |
|---|---|---|---|
| intake | ok | 0 | 同 C01:11 files, 11 layers, 2 copper |
| align | ok | 2 info | 同 C01(`layer_empty` B_Silkscreen、`profile_line_width` 0.254);**外形层多出的独立线段没有任何报告**(见下) |
| drill | **needs_review** | 2 error / 3 warn / 11 info | 下表 |

## 植入 → 应报出

| # | 植入(make_input.py) | 位置 | 期望 item | severity | EQ |
|---|---|---|---|---|---|
| 1 | 多余孔:PTH ⌀0.70 加在无铜处(距最近铜 9.4 mm) | (30.000, −35.000) | `extra_holes` layer=PTH,「孔 T01 ⌀0.7 mm @(30.000,-35.000) 不落在任何外层焊盘内」 | error | 是:「发现不属于任何 Pad 的多余孔,请客户确认是删除还是补焊盘」 |
| 2 | 重叠孔:PTH ⌀1.00 (40.259,−26.289) 复制到 X+0.05 | (40.259, −26.289) | `hole_separation`,「touching holes: T03 ⌀1.0 与 T03 ⌀1.0 边距 0.000 mm」,measured 0.0 / threshold 0.1 | error | 是:「发现重复/接触/过近的孔…p118」 |
| 3 | NPTH 近板边:NPTH ⌀0.65 加在距左边 0.15 mm | (20.475, −45.000) | `npth_to_rout` layer=NPTH,measured 0.15 / threshold 0.3 | warn | 否 |
| 4 | 缺孔:删掉 PTH ⌀1.10 @(22.18,−66.213),F/B_Cu 上的 ComponentPad 圆焊盘还在 | (22.180, −66.213) | `missing_holes` ×2(F_Cu 与 B_Cu 各一条),「非 SMD 焊盘 CircleAperture/ComponentPad … 中心无孔(启发式)」,measured 1.96 mm² | warn | 否 |
| 5 | 槽画在外形层:Edge_Cuts 末尾加一段 3 mm 独立开放线段 (60,−45)→(63,−45) | align | `outline_stray_segment` warn ×1 明细(定位到 (60–63, −45))+ 汇总 1 条带 EQ「若是槽请提供槽孔钻带或确认按锣槽处理」;Profile 仍是 80×50 矩形,**不报** `profile_not_closed` / `profile_extra_rings` | 3.0 mm | M2 ✓ |

## 不应出现

- intake / align 任何 error / warn(铜层未动,对齐不变)
- `profile_not_closed`、`profile_extra_rings`(悬空段不应把 Profile 搞坏)
- `drill_table_mismatch`(没有 order_spec)、`drill_plating_unknown`(%TF 仍在)

## 备注(以实际为准)

- 缺孔启发式(`check_missing_holes`)在本板稳定命中:要求焊盘是 Circle/Obround/Polygon 光圈或带 ComponentPad 属性、面积 ≥ 0.8 mm²;KiCad 的 THT 焊盘满足,所以没有标 skip。
- `missing_holes` / `npth_to_rout` 目前设计为 warn,不会成 EQ;工程师要在报告 tab 自己看。
- (已做,M2 W6)第 5 项:外形层悬空线段 → `outline_stray_segment` warn + EQ,fix op `DeleteOutsideProfile`(转槽/删除由工程师定)。
