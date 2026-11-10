// core/org/logic/avatar.ts — 员工头像的自助设置(个人设置页)。
//
// 三条约束,都是有意的:
// ① **只能改自己**:入参没有 employeeId,永远写 ctx.employeeId。头像是本人的脸,
//    不该出现「管理员帮你换一张」这种口子(要改别人的资料走 org:manage 的员工编辑,那是另一条路)。
// ② **默认没有头像**:清空 = 写 NULL,不是「换回默认头像」。系统不替任何人挑脸。
// ③ **私有存储**:员工照片是 PII,落 `storage:private/`,出站由 core/http/private-files.ts
//    换成短时效票据地址。不像系统 logo 那样走公开直链 —— logo 要在未登录的登录页显示,头像不用。
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../../db/client'
import { scope } from '../../db/soft-delete'
import { checkUpload, putObject } from '../../storage/api'
import { employees } from '../model'
import { OrgError } from './errors'

/** 允许的头像图片类型。★不含 svg —— 头像是**任意员工**传上来的,而 svg 是能被当页面渲染的东西
 *  (upload-guard.ts 头注释:svg 只给 logo/官网这类管理员口子)。 */
export const AVATAR_UPLOAD_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024 // 2MB;前端还会先压一道(src/image-compress.ts)

/** 校验头像上传,返回**归一后的 contentType**(调用方必须拿它去 putObject,别用客户端声明的)。 */
export function assertAllowedAvatar(bytes: Buffer, filename: string, size: number): string {
  if (size > MAX_AVATAR_BYTES) throw new OrgError('INVALID_INPUT', '头像图片不能超过 2MB')
  const checked = checkUpload(bytes, filename, AVATAR_UPLOAD_EXTS)
  if (!checked.ok) throw new OrgError('INVALID_INPUT', checked.reason)
  return checked.contentType
}

/** 上传并设为本人头像。返回入库后的 URL(私有标记,出站中间件会换成带票据的地址)。 */
export async function setOwnAvatar(
  db: Db,
  ctx: Ctx,
  input: { bytes: Buffer; filename: string; contentType: string },
): Promise<{ avatarUrl: string }> {
  const stored = await putObject(db, ctx, { ...input, keyPrefix: 'avatars', visibility: 'private' })
  await writeAvatar(db, ctx, stored.url)
  return { avatarUrl: stored.url }
}

/** 移除本人头像 → 回到「没有头像」(显示姓名首字),不是回到某张默认图。 */
export async function clearOwnAvatar(db: Db, ctx: Ctx): Promise<{ avatarUrl: null }> {
  await writeAvatar(db, ctx, null)
  return { avatarUrl: null }
}

/** 旧文件有意不删:云存储上的孤儿对象由存储侧生命周期管;删了会让还拿着旧票据的页面变成裂图。 */
async function writeAvatar(db: Db, ctx: Ctx, avatarUrl: string | null): Promise<void> {
  const updated = await db
    .update(employees)
    .set({ avatarUrl, updatedBy: ctx.employeeId, updatedAt: new Date() })
    .where(and(scope(employees, ctx.tenantId), eq(employees.id, ctx.employeeId)))
    .returning({ id: employees.id })
  if (updated.length === 0) throw new OrgError('NOT_FOUND', `employee ${ctx.employeeId} not found`)
}
