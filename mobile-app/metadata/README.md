# `metadata/` —— 应用商店文案

目录结构照搬 **fastlane deliver** 的约定(`<语言>/<字段>.txt`)。我们没用 fastlane
(见 `APP_STORE_RELEASE.md` §8.1),但按它的形状放:哪天要换,不用搬文件;
`scripts/asc.py` 之后补元数据上传时也按这个结构读。

```
metadata/
├── zh-Hans/            简体中文(主语言)
├── en-US/              英文
└── review-notes.txt    ★给审核员的备注 —— 不是文案,是防被拒的说明
```

## 字符上限(App Store Connect 的硬限制,超了直接拒收)

| 文件 | 上限 | 说明 |
|---|---|---|
| `name.txt` | 30 | 商店里显示的名字。★**要与软著登记的软件名称一致**,否则国内安卓商店过不了 |
| `subtitle.txt` | 30 | 名字下面那行 |
| `keywords.txt` | 100 | 逗号分隔,**不含空格**(空格会占字符);不要重复 name/subtitle 里已有的词 |
| `promotional_text.txt` | 170 | 可随时改、不用过审 —— 适合放限时信息 |
| `description.txt` | 4000 | 正文 |
| `release_notes.txt` | 4000 | 「新增内容」,每版都要改 |

跑 `python3 scripts/check-metadata.py` 校验长度。

## ★`review-notes.txt` 为什么单独存在

我们的登录第一步是**「输入服务器地址」**。审核员拿到账号密码也不知道该填什么,
大概率直接判「无法登录」退回 —— 这是本 App 被拒概率最高的一处,比 4.2「最小功能」还高。
那个文件就是用来堵这个洞的,提交时**必须**粘进 App Store Connect 的「审核备注」栏。
