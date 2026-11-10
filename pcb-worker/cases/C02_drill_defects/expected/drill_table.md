# C02 钻孔预期(stage = drill)

来源:C01 的 `Flashpads-PTH.drl` / `Flashpads-NPTH.drl` 副本,由 `make_input.py` 植入 4 处钻孔缺陷(见 findings.md)。
预大规则同 C01:plated +0.15 / non_plated +0.05,钻嘴 0.05 取整;无 via。

| 文件 | 工具 | 属性 | 成品孔径 mm | 钻嘴 mm | 数量 | 槽 | 相对 C01 |
|---|---|---|---|---|---|---|---|
| NPTH | T01 | non_plated | 0.65 | 0.70 | **4** | | +1(近板边 NPTH) |
| NPTH | T02 | non_plated | 0.95 | 1.00 | 1 | | |
| PTH | T01 | plated | 0.70 | 0.85 | **15** | | +1(多余孔) |
| PTH | T02 | plated | 0.85 | 1.00 | 2 | | |
| PTH | T03 | plated | 1.00 | 1.15 | **41** | | +1(重叠孔) |
| PTH | T04 | plated | 1.10 | 1.25 | **3** | | −1(缺孔) |
| PTH | T05 | plated | 0.60 | 0.75 | 10 | G85 槽 | |
| PTH | T06 | plated | 0.65 | 0.80 | 2 | G85 槽 | |
| PTH | T07 | plated | 0.70 | 0.85 | 4 | G85 槽 | |

合计:9 工具、**82 孔**(plated 77 / non_plated 5),16 个 G85 槽孔。

注意:worker 的 drill stage 按 (孔径, 镀孔, 槽) 分组后**重新编号** T01…,所以报告里的 T 号和 Excellon 文件里的 T 号不同
(例如多余孔在文件里挂在 `T3`,报告里显示 `T01 ⌀0.7`)。

## 报告项

- 9 条 `drill_oversize` info(同 C01,数量变化如上)
- 1 条 `hole_size` 汇总:plated 77 孔 / 7 工具(0.6~1.1),non_plated 5 孔 / 2 工具(0.65~0.95)
- 1 条 `power_ground_shorts` info(M1 占位)
- **Drill Checks 命中**(详见 findings.md):`extra_holes` ×1 error、`hole_separation` ×1 error、`missing_holes` ×2 warn、`npth_to_rout` ×1 warn

## 成果物

- `Flashpads-NPTH_oversized.drl`、`Flashpads-PTH_oversized.drl`:预大钻带(含植入的孔,worker 不删)
- `drill_table.json`:`total_holes = 82`,`checks = {extra_holes: 1, hole_separation: 1, missing_holes: 2, npth_to_rout: 1}`
