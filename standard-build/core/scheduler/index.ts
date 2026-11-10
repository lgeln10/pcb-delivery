// core/scheduler — 平台级后台定时任务框架。
// 各模块通过 registerJob 注册周期任务,server.ts 启动时 startScheduler 一次拉起全部。
// 仿 lead-intake-email/poller 的约定:单个 job 抛错只记该 job 失败,不影响其它;
// timer unref 不阻止进程退出;测试不经 server.ts,故注册了也不会自动跑(可手动调 job.run)。
import type { Db } from '../db/client'

export type SchedulerJob = {
  /** 唯一名(重复注册直接覆盖,便于热重载/测试) */
  name: string
  /** 执行间隔(毫秒) */
  intervalMs: number
  /** 任务体:自行处理多租户遍历;抛错由框架吞掉并记入 lastError */
  run: (db: Db) => Promise<void>
  /**
   * 启动后先跑一次(延迟 startDelayMs,默认 60s,避开启动期争抢)。
   * ★给**长间隔**任务用:间隔 3 小时的任务如果只靠 setInterval,每次发版后前 3 小时它的产物
   *   都是空的 —— 用户看到的是「这功能坏了」,而不是「还没到点」。间隔几分钟的任务不需要开这个。
   * 前提是任务本身幂等(重启即重跑,不能产生重复副作用)。
   */
  runOnStart?: boolean
  /** runOnStart 的延迟毫秒数,默认 60_000。 */
  startDelayMs?: number
}

export type JobStatus = {
  name: string
  intervalMs: number
  lastRunAt: Date | null
  lastError: string | null
}

const jobs = new Map<string, SchedulerJob>()
const status = new Map<string, JobStatus>()
let timers: ReturnType<typeof setInterval>[] = []
let startTimers: ReturnType<typeof setTimeout>[] = []
let started = false

export function registerJob(job: SchedulerJob): void {
  jobs.set(job.name, job)
  if (!status.has(job.name)) {
    status.set(job.name, { name: job.name, intervalMs: job.intervalMs, lastRunAt: null, lastError: null })
  }
}

async function runJob(db: Db, job: SchedulerJob): Promise<void> {
  const st = status.get(job.name)!
  st.lastRunAt = new Date()
  try {
    await job.run(db)
    st.lastError = null
  } catch (err) {
    st.lastError = err instanceof Error ? err.message : String(err)
  }
}

/** server.ts 启动时调用一次。重复调用无效(幂等)。 */
export function startScheduler(db: Db): void {
  if (started) return
  started = true
  for (const job of jobs.values()) {
    const t = setInterval(() => void runJob(db, job), job.intervalMs)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
    if (job.runOnStart) {
      const once = setTimeout(() => void runJob(db, job), job.startDelayMs ?? 60_000)
      if (typeof once.unref === 'function') once.unref()
      startTimers.push(once)
    }
  }
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t)
  for (const t of startTimers) clearTimeout(t)
  timers = []
  startTimers = []
  started = false
}

/** 运维/测试用:查看各 job 最近执行情况 */
export function getJobStatuses(): JobStatus[] {
  return [...status.values()]
}

/** 测试用:立即执行一个已注册 job(走同一套错误记录) */
export async function runJobNow(db: Db, name: string): Promise<void> {
  const job = jobs.get(name)
  if (!job) throw new Error(`scheduler job not found: ${name}`)
  await runJob(db, job)
}
