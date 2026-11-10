# 部署

一台装了 Docker 的机器可以同时启动应用、PostgreSQL 和几何引擎。

```bash
cp .env.docker.example .env
# 填写 DB_PASSWORD、AUTH_SECRET、CONFIG_ENC_KEY、SITE_ADDRESS、PUBLIC_BASE_URL
docker compose up -d --build
docker compose logs -f app
```

空库会执行 `standard-build/core/db/migrations` 里的基线。演示数据：`SEED_DEMO=true`，账号见根目录 README。正式使用不要打开 `SEED_DEMO`。
