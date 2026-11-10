# C04 各 stage 预期报告

板 = C01,文件全部改名并删掉每个文件里的 `%TF.…*%` 与 `; #@! TF.…` 行(`make_input.py`)。识别只能走名字/扩展名/内容规则。

| stage | status | items | 说明 |
|---|---|---|---|
| intake | ok(!) | 1 error / 8 warn / 1 info | 3 layers identified, **0 copper**, 8 unmapped;见下。worker 的 intake 只在 %SR 时 blocked,其它情况 status 仍 ok,EQ 由 item 决定 |
| align | ok | 2 info | **人工确认层后**同 C01:`layer_empty` ssb.gbr、`profile_line_width` outline.gbr |
| drill | ok | 11 info | **人工确认层后**同 C01;drill.txt 被确认成 drill_pth,plated 预大 +0.15,不出 `drill_plating_unknown` |

## intake 实际(2026-09-05 测得,以实际为准)

| 文件 | 规则路径 | type | 置信度 | needs_llm | item |
|---|---|---|---|---|---|
| outline.gbr | 名字 `^(profile|outline|…)$` | outline | 0.90 | 否 | — |
| npth.txt | Excellon M48 + 名字含 npth | drill_npth | 0.90 | 否 | — |
| drill.txt | Excellon M48,名字无 pth/npth,文件里无 `;TYPE=PLATED` | drill_unknown | 0.65 | **是** | `layer_low_confidence` info |
| top.art / bot.art | `.art` 是 Gerber 扩展名但没有名字规则命中「top」「bot」;内容 sniff 只知道是 Gerber | unknown | 0.30 | **是** | `layer_unrecognized` warn ×2 |
| smt/smb/sst/ssb/spt/spb.gbr | 这些缩写只在**扩展名表**里(`.smt` 等),做主文件名时无规则 | unknown | 0.30 | **是** | `layer_unrecognized` warn ×6 |
| — | 0 铜层 | | | | `missing_layer` error + EQ「资料中未找到线路层,请客户确认文件是否齐全」 |

满足验收底线:钻孔文件都识别成「是钻孔」(npth.txt 高置信、drill.txt 低置信),外形高置信;铜层/阻焊/字符/锡膏全部要人工指定。

## 确认后(expected/layer_map.json 的 `confirm_as`)

top.art→top_copper L1、bot.art→bottom_copper L2、smt/smb→top/bottom_mask、sst/ssb→top/bottom_silk、spt/spb→top/bottom_paste、drill.txt→drill_pth。
之后 align / drill 与 C01 完全一致(孔表见 drill_table.md)。

## 不应出现

- `sr_not_expanded`、`stackup_odd`
- 确认后 align / drill 任何 error / warn;特别是 `drill_plating_unknown`(如果出现,说明确认层时 drill.txt 没有改成 drill_pth)

## worker 改进点(记录,不在本案例修)

- `classify_by_name` 应把主文件名 == 扩展名表键(`smt.gbr` → `.smt`)也当作规则命中(约 0.85);`top.art` / `bot.art` 可加 `^(top|bot|bottom)$` → copper 0.75 规则
- `.art` 目前只当 Gerber 扩展名,没有 Cadence Allegro 风格的名字规则
