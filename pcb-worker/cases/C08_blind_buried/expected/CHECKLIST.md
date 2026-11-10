# C08 盲埋孔 — 网页验收清单

输入：`input/board.zip`（`uv run python cases/C08_blind_buried/make_input.py` 可重生成）。本地比对：`make verify CASE=C08_blind_buried`。

## 操作 → 勾选
- [ ] 1. 新建项目 `C08-BlindBuried` → 上传 → 层确认表 **17 行**：In1..In4 = 内层 L2–L5（极性列「正片」）；`Flashpads-L1-L2.drl` / `L2-L5.drl` 类型 = 盲埋钻孔，依据列含「span L1-L2」「span L2-L5」→ 确认
- [ ] 2. 规格确认 → 「检查报告」选「钻孔」：4 个文件、83 孔；孔表里三个 ⌀0.2 via 预大 0
- [ ] 3. 外层停 2 条（C01 固有）→ 处理；内层/阻焊/字符不停
- [ ] 4. 「网络比较」停 1 条 `net_open`（BUR）；「定位」→ 预览 F_Cu 放大到 BUR 点的 L1 焊盘
- [ ] 5. 「成果物」`netlist.json`：名为 TH 的网络 layers 含 6 层；BV 含 F_Cu + In1；BUR 有两个（一个 In1..In4，一个只有 F_Cu）
- [ ] 6. 处理后 → 拼板 → 输出：「成果物」有 4 套钻带，其中 `*-1-2.TXT`、`*-2-5.TXT`
- [ ] 7. 「流程单」：板型「六层板 盲埋孔」类别 6 层盲孔模板（p216 或 p218），要求项含「钻带 L1-L2」「L2-L5」字样；叠层图 6 层、三条钻孔 span
- [ ] 8. 回读校验通过 → 任务「已完成」

## 不应出现
`net_short`；`L1-L2.drl` 被识别成普通 PTH（span 丢失会让 #4 的 net_open 消失）；inner 步骤有 error
