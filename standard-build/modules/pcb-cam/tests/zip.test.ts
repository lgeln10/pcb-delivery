// 最小 zip 写入器:不靠第三方解压库,按 zip 规范自己读中央目录、逐个 inflate 回来比对。
import { describe, expect, it } from 'vitest'
import { crc32, inflateRawSync } from 'node:zlib'
import { buildZip, dedupeNames } from '../zip'

type Parsed = { name: string; data: Buffer; crc: number }

/** 从 EOCD 找中央目录,再按每条记录的本地头偏移取数据 */
function readZip(buf: Buffer): Parsed[] {
  expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50)
  const count = buf.readUInt16LE(buf.length - 12)
  let p = buf.readUInt32LE(buf.length - 6)
  const out: Parsed[] = []
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    expect(buf.readUInt32LE(local)).toBe(0x04034b50)
    const lnlen = buf.readUInt16LE(local + 26)
    const lelen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lnlen + lelen
    const raw = buf.subarray(start, start + csize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(data.length).toBe(usize)
    out.push({ name, data, crc })
    p += 46 + nlen + elen + clen
  }
  return out
}

describe('buildZip', () => {
  it('写出的包能按规范读回:文件名(含中文)、内容、CRC 都对', () => {
    const gerber = Buffer.from('%FSLAX46Y46*%\n%MOMM*%\nG04 ' + 'X'.repeat(5000) + '*\nM02*\n')
    const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff))
    const zip = buildZip([
      { name: 'board_panel.GTL', data: gerber, mtime: new Date('2026-09-07T10:00:00') },
      { name: '流程单.html', data: Buffer.from('<h1>流程单</h1>'), mtime: new Date('2026-09-07T10:00:00') },
      { name: 'drill/PTH.drl', data: bin },
    ])
    const got = readZip(zip)
    expect(got.map((g) => g.name)).toEqual(['board_panel.GTL', '流程单.html', 'drill/PTH.drl'])
    expect(got[0]!.data.equals(gerber)).toBe(true)
    expect(got[1]!.data.toString('utf8')).toBe('<h1>流程单</h1>')
    expect(got[2]!.data.equals(bin)).toBe(true)
    for (const g of got) expect(g.crc).toBe(crc32(g.data))
    // 文本真的被压了(不是 store),否则大 Gerber 打包没意义
    expect(zip.length).toBeLessThan(gerber.length + bin.length)
  })

  it('空包也是合法 zip;同名文件加序号而不是互相覆盖', () => {
    const empty = buildZip([])
    expect(readZip(empty)).toEqual([])
    expect(dedupeNames(['a.drl', 'A.DRL', 'a.drl', 'noext', 'noext'])).toEqual(['a.drl', 'A (1).DRL', 'a (2).drl', 'noext', 'noext (1)'])
    const dup = buildZip([
      { name: 'x.txt', data: Buffer.from('1') },
      { name: 'x.txt', data: Buffer.from('2') },
    ])
    expect(readZip(dup).map((g) => [g.name, g.data.toString()])).toEqual([
      ['x.txt', '1'],
      ['x (1).txt', '2'],
    ])
  })
})
