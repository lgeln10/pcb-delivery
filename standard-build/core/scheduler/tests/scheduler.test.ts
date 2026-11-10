// core/scheduler 的两条行为:普通 job 只按 interval 跑;runOnStart 的 job 启动后先跑一次。
//
// ★runOnStart 是为**长间隔**任务加的。间隔 3 小时的任务如果只靠 setInterval,每次发版后
//   前 3 小时它的产物都是空的 —— 用户看到的是「这功能坏了」,而不是「还没到点」。
//   客户冲突预警(partner-conflict-scan)就是被这个坑到才加的这个开关。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJobStatuses, registerJob, startScheduler, stopScheduler } from '../index'
import type { Db } from '../../db/client'

const fakeDb = {} as Db

afterEach(() => {
  stopScheduler()
  vi.useRealTimers()
})

describe('startScheduler', () => {
  it('普通 job 启动时**不**立即跑,到间隔才跑', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => {})
    registerJob({ name: 'test-plain', intervalMs: 60_000, run })
    startScheduler(fakeDb)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('★runOnStart:启动后延迟一次先跑,之后照常按间隔跑', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => {})
    registerJob({ name: 'test-onstart', intervalMs: 3 * 3600_000, runOnStart: true, startDelayMs: 5_000, run })
    startScheduler(fakeDb)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(run).not.toHaveBeenCalled() // 还没到延迟点,不该抢启动期的资源
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run).toHaveBeenCalledTimes(1) // 先跑了这一次
    await vi.advanceTimersByTimeAsync(3 * 3600_000)
    expect(run).toHaveBeenCalledTimes(2) // 间隔照常
  })

  it('job 抛错只记进自己的 lastError,不影响别的 job', async () => {
    vi.useFakeTimers()
    const ok = vi.fn(async () => {})
    registerJob({ name: 'test-boom', intervalMs: 1000, run: async () => { throw new Error('炸了') } })
    registerJob({ name: 'test-fine', intervalMs: 1000, run: ok })
    startScheduler(fakeDb)
    await vi.advanceTimersByTimeAsync(1100)
    expect(ok).toHaveBeenCalled()
    expect(getJobStatuses().find((s) => s.name === 'test-boom')?.lastError).toBe('炸了')
    expect(getJobStatuses().find((s) => s.name === 'test-fine')?.lastError).toBeNull()
  })

  it('stopScheduler 把 runOnStart 的一次性定时器也清掉(否则停了还会跑一次)', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => {})
    registerJob({ name: 'test-stop', intervalMs: 3600_000, runOnStart: true, startDelayMs: 5_000, run })
    startScheduler(fakeDb)
    stopScheduler()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
  })
})
