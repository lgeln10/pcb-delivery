# C06 网络守门 — 网页验收清单

输入：`input/board.zip`（C05 + 三个网表缺陷；`uv run python cases/C06_net_guard/make_input.py` 可重生成，坐标在 `expected/spots.json`）
本地比对：`make verify CASE=C06_net_guard`。

## 操作 → 勾选
- [ ] 1. 新建项目 `C06-NetGuard` → 上传 → 层确认（13 行，同 C05）→ 规格确认
- [ ] 2. 内层/外层/阻焊/字符四步共 15 条问题点，逐步处理（同 C05 清单 4–9）
- [ ] 3. 走到「网络比较」停下，问题点 **3 条**：短路 / 开路 / 内层减铜后开路
- [ ] 4. 「检查报告」选「网络比较」：`net_short` 明细「定位」→ 预览 F_Cu 放大到 S 点，看到两个圆焊盘被一条线连着；`net_open` 定位到 O 点两个焊盘之一；`net_open_after_reduce` 定位到 In2 R 点两个方块角接处
- [ ] 5. 报告里有 `net_summary`（网络数 > 200，跨层 > 70）和 `net_open_after_reduce_outer`（info，外层细线接窄焊盘，不需处理）
- [ ] 6. 「成果物」有 `netlist.json`（含 NET_A/NET_B 同在一个 names 列表的网络）
- [ ] 7. 处理完 3 条 → 拼板（1 条 info 方案）→ 输出 → 回读校验全绿 → 任务「已完成」；成果物含 `*.GTL … *.IPC` 与 `output_manifest.json`

## 不应出现
- `no_reference_netlist`、`net_reduce_capped`；output `roundtrip_diff`；gatekeeper error
