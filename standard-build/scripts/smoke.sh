#!/usr/bin/env bash
# scripts/smoke.sh — 一键演示:起内存演示库 → 走 org/partner/finance 真实业务流 → 打印每步返回。
# 用法:bash scripts/smoke.sh   (可选 PORT=xxxx 改端口,默认 3217)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3217}"
BASE="http://localhost:$PORT"
SECRET="smoke-secret"

echo "▶ 启动演示服务(PGlite 内存库 + seed 演示数据)..."
AUTH_SECRET="$SECRET" PORT="$PORT" npx tsx server.ts >/tmp/sb-smoke.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# 等服务起来
for i in $(seq 1 30); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

jqf() { python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d, ensure_ascii=False, indent=2))" 2>/dev/null || cat; }
get_token() { python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"; }

echo ""
echo "═══ 1) 未带 token 访问 → 应被拒(401) ═══"
curl -s -o /dev/null -w "GET /api/partners 无 token → HTTP %{http_code}\n" "$BASE/api/partners"

echo ""
echo "═══ 2) 老板登录 ═══"
BOSS=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"phone":"13800000001","password":"demo-pass-123"}')
echo "$BOSS" | jqf
BOSS_TOKEN=$(echo "$BOSS" | get_token)

echo ""
echo "═══ 3) 看组织/员工(老板是超管,放行) ═══"
curl -s "$BASE/api/org/employees" -H "Authorization: Bearer $BOSS_TOKEN" | jqf

echo ""
echo "═══ 4) 看客户列表(老板看到全部) ═══"
curl -s "$BASE/api/partners" -H "Authorization: Bearer $BOSS_TOKEN" | jqf

echo ""
echo "═══ 5) 销售小张登录,只看到自己建的客户(数据权限 SELF) ═══"
SALES_TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"phone":"13800000002","password":"demo-pass-123"}' | get_token)
echo "小张看到的客户数:"
curl -s "$BASE/api/partners" -H "Authorization: Bearer $SALES_TOKEN" | python3 -c "import sys,json;print('  ',len(json.load(sys.stdin)['items']),'个')"
echo "小张访问财务接口(无权限)→ 应 403:"
curl -s -o /dev/null -w "  GET /api/finance/accounts → HTTP %{http_code}\n" \
  "$BASE/api/finance/accounts" -H "Authorization: Bearer $SALES_TOKEN"

echo ""
echo "═══ 6) 财务报表(seed 已有一单销售11300+收款5000) ═══"
echo "利润表 2026-06:"
curl -s "$BASE/api/finance/reports/income?period=2026-06" -H "Authorization: Bearer $BOSS_TOKEN" | jqf
echo "资产负债表 截至 2026-06:"
curl -s "$BASE/api/finance/reports/balance-sheet?upto=2026-06" -H "Authorization: Bearer $BOSS_TOKEN" | jqf

echo ""
echo "═══ 7) 借贷不平的凭证 → 被拒(400 UNBALANCED) ═══"
CASH=$(curl -s "$BASE/api/finance/accounts" -H "Authorization: Bearer $BOSS_TOKEN" | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['items'] if a['code']=='1001'][0])")
BANK=$(curl -s "$BASE/api/finance/accounts" -H "Authorization: Bearer $BOSS_TOKEN" | python3 -c "import sys,json;print([a['id'] for a in json.load(sys.stdin)['items'] if a['code']=='1002'][0])")
curl -s -X POST "$BASE/api/finance/vouchers" -H "Authorization: Bearer $BOSS_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"voucherDate\":\"2026-06-20\",\"entries\":[{\"accountId\":\"$CASH\",\"direction\":\"debit\",\"amount\":\"100.00\"},{\"accountId\":\"$BANK\",\"direction\":\"credit\",\"amount\":\"99.99\"}]}" | jqf

echo ""
echo "✅ 演示结束。完整服务日志:/tmp/sb-smoke.log"
echo "   服务仍可手动起:AUTH_SECRET=xxx PORT=$PORT npx tsx server.ts"
