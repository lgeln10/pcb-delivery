// core/backup/automation.ts
// 定时接线:每小时 tick 一次,到点(BACKUP_HOUR)且今天还没备成功就备一次;顺带巡「太久没备成功」。
//
// ★为什么是「每小时 tick + 自己判小时」而不是「每 24h 跑一次」:
//   core/scheduler 是 setInterval 语义 —— 24h 的间隔是**从进程启动那一刻**起算的,
//   发一次版就把备份时间挪到白天,再发一次又挪走,永远漂。所以按本地小时判定,
//   幂等由「今天有没有 verdict='ok'」保证(见 service.runBackupOnce)。
//
// ★告警放在这里而不是 service.ts:service 只管把备份做对,「谁该被通知」是接线层的事。
//   core 往下够 modules/inapp-notify 这一笔与 core/http/app.ts、core/data-catalog/registry.ts
//   同形 —— 组合/接线文件可以往下够,logic 文件不行。

import { eq } from 'drizzle-orm'
import { createNotification } from '../../modules/inapp-notify/api'
import type { Db } from '../db/client'
import { listEmployeeIdsWithPermission } from '../org/api'
import { tenants } from '../org/model'
import { registerJob } from '../scheduler'
import { loadBackupConfig, localHourOf, localWeekdayOf } from './config'
import { runRestoreDrill } from './restore-drill'
import { getBackupHealth, runBackupOnce } from './service'

const TICK_MS = 3600_000

/** 谁该收到备份告警:租户主 + 持有 app-settings:manage 的人(与「文件存储」页同一把尺子) */
const ALERT_PERMISSION = 'app-settings:manage'

export async function runBackupTick(db: Db, now: Date = new Date()): Promise<void> {
  const cfg = loadBackupConfig()
  if (!cfg.enabled) return
  if (localHourOf(now, cfg.timeZone) !== cfg.hour) return
  const outcome = await runBackupOnce(db, { now, config: cfg })
  if (outcome.status !== 'done' || outcome.verdict === 'ok') return
  await alertAdmins(db, {
    title: `数据库备份${outcome.verdict === 'failed' ? '失败' : '结果可疑'}`,
    // ★原因原文一定要带上。教训来自 AI 能力回归那三次连红:告警卡片只写了「常见原因」清单,
    //   真因(配额耗尽)的原始错误串一次都没带出来,于是三次告警三次没人动。
    body: outcome.reasons.join(';') || '(无详情)',
    sourceId: outcome.runId,
  })
}

/**
 * 陈旧巡检:连续 staleAlertDays 天没有成功备份就告警。
 * ★这条比「失败告警」更重要 —— 备份最常见的坏法不是失败,是**从某天起干脆不跑了**
 *   (被关掉、进程没起来、时区被改),那种情况下一条失败告警都不会有。
 */
export async function runBackupStaleCheck(db: Db, now: Date = new Date()): Promise<void> {
  const cfg = loadBackupConfig()
  if (!cfg.enabled) return
  // 一天只提醒一次(挪到备份点后一小时),否则每小时刷一条,人会学会忽略它
  if (localHourOf(now, cfg.timeZone) !== (cfg.hour + 1) % 24) return
  const health = await getBackupHealth(db, cfg, now)
  if (!health.stale) return
  const since = health.daysSinceOk == null ? '从未成功备份过' : `已经 ${health.daysSinceOk} 天没有成功备份`
  await alertAdmins(db, {
    title: '数据库备份已陈旧',
    body: `${since}(最近一次成功:${health.lastOkDate ?? '无'})。现存可用备份 ${health.liveCount} 份。`,
    sourceId: health.lastRunId,
  })
}

/**
 * 发给每个租户里「租户主 + 持有 app-settings:manage 的员工」。
 * ★落点是「系统设置」(`notification-target.ts` 的 db_backup 分支)—— 备份那一屏下一轮做在那里。
 *   收件人恰好都持有 `app-settings:manage`,所以 si:navigate 的可见性白名单不会把跳转吞掉。
 * ★sourceId 是 uuid 非空列,但前端不消费它。所以从未备份过、连一条台账行都没有时,借租户 id 占位。
 */
async function alertAdmins(db: Db, msg: { title: string; body: string; sourceId: string | null }): Promise<void> {
  const tenantRows = await db.select({ id: tenants.id, owner: tenants.ownerEmployeeId }).from(tenants).where(eq(tenants.isDeleted, false))
  for (const t of tenantRows) {
    // ★一次 JOIN 拿到全部收件人(含超管)。原先是「查全部员工 + 逐个 hasPermission」——
    //   那是 N+1,而且单人失败只能就地吞掉:权限判定要是系统性坏了(底座改了签名之类),
    //   表现只是收件人**静默缩成租户主一个人**,日志里一个字都没有。
    let recipients: string[]
    try {
      recipients = await listEmployeeIdsWithPermission(db, t.id, ALERT_PERMISSION)
    } catch (err) {
      // 算不出收件人不该让整轮告警哑掉,但**必须留痕** —— 备份告警本身就是「出事了」的唯一信号,
      // 它发不到该看的人手上,是比备份失败更糟的一种坏法。
      console.error('[backup] 算不出告警收件人,退回只发租户主:', t.id, err instanceof Error ? err.message : err)
      recipients = t.owner ? [t.owner] : []
    }
    for (const rid of recipients) {
      try {
        await createNotification(db, {
          tenantId: t.id,
          createdBy: rid, // 系统触发,没有真实操作人;沿用 attendance 预警的写法
          recipientId: rid,
          type: 'system',
          title: msg.title,
          body: msg.body,
          sourceType: 'db_backup',
          sourceId: msg.sourceId ?? t.id,
        })
      } catch (err) {
        console.error('[backup] 发告警失败:', err instanceof Error ? err.message : err)
      }
    }
  }
}

/**
 * 每周一次的恢复演练:把最近一份 ok 的 dump 真的恢复进临时库,点几张表,再把临时库删掉。
 *
 * ★为什么每周而不是每天:它要建一个和原库同样大的临时库、跑一遍完整 restore,是这套里最重的动作。
 *   而它防的是「某次改动让备份从此恢复不出来」——那类问题不会一天之内来回变。
 * ★幂等靠 `runRestoreDrill` 自己:最近那份备份已经演练过就直接 skip。所以这里只管「到点了没」,
 *   同一小时内多跑几次也不会重复演练。
 */
export async function runRestoreDrillTick(db: Db, now: Date = new Date()): Promise<void> {
  const cfg = loadBackupConfig()
  if (!cfg.drillEnabled) return
  if (localWeekdayOf(now, cfg.timeZone) !== cfg.drillWeekday) return
  if (localHourOf(now, cfg.timeZone) !== cfg.drillHour) return
  const r = await runRestoreDrill(db, { now, config: cfg })
  // ★只在**真恢复不出来**时告警。skipped(权限不够/太大/没得演练)不告警 —— 那是「演练跑不了」,
  //   不是「备份坏了」,每周为它响一次会让人学会忽略这个告警。
  if (r.status !== 'done' || r.verdict !== 'failed') return
  await alertAdmins(db, {
    title: '备份恢复演练没通过 —— 这份备份恢复不出来',
    body: `${r.detail.problems.join(';')}(耗时 ${r.detail.durationMs}ms)`,
    sourceId: r.runId,
  })
}

export function registerBackupJobs(): void {
  registerJob({ name: 'db-backup', intervalMs: TICK_MS, run: (db) => runBackupTick(db) })
  registerJob({ name: 'db-backup-stale-check', intervalMs: TICK_MS, run: (db) => runBackupStaleCheck(db) })
  registerJob({ name: 'db-backup-restore-drill', intervalMs: TICK_MS, run: (db) => runRestoreDrillTick(db) })
}
