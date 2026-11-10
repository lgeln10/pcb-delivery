# C03 各 stage 预期报告

板 = C01(`board.zip` 逐字节相同)+ 两个附件 `制作要求.xlsx` / `制作要求.pdf`。

| stage | status | items | 说明 |
|---|---|---|---|
| intake | ok | 0 | 13 files, 11 layers, 2 copper, **2 unmapped**(xlsx/pdf 按扩展名判 aux,不出 item、不进层确认表) |
| order_spec | ok(Node 侧) | — | LLM 候选见 order_spec.md;worker 侧 M1 占位 |
| align | ok | 2 info | 同 C01 |
| drill | **needs_review** | 2 error / 11 info | 收到确认后的 `order_spec.drill_table`,`compare_with_order_spec`(p113)报 2 条 `drill_table_mismatch` |

## 植入 → 应报出

| # | 植入 | 期望 item | severity | EQ |
|---|---|---|---|---|
| 1 | 钻孔表 PTH T03 写成 **1.2 mm**(Excellon 实际 1.0) | `drill_table_mismatch`:「钻孔表孔径 1.2 mm 在 Excellon 中找不到匹配工具」(最近的 1.1 差 0.1 > 容差 0.02) | error | 是:「钻孔表与 Excellon 不一致:钻孔表孔径 1.2 mm 在钻孔文件中不存在,请客户确认以哪个为准」 |
| 1' | 同一处的另一面 | `drill_table_mismatch` layer=PTH:「Excellon 工具 T03 1.0 mm ×40 不在钻孔表中」 | error | 是:「钻孔表与 Excellon 不一致:钻孔文件多出 1.0 mm ×40,请客户确认」 |

其余 8 行(含 3 行槽孔、2 行 NPTH)孔径与数量全部对上 → 不出 `drill_table_dia_diff`。

## 不应出现

- intake `layer_unrecognized`(xlsx 不能被当 zip 解开——worker 已修:`is_archive` 排除 .xlsx/.docx/.pptx)
- align 任何 error / warn
- Drill Checks 任何命中(板同 C01)

## 备注

- `make verify` 直接把 `input/order_spec.json` 当作「网页上确认后的规格」送给 drill stage,所以本地也能看到这 2 条 EQ;网页上要先经过 LLM 候选 + 人工确认,候选里 T03 应读出 1.2(见 order_spec.md)。
- 一个植入产生两条 EQ 是 `compare_with_order_spec` 的按行匹配逻辑决定的(先按规格找工具、再列出未匹配的 Excellon 工具);M2 可考虑把「一对孔径互不匹配」合并成一条。
