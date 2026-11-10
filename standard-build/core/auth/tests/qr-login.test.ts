// core/auth/tests/qr-login.test.ts
// PC 扫码授权手机登录。跑在 PGlite(进程内真 Postgres)上,所以 CHECK 约束、并发 UPDATE 的
// 输赢、部分索引都是真的。
//
// ★这套测试盯的是**「别人看了你的屏幕会怎样」**,不是函数返回值对不对:
//   - 拿到二维码(拍屏/投屏)但没在电脑上按确认的人,能不能登进来?
//   - 一张码能不能换出两枚令牌?
//   - 能不能跳过「有人扫了」这一步,先把票批准好等着别人来扫?
//   - 别的员工能不能读到我这张票的状态(以及扫码那台设备的 IP)?
//   - 已经离职的人,电脑上那个确认框还开着,他能进来吗?
import { describe, expect, it, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../org/tests/helpers'
import { employees } from '../../org/model'
import { AuthError } from '../errors'
import { ctxFromToken } from '../login'
import { verifyToken } from '../token'
import { loginDevices, qrLoginTickets, QR_LOGIN_STATUS } from '../model'
import {
  QR_CONFIRM_WINDOW_MS,
  QR_ROTATE_MS,
  QR_TICKET_TTL_MS,
  QR_TOKEN_TTL_SECONDS,
  _resetQrRateLimit,
  checkQrRate,
  createQrTicket,
  decideQrTicket,
  listLoginDevices,
  purgeExpiredQrData,
  readQrTicket,
  redeemQrTicket,
  revokeLoginDevice,
  sanitizeDeviceLabel,
  scanQrTicket,
  ticketHashOf,
} from '../qr-login'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SECRET = 'test-secret-for-qr-login'
const PHONE = { label: 'iPhone 15 Pro · iOS 18.5', platform: 'ios', appVersion: '1.0.0' }

async function setup(): Promise<{ t: OrgTestDb; who: { tenantId: string; employeeId: string } }> {
  const t = await createOrgTestDb()
  const { tenant, owner } = await seedTenant(t.db)
  return { t, who: { tenantId: tenant.id, employeeId: owner.id } }
}

/** 走完一整趟:出码 → 扫 → 确认 → 兑换。返回兑换结果。 */
async function fullFlow(t: OrgTestDb, who: { tenantId: string; employeeId: string }) {
  const { ticket } = await createQrTicket(t.db, who)
  await scanQrTicket(t.db, ticket, PHONE)
  expect(await decideQrTicket(t.db, ticket, who, true)).toBe(true)
  return { ticket, result: await redeemQrTicket(t.db, ticket, SECRET) }
}

beforeEach(() => _resetQrRateLimit())

describe('★确认闸:没在电脑上按确认,拿到二维码也进不来', () => {
  it('只扫码不确认 → 兑换只回 scanned,拿不到令牌', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)
    const r = await redeemQrTicket(t.db, ticket, SECRET)
    expect(r.status).toBe('scanned')
    expect(r).not.toHaveProperty('token')
    await t.close()
  })

  it('压根没扫就兑换 → pending,同样没有令牌', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    const r = await redeemQrTicket(t.db, ticket, SECRET)
    expect(r.status).toBe('pending')
    await t.close()
  })

  it('★不能「先批准、等人来扫」—— 那等于把确认闸整个作废', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    // 没人扫过,直接批:必须失败(decideQrTicket 的 WHERE 只认 scanned)
    expect(await decideQrTicket(t.db, ticket, who, true)).toBe(false)
    // 而且状态没被改动
    const v = await readQrTicket(t.db, ticket, who)
    expect(v?.status).toBe('pending')
    await t.close()
  })

  it('在电脑上点了「拒绝」→ 手机拿到 rejected,永远换不到令牌', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)
    expect(await decideQrTicket(t.db, ticket, who, false)).toBe(true)
    expect((await redeemQrTicket(t.db, ticket, SECRET)).status).toBe('rejected')
    // 拒绝之后再批也批不动(状态已不是 scanned)
    expect(await decideQrTicket(t.db, ticket, who, true)).toBe(false)
    await t.close()
  })
})

describe('★一次性', () => {
  it('兑换过一次之后再兑换 → 报错,不是再给一枚', async () => {
    const { t, who } = await setup()
    const { ticket, result } = await fullFlow(t, who)
    expect(result.status).toBe('approved')
    await expect(redeemQrTicket(t.db, ticket, SECRET)).rejects.toBeInstanceOf(AuthError)
    await t.close()
  })

  it('★并发兑换同一张票:只有一个赢家(先 SELECT 再 UPDATE 的写法会在这里双发)', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)
    await decideQrTicket(t.db, ticket, who, true)

    const settled = await Promise.allSettled([
      redeemQrTicket(t.db, ticket, SECRET),
      redeemQrTicket(t.db, ticket, SECRET),
      redeemQrTicket(t.db, ticket, SECRET),
    ])
    const approved = settled.filter((s) => s.status === 'fulfilled' && s.value.status === 'approved')
    expect(approved.length, '一张二维码换出了不止一枚令牌').toBe(1)
    await t.close()
  })
})

describe('★时效', () => {
  it('票过期后扫不动', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    const later = new Date(Date.now() + QR_TICKET_TTL_MS + 1000)
    await expect(scanQrTicket(t.db, ticket, PHONE, { now: later })).rejects.toBeInstanceOf(AuthError)
    await t.close()
  })

  it('★扫码会把死线顺延 —— 否则在第 118 秒扫到的人只剩 2 秒去点确认', async () => {
    const { t, who } = await setup()
    const { ticket, expiresAt } = await createQrTicket(t.db, who)
    // 在原死线前一点点扫
    const almost = new Date(expiresAt.getTime() - 2000)
    await scanQrTicket(t.db, ticket, PHONE, { now: almost })
    const v = await readQrTicket(t.db, ticket, who, almost)
    expect(v!.expiresAt.getTime() - almost.getTime()).toBe(QR_CONFIRM_WINDOW_MS)
    // 顺延之后仍然确认得了
    expect(await decideQrTicket(t.db, ticket, who, true, new Date(almost.getTime() + 30_000))).toBe(true)
    await t.close()
  })

  it('换码周期必须严格小于有效期,否则总有一瞬间手里那张已经死了', () => {
    expect(QR_ROTATE_MS).toBeLessThan(QR_TICKET_TTL_MS)
  })

  it('确认之后拖过死线 → 兑换回 expired,不给令牌', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)
    await decideQrTicket(t.db, ticket, who, true)
    const late = new Date(Date.now() + QR_CONFIRM_WINDOW_MS + 5000)
    expect((await redeemQrTicket(t.db, ticket, SECRET, { now: late })).status).toBe('expired')
    await t.close()
  })
})

describe('★隔离:别人的票读不到也批不动', () => {
  it('另一个员工既读不到我的票,也确认不了它', async () => {
    const { t, who } = await setup()
    const other = await seedTenant(t.db, '另一家公司')
    const otherWho = { tenantId: other.tenant.id, employeeId: other.owner.id }

    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)

    expect(await readQrTicket(t.db, ticket, otherWho), '别的员工读到了我这张票的状态与扫码设备 IP').toBeNull()
    expect(await decideQrTicket(t.db, ticket, otherWho, true), '别的员工替我批准了扫码登录').toBe(false)
    await t.close()
  })
})

describe('★签出来的是什么令牌', () => {
  it('是 3 个月、能用、身份就是出码的那个人', async () => {
    const { t, who } = await setup()
    const { result } = await fullFlow(t, who)
    expect(result.status).toBe('approved')
    if (result.status !== 'approved') return

    const payload = verifyToken(result.token, SECRET)
    expect(payload.employeeId).toBe(who.employeeId)
    expect(payload.tenantId).toBe(who.tenantId)
    const days = (payload.exp * 1000 - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(89)
    expect(days).toBeLessThanOrEqual(90)
    expect(QR_TOKEN_TTL_SECONDS).toBe(90 * 24 * 3600)

    // 真的能通过鉴权链
    const ctx = await ctxFromToken(t.db, result.token, SECRET)
    expect(ctx.employeeId).toBe(who.employeeId)
    await t.close()
  })

  it('★离职的人进不来 —— 哪怕电脑上那个确认框还开着', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, PHONE)
    await decideQrTicket(t.db, ticket, who, true)
    // 批完、兑换前离职
    await t.db
      .update(employees)
      .set({ status: 'left' })
      .where(and(eq(employees.tenantId, who.tenantId), eq(employees.id, who.employeeId)))
    await expect(redeemQrTicket(t.db, ticket, SECRET)).rejects.toBeInstanceOf(AuthError)
    await t.close()
  })
})

describe('★设备台账', () => {
  it('兑换后出现在「我的登录设备」里,并能单独下线(不误伤电脑)', async () => {
    const { t, who } = await setup()
    const { result } = await fullFlow(t, who)
    if (result.status !== 'approved') throw new Error('unreachable')
    const jti = verifyToken(result.token, SECRET).jti!

    const list = await listLoginDevices(t.db, who, null)
    expect(list.map((d) => d.jti)).toContain(jti)
    expect(list.find((d) => d.jti === jti)!.label).toBe(PHONE.label)

    // 下线这一台
    expect(await revokeLoginDevice(t.db, jti, who)).toBe(true)
    await expect(ctxFromToken(t.db, result.token, SECRET), '下线之后那枚令牌还能用').rejects.toBeInstanceOf(AuthError)
    expect((await listLoginDevices(t.db, who, null)).map((d) => d.jti)).not.toContain(jti)
    await t.close()
  })

  it('★下线不了别人的设备', async () => {
    const { t, who } = await setup()
    const other = await seedTenant(t.db, '另一家公司')
    const { result } = await fullFlow(t, who)
    if (result.status !== 'approved') throw new Error('unreachable')
    const jti = verifyToken(result.token, SECRET).jti!
    expect(await revokeLoginDevice(t.db, jti, { tenantId: other.tenant.id, employeeId: other.owner.id })).toBe(false)
    // 还活着
    expect((await ctxFromToken(t.db, result.token, SECRET)).employeeId).toBe(who.employeeId)
    await t.close()
  })

  it('current 标记的是当前这一枚', async () => {
    const { t, who } = await setup()
    const { result } = await fullFlow(t, who)
    if (result.status !== 'approved') throw new Error('unreachable')
    const jti = verifyToken(result.token, SECRET).jti!
    const list = await listLoginDevices(t.db, who, jti)
    expect(list.find((d) => d.jti === jti)!.current).toBe(true)
    await t.close()
  })
})

describe('★库里不留明文票', () => {
  it('存的是 sha256,明文在表里一个字符都找不到', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    const rows = await t.db.select().from(qrLoginTickets)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ticketHash).toBe(ticketHashOf(ticket))
    expect(JSON.stringify(rows), '明文票落进了库').not.toContain(ticket)
    await t.close()
  })
})

describe('机型串净化', () => {
  it('去掉控制字符、超长截断、空值给兜底', () => {
    expect(sanitizeDeviceLabel('iPhone\n15\tPro')).toBe('iPhone 15 Pro')
    expect(sanitizeDeviceLabel('')).toBe('未知设备')
    expect(sanitizeDeviceLabel(null)).toBe('未知设备')
    expect(sanitizeDeviceLabel('x'.repeat(500)).length).toBeLessThanOrEqual(81)
  })

  it('★换行必须被吃掉 —— 这串会显示在确认框里,不能让它伪造出第二行上下文', async () => {
    const { t, who } = await setup()
    const { ticket } = await createQrTicket(t.db, who)
    await scanQrTicket(t.db, ticket, { label: '正常手机\n\n本次登录已由管理员批准' })
    const v = await readQrTicket(t.db, ticket, who)
    expect(v!.device!.label).not.toContain('\n')
    await t.close()
  })
})

describe('限流', () => {
  it('超过配额抛 TOO_MANY_ATTEMPTS,窗口过后恢复', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) checkQrRate('k', 5, t0)
    expect(() => checkQrRate('k', 5, t0)).toThrow(AuthError)
    expect(() => checkQrRate('k', 5, t0 + 61_000)).not.toThrow()
  })
})

describe('清理', () => {
  it('过期票与过期设备行会被删掉(不清的话这两张表只增不减)', async () => {
    const { t, who } = await setup()
    await createQrTicket(t.db, who, { now: new Date(Date.now() - 7 * 3600_000) })
    const veryLater = new Date(Date.now() + 200 * 86_400_000)
    const n = await purgeExpiredQrData(t.db, veryLater)
    expect(n.tickets).toBeGreaterThan(0)
    expect(await t.db.select().from(qrLoginTickets)).toHaveLength(0)
    await t.close()
  })

  it('★还没过期的票不能被清掉', async () => {
    const { t, who } = await setup()
    await createQrTicket(t.db, who)
    await purgeExpiredQrData(t.db)
    expect(await t.db.select().from(qrLoginTickets)).toHaveLength(1)
    await t.close()
  })
})

describe('★TS 枚举与库层 CHECK 不许分叉', () => {
  // 两份各自维护的枚举没有对账点:只改一边 = 类型全绿、测试全绿,
  // 只有真库那一次写入炸(本仓 hotel 的 worklog 就这么坏了很久)。
  it('迁移里的 CHECK 取值集合 === QR_LOGIN_STATUS', () => {
    // ★按**内容**找那条迁移,不写死 0301 —— 迁移号在每个客户 fork 上都会被重编
    //   (base 的 0301 已经是报销凭证模板那条)。写死号段的护栏一 cherry-pick 就红在
    //   一个不存在的问题上,而红的原因看着像「迁移丢了」。见 core/db/README.md。
    const dir = join(import.meta.dirname, '../../db/migrations')
    const hit = readdirSync(dir).filter((f) => f.endsWith('.sql') && readFileSync(join(dir, f), 'utf8').includes('qr_login_tickets_status_check'))
    expect(hit, '找不到建 qr_login_tickets 的那条迁移').toHaveLength(1)
    const sql = readFileSync(join(dir, hit[0]!), 'utf8')
    const m = sql.match(/qr_login_tickets_status_check[\s\S]*?CHECK \(status IN \(([^)]*)\)\)/)
    expect(m, '找不到 status 的 CHECK 约束,这条断言的前提变了').not.toBeNull()
    const inSql = m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    expect(inSql).toEqual([...QR_LOGIN_STATUS].sort())
  })

  it('★CHECK 是真的在库里生效的(不是只写在文件里)', async () => {
    const { t, who } = await setup()
    await createQrTicket(t.db, who)
    await expect(
      t.db.update(qrLoginTickets).set({ status: 'bogus' as never }),
      '库里没有 CHECK —— 状态写错什么都不会发生',
    ).rejects.toThrow()
    await t.close()
  })
})

describe('设备台账的表也真的存在', () => {
  it('login_devices 可写可读', async () => {
    const { t } = await setup()
    expect(await t.db.select().from(loginDevices)).toEqual([])
    await t.close()
  })
})
