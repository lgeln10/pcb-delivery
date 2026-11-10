# C07 拼板 + 输出 — 应报出的项

板 = C01（无植入）。输入多两份：`input/profile.yaml`（工厂标准覆盖：只用 406.4×508 工作板、工艺边 10、间距 2、输出主名 `C07`）和 `input/order_spec.json`（客户拼板要求原文、绿油）。

| 步骤 | 类型 | 级别 | 内容 | 来源 |
|---|---|---|---|---|
| panel | `panel_plan` | info | 工作板 406.4×508，**4×9 = 36 只**，旋转 0°，利用率 69.8%；候选 2 个（旋转 90° 为 7×5 = 35） | p152 建立 panel |
| panel | `panel_customer_spec` | warn + EQ | 客户要求「2×3 拼板，V-CUT，工艺边 5mm 加 mark 点（参考上一版本）」→ SET 按客户，生产 panel 按工厂 | p149/p151 |
| output | `gerber_output` | info | 9 层，`C07.GTL / GBL / GTS / GBS / GTO / GBO / GTP / GBP / GKO`，inch 2.4 absolute zeros none，最大 round-trip 差异 0.82%（字符层，按周长×量化允许） | p157 |
| output | `drill_output` | info | `C07.TXT`（PTH 预大）、`C07-NPTH.TXT` | p158 |
| output | `ipc356_output` | info | `C07.IPC` 76 个通孔测试点（实验性） | — |
| gatekeeper | `gate_ipc_ok` / `gate_summary` | info | 9/9 层面积一致、80 孔一致、IPC 一致、不一致 0 项 | 守门 |

## 计算核对（拼板）
单只 80×50，工作板 406.4×508，板边 10，间距 2：
- 旋转 0°：⌊(386.4+2)/82⌋ = 4，⌊(488+2)/52⌋ = 9 → 36
- 旋转 90°：⌊388.4/52⌋ = 7，⌊490/82⌋ = 5 → 35

## 不应出现
`panel_no_fit`、`roundtrip_diff`、`gerber_write_error`、gatekeeper 任何 error、net_compare 任何 error
