#!/usr/bin/env bash
# 发一个版本:算版本号 -> 生成 changelog -> 写进 CHANGELOG.md -> commit + tag + push。
#
#   scripts/release.sh --dry-run    # 只打印会发什么,不动仓库(周报里用这个预览)
#   scripts/release.sh              # 真发
#
# 版本号用 CalVer vYYYY.M.D(跟公司其它仓一致)。同一天再发一次 -> vYYYY.M.D.1、.2……
#
# ★release commit 只改 CHANGELOG.md。CI 的 push 触发器有 paths-ignore '**/*.md',
#   所以发版不会白跑一遍 17 分钟的测试、也不会触发一次无意义的重新部署。
set -euo pipefail

cd "$(dirname "$0")/.."
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "base" ]; then
  # 预览可以在任何分支跑(周报只是想看看「现在发会发出什么」);真发版必须在 base
  [ "$DRY" = 1 ] && echo "注意:当前在 $BRANCH,不是 base,下面的预览内容不代表实际发版范围。" >&2 \
                 || { echo "!! 只能在 base 分支发版(当前 $BRANCH)" >&2; exit 1; }
fi

if [ "$DRY" = 0 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "!! 工作区不干净,先提交或清理" >&2; exit 1; }
  git fetch origin base --quiet
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/base)" ] \
    || { echo "!! 本地 base 与 origin/base 不一致,先同步" >&2; exit 1; }
fi

# ---- 版本号 ---------------------------------------------------------------
BASE_VER="v$(date +%Y).$(date +%-m).$(date +%-d)"
VER="$BASE_VER"; n=1
while git rev-parse -q --verify "refs/tags/$VER" >/dev/null; do
  VER="$BASE_VER.$n"; n=$((n + 1))
done

PREV="$(git describe --tags --abbrev=0 2>/dev/null || true)"

if [ -z "$PREV" ]; then
  # ★起点版本:仓库此前没有任何 tag。不把几百条历史提交倒推成 changelog
  #   (那是一堵没人会读的墙),只立一个基准点,从下一版开始才有真正的变更记录。
  COUNT=0
  SECTION="## $VER — $(date +%Y-%m-%d)

起点版本。本仓库此前没有版本记录，历史提交不倒推整理；自本版本起，每次发版的变更都记录在下面。

当前线上：<https://base.sixamtech.ai>（提交 \`$(git rev-parse --short HEAD)\`）"
else
  COUNT="$(git log --no-merges --oneline "$PREV..HEAD" | wc -l | tr -d ' ')"
  if [ "$COUNT" = "0" ]; then
    echo "自 $PREV 起没有新提交,不需要发版。"
    exit 0
  fi
  SECTION="## $VER — $(date +%Y-%m-%d)

自 $PREV 起 $COUNT 个提交。

$(bash scripts/changelog.sh "$PREV" HEAD)"
fi

if [ "$DRY" = 1 ]; then
  echo "=== 预览(未改动任何东西) ==="
  echo "$SECTION"
  exit 0
fi

# ---- 写 CHANGELOG.md ------------------------------------------------------
HEADER='# 更新日志

本文件由 `scripts/release.sh` 从 conventional commit 自动生成，不要手改历史条目。
版本号是 CalVer `vYYYY.M.D`；同一天多次发版追加 `.1`、`.2`。
'
if [ -f CHANGELOG.md ]; then
  # 把新版本插在 header 之后、上一个版本之前
  python3 - "$SECTION" <<'PY'
import sys, io
section = sys.argv[1]
p = 'CHANGELOG.md'
txt = open(p, encoding='utf-8').read()
i = txt.find('\n## ')
if i == -1:
    out = txt.rstrip() + '\n\n' + section + '\n'
else:
    out = txt[:i + 1] + section + '\n' + txt[i + 1:]
open(p, 'w', encoding='utf-8').write(out)
PY
else
  printf '%s\n%s\n' "$HEADER" "$SECTION" > CHANGELOG.md
fi

git add CHANGELOG.md
git commit -m "chore(release): $VER"
git tag -a "$VER" -m "$VER"
git push origin base
git push origin "$VER"

echo
if [ "$COUNT" = 0 ]; then
  echo "已发布 $VER(起点版本;从下一版开始会列出自上一版以来的全部变更)"
else
  echo "已发布 $VER($COUNT 个提交,自 $PREV)"
fi
echo "tag  : $(git rev-parse --short "$VER")"
echo "线上 : https://base.sixamtech.ai （代码未变，本次发版不触发重新部署）"
