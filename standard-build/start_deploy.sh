#!/usr/bin/env bash
# start_deploy.sh — 部署引导脚本
#
# 放在项目根（standard-build/），由外部调用（CI、运维脚本等）在代码已就位后执行。
#
# 职责：git pull 拉取最新代码，然后移交给 deploy_production.sh。
# deploy_production.sh 随 git 更新，此处用 exec 确保始终执行最新版本。
#
# 用法:
#   bash standard-build/start_deploy.sh                    # 默认当前目录(增量部署)
#   bash standard-build/start_deploy.sh /home/FUTURE/standard-build  # 指定路径
#   bash standard-build/start_deploy.sh --full             # 强制全量部署(忽略版本记录)
#   bash standard-build/start_deploy.sh --nginx-only       # 只重写 nginx 配置 + 申请/续期证书
#   bash standard-build/start_deploy.sh /home/FUTURE/standard-build --full
# 说明:--full / --nginx-only 等参数会原样透传给 deploy_production.sh。
#
# 定时部署（crontab）示例：
#   0 3 * * * bash /home/FUTURE/standard-build/start_deploy.sh >> /var/log/deploy.log 2>&1

set -euo pipefail

DEFAULT_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$DEFAULT_PROJECT_DIR"

if [[ $# -gt 0 && "${1:-}" != --* ]]; then
  PROJECT_DIR="$1"
  shift
fi

DEPLOY_ARGS=("$@")

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "[start_deploy] 错误: 目录不存在: $PROJECT_DIR" >&2
  exit 1
fi

cd "$PROJECT_DIR"
echo "[start_deploy $(date '+%Y-%m-%d %H:%M:%S')] 进入 $PROJECT_DIR"

# ── 对齐 origin ───────────────────────────────────────────────────────────────
# 部署机以远端为准:不用 git pull(分叉 / 上次 npm install 改了 package-lock.json 时会失败),
# 改为 fetch + reset --hard,稳定抗「lock 文件被改」与「上游 force-push/重排历史」。
# 注意:git fetch origin <branch> 只更新 FETCH_HEAD，不更新 origin/<branch> 追踪引用，
# 因此必须 reset 到 FETCH_HEAD 而不是 origin/$BRANCH。
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "[start_deploy] git fetch origin $BRANCH ..."
git fetch origin "$BRANCH"
echo "[start_deploy] git reset --hard FETCH_HEAD（采用远端历史,丢弃本地跟踪文件改动）"
git reset --hard FETCH_HEAD

# ── 执行最新版本的部署脚本 ───────────────────────────────────────────────────
echo "[start_deploy] 移交给 deploy_production.sh ..."
if [[ ${#DEPLOY_ARGS[@]} -gt 0 ]]; then
  echo "[start_deploy] deploy args: ${DEPLOY_ARGS[*]}"
fi
exec bash "$PROJECT_DIR/deploy_production.sh" "${DEPLOY_ARGS[@]}"
