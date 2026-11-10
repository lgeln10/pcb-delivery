// src/avatars.ts — **数字员工**头像图库(3D 数字人,codex 内置 image_gen 生成,存 public/avatars/)。
// 用户创建/雇人时可选头像;不选则按员工 id 稳定挑一个(随机但稳定,刷新不变)。
// 渲染 <img :src="avatarUrl(...)">,加载失败回退首字母底色(见各组件 avatar 结构)。
//
// ★★★ 只给「数字员工 / AI 智能体」用,**真人同事一律不许碰这里**(2026-08-16 用户反馈)。
//   真人的头像是 `employees.avatar_url` —— 本人在个人设置页上传的那一张,没传就显示姓名首字。
//   这里的 `avatarKeyForSeed` 是「按 id 稳定挑一张」,套在真人身上就是**系统替每个人认领了一张脸**:
//   消息页里一屏陌生的 3D 面孔,谁也认不出谁,而且没有任何人能改。
//   护栏:`modules/messenger/tests/avatar-no-default.test.ts` 会拦住 messenger 再 import 本文件。
export const AVATAR_KEYS = [
  'avatar-01', 'avatar-02', 'avatar-03', 'avatar-04',
  'avatar-05', 'avatar-06', 'avatar-07', 'avatar-08',
] as const
export type AvatarKey = (typeof AVATAR_KEYS)[number]

function isKey(k: string | null | undefined): k is AvatarKey {
  return !!k && (AVATAR_KEYS as readonly string[]).includes(k)
}

/** 头像图片 URL(public/avatars 下,静态服务)。非法/空 key 回退首张。 */
export function avatarUrl(key: string | null | undefined): string {
  return `/avatars/${isKey(key) ? key : AVATAR_KEYS[0]}.png`
}

/** 按种子(员工 id)稳定挑一个头像 —— 未显式选择时的默认,保证同一员工每次一致。 */
export function avatarKeyForSeed(seed: string): AvatarKey {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0x7fffffff
  return AVATAR_KEYS[h % AVATAR_KEYS.length]!
}

/** 解析员工最终头像 key:优先其存储的 avatarId,否则按 id 稳定回退。 */
export function resolveAvatarKey(e: { avatarId?: string | null; id: string }): AvatarKey {
  return isKey(e.avatarId) ? e.avatarId : avatarKeyForSeed(e.id)
}

/** 随机挑一个(创建时用户没选头像的默认)。 */
export function randomAvatarKey(): AvatarKey {
  return AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)]!
}
