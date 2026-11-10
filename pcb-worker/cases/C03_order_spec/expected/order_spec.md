# C03 预期规格候选(order_spec,Node/aios 侧 LLM)

附件:`制作要求.xlsx`(sheet「制作要求」)与 `制作要求.pdf`(同内容一页),都由 `make_input.py` 生成。

## 网页上应看到的候选

| 字段 | 候选值 |
|---|---|
| 层数 | 2 |
| 板厚 | 1.6 mm |
| 铜厚 | 1 oz |
| 表面处理 | 沉金 |
| 阻焊颜色 | 绿色 |
| 字符颜色 | 白色 |
| 最小线宽/线距 | 6/6 mil |
| 板材 | FR-4 TG150 |

**drill_table 应有 9 行**(与 C01 的 9 个刀具一一对应),其中 **PTH T03 = 1.2 mm**(附件故意写错;Excellon 实际 1.0):

| 文件 | 刀具 | 属性 | 孔径 mm | 数量 | 槽 |
|---|---|---|---|---|---|
| NPTH | T01 | NPTH | 0.65 | 3 | |
| NPTH | T02 | NPTH | 0.95 | 1 | |
| PTH | T01 | PTH | 0.70 | 14 | |
| PTH | T02 | PTH | 0.85 | 2 | |
| PTH | **T03** | PTH | **1.20** | 40 | |
| PTH | T04 | PTH | 1.10 | 4 | |
| PTH | T05 | PTH | 0.60 | 10 | 是 |
| PTH | T06 | PTH | 0.65 | 2 | 是 |
| PTH | T07 | PTH | 0.70 | 4 | 是 |

确认后的规格 JSON 应等价于 `input/order_spec.json`(`make verify` 直接用它送 drill stage)。

## 钻孔阶段

拿到确认规格后 worker drill stage 做 `compare_with_order_spec`(p113 核对孔径大小及孔数,容差 0.02 mm):
**EQ「钻孔表与 Excellon 不一致」×2**——「钻孔表孔径 1.2 mm 在钻孔文件中不存在」+「钻孔文件多出 1.0 mm ×40」。

## 租户没配模型时

候选是 `_llm: unavailable` + 附件文字预览(xlsx 单元格 / pdf 文本),drill_table 为空;此时手工按上表填,**也算通过**,但钻孔阶段的 EQ 只有在把 drill_table(含 1.2)填进确认规格后才会出现。
