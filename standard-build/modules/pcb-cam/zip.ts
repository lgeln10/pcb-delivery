// modules/pcb-cam/zip.ts
// 最小 zip 写入器:成果物「打包下载」用。只写 deflate(方法 8)+ 中央目录 + EOCD,不做 zip64
// (单个 job 的成果物几十个文件、几十 MB,远够用)。手写而不是加依赖:仓里没有 zip 库,
// 而这个格式只有三种记录。文件名按 UTF-8 写并置通用位标志 bit 11,中文名在 Windows 资源管理器里也对。
import { crc32, deflateRawSync } from 'node:zlib'

export type ZipEntry = { name: string; data: Buffer; mtime?: Date }

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const METHOD_DEFLATE = 8
const FLAG_UTF8 = 1 << 11
/** 目标不是压缩率而是「一个文件」,deflate 到 6 就够了,Gerber 文本一般能压到 1/5 */
const LEVEL = 6

/** DOS 时间戳(zip 的 mtime 只有 2 秒精度,1980 年起)。按 UTC 写:zip 规范没有时区,解压工具各按本机解释,
 *  这里只求同一包内一致,不走系统时区(tz-guard 只放行 getUTC*)。 */
function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(d.getUTCFullYear(), 1980)
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)
  const date = ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()
  return { time, date }
}

/** 同名文件在 zip 里会互相覆盖(解压工具的行为不一),这里给后来的加序号 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = n.toLowerCase()
    const c = seen.get(k) ?? 0
    seen.set(k, c + 1)
    if (c === 0) return n
    const dot = n.lastIndexOf('.')
    return dot > 0 ? `${n.slice(0, dot)} (${c})${n.slice(dot)}` : `${n} (${c})`
  })
}

export function buildZip(entries: ZipEntry[], now = new Date()): Buffer {
  const names = dedupeNames(entries.map((e) => e.name.replace(/\\/g, '/').replace(/^\/+/, '')))
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  entries.forEach((e, i) => {
    const name = Buffer.from(names[i]!, 'utf8')
    const packed = deflateRawSync(e.data, { level: LEVEL })
    const crc = crc32(e.data)
    const { time, date } = dosDateTime(e.mtime ?? now)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra
    parts.push(local, name, packed)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(SIG_CENTRAL, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8)
    cd.writeUInt16LE(METHOD_DEFLATE, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(date, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(packed.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // comment
    cd.writeUInt16LE(0, 34) // disk
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += local.length + name.length + packed.length
  })
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, cdBuf, eocd])
}
