#!/usr/bin/env bash
# 把 compose 用到的两个**第三方基础镜像**(postgres / caddy)同步一份到我们自己的火山 CR。
#
# ★为什么需要这件事(2026-08-25 UniX 实打):
#   国内客户机拉 docker.io 实测 **84 KB/s**,更早在江南电缆干脆是 `i/o timeout` **拉不动**。
#   而同样这两个镜像放在火山 CR、机器也在火山时是秒下。
#   compose 里已经钉了小版本 + `pull_policy: missing`,所以**日常发版根本不碰它们** ——
#   这个脚本管的是「新机器第一次拉」和「将来升版本」那两次。
#
# ★在哪儿跑:一台**既能拉 docker.io、又登录过火山 CR** 的机器。
#   实测 `118.196.97.238`(镜像构建机)docker.io 约 900 KB/s —— 是客户机的 10 倍,
#   所以「构建机拉一次、客户机从 CR 拿」比「每台客户机各自去 Docker Hub 拿」划算得多。
#
# ★用法:版本号跟着 docker-compose.yml 的默认值走,别在这儿各写各的。
#     PG_TAG=16.15 CADDY_TAG=2.11.4 bash scripts/mirror-base-images.sh
#   升版本的完整动作是三件,缺一不可:
#     ① 改 docker-compose.yml 里的默认版本(升 postgres **大**版本还要改 Dockerfile 的
#        `ARG PG_MAJOR` —— core/backup/tests/pg-client-version.test.ts 会对账);
#     ② 跑这个脚本把新版本同步进 CR;
#     ③ 改客户 `.env` 里的 `DB_IMAGE`/`CADDY_IMAGE`(见 .env.docker.example)。
#     只做 ① 不做 ②,国内客户下次拉就会掉回 docker.io 那条 84 KB/s 的线上。
#
# ★只同步 **linux/amd64**:客户机都是 x86_64(Dockerfile 里也这么写着)。
#   `docker push` 会提示 "Not all multiplatform-content is present" —— 那是预期的,不是错误。
set -Eeuo pipefail

CR="${CR:-cust-pro-cn-beijing.cr.volces.com/cust-pro}"
PG_TAG="${PG_TAG:-16.15}"
CADDY_TAG="${CADDY_TAG:-2.11.4}"

sync_one() {
  local upstream="$1" target="$2"
  echo "=== $upstream → $target ==="
  docker pull --platform linux/amd64 "$upstream"
  docker tag "$upstream" "$target"
  docker push "$target"
  # ★推完真去读一次清单再说成功。push 打印 digest 只证明「传上去了」,
  #   证明不了「拉得下来」—— 而这两件事在私有仓库上分属两套权限。
  docker manifest inspect "$target" > /dev/null
  echo "✓ $target 可读"
}

sync_one "postgres:${PG_TAG}" "${CR}/postgres:${PG_TAG}"
sync_one "caddy:${CADDY_TAG}" "${CR}/caddy:${CADDY_TAG}"

cat <<EOF

同步完成。接下来把客户 .env 指过来(海外/通用交付不用设,留空即走上游):
  DB_IMAGE=${CR}/postgres:${PG_TAG}
  CADDY_IMAGE=${CR}/caddy:${CADDY_TAG}
EOF
