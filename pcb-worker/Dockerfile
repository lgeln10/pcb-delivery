# pcb-worker:PCB CAM 几何/解析/检查服务(Python 3.12 + gerbonara + shapely),供 AIOS modules/pcb-cam 通过 HTTP 调用。
# 构建:docker build -t pcb-worker:dev .
# 运行:docker run -p 8000:8000 -v uploads:/data/storage -v pcb-work:/data/work pcb-worker:dev
# ★基础镜像钉小版本(与 aios docker-compose 的约定一致:发版不碰浮动 tag)。
FROM python:3.12.9-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
# GEOS 由 shapely wheel 自带;unrar 给 rarfile 用(非自由许可,交付时若不允许可去掉,rar 输入会报「不支持」而非崩溃)
RUN apt-get update && apt-get install -y --no-install-recommends unrar-free ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.7.13 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY engine ./engine
RUN uv sync --frozen --no-dev
ENV PATH="/app/.venv/bin:$PATH" \
    PCB_STORAGE_ROOT=/data/storage \
    PCB_WORK_ROOT=/data/work
VOLUME ["/data/storage", "/data/work"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4).status==200 else 1)"
CMD ["uvicorn", "engine.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
