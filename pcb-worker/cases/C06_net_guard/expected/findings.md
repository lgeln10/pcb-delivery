# C06 网络守门 — 应报出的项

板 = C05 + 三个网表缺陷（`make_input.py`，坐标在 `expected/spots.json` 的 S/O/R）。网名用 Gerber X2 `%TO.N` 注入，这是样板里唯一的真实网名（KiCad 样板全是 N/C）。

| 步骤 | 类型 | 级别 | 位置 | 说明 | 来源 |
|---|---|---|---|---|---|
| net_compare | `net_short` | error + EQ | F_Cu S 点：NET_A 焊盘 —0.25 线— NET_B 焊盘 | 两个设计网名连成一个生产网络 | p130 网络比较 |
| net_compare | `net_open` | error + EQ | F_Cu O 点：两个 NET_C 焊盘相距 3mm 无连接 | 同一网名分成 2 段（明细定位到小段） | p130 |
| net_compare | `net_open_after_reduce` | warn + EQ | In2 R 点：两个 1.5mm 方块角上重叠 0.05mm | 缩铜 0.15 后断成 2 段（内层 → 决策）；未被下调（内层正片最细画线 0.2） | p130 第二次减铜 |
| net_compare | `net_open_after_reduce_outer` | info | F_Cu 细线接窄焊盘处 | 外层只提示 | — |
| net_compare | `net_summary` | info | | 网络数 / 跨层数 / 比对结果 | |
| panel / output / gatekeeper | `panel_plan` / `gerber_output` / `drill_output` / `ipc356_output` / `gate_summary` | info | | 全部通过，不阻塞 | 第10/11章 |

C05 的全部项照旧（见 `../C05_four_layer_dfm/expected/findings.md`）。

## 不应出现
- `no_reference_netlist`（本案例有网名）、`net_reduce_capped`（内层最细画线 0.2 > 0.15）
- output 的 `roundtrip_diff`；gatekeeper 任何 error（回读一致）
