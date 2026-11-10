#!/usr/bin/env bash
# 从 conventional commit 生成一段 changelog(markdown 到 stdout)。
#
#   scripts/changelog.sh                 # 上一个 tag ..HEAD
#   scripts/changelog.sh v2026.7.24      # 指定起点 ..HEAD
#   scripts/changelog.sh v2026.7.24 v2026.7.31
#
# 仓库里 93% 的提交带 conventional 前缀(feat/fix/docs/refactor/chore/ci/style/test/perf),
# 不带前缀的归到「其他」,merge commit 直接丢掉。
set -euo pipefail

FROM="${1:-}"
TO="${2:-HEAD}"

if [ -z "$FROM" ]; then
  FROM="$(git describe --tags --abbrev=0 "$TO^" 2>/dev/null || true)"
fi
RANGE="${FROM:+$FROM..}$TO"

emit() { # emit <前缀正则> <小节标题>
  local pat="$1" title="$2" body
  body="$(git log --no-merges --pretty='%h%x09%s' "$RANGE" \
    | awk -F'\t' -v pat="$pat" '
        {
          msg = $2
          if (match(msg, "^(" pat ")(\\([^)]*\\))?!?: ")) {
            rest = substr(msg, RLENGTH + 1)
            scope = ""
            if (match(msg, "\\(([^)]*)\\)")) scope = substr(msg, RSTART + 1, RLENGTH - 2)
            printf "- %s%s (`%s`)\n", (scope ? "**" scope "** " : ""), rest, $1
          }
        }')"
  [ -n "$body" ] && printf '### %s\n\n%s\n\n' "$title" "$body"
  return 0
}

emit 'feat'              '新功能'
emit 'fix'               '修复'
emit 'perf'              '性能'
emit 'refactor'          '重构'
emit 'docs'              '文档'
emit 'test'              '测试'
emit 'chore|ci|style|build' '工程'

# 不带任何已知前缀的(约 6%),别丢掉,单独列出来提醒补前缀
other="$(git log --no-merges --pretty='%h%x09%s' "$RANGE" \
  | awk -F'\t' '!/^[^\t]*\t(feat|fix|perf|refactor|docs|test|chore|ci|style|build)(\([^)]*\))?!?: /{printf "- %s (`%s`)\n", $2, $1}')"
[ -n "$other" ] && printf '### 其他（提交信息未带 conventional 前缀）\n\n%s\n\n' "$other"

exit 0
