// core/org/tests/own-avatar.test.ts — 员工自助设置头像。
//
// 这一组守的是产品口径,不只是接口能不能跑通:
// ① **新建的人没有头像**(avatar_url 为 NULL)—— 「默认不分配头像」是从库层就成立的,
//    不是前端少渲染一个 <img> 那种表面功夫;
// ② **只能改自己** —— setOwnAvatar 的入参里根本没有 employeeId,顺手钉死这一点:
//    A 传头像不该动到 B 那一行;
// ③ **移除 = 回到没有**,不是换成另一张默认图;
// ④ 上传校验按**内容**判,不认客户端声明的类型/扩展名(.png 里装 HTML 要被拒)。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createOrgTestDb, seedTenant, type OrgTestDb } from './helpers'
import { assertAllowedAvatar, clearOwnAvatar, MAX_AVATAR_BYTES, setOwnAvatar } from '../logic/avatar'
import { createEmployee } from '../logic/employee'
import { employeeBriefsByIds } from '../api'
import { employees } from '../model'
import { OrgError } from '../logic/errors'
import type { Ctx } from '../../db/client'

let t: OrgTestDb
let ownerCtx: Ctx
let rootDeptId: string

beforeAll(async () => {
  t = await createOrgTestDb()
  const seeded = await seedTenant(t.db)
  ownerCtx = seeded.ownerCtx
  rootDeptId = seeded.rootDept.id
})
afterAll(async () => t.close())

/** 最小合法 PNG(魔数 + 一点内容);判定看的是文件头,不需要真是一张能解码的图 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')])

let seq = 0
async function newEmployee() {
  seq += 1
  return createEmployee(t.db, ownerCtx, {
    name: `员工${seq}`,
    empNo: `A${String(seq).padStart(4, '0')}`,
    phone: `137${String(seq).padStart(8, '0')}`,
    departmentId: rootDeptId,
    password: 'init-pass-123',
  })
}

async function avatarOf(id: string): Promise<string | null> {
  const rows = await t.db
    .select({ avatarUrl: employees.avatarUrl })
    .from(employees)
    .where(and(eq(employees.tenantId, ownerCtx.tenantId), eq(employees.id, id)))
  return rows[0]?.avatarUrl ?? null
}

describe('默认不分配头像', () => {
  it('★新建员工的 avatar_url 是 NULL(库层就没有「默认头像」这回事)', async () => {
    const emp = await newEmployee()
    expect(await avatarOf(emp.id)).toBeNull()
  })

  it('★批量取展示信息时,没设过头像的人拿到的是 null,不是某张兜底图', async () => {
    const emp = await newEmployee()
    const briefs = await employeeBriefsByIds(t.db, ownerCtx.tenantId, [emp.id])
    expect(briefs.get(emp.id)).toEqual({ name: emp.name, avatarUrl: null })
  })
})

describe('自助设置头像', () => {
  it('上传后本人那一行有了头像,再移除又回到 null', async () => {
    const emp = await newEmployee()
    const ctx: Ctx = { ...ownerCtx, employeeId: emp.id }
    const { avatarUrl } = await setOwnAvatar(t.db, ctx, { bytes: PNG, filename: 'me.png', contentType: 'image/png' })
    expect(avatarUrl).toContain('avatars/') // 落在 avatars/ 前缀下
    expect(await avatarOf(emp.id)).toBe(avatarUrl)

    await clearOwnAvatar(t.db, ctx)
    expect(await avatarOf(emp.id)).toBeNull() // 不是「换回默认图」,是真的没有
  })

  it('★只动自己那一行:A 设头像不会碰到 B', async () => {
    const a = await newEmployee()
    const b = await newEmployee()
    await setOwnAvatar(t.db, { ...ownerCtx, employeeId: a.id }, { bytes: PNG, filename: 'a.png', contentType: 'image/png' })
    expect(await avatarOf(a.id)).not.toBeNull()
    expect(await avatarOf(b.id)).toBeNull()
  })

  it('私有存储:入库的是 storage:private 标记,不是公开直链(员工照片是 PII)', async () => {
    const emp = await newEmployee()
    const { avatarUrl } = await setOwnAvatar(
      t.db,
      { ...ownerCtx, employeeId: emp.id },
      { bytes: PNG, filename: 'me.png', contentType: 'image/png' },
    )
    expect(avatarUrl.startsWith('storage:private/')).toBe(true)
  })
})

describe('上传校验', () => {
  it('合法 PNG 通过,返回归一后的 contentType', () => {
    expect(assertAllowedAvatar(PNG, 'me.PNG', PNG.length)).toBe('image/png')
  })

  it('★改了扩展名的 HTML 会被拒(判据看内容,不看客户端说是什么)', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>')
    expect(() => assertAllowedAvatar(html, 'evil.png', html.length)).toThrow(OrgError)
  })

  it('★不收 svg —— 头像是任意员工传的,svg 能被当页面渲染', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(() => assertAllowedAvatar(svg, 'me.svg', svg.length)).toThrow(OrgError)
  })

  it('超过 2MB 拒绝', () => {
    expect(() => assertAllowedAvatar(PNG, 'me.png', MAX_AVATAR_BYTES + 1)).toThrow(OrgError)
  })
})
