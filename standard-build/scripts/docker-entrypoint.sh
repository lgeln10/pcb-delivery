#!/bin/sh
# 容器入口:首次建管理员 → 自助开通 getdeployed → 启动服务(服务自身在启动时跑数据库迁移)。
set -e

echo "[entrypoint] AIOS starting…"
mkdir -p /app/uploads

# 首次运行:库为空时创建第一个租户/管理员,凭据打到容器日志(docker compose logs app)。幂等。
if [ -n "$DATABASE_URL" ]; then
  node dist-server/bootstrap.mjs || echo "[entrypoint] bootstrap skipped/failed (通常=库里已有账号)"
fi

# 自助开通 getdeployed(agent 引擎):设了 MANAGEMENT_URL+ENROLL_TOKEN 时,出站登记到 Management,
# 拿回 workspace/PAT 写进 /app/uploads/.env(持久化卷)。幂等(.enrolled 标记在同卷,重启跳过)。
if [ -n "$MANAGEMENT_URL" ] && [ -n "$ENROLL_TOKEN" ]; then
  ( cd /app/uploads && node /app/dist-server/self-enroll.mjs ) || echo "[entrypoint] self-enroll skipped/failed"
fi
# 载入 enroll 写回的 GETDEPLOYED_*(若有)→ 让本进程用上
if [ -f /app/uploads/.env ]; then
  set -a
  . /app/uploads/.env 2>/dev/null || true
  set +a
fi

# 启动服务(createDatabase 会在此自动应用未执行的迁移)
exec node dist-server/server.mjs
