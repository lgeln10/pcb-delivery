#!/usr/bin/env bash
# 线上冒烟:部署之后验证 base.sixamtech.ai 真的活着、且跑的是期望的那一版。
#
#   scripts/smoke.sh                  # 只验存活
#   scripts/smoke.sh <expected-sha>   # 额外验线上版本 == 这个 commit
#   SMOKE_BASE_URL=https://... scripts/smoke.sh
#
# ★为什么每一项都按「内容」判定而不是状态码:
#   Caddy 配的是 SPA fallback(`try_files {path} /index.html`),所以**任意**非 /api 路径
#   都会 200 + 返回 index.html。实测 /version.json、/definitely-not-a-real-path 全是 200。
#   只看状态码的冒烟在这套 Caddy 下永远绿 —— 那是假阳性,不是检查。
#   同一个原因也让「前端 chunk 掉了」变得隐蔽:缺失的 /assets/xxx.js 同样 200 + HTML,
#   浏览器拿 HTML 当 JS 解析 → 白屏,而任何看状态码的探针都说一切正常。
set -uo pipefail

BASE="${SMOKE_BASE_URL:-https://base.sixamtech.ai}"
EXPECT_SHA="${1:-}"
FAILED=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=1; }
head_ () { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "1. 后端存活"
body="$(curl -sS -m 15 "$BASE/api/health" 2>/dev/null)"
code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BASE/api/health" 2>/dev/null)"
if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"ok"'; then
  ok "/api/health 200 且返回 ok"
else
  bad "/api/health -> code=$code body=$(printf '%s' "$body" | head -c 80)"
fi

head_ "2. 鉴权链路活着（不是 502/503）"
code="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BASE/api/crm-dashboard/summary" 2>/dev/null)"
case "$code" in
  401|403) ok "受保护接口返回 $code —— 后端在跑且鉴权生效" ;;
  5*)      bad "受保护接口返回 $code —— 后端挂了或迁移失败" ;;
  *)       bad "受保护接口返回 $code —— 预期 401/403" ;;
esac

head_ "3. 前端首页"
html="$(curl -sS -m 15 "$BASE/" 2>/dev/null)"
if printf '%s' "$html" | grep -qi '<!doctype html'; then
  ok "首页返回 HTML"
else
  bad "首页不是 HTML: $(printf '%s' "$html" | head -c 80)"
fi

head_ "4. 前端产物真的在（白屏故障的唯一有效探针）"
# SPA fallback 让缺失的 chunk 也回 200 + HTML,所以必须看返回体是不是 JS
asset="$(printf '%s' "$html" | grep -oE '(src|href)="/assets/[^"]+\.js"' | head -1 | sed -E 's/.*"(\/assets[^"]+)".*/\1/')"
if [ -z "$asset" ]; then
  bad "首页里找不到 /assets/*.js 引用 —— 构建产物可能是空的"
else
  a_body="$(curl -sS -m 20 "$BASE$asset" 2>/dev/null | head -c 400)"
  if printf '%s' "$a_body" | grep -qi '<!doctype html'; then
    bad "$asset 返回的是 HTML 而不是 JS —— chunk 掉了,线上白屏"
  elif [ -z "$a_body" ]; then
    bad "$asset 返回空"
  else
    ok "$asset 返回真实 JS"
  fi
fi

head_ "5. 线上版本"
v_body="$(curl -sS -m 15 "$BASE/version.json" 2>/dev/null)"
live_sha="$(printf '%s' "$v_body" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("sha",""))
except Exception:
    print("")' 2>/dev/null)"
if [ -z "$live_sha" ]; then
  if [ -n "$EXPECT_SHA" ]; then
    # 带期望 sha = 刚部署完:这次部署自己就写了 version.json,读不回 JSON 只有两种可能 ——
    # 静态发布失败,或 /version.json 被 SPA/官网 HTML 兜底吞掉。哪种都是坏,必须红。
    # (旧行为是降级成警告跳过 —— 那正是「版本校验绿着失明」的入口。)
    bad "/version.json 不是合法 JSON: $(printf '%s' "$v_body" | head -c 80) —— 发布失败或被 HTML 兜底吞掉"
  else
    # 手动只验存活(不带 sha)时才容忍:目标环境可能压根没有版本标记机制
    printf '  \033[33m!\033[0m /version.json 不是合法 JSON,版本校验本次跳过（未提供期望 sha）\n'
  fi
elif [ -n "$EXPECT_SHA" ]; then
  if [ "${live_sha:0:8}" = "${EXPECT_SHA:0:8}" ]; then
    ok "线上版本 ${live_sha:0:8} == 期望 ${EXPECT_SHA:0:8}"
  else
    bad "线上版本 ${live_sha:0:8} != 期望 ${EXPECT_SHA:0:8} —— 部署没生效或被别的部署顶掉了"
  fi
else
  ok "线上版本 ${live_sha:0:8}"
fi

echo
if [ "$FAILED" = 0 ]; then
  echo "冒烟全部通过"
else
  echo "冒烟失败 —— 线上有问题"
fi
exit "$FAILED"
