# PCB CAM

登录、组织与角色、系统设置、通知、审计，以及 PCB 制造。应用在 `standard-build/`，几何引擎在 `pcb-worker/`。

## 本地开发

```sh
cd standard-build
npm ci
cp .env.example .env.local
npm run dev
```

不设置 `DATABASE_URL` 时，使用内存数据库并写入演示租户。老板账号 `13800000001`，工程员 `13800000002`，密码 `demo-pass-123`。登录后进入 PCB CAM。

几何引擎：

```sh
cd pcb-worker
uv sync --frozen
uv run uvicorn engine.api.main:app --host 127.0.0.1 --port 8000
```

平台通过 `PCB_WORKER_URL` 调用引擎，本地设为 `http://127.0.0.1:8000`。

## 容器

```sh
cd standard-build
cp .env.docker.example .env
docker compose up -d --build
```

数据库迁移是一份当前结构的基线，给空库使用。
