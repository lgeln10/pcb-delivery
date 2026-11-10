# AIOS 本地化部署镜像。多阶段:构建期编译前端 + 打包压缩后端;运行期只放压缩产物(不含源码/测试/文档)。
# 源码保护:后端经 esbuild 打成压缩混淆 bundle,镜像里没有 pristine 源码。

# ---- 构建阶段 ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 前端 → dist/;后端 → dist-server/server.mjs(压缩) + bootstrap.mjs + migrations/
RUN npm run web:build && node scripts/build-server.mjs

# ---- agent 运行时已移除 ----
# 本仓不再托管数字员工进程。
# ---- 运行阶段 ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 只装生产依赖(去掉 tsx/vite/esbuild/drizzle-kit 等构建期工具)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# 只拷压缩产物 —— 没有 core/ modules/ src/ 源码目录
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh && mkdir -p /app/uploads
# ★备份要用的 `pg_dump` / `pg_restore`。**不装的话备份功能整个是死的** ——
#   `core/backup` 默认 `BACKUP_ENABLED=true`,每天 03:00 跑,而 `BACKUP_PG_DUMP` 默认就是裸
#   `pg_dump`;镜像里没有它,备份每天失败一次,而告警只发站内信(没人会登进来看)。
#
# ★★**必须从 PGDG 装,不能用发行版自带的那个。** node:22-slim 是 Debian 12(bookworm),
#   自带 `postgresql-client` 是 **15.19**,而我们 compose 里的库是 **postgres:16** ——
#   pg_dump 拒绝导出比自己新的服务端(`server version: 16.x; pg_dump version: 15.x`,直接 abort)。
#   2026-08-19 在 node:22-slim 里实打过这两个版本号。装完只有 7.1MB。
#
# ★★**放在这里(所有 COPY 之后)不是随意的**:2026-08-19 第一版把它插在 `npm ci` 之前,
#   于是后面每一层的缓存全被冲掉 —— 推镜像时要把整个运行阶段(1.1GB)重新传去北京,
#   构建 3 分钟跑完、在 `exporting to image` 上挂了 58 分钟。
#   **在这个文件里加东西之前,先想一遍它会冲掉哪些层** —— 尤其是 npm ci 那一层。
#
# ★大版本必须与 docker-compose.yml 里的 `postgres:` 镜像**一致**,
#   有测试对账(core/backup/tests/pg-client-version.test.ts)—— 升库不升它,备份就在升级当晚死掉。
ARG PG_MAJOR=16
# ★APT 镜像源(可选)。**空着 = 行为与以前一字不差**,海外构建机(godeploy 在 AWS)不传就好。
#   国内构建机必须传:2026-08-29 在 118.196.97.238 上实测同一个 12MB 的 Packages 索引 ——
#     deb.debian.org  33 KB/s(25 秒只拉到 837KB)
#     mirrors.volces.com 1.26 MB/s   ← 快 38 倍(同云内网)
#   这一层原来要 **40 分钟**,而它排在 COPY --from=build 之后,所以**每一次代码改动都要付一遍**。
#   换源后压到一分钟内 —— 这比调层顺序划算得多,也就不用去动上面那条"放在这里不是随意的"。
#   PGDG 单独一个:apt.postgresql.org 从国内是 106 KB/s,阿里云那份 622 KB/s。
#   ★★APT_MIRROR 必须给 **http://**,不能给 https —— 这一层要装的正是 ca-certificates,
#     在它装上之前 apt 验不了 TLS,报 "Certificate verification failed",然后 curl/gnupg
#     全变成 "Unable to locate package",构建当场红(2026-08-29 实打过)。
#     apt 靠仓库 GPG 签名校验包,http 是标准做法。PGDG 那个可以是 https:轮到它时
#     ca-certificates 已经装好了。
ARG APT_MIRROR=
ARG PGDG_MIRROR=https://apt.postgresql.org/pub/repos/apt
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s#https\?://deb.debian.org#$APT_MIRROR#g; s#https\?://security.debian.org#$APT_MIRROR#g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null || true; \
    fi \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    # ★curl 必须带超时:构建里一个无超时的网络调用会把整条流水线挂住(2026-08-19 自己踩过)
    && curl -fsSL --max-time 60 --retry 3 --retry-delay 2 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
         https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] $PGDG_MIRROR bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends "postgresql-client-$PG_MAJOR" \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/* \
    # 装完当场验大版本 —— 装成 15 的话备份是**每天静默失败**,而这里能在构建期红。
    && pg_dump --version | grep -q " $PG_MAJOR\." \
    && pg_restore --version | grep -q " $PG_MAJOR\."

# ★TZ:定时任务用进程本地时区。node:22-slim 默认 UTC,这里固定东八区。
ENV FRONTEND_DIST=/app/dist \
    UPLOAD_DIR=/app/uploads \
    TZ=Asia/Shanghai \
    PORT=3005
EXPOSE 3005
ENTRYPOINT ["./docker-entrypoint.sh"]
