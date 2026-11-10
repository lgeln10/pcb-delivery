# C07 拼板 + 输出 — 网页验收清单

输入：`input/board.zip`（= C01）。**先在「工厂标准」里建一个标准**：名称 `C07`，YAML 视图粘贴 `input/profile.yaml` 的内容 → 校验 → 保存 → 设为默认；再新建项目时选这个标准。规格确认时把 `input/order_spec.json` 的拼板要求填进去（或上传后在候选里补）。
本地比对：`make verify CASE=C07_panel_output`（verify 会自动把 profile.yaml / order_spec.json 送给 worker）。

## 操作 → 勾选
- [ ] 1. 「工厂标准」对话框：新建 → 表单视图筛 `panel` → 改 `panel.working_panels_mm` 为 `[[406.4, 508.0]]`、`panel.rail_mm` 为 `10`；筛 `output.stem` 改 `C07` → 切 YAML 视图看到只含这几个键 → 校验通过 → 保存并设默认
- [ ] 2. 新建项目 `C07-Panel`（工厂标准选 C07）→ 上传 → 层确认（11 行）→ 规格确认（panelization 填客户要求）
- [ ] 3. 外层停下 2 条（C01 固有）→ 处理 → 阻焊/字符/网络比较不停
- [ ] 4. 「拼板」停下 1 条：`panel_customer_spec`；「检查报告」选「拼板」：`panel_plan` 写 **4×9=36 只 / 406.4×508 / 利用率 69.8%**
- [ ] 5. 「层预览」下拉选「拼板预览(_panel)」：看到工作板矩形、虚线工艺边、36 个单只轮廓、顶部标注
- [ ] 6. 「成果物」有 `panel.json`（candidates 2 个）、`panel.svg`
- [ ] 7. 处理拼板决策 → 「输出」「回读校验」通过 → 任务「已完成」
- [ ] 8. 「成果物」：`C07.GTL … C07.GKO`（9 个）、`C07.TXT`、`C07-NPTH.TXT`、`C07.IPC`、`output_manifest.json`、`genesis_*.csh`；下载 `C07.GTL` 头两行是 `%MOIN*%` / `%FSLAX24Y24*%`
- [ ] 9. 「检查报告」选「回读校验」：`gate_summary` 写「9/9 层面积一致，钻带 80 孔（与钻孔表一致），IPC-D-356 一致；不一致 0 项」

## 不应出现
`panel_no_fit`；output `roundtrip_diff`；gatekeeper error；任务被 blocked
