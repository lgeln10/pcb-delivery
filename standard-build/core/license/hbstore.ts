// core/license/hbstore.ts
// 心跳结果的持久化(跨重启)。独立小模块,避免 state.ts ↔ heartbeat.ts 循环依赖。
import { readFileSync, writeFileSync } from 'node:fs'

export type HeartbeatState = { revoked: boolean; serverExpiresAt: string | null; lastOkAt: string | null }

function stateFile(): string {
  return process.env.LICENSE_STATE_FILE || `${process.env.UPLOAD_DIR || 'uploads'}/.license-hb.json`
}

export function readHeartbeatState(): HeartbeatState | null {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as HeartbeatState
  } catch {
    return null
  }
}

export function writeHeartbeatState(s: HeartbeatState): void {
  try {
    writeFileSync(stateFile(), JSON.stringify(s))
  } catch {
    /* 只读 fs 写不了也不致命 */
  }
}
