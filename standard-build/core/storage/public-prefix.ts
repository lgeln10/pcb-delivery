// core/storage/public-prefix.ts
// 「哪些 key 是匿名可读的」——公开/私有那条线的**唯一定义**。
//
// 这条线本来就存在,只是原先散在三处各自表述:
//   * core/db/migrations/0143_private_file_urls.sql —— 把 contract/finance/reimbursements/
//     payment-vouchers/hr/general-request/feedback 改写成 storage:private/,并写明
//     「公开前缀(branding 系统 logo、website 官网图)保持直链不动」;
//   * core/storage/repair-public.ts —— PUBLIC_COLUMNS 只扫 branding/ 与 website/;
//   * core/http/app.ts 的 /uploads 静态路由 —— **没有收窄**,把整个 UPLOAD_DIR 都开了。
// 第三处漏掉的后果:本地存储模式下,发票/合同/证件/报销附件全都躺在同一个 UPLOAD_DIR 里,
// 于是 `/api/files/<key>?t=<15分钟票据>` 只要把 `?t=` 去掉、把 `/api/files/` 换成 `/uploads/`,
// 就是一条**永不过期、不需要登录**的直链 —— 整套票据机制被旁路掉。
//
// 所以把它收进一个常量,三处引同一个,新增公开前缀时只有这一处要改。
// ★往这里加前缀 = 宣布该前缀下的文件可以被任何人匿名下载。加之前先问一遍这句话成不成立。

/** 匿名可读的 key 前缀(结尾的 `/` 是有意的:防 `websiteX/` 这类前缀混淆)。 */
export const PUBLIC_KEY_PREFIXES = [
  'branding/', // 系统 logo:未登录的登录页就要显示
  'website/', // 企业官网图片:公网访客与爬虫要读(og:image 等)
] as const

/**
 * 这个 key 是否属于公开前缀。
 * ★先归一化再判:去掉前导 `/`、把 `\` 当 `/`,并拒绝任何含 `..` 的段(防前缀绕过与路径穿越)。
 */
export function isPublicStorageKey(rawKey: string): boolean {
  const key = rawKey.replace(/\\/g, '/').replace(/^\/+/, '')
  if (key.split('/').some((seg) => seg === '..' || seg === '.')) return false
  return PUBLIC_KEY_PREFIXES.some((p) => key.startsWith(p))
}
