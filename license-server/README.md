# License 服务（厂商侧托管）

零依赖单文件 Node 服务。给各客户 AIOS 做心跳校验 + 远程**吊销 / 续期**。私钥只在这里。

## 部署（你们服务器）
```bash
# 1) 生成密钥对（一次性）：公钥填进 AIOS 的 core/license/verify.ts EMBEDDED_PUBLIC_KEY
node ../standard-build/scripts/license-keygen.mjs   # 生成 license-private.pem / license-public.pem

# 2) 起服务
LICENSE_ADMIN_TOKEN=<强随机串> \
LICENSE_PRIVATE_KEY_FILE=./license-private.pem \
LICENSE_STORE_FILE=./licenses.json \
PORT=8787 \
node server.mjs
```
用 systemd 常驻 + Caddy 反代到 `https://license.<你们域名>`。

## 接口
| 方法 | 路径 | 权限 | 用途 |
|---|---|---|---|
| POST | `/issue` | x-admin-token | 签发 license：`{customer,seats,days,graceDays?}` → `{licenseId,license,...}` |
| POST | `/heartbeat` | 公开 | 客户 AIOS 每天调：`{licenseId}` → `{revoked,expiresAt}` |
| POST | `/revoke` | x-admin-token | 吊销：`{licenseId}` |
| POST | `/renew` | x-admin-token | 续期：`{licenseId,days}` |
| GET | `/admin/licenses` | x-admin-token | 列出所有授权 + 最近心跳 |
| GET | `/health` | 公开 | 健康检查 |

## 给客户开通
```bash
curl -X POST -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"customer":"客户A","seats":50,"days":365}' https://license.<域名>/issue
```
把返回的 `license` 放进客户 `.env` 的 `LICENSE_KEY`，并设 `LICENSE_SERVER_URL=https://license.<域名>`。
之后随时 `/revoke` 停用、`/renew` 续期，客户端次日心跳生效（吊销/续期无需重新部署客户）。
