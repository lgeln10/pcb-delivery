// 站内信列表:游标分页 + 「只看未读」过滤。
// ★这个模块此前一条测试都没有 —— 铃铛只取首页 20 条,分页与过滤从来没被走到过。
//   新增的整页(NotificationsPage.vue)会真的翻页、真的切「未读」,所以先把契约钉住。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createOrgTestDb, seedTenant, type OrgTestDb } from '../../../core/org/tests/helpers'
import { createEmployee } from '../../../core/org/logic/employee'
import type { Ctx } from '../../../core/db/client'
import { getUnreadCount, listMyNotifications, markAllRead, markRead } from '../logic'
import { inappNotifications } from '../model'

let t: OrgTestDb
let me: Ctx
let other: Ctx

/**
 * 直接插表而不走 createNotification:要**精确控制 createdAt** 才能断言倒序与游标。
 * createNotification 用数据库默认 now(),连插几条的时间差在微秒级,顺序不稳。
 */
async function seedNotif(recipient: Ctx, opts: { title: string; minutesAgo: number; read: boolean }) {
  await t.db.insert(inappNotifications).values({
    id: randomUUID(),
    tenantId: recipient.tenantId,
    createdBy: recipient.employeeId,
    updatedBy: recipient.employeeId,
    recipientId: recipient.employeeId,
    type: 'system',
    title: opts.title,
    body: opts.title + ' 正文',
    sourceType: 'db_backup',
    sourceId: randomUUID(),
    isRead: opts.read,
    readAt: opts.read ? new Date() : null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - opts.minutesAgo * 60_000),
  })
}

beforeAll(async () => {
  t = await createOrgTestDb()
  const s = await seedTenant(t.db, '站内信租户')
  me = s.ownerCtx
  const emp = await createEmployee(t.db, me, { name: '同事', empNo: 'N001', phone: '13922220001', departmentId: s.rootDept.id })
  other = { tenantId: me.tenantId, employeeId: emp.id }
})
afterAll(async () => t.close())

describe('我的站内信列表', () => {
  it('只看未读:必须在 SQL 里过滤 —— 前 20 条全已读时,未读页仍要拿到后面的未读', async () => {
    // 最新的 20 条全部已读,更早的 3 条未读。这正是「前端拿一页自己筛」会翻车的形状:
    // 未读页会显示成空,而下面其实还有 3 条未读。
    for (let i = 0; i < 20; i += 1) await seedNotif(me, { title: `已读${i}`, minutesAgo: i, read: true })
    for (let i = 0; i < 3; i += 1) await seedNotif(me, { title: `未读${i}`, minutesAgo: 100 + i, read: false })

    const unread = await listMyNotifications(t.db, me, { unreadOnly: true })
    expect(unread.items.map((n) => n.title)).toEqual(['未读0', '未读1', '未读2'])
    expect(unread.nextCursor).toBeNull()

    // 不传 unreadOnly = 全部,首页是最新的 20 条(全已读)且还有下一页
    const all = await listMyNotifications(t.db, me)
    expect(all.items).toHaveLength(20)
    expect(all.items.every((n) => n.isRead)).toBe(true)
    expect(all.nextCursor).not.toBeNull()
  })

  it('游标分页在「只看未读」下同样成立(不会把已读混回来)', async () => {
    const page1 = await listMyNotifications(t.db, me, { unreadOnly: true, limit: 2 })
    expect(page1.items.map((n) => n.title)).toEqual(['未读0', '未读1'])
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await listMyNotifications(t.db, me, { unreadOnly: true, limit: 2, cursor: page1.nextCursor! })
    expect(page2.items.map((n) => n.title)).toEqual(['未读2'])
    expect(page2.nextCursor).toBeNull()
  })

  it('只看自己的:同租户同事的通知不出现在我的列表里', async () => {
    await seedNotif(other, { title: '同事的未读', minutesAgo: 1, read: false })
    const mine = await listMyNotifications(t.db, me, { unreadOnly: true })
    expect(mine.items.map((n) => n.title)).not.toContain('同事的未读')
    const theirs = await listMyNotifications(t.db, other, { unreadOnly: true })
    expect(theirs.items.map((n) => n.title)).toEqual(['同事的未读'])
  })

  it('标已读后从未读列表消失,未读数同步减少', async () => {
    const before = await getUnreadCount(t.db, me)
    const target = (await listMyNotifications(t.db, me, { unreadOnly: true })).items[0]!
    await markRead(t.db, me, target.id)
    expect(await getUnreadCount(t.db, me)).toBe(before - 1)
    const after = await listMyNotifications(t.db, me, { unreadOnly: true })
    expect(after.items.map((n) => n.id)).not.toContain(target.id)
    // 全部列表里还在,只是变成已读 —— 「未读」是筛选不是删除
    const all = await listMyNotifications(t.db, me, { limit: 50 })
    expect(all.items.find((n) => n.id === target.id)?.isRead).toBe(true)
  })

  it('全部已读只清自己的:同事的未读不受影响', async () => {
    await markAllRead(t.db, me)
    expect(await getUnreadCount(t.db, me)).toBe(0)
    expect((await listMyNotifications(t.db, me, { unreadOnly: true })).items).toHaveLength(0)
    expect(await getUnreadCount(t.db, other)).toBe(1)
  })
})
