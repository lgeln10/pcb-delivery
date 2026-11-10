# C04 钻孔预期(stage = drill,人工确认层之后)

Excellon 内容同 C01,只是改名并去掉 `; #@! TF.FileFunction` 行:

| 文件 | 原文件 | 确认为 | 属性来源 |
|---|---|---|---|
| `drill.txt` | Flashpads-PTH.drl | drill_pth | 文件里无 TF、名字无 pth → 全靠层确认表选 drill_pth |
| `npth.txt` | Flashpads-NPTH.drl | drill_npth(自动 0.9) | 名字含 npth |

孔表与 `../../C01_two_layer_clean/expected/drill_table.md` 完全一致(9 工具 80 孔;plated +0.15 / non_plated +0.05),只是文件列换成 drill.txt / npth.txt;成果物名 `drill_oversized.drl`、`npth_oversized.drl`。

如果层确认时把 drill.txt 留成 `drill_unknown`:7 把工具 76 孔预大按 0、多一条 `drill_plating_unknown` error + EQ —— 这是「没确认对」的信号,不是本案例的预期。
