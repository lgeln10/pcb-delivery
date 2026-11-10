# C01 各 stage 预期报告

| stage | status | items | 说明 |
|---|---|---|---|
| intake | ok | 0 | 11 files, 11 layers identified, 2 copper, 0 unmapped |
| order_spec | ok | 0 | 无附件 → 候选为 `_llm: ok` + `_note: 没有可读的制作要求附件…`;M1 worker 侧占位 |
| align | ok | 2 info | `layer_empty`:B_Silkscreen 无图形;`profile_line_width`:外形线宽 0.254 ≠ 0.15,fix `set_profile_line_width`(auto_fixable=false,附 Genesis 脚本建议) |
| drill | ok | 11 info | 见 drill_table.md |
| inner … gatekeeper | ok | 0 | M1 占位「not implemented in M1」 |

## 不应出现

- 任何 `severity=error` / `warn`
- `sr_not_expanded`(本板无 %SR)
- `layer_offset` / `outside_profile`(各层与钻孔层对齐,板外无物件)
- `needs_llm=true` 的文件
