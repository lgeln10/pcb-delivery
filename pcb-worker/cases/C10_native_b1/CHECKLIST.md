# C10 本地几何引擎（B 线 B1）— 网页验收清单

前置：worker 以 `PCB_CAM_ENGINE=native` 启动（`.claude/launch.json` 的 pcb-worker 加该环境变量）。输入与 C05 相同（`input/board.zip`）。

1. 新建项目「C10 本地引擎」，上传 `input/board.zip`，层确认后继续。
2. **对齐**步骤：报告里「板外对象」项显示已执行（本地几何引擎已执行），并出现「本地几何引擎已执行 SetProfile…、DeleteOutsideProfile…」信息行。
3. 成果物列表多出「检查数据 changes_align.json」，打开能看到每条改动（before/after 符号名、坐标）。
4. **内层**步骤：In1 的「隔离环」「无隔离 PAD」为已执行；层预览切到 In1，孔位的隔离盘变大 / 新增。叠加对照 In1 与「原稿」（差异模式）能看到新增的削外围带。
5. **外层**步骤：F_Cu 的「NPTH 削铜」已执行；预览里 NPTH 孔周围出现清铜圆。「线宽 3mil」已执行（补偿到 4mil）；「间距」仍是 EQ（两条线不会被补偿到短路，报告参数 skipped_would_short=2）。
6. **阻焊**步骤：「开窗比焊盘大 <2mil」已执行；预览开窗略大。
7. **字符**步骤：不再有「板外字符」项（对齐阶段已删）。
8. Genesis 脚本草稿：已执行的块以 `# (lite 引擎已自动执行…)` 注释形式出现，不再有 COM 命令。
9. 任务报告 HTML 的「步骤结果」里能看到本地引擎执行行。
10. 重跑内层（EQ 放行后）不会再次改图（成果物 changes_inner.json 不增）。
