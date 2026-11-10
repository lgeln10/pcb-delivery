// 备份要用的 `pg_dump` 大版本,必须与 compose 里那个 Postgres 镜像**一致**。
//
// ★为什么值得一条测试:`pg_dump` **拒绝导出比自己新的服务端**
//   (`server version: 16.x; pg_dump version: 15.x … aborting`)。
//   所以「库升到 17、镜像里的客户端还是 16」= 升级当晚备份就死,
//   而失败只发站内信(没人会登进来看),等发现时已经断了很多天。
//
// ★这两个数字天然分居两个文件、两种语言(Dockerfile 的 `ARG PG_MAJOR` 与
//   docker-compose.yml 的 `image: postgres:N`),没有对账点就一定会漂。
//
// 2026-08-19 实测:node:22-slim(Debian 12)自带的是 pg_dump **15.19**,
// 而客户库是 **16.15** —— 所以镜像里必须从 PGDG 装 `postgresql-client-16`,
// 不能用发行版自带的那个。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

// 两个第三方镜像都留了 `.env` 覆盖口(国内客户指到自家火山 CR,海外用上游默认),
// 所以形状是 `image: ${VAR:-上游名:版本}` —— 下面对账的是**默认值**里的版本号。
// 覆盖成别的仓库时版本号仍要自己对齐,这条测试管不到那一层(也管不了)。
const DB_IMAGE_RE = /image:\s*\$\{DB_IMAGE:-postgres:([\d.]+)\}/
const CADDY_IMAGE_RE = /image:\s*\$\{CADDY_IMAGE:-caddy:([\d.]+)\}/

describe('★pg_dump 大版本 == compose 里的 Postgres 大版本', () => {
  const dockerfile = read('../../../Dockerfile')
  const compose = read('../../../docker-compose.yml')

  it('两处都能解析出大版本号', () => {
    expect(/ARG PG_MAJOR=(\d+)/.exec(dockerfile), 'Dockerfile 里没有 ARG PG_MAJOR').not.toBeNull()
    expect(DB_IMAGE_RE.exec(compose), 'compose 里没有 postgres: 镜像').not.toBeNull()
  })

  it('★两者一致 —— 不一致的话备份会在库升级当晚静默死掉', () => {
    const pgMajor = /ARG PG_MAJOR=(\d+)/.exec(dockerfile)![1]
    const imgMajor = DB_IMAGE_RE.exec(compose)![1]!.split('.')[0]
    expect(
      pgMajor,
      `Dockerfile 装的是 postgresql-client-${pgMajor},而 compose 起的是 postgres:${imgMajor}。` +
      `pg_dump 拒绝导出比自己新的服务端 —— 两处要一起改。`,
    ).toBe(imgMajor)
  })

  it('镜像里确实装了客户端,而且不是发行版自带的那个', () => {
    // 发行版自带的是 15,装它等于备份从第一天就不能用。
    expect(dockerfile, '没有从 PGDG 装 postgresql-client').toContain('postgresql-client-$PG_MAJOR')
    expect(dockerfile, '少了 PGDG 源,apt 会装成发行版自带的 15').toContain('apt.postgresql.org')
  })

  // 2026-08-25 UniX:`postgres:16` 这个**浮动 tag** 被上游换成 16.15(同 tag 新 digest),
  // 于是一次普通发版要重拉 152.8MB,而国内机拉 docker.io 实测 84 KB/s —— 拖了半个多小时。
  // 「什么都没改却突然变慢」的根因就是它。钉了小版本之后 digest 不会在脚下移动;
  // `pull_policy: missing` 让 `docker compose pull` 本地已有时直接跳过(实测认这个字段)。
  // 这条测试挡的是「有人觉得 `postgres:16` 更简洁」而把它改回去 —— 那次退化没有任何红灯,
  // 只会在某个上游发版的日子里,变成一句「今天发版怎么这么久」。
  it('★第三方基础镜像必须钉到小版本 + pull_policy: missing(浮动 tag 会在发版时炸)', () => {
    for (const [name, re] of [
      ['postgres', DB_IMAGE_RE],
      ['caddy', CADDY_IMAGE_RE],
    ] as const) {
      const tag = re.exec(compose)?.[1]
      expect(tag, `compose 里找不到 ${name} 镜像(或不是「\${VAR:-上游:版本}」这个形状)`).toBeTruthy()
      expect(tag, `${name} 的 tag「${tag}」是浮动的 —— 上游改 tag 那天就是一次跨境全量重拉`).toMatch(
        /^\d+\.\d+/,
      )
    }
    // 光钉版本还会走一次 registry 往返;要彻底不碰 docker.io,得有 pull_policy
    for (const re of [DB_IMAGE_RE, CADDY_IMAGE_RE]) {
      const at = re.exec(compose)!.index
      expect(
        compose.slice(at, at + 200),
        '镜像行后面紧跟的那几行里没有 pull_policy: missing',
      ).toMatch(/pull_policy:\s*missing/)
    }
  })

  it('★备份落点挂了卷 —— 不挂的话备份写进容器可写层,重建即丢', () => {
    expect(compose, 'compose 没挂 backups 卷').toMatch(/backups:\/app\/backups/)
    expect(compose, '顶层 volumes 里没声明 backups').toMatch(/^volumes:[\s\S]*^ {2}backups:/m)
  })
})
