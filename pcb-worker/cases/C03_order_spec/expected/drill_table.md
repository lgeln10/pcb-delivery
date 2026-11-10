# C03 钻孔预期(stage = drill)

Excellon 同 C01 → 孔表、预大、钻带与 `../../C01_two_layer_clean/expected/drill_table.md` 完全一致(9 工具 80 孔,全部 info)。

多出的只有 `order_spec.drill_table` 比对结果:

| 钻孔表行 | Excellon | 结果 |
|---|---|---|
| PTH T03 1.20 ×40 | 无 1.20;最近 1.10(差 0.1 > 0.02) | `drill_table_mismatch` error + EQ |
| — | PTH ⌀1.00 ×40 | 未被任何钻孔表行匹配 → `drill_table_mismatch` error + EQ |
| 其余 8 行 | 孔径、数量、槽全对 | 无 item(连 `drill_table_dia_diff` info 也没有) |
