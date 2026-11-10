#!/usr/bin/env bash
# deploy_production.sh — 增量生产部署脚本
#
# 调用方式: 由 start_deploy.sh 在 git pull 之后调用（确保执行的是最新版本）
# 不要直接运行此脚本；否则可能执行旧版本逻辑。
#
# 参数:
#   --full        强制全量构建（npm + 前端 + 后端 + 迁移），忽略上次部署版本记录
#   --nginx-only  跳过代码构建/迁移/重启，只重写 nginx 配置并申请/续期 HTTPS 证书
#
# 增量逻辑:
#   package.json / package-lock.json  → npm ci + 前端重建 + 后端重启
#   src/ index.html vite.config.ts
#   modules/*/ui/  core/ui-kit/  core/*/ui/  → npm run web:build
#   server.ts  core/(非 ui 目录)
#   modules/(非ui/)  seed/            → npm run db:migrate + pm2 restart
#   两类都改了                         → 先建前端再重启后端
#   每次部署都会执行幂等数据库迁移;即使当前代码版本未变化,也会补跑漏掉的迁移。
#
# .env 必填项（写在项目根 .env 文件）:
#   DATABASE_URL   PostgreSQL 连接串
#   AUTH_SECRET    JWT 签名密钥（32 位以上随机字符串）
#
# .env 可选项:
#   PORT           后端监听端口，默认 3005
#   PM2_APP_NAME   PM2 进程名，默认 standard-build
#   DOMAIN         管理端域名，设置后自动生成/更新 nginx 配置并自动申请 HTTPS
#   WEBSITE_DOMAIN 企业官网域名(如 www.kehu.com)。设置后一键启用官网:构建 dist-website、
#                  生成官网 nginx server 块(页面反代 Node 做 SEO/JSON-LD 注入,assets 静态直出)、
#                  证书随管理端一并申请(--expand)、并向后端注入 WEBSITE_DIST/WEBSITE_HOST。
#                  不设 = 不构建不启用,行为与从前完全一致。
#                  ★与 WEBSITE_HOST 互为兜底:只在 .env 里配了 WEBSITE_HOST(Node 侧变量名)
#                  同样会启用官网,任填一个即可(同 DOMAIN/NGINX_SERVER_NAME 的处理)。
#   CERTBOT_EMAIL  Let's Encrypt 证书申请邮箱，默认 webmaster@<DOMAIN>
#   DEPLOY_RECORD  版本记录文件路径，默认 <项目根>/.deploy_version
#   BOOTSTRAP_TENANT_NAME      生产空库首次初始化租户名，默认 默认企业
#   BOOTSTRAP_ADMIN_NAME       生产空库首次初始化管理员姓名，默认 管理员
#   BOOTSTRAP_ADMIN_PHONE      生产空库首次初始化管理员手机号，默认 13800000001
#   BOOTSTRAP_ADMIN_PASSWORD   生产空库首次初始化管理员密码；不填则自动生成并写入 .env

set -euo pipefail

# ── 参数解析 ──────────────────────────────────────────────────────────────────
# --full：忽略版本记录强制全量。--nginx-only：只配 nginx，跳过构建/迁移/重启。
NGINX_ONLY=false
FORCE_FULL=false
for _arg in "$@"; do
  [[ "$_arg" == "--nginx-only" ]] && NGINX_ONLY=true
  [[ "$_arg" == "--full" ]]       && FORCE_FULL=true
done

# ── 路径与颜色 ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[deploy $(date '+%H:%M:%S')]${NC} $*"; }
ok()   { echo -e "${GREEN}[deploy $(date '+%H:%M:%S')]${NC} ${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy $(date '+%H:%M:%S')]${NC} ${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}[deploy $(date '+%H:%M:%S')]${NC} ${RED}✗${NC} $*" >&2; exit 1; }
step() { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}"; }

# ── 加载 .env ─────────────────────────────────────────────────────────────────
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1090
  source "$SCRIPT_DIR/.env"
  set +o allexport
  log "已加载 .env"
fi

# ── 必填检查 ──────────────────────────────────────────────────────────────────
[[ -z "${DATABASE_URL:-}" ]] && die "DATABASE_URL 未设置。请在 .env 中配置。"
[[ -z "${AUTH_SECRET:-}" ]]  && die "AUTH_SECRET 未设置。请在 .env 中配置。"

APP_NAME="${PM2_APP_NAME:-standard-build}"
PORT="${PORT:-3005}"
# 域名变量两种叫法互为兜底：旧脚本/本脚本用 DOMAIN，fund 派生版用 NGINX_SERVER_NAME。
# 任填一个即可，避免变量名不一致导致 server_name 为空 → 404。
DOMAIN="${DOMAIN:-${NGINX_SERVER_NAME:-}}"
# 企业官网域名(可选):设置即启用官网(modules/website + website/ SPA,详见其 MODULE.md 部署节)。
# 与 WEBSITE_HOST(Node 进程用的变量名)互为兜底——用户在 .env 里配哪个都启用,防变量名对不上被静默跳过。
WEBSITE_DOMAIN="${WEBSITE_DOMAIN:-${WEBSITE_HOST:-}}"
DOMAIN_URL_SCHEME="http"
DEPLOY_RECORD="${DEPLOY_RECORD:-$SCRIPT_DIR/.deploy_version}"
IS_FIRST_DEPLOY=false

can_root() {
  [[ $EUID -eq 0 ]] || sudo -n true >/dev/null 2>&1
}

run_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# 以 postgres OS 用户跑命令（建库/改 pg_hba 用）。
as_pg() {
  if [[ $EUID -eq 0 ]]; then sudo -u postgres "$@"
  else sudo -n -u postgres "$@"
  fi
}

# 包管理器抽象：Alibaba Cloud Linux/RHEL 用 dnf/yum，Debian/Ubuntu 用 apt-get。
pkg_install() {
  if command -v dnf &>/dev/null; then run_root dnf install -y "$@"
  elif command -v yum &>/dev/null; then run_root yum install -y "$@"
  elif command -v apt-get &>/dev/null; then run_root apt-get update && run_root apt-get install -y "$@"
  else die "未找到包管理器（dnf/yum/apt-get），无法自动安装: $*"
  fi
}

# ── 确保 PM2 已安装（防御性）────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  log "PM2 未安装，正在安装..."
  npm install -g pm2
  ok "PM2 安装完成"
fi

# ── 当前 / 上次版本 ───────────────────────────────────────────────────────────
CURR_VERSION=$(git rev-parse HEAD)
CURR_SHORT="${CURR_VERSION:0:8}"
PREV_VERSION=$(cat "$DEPLOY_RECORD" 2>/dev/null || echo "")
PREV_SHORT="${PREV_VERSION:0:8}"

step "版本分析"
log "当前代码: ${BOLD}$CURR_SHORT${NC}$(git log -1 --format=' — %s' HEAD)"
[[ -n "$PREV_VERSION" ]] && log "上次部署: ${BOLD}$PREV_SHORT${NC}" || log "上次部署: （首次）"

if [[ "$NGINX_ONLY" == true ]]; then
  log "--nginx-only:跳过版本检查与代码构建,直接重写 nginx 配置"
elif [[ "$FORCE_FULL" == true ]]; then
  log "--full:强制全量构建,忽略版本记录"
elif [[ "$PREV_VERSION" == "$CURR_VERSION" ]]; then
  ok "已是最新部署版本;仍会执行幂等数据库迁移。"
fi

# ── 分析变更文件 ──────────────────────────────────────────────────────────────
DO_NPM=false
DO_FRONTEND=false
DO_BACKEND=false
DO_WEBSITE=false   # 官网前端(website/ → dist-website);仅 WEBSITE_DOMAIN 非空时真正构建

if [[ "$NGINX_ONLY" == true ]]; then
  : # 只配 nginx:DO_* 全保持 false,下方迁移/重启/初始化均跳过
elif [[ "$FORCE_FULL" == true || -z "$PREV_VERSION" ]]; then
  [[ -z "$PREV_VERSION" ]] && { log "首次部署 → 执行完整构建"; IS_FIRST_DEPLOY=true; } || log "强制全量 → 执行完整构建"
  DO_NPM=true
  DO_FRONTEND=true
  DO_BACKEND=true
  DO_WEBSITE=true
else
  if ! git cat-file -e "${PREV_VERSION}^{commit}" 2>/dev/null; then
    warn "上次版本 $PREV_SHORT 在当前 git 历史中不存在（可能曾 force push），执行完整部署"
    DO_NPM=true; DO_FRONTEND=true; DO_BACKEND=true; DO_WEBSITE=true
  else
    # --relative:仓库根可能在上层(monorepo,本应用在子目录),git diff 默认输出带子目录前缀
    # (如 standard-build/core/...),会让下方 ^core/、^src/ 等规则全部漏判 → 前端/后端永不重建。
    # --relative 把路径裁成相对脚本所在目录(已 cd 到 SCRIPT_DIR),并自动只看本应用子树。
    CHANGED=$(git diff --name-only --relative "$PREV_VERSION" "$CURR_VERSION")
    if [[ -z "$CHANGED" ]]; then
      warn "git diff 无文件变更;仍会执行幂等数据库迁移"
    else
      log "变更文件列表:"
      echo "$CHANGED" | sed 's/^/  /'

      changed_any() { echo "$CHANGED" | grep -qE "$1"; }

      if changed_any '^package(-lock)?\.json$'; then
        log "检测到依赖变更 → 触发完整重建"
        DO_NPM=true; DO_FRONTEND=true; DO_BACKEND=true; DO_WEBSITE=true
      fi

      # 前端文件:src/、index.html/vite/tsconfig、core/ui-kit/、core/*/ui/(如 core/org/ui)、modules/*/ui/
      if changed_any '^(src/|index\.html$|vite\.config\.ts$|tsconfig\.json$|core/ui-kit/|core/[^/]+/ui/)' || \
         echo "$CHANGED" | grep -qE '^modules/[^/]+/ui/'; then
        DO_FRONTEND=true
      fi

      # 官网前端文件:website/ 与其独立 vite 配置
      if changed_any '^(website/|vite\.website\.config\.ts$)'; then
        DO_WEBSITE=true
      fi

      # 后端文件:server.ts、drizzle.config、seed/、core/(非 ui:既非 ui-kit 也非 core/*/ui)、modules/(非 ui)
      if changed_any '^(server\.ts$|drizzle\.config\.ts$|seed/)' || \
         { echo "$CHANGED" | grep -E '^core/' | grep -qvE '^core/(ui-kit/|[^/]+/ui/)' 2>/dev/null || false; } || \
         { echo "$CHANGED" | grep -E '^modules/' | grep -qvE '^modules/[^/]+/ui/' 2>/dev/null || false; }; then
        DO_BACKEND=true
      fi
    fi
  fi
fi

# nginx-only 跳过迁移;其余部署始终执行幂等迁移(补跑漏掉的迁移)。
if [[ "$NGINX_ONLY" == true ]]; then DO_MIGRATE=false; else DO_MIGRATE=true; fi

# 本仓已去掉企业官网。环境里若还留着 WEBSITE_DOMAIN,也不再构建 website/。
DO_WEBSITE=false
WEBSITE_DOMAIN=""

log "执行计划 → npm_install=${BOLD}$DO_NPM${NC}  前端构建=${BOLD}$DO_FRONTEND${NC}  官网构建=${BOLD}$DO_WEBSITE${NC}  数据库迁移=${BOLD}$DO_MIGRATE${NC}  后端重启=${BOLD}$DO_BACKEND${NC}  仅配nginx=${BOLD}$NGINX_ONLY${NC}"

if [[ "$NGINX_ONLY" == false && "$DO_NPM" == false && "$DO_FRONTEND" == false && "$DO_BACKEND" == false ]]; then
  warn "无构建/重启目标;仍会执行数据库迁移并重写 nginx 后更新版本记录"
fi

# ── Step 1: 安装 Node 依赖 ────────────────────────────────────────────────────
# ★为什么要重试:这一步是**整条部署里唯一依赖公网的环节**,一次抖动就让发版整个失败
#   (2026-08-25 线上:拉 ip2region 那个 ~11MB 的包 read ETIMEDOUT,部署止步于此)。
#   `npm ci` 是幂等的(它先清 node_modules 再装),重试安全。
#   npm 自带的 --fetch-retries 只在它认得的错误上生效,对 read ETIMEDOUT 常常不重试,
#   所以外面再包一层整命令重试 —— 两层各管各的。
# ★registry 不写死:机器在境内还是境外,合适的源不一样(境内机配 npmmirror 快得多,
#   境外机配了反而绕远)。用 NPM_REGISTRY 环境变量给部署方一个出口,不设就用默认源。
if [[ "$DO_NPM" == true ]]; then
  step "安装 Node 依赖"
  # npm ci:只读 lock file、绝不改写 → 保持工作树干净(避免外层 git pull 撞上脏 package-lock.json)。
  # 前提是 lock file 与 package.json 同步 —— 已由 CI/提交流程保证;不同步时此处会明确报错而非静默漂移。
  npm_ci_args=(--fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000)
  if [[ -n "${NPM_REGISTRY:-}" ]]; then
    npm_ci_args+=(--registry="$NPM_REGISTRY")
  fi
  npm_attempt=1
  until npm ci "${npm_ci_args[@]}"; do
    if (( npm_attempt >= 3 )); then
      die "npm ci 连续 3 次失败 —— 这一步几乎总是网络问题,不是代码问题。\n         · 站点仍在跑旧版本,没有进入半坏状态,可以从容重试\n         · 直接重跑本次部署通常就过\n         · 持续失败就给这台机设 NPM_REGISTRY(境内机用 https://registry.npmmirror.com)"
    fi
    warn "npm ci 第 ${npm_attempt} 次失败(多为网络抖动)→ 20s 后重试"
    sleep 20
    npm_attempt=$((npm_attempt + 1))
  done
  ok "依赖安装完成"
fi

# ── Step 2: 构建前端 ──────────────────────────────────────────────────────────
if [[ "$DO_FRONTEND" == true ]]; then
  step "构建前端"
  # ★内存受限服务器(≈2G RAM)上 Node 会把 V8 堆自动限到 ~880M,而本仓前端体量大、
  #   vite/rollup 打包峰值需 ~1G 堆 → 报「JavaScript heap out of memory」中止部署。
  #   这里显式抬高堆上限;若服务器 RAM < 2G,还需加 swap(见 DEPLOY.md「构建 OOM」)。
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=2048"
  # 生产构建不能有 VITE_API_BASE_URL（会被烧进产物），前端通过 window.location.origin 走 nginx 同域代理
  unset VITE_API_BASE_URL
  npm run web:build
  ok "前端构建完成 → dist/"
  unset NODE_OPTIONS  # 抬高的堆上限只作用于前端构建,不带进后续迁移/管理员初始化步骤
fi

# ── Step 2b: 构建官网前端（仅 WEBSITE_DOMAIN 已配置时）────────────────────────
if [[ "$DO_WEBSITE" == true ]]; then
  step "构建官网前端"
  unset VITE_API_BASE_URL
  npm run website:build
  ok "官网构建完成 → dist-website/"
fi

# ── 官网环境变量注入 ──────────────────────────────────────────────────────────
# Node 按 Host 分发官网(core/http/app.ts):WEBSITE_DIST 指产物目录,WEBSITE_HOST 匹配请求域名。
# export 后由下方 pm2 start/restart --update-env 带给后端进程,不需要手改 .env。
if [[ -n "$WEBSITE_DOMAIN" ]]; then
  export WEBSITE_DIST="${WEBSITE_DIST:-$SCRIPT_DIR/dist-website}"
  # .env 里配了相对路径(如 dist-website)→ 归一成绝对路径:pm2 resurrect/重启后 cwd 不保证
  [[ "$WEBSITE_DIST" != /* ]] && export WEBSITE_DIST="$SCRIPT_DIR/$WEBSITE_DIST"
  export WEBSITE_HOST="${WEBSITE_HOST:-$WEBSITE_DOMAIN}"
fi

# ── Step 2.5: 本机数据库准备 ──────────────────────────────────────────────────
# 全新服务器自动装 PostgreSQL、起服务、建用户/库、配 pg_hba 密码认证，使迁移可直接连库。
# 仅当 DATABASE_URL 指向本机（localhost/127.0.0.1）时执行；远程库只检查连通性。
# 用 node 解析 URL（密码含特殊字符也安全），与 node-postgres 实际发送一致。
_node_url() { node -e "process.stdout.write($1)" -- "$DATABASE_URL"; }
DB_HOST=$(_node_url "new URL(process.argv[1]).hostname")
_dbport=$(_node_url "new URL(process.argv[1]).port"); DB_PORT="${_dbport:-5432}"
DB_USER=$(_node_url "new URL(process.argv[1]).username")
DB_PASS=$(_node_url "decodeURIComponent(new URL(process.argv[1]).password)")
DB_NAME=$(_node_url "new URL(process.argv[1]).pathname.slice(1)")

if [[ "$NGINX_ONLY" == true ]]; then
  log "仅配 nginx,跳过数据库准备"
elif [[ "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ]]; then
  step "本机数据库准备"

  pg_ready() {
    if command -v pg_isready &>/dev/null; then pg_isready -h 127.0.0.1 -p "$DB_PORT" >/dev/null 2>&1
    else as_pg psql -p "$DB_PORT" -tAc 'SELECT 1' >/dev/null 2>&1; fi
  }
  # 定位服务端二进制（PGDG:/usr/pgsql-NN/bin；Debian:/usr/lib/postgresql/NN/bin；RHEL默认源:/usr/bin）
  pg_bindir() {
    local d
    for d in /usr/pgsql-*/bin /usr/lib/postgresql/*/bin; do
      [[ -x "$d/postgres" ]] && { echo "$d"; return 0; }
    done
    command -v pg_ctl &>/dev/null && { dirname "$(command -v pg_ctl)"; return 0; }
    return 1
  }

  PG_BIN="$(pg_bindir || true)"
  if [[ -z "$PG_BIN" ]]; then
    log "PostgreSQL 服务端未安装，正在安装..."
    pkg_install postgresql-server || pkg_install postgresql
    PG_BIN="$(pg_bindir || true)"
    [[ -z "$PG_BIN" ]] && die "PostgreSQL 安装后仍未找到服务端二进制，请手动检查。"
    ok "PostgreSQL 服务端安装完成（$PG_BIN）"
  else
    log "PostgreSQL 服务端已安装 ✓（$PG_BIN）"
  fi

  # 主版本号从 postgres/pg_ctl --version 取（不依赖路径含版本号；RHEL 默认源在 /usr/bin）。|| true 防 set -e。
  PG_VER="$( { "$PG_BIN/postgres" --version 2>/dev/null || "$PG_BIN/pg_ctl" --version 2>/dev/null; } | grep -oE '[0-9]+' | head -1 || true)"

  # 数据目录未初始化时 initdb（RHEL/PGDG 需手动；Debian 包装时已自动建 cluster）
  #
  # 先整段判断「本机是否已有任一 cluster」再决定要不要 initdb——机器上可能被别的服务先装过
  # PostgreSQL，也可能是本项目上一次部署自己建的。缺这道闸时：第一个候选目录（已初始化）只让
  # if 为假，而 break 写在 if 内、循环不停，于是第二个候选 /var/lib/pgsql/data 必然进 if；
  # 但 postgresql-NN-setup initdb 动的是 systemd 单元里的 PGDATA（/var/lib/pgsql/NN/data）
  # 而不是循环变量 _dd，于是对着已有数据报 "Data directory is not empty!"，整个部署 exit 1。
  # 这条死角只在 RHEL/PGDG 机器上醒（Debian 系没有 /var/lib/pgsql，两轮 -d 都假、整段空转），
  # 所以 base 自己发布从来碰不到；youtucoating 是第一台 RHEL 机。
  PG_EXISTING_DATA=""
  for _dd in "/var/lib/pgsql/${PG_VER}/data" "/var/lib/pgsql/data" /var/lib/pgsql/*/data \
             "/var/lib/postgresql/${PG_VER}/main" /var/lib/postgresql/*/main; do
    if [[ -f "${_dd}/PG_VERSION" ]]; then PG_EXISTING_DATA="$_dd"; break; fi
  done

  if [[ -n "$PG_EXISTING_DATA" ]]; then
    # 复用已有实例：下面建用户/建库/改 pg_hba 都是叠加，不动别的服务已有的库与规则。
    log "PostgreSQL 数据目录已存在 ✓（$PG_EXISTING_DATA），跳过 initdb"
  else
    for _dd in "/var/lib/pgsql/${PG_VER}/data" "/var/lib/pgsql/data"; do
      [[ -d "$(dirname "$_dd")" ]] || continue
      # postgresql-NN-setup / postgresql-setup 自己决定 PGDATA（读 systemd 单元），不认 _dd；
      # 只有兜底的裸 initdb 才真用 _dd。日志按实际执行的那条写，别报一个它不会碰的目录。
      if [[ -x "${PG_BIN}/postgresql-${PG_VER}-setup" ]]; then
        log "初始化 PostgreSQL 数据目录（postgresql-${PG_VER}-setup，PGDATA 由 systemd 单元决定）..."
        run_root "${PG_BIN}/postgresql-${PG_VER}-setup" initdb
      elif command -v postgresql-setup &>/dev/null; then
        log "初始化 PostgreSQL 数据目录（postgresql-setup，PGDATA 由 systemd 单元决定）..."
        run_root postgresql-setup --initdb
      else
        log "初始化 PostgreSQL 数据目录（${_dd}）..."
        as_pg "${PG_BIN}/initdb" -D "$_dd"
      fi
      ok "数据目录已初始化"; break
    done
  fi

  # 确保服务在运行（服务名因发行版/版本而异）
  if pg_ready; then
    log "PostgreSQL 已在运行 ✓"
  else
    log "启动 PostgreSQL..."
    for _svc in "postgresql-${PG_VER}" postgresql "postgresql@${PG_VER}-main"; do
      run_root systemctl enable --now "$_svc" 2>/dev/null || true
      pg_ready && break
    done
    pg_ready || die "PostgreSQL 无法启动或未就绪（127.0.0.1:${DB_PORT}）。请手动排查 systemctl status postgresql。"
    ok "PostgreSQL 已就绪"
  fi

  # 建/同步用户（scram 存储，与下面 pg_hba 的 scram-sha-256 对齐）
  if as_pg psql -p "$DB_PORT" -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" 2>/dev/null | grep -q 1; then
    as_pg psql -p "$DB_PORT" -c "SET password_encryption='scram-sha-256'; ALTER USER \"${DB_USER}\" WITH PASSWORD '${DB_PASS}';"
    ok "数据库用户 $DB_USER 密码已同步"
  else
    as_pg psql -p "$DB_PORT" -c "SET password_encryption='scram-sha-256'; CREATE USER \"${DB_USER}\" WITH PASSWORD '${DB_PASS}';"
    ok "数据库用户 $DB_USER 已创建"
  fi

  # 建库（若不存在）
  if as_pg psql -p "$DB_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null | grep -q 1; then
    log "数据库 $DB_NAME 已存在 ✓"
  else
    as_pg psql -p "$DB_PORT" -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_USER}\";"
    ok "数据库 $DB_NAME 已创建"
  fi

  # pg_hba：放行本机应用用户用密码(scram)登录。RHEL 默认 host 行是 ident，
  # node-postgres 以 ${DB_USER}@127.0.0.1 带密码连会被拒（Ident authentication failed）。
  # 用 SHOW hba_file 取真实路径，awk 幂等把本应用用户的 scram 放行行插到首条 host 之前（首条匹配优先）。
  HBA_FILE="$(as_pg psql -p "$DB_PORT" -tAc 'SHOW hba_file' 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$HBA_FILE" ]] && run_root test -f "$HBA_FILE"; then
    if ! run_root grep -qE "^host[[:space:]]+all[[:space:]]+${DB_USER}[[:space:]]+127\.0\.0\.1/32[[:space:]]+scram-sha-256" "$HBA_FILE"; then
      log "配置 pg_hba 放行 ${DB_USER}@loopback (scram-sha-256)..."
      run_root cp "$HBA_FILE" "${HBA_FILE}.bak.$(date +%s)"
      _hba_tmp="$(mktemp)"
      run_root awk -v u="$DB_USER" '
        !ins && /^host/ { print "host\tall\t" u "\t127.0.0.1/32\tscram-sha-256"; print "host\tall\t" u "\t::1/128\tscram-sha-256"; ins=1 }
        { print }
      ' "$HBA_FILE" > "$_hba_tmp"
      run_root cp "$_hba_tmp" "$HBA_FILE"   # cp 覆盖内容、保留原属主权限
      rm -f "$_hba_tmp"
      ok "pg_hba 已更新"
    else
      log "pg_hba 已放行 $DB_USER ✓"
    fi
    # 始终 reload，确保磁盘上的 pg_hba 生效（pg_reload_conf 以超管 peer 跑，比 pg_ctl/systemctl 可靠）
    as_pg psql -p "$DB_PORT" -tAc 'SELECT pg_reload_conf();' >/dev/null 2>&1 && ok "pg_hba 已 reload" || warn "pg_hba reload 失败，请手动 reload"
  else
    warn "未能定位 pg_hba 文件，跳过自动配置（如连接失败请手动改为密码认证）"
  fi
else
  step "检查远程数据库连接 ($DB_HOST:$DB_PORT)"
  if command -v nc &>/dev/null; then
    nc -z -w5 "$DB_HOST" "$DB_PORT" 2>/dev/null || die "数据库端口不可达 ($DB_HOST:$DB_PORT)，请确认地址与防火墙。"
    ok "远程数据库连接正常"
  else
    warn "nc 不可用，跳过远程数据库连接检查"
  fi
fi

# ── Step 3: 数据库迁移 ────────────────────────────────────────────────────────
# 幂等执行所有未应用迁移。放在后端重启之前,失败即中止部署,避免新代码连旧库结构。
# nginx-only 模式跳过(不碰数据库)。
if [[ "$DO_MIGRATE" == true ]]; then
  step "数据库迁移"
  npm run db:migrate || die "数据库迁移失败,已中止部署(未重启后端)。请检查迁移文件与数据库状态。"
  ok "数据库迁移完成"

  step "生产管理员初始化"
  npm run prod:bootstrap-admin || die "生产管理员初始化失败,已中止部署。请检查数据库状态与 BOOTSTRAP_* 配置。"
  ok "生产管理员初始化检查完成"
fi

# 注:纯迁移/重复部署也不再提前退出 —— 继续往下,每次部署都会重写 nginx(reload 零中断),
# 确保「部署后 nginx 没配对」不再发生。后端重启由 DO_BACKEND 决定,无目标时自动跳过。

# ── Step 4: 重启后端 ──────────────────────────────────────────────────────────
if [[ "$DO_BACKEND" == true ]]; then
  step "重启后端 ($APP_NAME)"
  if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
    ok "PM2 进程已重启"
  else
    log "PM2 中无 $APP_NAME 进程，首次启动..."
    pm2 start npm --name "$APP_NAME" -- run start
    ok "PM2 进程已启动"
  fi

  # 健康检查（最多等 60 秒）
  log "等待后端就绪（最多 60s）..."
  READY=false
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
      READY=true
      ok "后端健康检查通过（用时约 $((i * 2))s）"
      break
    fi
  done
  [[ "$READY" == false ]] && die "后端启动超时（60s 内未通过健康检查）。请运行: pm2 logs $APP_NAME"
fi

# ── Step 4b: 自助登记到 Management（首次，幂等；设了 ENROLL_TOKEN 才跑）─────────
if [[ -n "${ENROLL_TOKEN:-}" ]]; then
  step "自助登记到 Management"
  _had_enroll=false; [[ -f "$SCRIPT_DIR/.enrolled" ]] && _had_enroll=true
  if npm run self-enroll; then
    # 本次新登记且写入了 GETDEPLOYED_PAT → 重启后端使其生效
    if [[ "$_had_enroll" == false && -f "$SCRIPT_DIR/.enrolled" ]] \
       && grep -qE '^GETDEPLOYED_PAT=.+' "$SCRIPT_DIR/.env" 2>/dev/null; then
      log "已写入 GETDEPLOYED_*，重启后端使其生效"
      pm2 restart "$APP_NAME" --update-env || true
    fi
  else
    warn "自助登记失败（不阻断部署；可稍后手动 npm run self-enroll）"
  fi
fi

# ── Step 5: 生成 / 更新 nginx 配置 ──────────────────────────────────────────
# ★每次部署都重写并 reload（reload 零中断），不再依赖「设了域名 + 前端有改动」——
#   这正是过去「部署后 nginx 没配对」的根因。未设域名时 server_name 用 _（匹配所有域名/IP）。
setup_nginx() {
  local server_name="${DOMAIN:-_}"
  local nginx_local="$SCRIPT_DIR/nginx.conf.generated"
  local nginx_path default_server
  # 发行版布局差异:Debian/Ubuntu 用 sites-available+sites-enabled 软链;
  # RHEL/Alibaba Cloud Linux 用 conf.d/*.conf。conf.d 布局下加 default_server 抢占 IP 直连请求。
  if [[ -d /etc/nginx/sites-enabled ]]; then
    nginx_path="/etc/nginx/sites-available/${APP_NAME}"; default_server=""
  else
    nginx_path="/etc/nginx/conf.d/${APP_NAME}.conf"; default_server=" default_server"
  fi

  local nginx_conf
  nginx_conf=$(cat <<NGINXCONF
# 由 deploy_production.sh 自动生成 — 每次部署覆盖,勿手动编辑;自定义请另建 server 块
server {
    listen 80${default_server};
    server_name ${server_name};

    # 前端静态文件（Vue SPA）
    root ${SCRIPT_DIR}/dist;
    index index.html;
    gzip on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # Vue Router history 模式兜底
    location / {
        try_files \$uri \$uri/ /index.html;
        add_header Cache-Control "no-cache";
    }

    # API + 健康检查 + 本地存储上传件 → 反代到 Node.js 后端
    location ~ ^/(api|health|uploads)(/|\$) {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header Authorization \$http_authorization;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;   # ★与 core/llm/caller.ts 的 TOTAL_BUDGET_MS(110s)成对,改一个必须两个一起改
        # nginx 默认 client_max_body_size 1m,合同扫描件/发票影像等上传在反代层就被 413;
        # 放宽到 100m,单文件真实上限由应用层各接口 maxBytes 校验(如合同扫描件 30m)
        client_max_body_size 100m;
    }

    # 静态资源长缓存（Vite 构建产物带 hash，可永久缓存）
    location ~* \.(?:js|css|woff2?|png|svg|ico)\$ {
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
NGINXCONF
)

  # 企业官网 server 块:assets 静态直出(带 hash 长缓存);页面与 GEO 端点(/、/posts/…、
  # /llms.txt、/sitemap.xml)反代 Node —— SEO meta/JSON-LD 是 serve-time 注入的,不能静态直出。
  if [[ -n "$WEBSITE_DOMAIN" ]]; then
    nginx_conf+=$(cat <<NGINXCONF


# 企业官网(modules/website) — 同后端进程按 Host 分发
server {
    listen 80;
    server_name ${WEBSITE_DOMAIN};
    gzip on;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location /assets/ {
        root ${SCRIPT_DIR}/dist-website;
        expires 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;   # ★与 core/llm/caller.ts 的 TOTAL_BUDGET_MS(110s)成对,改一个必须两个一起改
    }
}
NGINXCONF
)
  fi

  echo "$nginx_conf" > "$nginx_local"
  ok "nginx 配置已写入本地 $nginx_local"

  if ! command -v nginx &>/dev/null; then
    if can_root; then
      log "Nginx 未安装，正在安装..."
      pkg_install nginx
      ok "Nginx 安装完成"
    else
      warn "Nginx 未安装且当前用户无免密 sudo，无法自动部署"
    fi
  fi

  # 无 root/免密 sudo:保留本地文件并打印手动命令。
  if ! can_root; then
    echo ""
    echo -e "${YELLOW}══ nginx 配置（需要 root 权限写入）══${NC}"
    echo -e "  ${BOLD}sudo cp $nginx_local $nginx_path${NC}"
    [[ -d /etc/nginx/sites-enabled ]] && echo -e "  ${BOLD}sudo ln -sf $nginx_path /etc/nginx/sites-enabled/${APP_NAME}${NC}"
    echo -e "  ${BOLD}sudo nginx -t && sudo nginx -s reload${NC}"
    echo ""
    return
  fi

  run_root mkdir -p "$(dirname "$nginx_path")"
  run_root cp "$nginx_local" "$nginx_path"
  ok "nginx 配置已写入 $nginx_path"

  # 处理与默认站点的 default_server 冲突
  if [[ -d /etc/nginx/sites-enabled ]]; then
    [[ ! -e "/etc/nginx/sites-enabled/${APP_NAME}" ]] && run_root ln -sf "$nginx_path" "/etc/nginx/sites-enabled/${APP_NAME}" && log "站点已启用"
    [[ -L /etc/nginx/sites-enabled/default ]] && run_root rm -f /etc/nginx/sites-enabled/default && log "已禁用 nginx default 站点"
  else
    [[ -f /etc/nginx/conf.d/default.conf ]] && run_root mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled && log "已禁用 conf.d/default.conf"
  fi
  # 全新服务器上 stock nginx.conf 的内置 server(或别处 conf)可能已占用 default_server,
  # 与本站点冲突报 "duplicate default server"。这里从所有非本站点的配置里剥掉 default_server,
  # 保证整棵配置树里只有本站点带 default_server(幂等,可重复执行)。
  local conf
  for conf in /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf /etc/nginx/default.d/*.conf; do
    [[ -f "$conf" ]] || continue
    [[ "$conf" == "$nginx_path" ]] && continue
    run_root sed -i -E 's/(listen[^;#]*)[[:space:]]+default_server/\1/g' "$conf" 2>/dev/null || true
  done

  if run_root nginx -t; then
    if command -v systemctl &>/dev/null; then
      if run_root systemctl is-active --quiet nginx; then run_root systemctl reload nginx
      else run_root systemctl enable nginx; run_root systemctl restart nginx; fi
    else
      run_root nginx -s reload || run_root nginx
    fi
    ok "nginx 已重载 (server_name: ${server_name})"
  else
    warn "nginx 配置测试失败，请手动检查: nginx -t"
    return
  fi

  # HTTPS:仅当配了真实域名才申请/续期证书(server_name=_ 无法签发)。
  # 管理端 + 官网域名一次签进同一张证书;追加域名到既有证书必须 --expand(fund 部署教训)。
  local cert_args=()
  [[ -n "$DOMAIN" ]] && cert_args+=(-d "$DOMAIN")
  [[ -n "$WEBSITE_DOMAIN" ]] && cert_args+=(-d "$WEBSITE_DOMAIN")
  if [[ ${#cert_args[@]} -eq 0 ]]; then
    log "未配置 DOMAIN/NGINX_SERVER_NAME → 仅 HTTP（server_name _ 匹配所有域名/IP）"
    return
  fi
  if ! command -v certbot &>/dev/null; then
    if can_root; then
      log "certbot 未安装，正在安装..."
      pkg_install certbot python3-certbot-nginx
      ok "certbot 安装完成"
    else
      warn "certbot 未安装且无免密 sudo，跳过 HTTPS"
      return
    fi
  fi
  local certbot_email="${CERTBOT_EMAIL:-webmaster@${DOMAIN:-$WEBSITE_DOMAIN}}"

  # 官网域名 DNS 预检:未解析时不把它塞进证书——否则整张证书(含管理端)一起失败,
  # 而本脚本每次部署都重写 nginx 配置(443 块被冲掉),管理端 HTTPS 会连带消失,
  # https 请求经 SNI 兜底落到同机其它应用的默认 443 站点上(表现为"跳到别的系统")。
  if [[ -n "$WEBSITE_DOMAIN" && -n "$DOMAIN" ]]; then
    if ! getent hosts "$WEBSITE_DOMAIN" >/dev/null 2>&1 && ! nslookup "$WEBSITE_DOMAIN" >/dev/null 2>&1; then
      warn "官网域名 ${WEBSITE_DOMAIN} 尚未解析 → 本轮证书只签管理端;解析生效后重跑 --nginx-only 补签"
      cert_args=(-d "$DOMAIN")
    fi
  fi

  log "申请/续期 HTTPS 证书 (${cert_args[*]})..."
  if run_root certbot --nginx "${cert_args[@]}" --expand \
    --non-interactive --agree-tos --email "$certbot_email" \
    --redirect 2>&1; then
    DOMAIN_URL_SCHEME="https"
    ok "HTTPS 证书已配置，HTTP 自动跳转 HTTPS"
  elif [[ -n "$DOMAIN" && -n "$WEBSITE_DOMAIN" && ${#cert_args[@]} -gt 2 ]]; then
    # 双域名合签失败(常见:官网域名 DNS 未指到本机)→ 回退只签管理端,保住既有入口的 HTTPS
    warn "双域名证书申请失败,回退仅为管理端 ${DOMAIN} 签发(官网暂走 HTTP,DNS 就绪后重跑 --nginx-only)"
    if run_root certbot --nginx -d "$DOMAIN" --expand \
      --non-interactive --agree-tos --email "$certbot_email" \
      --redirect 2>&1; then
      DOMAIN_URL_SCHEME="https"
      ok "管理端 HTTPS 已恢复(官网证书待补)"
    else
      warn "证书申请失败（请确认 DNS 已解析且端口 80/443 可访问），当前仅 HTTP"
    fi
  else
    warn "证书申请失败（请确认 DNS 已解析且端口 80/443 可访问），当前仅 HTTP"
  fi
}

warm_up_after_deploy() {
  [[ "${DEPLOY_WARMUP:-true}" == "false" ]] && { log "DEPLOY_WARMUP=false,跳过部署后预热"; return; }
  step "部署后预热首屏资源"

  local host_header=()
  [[ -n "${DOMAIN:-}" ]] && host_header=(-H "Host: ${DOMAIN}")

  curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1 || warn "后端 health 预热失败"

  if command -v nginx &>/dev/null; then
    curl -fsS "${host_header[@]}" "http://127.0.0.1/" > /dev/null 2>&1 || warn "nginx 首页预热失败"
    if [[ -f "$SCRIPT_DIR/dist/index.html" ]]; then
      while IFS= read -r asset; do
        [[ -z "$asset" ]] && continue
        curl -fsS "${host_header[@]}" "http://127.0.0.1${asset}" > /dev/null 2>&1 || true
      done < <(grep -oE '/assets/[^"]+\.(js|css)' "$SCRIPT_DIR/dist/index.html" | head -20)
    fi
    # 官网:预热首页(顺带验证 Host 分发与 SEO 注入链路通)
    if [[ -n "$WEBSITE_DOMAIN" ]]; then
      curl -fsS -H "Host: ${WEBSITE_DOMAIN}" "http://127.0.0.1/" > /dev/null 2>&1 || warn "官网首页预热失败(检查 WEBSITE_DIST/WEBSITE_HOST 与 nginx)"
      curl -fsS -H "Host: ${WEBSITE_DOMAIN}" "http://127.0.0.1/llms.txt" > /dev/null 2>&1 || true
    fi
  fi
  ok "部署后预热已完成"
}

# 每次部署都配 nginx(含 --nginx-only、纯迁移、纯后端);未设域名用 server_name _。
step "Nginx 配置（server_name: ${DOMAIN:-_}）"
setup_nginx
warm_up_after_deploy

# ── Step 6: PM2 开机自启（首次部署时执行）───────────────────────────────────
if [[ "$IS_FIRST_DEPLOY" == true ]]; then
  step "设置 PM2 开机自启"
  pm2 save
  ok "PM2 进程列表已保存"

  # pm2 startup 会输出一条需要执行的 sudo 命令
  STARTUP_CMD=$(pm2 startup 2>&1 | grep "sudo" | tail -1 || true)
  if [[ -n "$STARTUP_CMD" ]]; then
    if [[ $EUID -eq 0 ]]; then
      # 当前是 root，直接执行
      eval "$STARTUP_CMD"
      ok "PM2 开机自启已设置（root 直接执行）"
    else
      echo ""
      echo -e "${YELLOW}══ PM2 开机自启（需要 root 权限）══${NC}"
      echo -e "请手动执行以下命令完成开机自启配置:"
      echo -e "  ${BOLD}${STARTUP_CMD}${NC}"
      echo ""
    fi
  fi
fi

# ── 记录版本 ──────────────────────────────────────────────────────────────────
# nginx-only 不写版本记录(它没部署代码),否则下次正常部署会误判「已是最新」而跳过构建。
if [[ "$NGINX_ONLY" == false ]]; then
  echo "$CURR_VERSION" > "$DEPLOY_RECORD"
fi

step "部署完成"
if [[ "$NGINX_ONLY" == true ]]; then
  echo -e "  ${GREEN}模式${NC}: 仅配 nginx（未动代码/数据库/后端）"
else
  echo -e "  ${GREEN}版本${NC}: ${PREV_SHORT:-（首次）} → ${BOLD}$CURR_SHORT${NC}"
  echo -e "  ${GREEN}前端${NC}: $DO_FRONTEND  ${GREEN}数据库迁移${NC}: $DO_MIGRATE  ${GREEN}后端${NC}: $DO_BACKEND"
fi
echo -e "  ${GREEN}时间${NC}: $(date '+%Y-%m-%d %H:%M:%S')"
echo -e "  ${GREEN}访问${NC}: ${DOMAIN_URL_SCHEME}://${DOMAIN:-<服务器IP>}"
if [[ -n "$WEBSITE_DOMAIN" ]]; then
  echo -e "  ${GREEN}官网${NC}: ${DOMAIN_URL_SCHEME}://${WEBSITE_DOMAIN}  (记得在后台「企业官网→站点配置→站点地址」填 ${DOMAIN_URL_SCHEME}://${WEBSITE_DOMAIN})"
fi
echo ""
