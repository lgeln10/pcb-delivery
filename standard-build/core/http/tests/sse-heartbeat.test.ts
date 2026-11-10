// SSE 心跳。钉的是三件事:第一拍立刻发、之后按间隔发、停了就真停。
//
// ★为什么值得单测:它坏掉的样子是**看不见的** —— 流照常跑、事件照常到,只是长时间
//   没有字节的那一段没人保活,于是浏览器把连接掐了,前端抛一句「Load failed」。
//   谁都不会怀疑到心跳上(2026-08-24 线上就是这么找了一圈)。
import { describe, expect, it, vi } from 'vitest'
import { SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_MS, startSseHeartbeat } from '../sse-heartbeat'

describe('★SSE 心跳', () => {
  it('第一拍立刻发 —— 首字节要马上出去,客户端才知道「连上了、在干活」', () => {
    const beats: number[] = []
    const stop = startSseHeartbeat(() => beats.push(1))
    try {
      expect(beats.length, '等到第一个间隔才发的话,前 15 秒仍然是纯静默').toBe(1)
    } finally {
      stop()
    }
  })

  it('之后按间隔发;stop 之后一拍都不再发', () => {
    vi.useFakeTimers()
    try {
      let beats = 0
      const stop = startSseHeartbeat(() => { beats += 1 }, 1_000)
      expect(beats).toBe(1)
      vi.advanceTimersByTime(3_500)
      expect(beats).toBe(4) // 立刻那一拍 + 3 次
      stop()
      vi.advanceTimersByTime(10_000)
      // 不清定时器的话,一轮结束后它还在往一条已经收尾的流里写
      expect(beats, 'stop 之后还在跳 = 定时器泄漏').toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('帧是**注释**不是 data —— 前端解析器必须看不见它', () => {
    // src/api/client.ts 的解析:按 \n\n 切帧,只取以 `data:` 开头的行。
    // 心跳一旦写成 data 帧,就会变成一个前端不认识的假事件(轻则忽略,重则渲染出空气泡)。
    expect(SSE_HEARTBEAT_FRAME.startsWith(':')).toBe(true)
    expect(SSE_HEARTBEAT_FRAME.endsWith('\n\n'), '不以空行结尾就不是一个完整帧,会粘住下一帧').toBe(true)
    const dataLine = SSE_HEARTBEAT_FRAME.split('\n').find((l) => l.startsWith('data:'))
    expect(dataLine, '解析器会把它当成一个事件').toBeUndefined()
  })

  it('间隔要短于常见的空闲上限(代理普遍 30s 起)', () => {
    expect(SSE_HEARTBEAT_MS).toBeLessThan(30_000)
  })
})
