# knowledge/ — 《CAM工程技能培训》知识库

从 `source/CAM工程技能培训.pdf`（219 物理页，Genesis 2000 CAM 工程培训教材）的文字层重建，
替代 v1 的 `docs/cam-knowledge/`（已删除，其中只有 3 KB glossary / 空洞 process_params，图片已迁入本目录）。

## 目录

| 路径 | 内容 | 数量 |
|---|---|---|
| `source/CAM工程技能培训.pdf` | 原始教材 | 1 |
| `chapters/00..17_*.md` | 各章正文，按页分段（`<!-- page:N -->`） | 18 |
| `rules/*.yaml` | 可检索规则条目，每条带 `source_page` + 原文 `quote` | 15 文件 / 451 条 |
| `glossary.json` | 第一章第二节 PCB 术语中英对照 | 367 条 |
| `images/<章>/<页>_<序>.png` | 教材截图/插图 | 292 |
| `images_index.json` | 图片索引 `[{path, page, chapter, description}]` | 292（缺描述 0） |
| `workflow_analysis.md` | 第 1–17 章流程梳理（目的逻辑 / 步骤 / 规则 / 自动化标注） | 544 行 |
| `legacy/CAM第4-11章流程梳理.md` | 修订前的第 4–11 章流程梳理（仅存档） | 1 |

## 各类文件的来源与可信度

| 文件 | 来源 | 可信度 |
|---|---|---|
| `chapters/*.md` | `pdftotext` 文字层**逐字**提取，仅做分页/标题标记 | 高：与 PDF 文字层一致，可 `pdftotext -f N -l N` 回查。注意：教材大量内容在截图内（如菜单路径、参数值），文字层没有的信息不在 chapters 里 |
| `rules/*.yaml` | 从各章正文归纳，每条 `quote` 为原文逐字片段，`source_page` 为物理页码 | 高：`quote` 可在对应页 pdftotext 输出中检索到。**例外**：① `layer_naming.yaml` 中 13 条层名规则（GTO/GTS/GTL/L2…/GBL/GBS/GBO/rout/drill）来自 p41 页面渲染的转录，标 `quote_source: page_render`；② `output_format.yaml` 各参数值（Units/Coordinates/Zeroes/Number format 等）来自 p158 两张截图 `images/11_文件输出/158_1.png`、`158_2.png`，p158 文字层只有两个标题 |
| `glossary.json` | 第一章第二节 p6–14 术语表原文 | 高：逐条对应，含 `no`/`zh`/`en`/`category`/`page` |
| `images/` | 从 PDF 抽取的位图，文件名 = 物理页码_页内序号 | 原样 |
| `images_index.json` | `description` 由人/模型**看图**写的中文描述，非 OCR | 中：描述准确性依赖读图；用于检索"哪张图讲什么"，不要当原文引用 |
| `workflow_analysis.md` | 第 4–11 章基于 legacy 版本并与原文逐页核对修订；第 1–3、12–17 章新写。自动化标注（【脚本】【AI判断】【人工】）是归纳判断，不是教材内容 | 中：归纳性文档；修订处均以"（修订：…）"或"（注：…）"标出并给页码 |

## 页码约定

全部使用 **PDF 物理页码**（`pdftotext -f N -l N` 的 N，也是 `images/` 文件名和 `<!-- page:N -->` 的 N）。
教材内印刷页码 = 物理页码 − 2（封面、目录各占一页）。例：第五章"钻孔制作"印刷页 111 = 物理页 113。

## 如何检索

```bash
# 原文关键词 → 章节与页
grep -rn "预大" knowledge/chapters            # 命中后向上找最近的 <!-- page:N -->
# 规则条目（含数值）
grep -n "0.15\|预大" knowledge/rules/drill.yaml
grep -rn "id: soldermask" knowledge/rules/
# 术语
python3 -c "import json;print([g for g in json.load(open('knowledge/glossary.json')) if '阻焊' in g['zh']])"
# 图片：找某页/某主题的截图
python3 -c "import json;print([i for i in json.load(open('knowledge/images_index.json')) if 'Drill Tools' in i['description']])"
# 回 PDF 核对
pdftotext -f 118 -l 118 -layout knowledge/source/CAM工程技能培训.pdf - | less
```

`grep -rl "预大" knowledge/chapters knowledge/rules` 当前命中 4 个文件：
`chapters/05_钻孔制作.md`、`chapters/07_外层资料制作.md`、`rules/drill.yaml`、`rules/outer.yaml`。

## 校验记录（2026-09-05）

- `rules/*.yaml`：15 个文件全部可用 PyYAML 加载，共 451 条，`id` 无重复。
- `images_index.json`：292 条，每个 `path` 在 `images/` 下均存在；`images/` 中没有未索引的图片（缺描述 0，无 `auto` 条目）。
- 随机抽 5 条规则，用 `pdftotext -f N -l N` 取 `source_page` 页文本，去空白后检索 `quote`：

| 文件 | id | source_page | quote（截断） | 结果 |
|---|---|---|---|---|
| outer.yaml | outer.check.ring_and_spacing | 135 | VIA，PTH孔的RING环是否够大。间距是否做够要求 | PASS |
| impedance.yaml | impedance.factor.spacing_direct | 186 | 相邻线路与线路之间的间距,与阻抗值成正比（差动阻抗） | PASS |
| gold_finger.yaml | gold_finger.outer_layer.no_copper_pour | 160 | 金手指的表层不要铺铜 | PASS |
| silkscreen.yaml | silkscreen.step.fix_width_height | 146 | 文字线宽没达到要求的直接改为相应尺寸、或在原来基础上加大也行 | PASS |
| mi_flow_templates.yaml | mi.flow.hdi.6L_2stage | 216 | 一次钻埋孔 钻带L3-L4：程序 | PASS |

- `workflow_analysis.md` 相对 legacy 版本的三处实质修订（均已回 PDF 核对）：
  1. 第四章：`"+1"` 是板属性**层**的副本（p111 "把所有板属性的复制一个"+1"放在下面"），不是备份 step；step 只有 Orig / net / Edit。
  2. 第六章：删去"掏铜不能掏断连铜线导致短路"（原文无）；p130 讲的是第二次减铜 0.15MM 网络比较检查 <0.15MM 连铜线导致**开路**。
  3. 第十一章：删去"教材注明工厂普遍已脚本化"（p156–158 无此话；"脚本"出自 p118 钻孔输出、p155 板边）；补入 p158 截图中的 Gerber274x / Excellon2 输出参数。
  另加两处注：第七章 Tolerance "如1或1.5" 为举例非范围（p135）；第八章光标点开窗有"相切/少许上铜皮可缩小"的例外（p144）。
