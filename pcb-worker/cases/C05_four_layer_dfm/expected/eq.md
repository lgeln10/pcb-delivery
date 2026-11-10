# C05 应生成的问题点（EQ）— 15 条

每层每类 1 条（明细在检查报告里带「定位」）。网页「问题点决策」面板应列出：

| # | 步骤 | 层 | 类型 | 问题文案要点 |
|---|---|---|---|---|
| 1 | 内层 | In1_Cu | partition_line_width | 线宽低于 0.254 mm，可否加大 |
| 2 | 内层 | In1_Cu | isolation_ring | 负片隔离环低于 0.254 mm，可否加大隔离 PAD |
| 3 | 内层 | In1_Cu | negative_no_clearance | 有孔位没有隔离/散热 PAD，会直接连铜面，确认设计意图 |
| 4 | 内层 | In2_Cu | hole_to_copper | 孔到铜低于 0.203 mm，可否移线/缩 PAD |
| 5 | 内层 | In2_Cu | copper_to_edge | 铜距板边不足 0.381 mm，削外围会削到 |
| 6 | 外层 | F_Cu | line_width | 线宽低于 0.100 mm |
| 7 | 外层 | F_Cu | spacing | 间距低于 0.100 mm |
| 8 | 外层 | F_Cu | annular_ring | 环宽低于 0.100 mm，可否加大焊盘 |
| 9 | 外层 | F_Cu | npth_clearance | 非金属孔到铜不足 0.305 mm，可否削铜（C01 固有） |
| 10 | 外层 | B_Cu | annular_ring | 同 8（过孔底面 PAD） |
| 11 | 外层 | B_Cu | npth_clearance | 同 9 |
| 12 | 阻焊 | F_Mask | opening_smaller_than_pad | 开窗小于焊盘，按焊盘加大 |
| 13 | 阻焊 | F_Mask | missing_opening | 焊盘无开窗，是否需要开窗 |
| 14 | 阻焊 | F_Mask | mask_sliver | 阻焊桥低于绿油最小 0.076 mm，是否合并开窗 |
| 15 | 字符 | F_Silkscreen | silk_on_opening | 字符压开窗，CAM 会用阻焊掏字符；上大铜皮开窗需确认 |

注意：pipeline 在 **inner** 就会停下等这 5 条决策，处理完继续才会跑 outer；所以网页上是分四次看到（5 → 6 → 3 → 1），不是一次 15 条。

不应出现的 EQ：`npth_in_pad`、`via_plug_too_large`（没给 order_spec 塞孔要求）、`silk_crossing_profile`、`opening_not_pad`。
