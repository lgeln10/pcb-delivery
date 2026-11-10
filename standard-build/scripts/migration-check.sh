#!/usr/bin/env bash
# 迁移安全闸:**先备份生产库,再在真实数据的副本上预演迁移,过了才允许打生产库。**
#
# 由部署流程在 `npm run db:migrate` 之前调用(需要 .env 已 source,拿到 DATABASE_URL)。
#
# ★为什么必须有这个:
#   1. 仓库有 158 个迁移、**0 个 down 文件** —— 迁移层面根本没有回滚路径。
#      一个坏迁移打到生产数据上,唯一的退路是从备份恢复。而在这之前,
#      部署流程**没有任何备份**:rsync → npm ci → db:migrate 直接打 base_prod。
#   2. CI 里那 6 片测试确实每个文件都跑一遍全套迁移 —— 但那是在**空库**上跑的。
#      空库能过、真数据过不了的迁移是最常见的一类:给已有行的列加 NOT NULL、
#      在有重复值的列上建 UNIQUE、改类型时旧值转不过去。CI 全绿也拦不住。
#
# 预演在一个用完即删的副本上做,失败就 exit 1 —— 此时生产库**一个字节都没被动过**。
set -euo pipefail

: "${DATABASE_URL:?需要 DATABASE_URL(部署流程里 set -a; . ./.env; set +a 会注入)}"

# 定位 standard-build 目录。正常由 `bash scripts/migration-check.sh` 调用,靠 $0;
# 但通过管道跑(`bash -s < 脚本`)时 $0 是 "bash",解析不出路径 —— 那种情况退回当前目录,
# 并用 package.json 兜底校验,免得在错误的目录里跑迁移。
_src="${BASH_SOURCE[0]:-$0}"
if [ -f "$_src" ]; then
  APP_DIR="$(cd "$(dirname "$_src")/.." && pwd)"
else
  APP_DIR="${MIGCHECK_APP_DIR:-$PWD}"
fi
[ -f "$APP_DIR/package.json" ] || { echo "$APP_DIR 里没有 package.json,定位错了目录"; exit 1; }
BACKUP_DIR="${MIGCHECK_BACKUP_DIR:-$APP_DIR/../backups}"
KEEP="${MIGCHECK_KEEP:-10}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# 从 DATABASE_URL 里拆出库名,并拼出「同主机同凭据但连 postgres 库」的管理连接,
# 以及副本库的连接串。用 python 解析,避免手写正则把密码里的特殊字符弄坏。
eval "$(python3 - "$DATABASE_URL" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
db = p.path.lstrip('/')
scratch = f"{db}_migcheck"
def swap(name):
    return u.urlunparse(p._replace(path='/' + name))
print(f"SRC_DB={db}")
print(f"DB_USER={p.username or ''}")
print(f"SCRATCH_DB={scratch}")
print(f"ADMIN_URL='{swap('postgres')}'")
print(f"SCRATCH_URL='{swap(scratch)}'")
PY
)"

say() { printf '\n\033[1;36m[迁移闸] %s\033[0m\n' "$*"; }

# ★pg_dump 不允许比服务端旧:客户端 16 对服务端 17 会直接
#   `aborting because of server version mismatch`(实测踩到)。psql 没这个限制,只有 pg_dump 有。
#   所以这里按服务端大版本挑一个能用的 pg_dump,挑不到就报出确切的安装命令,
#   而不是让部署在迁移闸上莫名其妙地红。
SERVER_MAJOR="$(psql "$ADMIN_URL" -At -c 'SHOW server_version_num' 2>/dev/null | cut -c1-2)"
[ -n "$SERVER_MAJOR" ] || { echo "连不上数据库,拿不到服务端版本" >&2; exit 1; }

# 选一个能用的导出方式,按优先级:
#   1. 宿主机 pg_dump 且大版本 >= 服务端
#   2. /usr/lib/postgresql/<服务端大版本>/bin/pg_dump
#   3. MIGCHECK_PG_CONTAINER 指定的数据库容器里的 pg_dump(零安装,版本天然匹配)
# psql 没有版本限制,只有 pg_dump 有 —— 所以只有导出这一步需要挑。
DUMP_MODE=""
DUMP_BIN=""
_client_major="$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
if [ -n "$_client_major" ] && [ "$_client_major" -ge "$SERVER_MAJOR" ] 2>/dev/null; then
  DUMP_MODE=host; DUMP_BIN="pg_dump"
elif [ -x "/usr/lib/postgresql/${SERVER_MAJOR}/bin/pg_dump" ]; then
  DUMP_MODE=host; DUMP_BIN="/usr/lib/postgresql/${SERVER_MAJOR}/bin/pg_dump"
elif [ -n "${MIGCHECK_PG_CONTAINER:-}" ] && command -v docker >/dev/null 2>&1 \
     && docker exec "$MIGCHECK_PG_CONTAINER" pg_dump --version >/dev/null 2>&1; then
  DUMP_MODE=docker
else
  cat >&2 <<EOF
找不到 >= 服务端大版本(${SERVER_MAJOR})的 pg_dump（宿主机是 ${_client_major:-无}）。
pg_dump 不允许比服务端旧,会直接 "aborting because of server version mismatch"。

两种修法,任选其一:
  A. 零安装:设 MIGCHECK_PG_CONTAINER=<数据库容器名>,用容器里的 pg_dump(版本天然匹配)
  B. 装客户端:给主机加 PGDG 源后 apt-get install -y postgresql-client-${SERVER_MAJOR}
EOF
  exit 1
fi

dump_prod() { # 把生产库导到 stdout
  if [ "$DUMP_MODE" = host ]; then
    "$DUMP_BIN" "$DATABASE_URL" </dev/null
  else
    # ★千万别加 -i:pg_dump 不需要 stdin,而 `-i` 会让它继承并吃掉调用方的 stdin。
    #   本脚本若以 `bash -s < 脚本` 方式运行,stdin 就是脚本自身 —— pg_dump 会把剩下的
    #   脚本内容当输入吞掉,bash 随后读不到任何命令,于是**静默结束、零报错**。
    #   (实测踩过:输出停在「导出方式」那行,后面三步一句不打就退出了。)
    docker exec "$MIGCHECK_PG_CONTAINER" pg_dump -U "$DB_USER" -d "$SRC_DB" </dev/null
  fi
}

cleanup() {
  # 副本用完即删。失败路径也要删,否则下次 CREATE 会撞名。
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1. 备份
say "1/3 备份生产库 $SRC_DB"
if [ "$DUMP_MODE" = host ]; then
  echo "  导出方式:宿主机 $DUMP_BIN"
else
  echo "  导出方式:容器 $MIGCHECK_PG_CONTAINER 内的 pg_dump（宿主机客户端 ${_client_major:-无} < 服务端 ${SERVER_MAJOR}）"
fi
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/${SRC_DB}-${STAMP}.sql.gz"
dump_prod | gzip > "$BACKUP"
# 空备份比没备份更危险 —— 它会让人以为有退路
size="$(stat -c%s "$BACKUP" 2>/dev/null || stat -f%z "$BACKUP")"
if [ "$size" -le 10240 ]; then
  # 失败的导出会留下一个 20 字节的空 gzip。留着它比没有备份更危险 —— 目录里
  # 躺着个 .sql.gz 会让人以为有退路。所以立刻删掉再退出。
  rm -f "$BACKUP"
  echo "备份只有 ${size} 字节,明显不对,已删除该文件并中止"
  exit 1
fi
echo "  $BACKUP ($(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B"))"

# 顺手清掉历史上遗留的空备份(旧版本脚本在导出失败时会留下 ~20 字节的空 gzip)
find "$BACKUP_DIR" -maxdepth 1 -name "${SRC_DB}-*.sql.gz" -size -10k -print -delete 2>/dev/null \
  | sed 's|^|  清理空备份 |' || true

# 只保留最近 N 份
ls -1t "$BACKUP_DIR"/${SRC_DB}-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" && echo "  清理旧备份 $(basename "$old")"
done

# ---------------------------------------------------------------- 2. 造副本
say "2/3 用这份备份造副本 $SCRATCH_DB"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB WITH (FORCE)" >/dev/null
psql "$ADMIN_URL" -q -c "CREATE DATABASE $SCRATCH_DB" >/dev/null
gunzip -c "$BACKUP" | psql "$SCRATCH_URL" -q >/dev/null
tables="$(psql "$SCRATCH_URL" -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "  副本就绪,$tables 张表(和生产同数据)"

# ---------------------------------------------------------------- 3. 预演
say "3/3 在副本上预演迁移"
cd "$APP_DIR"
if DATABASE_URL="$SCRATCH_URL" npm run db:migrate </dev/null; then
  say "预演通过 —— 允许对生产库执行迁移"
  echo "  出事可回滚:gunzip -c $BACKUP | psql \"\$DATABASE_URL\""
else
  say "预演失败 —— 生产库未被改动,部署中止"
  echo "  这套迁移在真实数据上跑不过(空库能过不代表真数据能过)。"
  echo "  备份仍在:$BACKUP"
  exit 1
fi
