// src/local-date.ts —— 前端取「今天」的唯一实现。
//
// ★病灶:`new Date().toISOString().slice(0, 10)` 取的是 **UTC** 日期,而同一个页面里用
//   `getFullYear/getMonth/getDate` 拼出来的日期是**本地**的。东八区 00:00–08:00 这一段,
//   本地已经是 16 号、UTC 还停在 15 号,两套时钟就会在同一个请求里打架。
//
// ★真实代价(base 2026-08-16 凌晨实测):CRM 驾驶舱把 `asOf`(UTC=15)和 `endDate`(本地=16)
//   一起发出去,后端那条「endDate 不能晚于今天」直接 400,**整页显示「暂无CRM数据」**——
//   而空态文案写的是「录入线索或商机后会显示驾驶舱」,看上去像没数据,其实是接口挂了。
//   其余站点表现轻一些但同样是错的:凌晨建单据,日期默认成昨天,而**用户不会报**
//   (谁会怀疑系统填的默认日期?他多半以为是自己点错了)。
//
// ★为什么抽成一份而不是各页各写:仓里已经有过「同一个判断抄到多处、状态一变只改了一处」的教训。
//   护栏 `src/local-date-guard.test.ts` 只扫 `.vue`,所以这个文件本身不受它管 ——
//   它是被信任的那一份,改它要格外小心。
//
// 后端侧不归这里管:服务端算「今天」要按**租户时区**,见 core 里的相关实现,别拿这两个函数去用。

/** 本地时区的 `YYYY-MM-DD`。默认取现在。 */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 本地时区往后 / 往前挪 n 天的 `YYYY-MM-DD`。
 *
 * ★用 `setDate` 而不是「加 n×86400000 毫秒」:后者在**夏令时切换**那两天会差一小时,
 *   落在边界上就整整差一天。国内没有夏令时,但这个函数没有理由只在国内对
 *   (unix 的客户已经有海外业务了)。`setDate` 会自动进位月/年,-1 也照样对。
 */
export function localDatePlus(days: number, from: Date = new Date()): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

/**
 * 本地时区的 `YYYY-MM`(会计期间、报表期间、工资期间都用这个形状)。
 *
 * ★和 `localDate` 是同一个坑,只是**更少被撞到所以更难查**:`toISOString().slice(0, 7)`
 *   只在**每月 1 号的 00:00–08:00**(东八区)才会给出上个月。月初早上打开财务报表,
 *   期间默认成上月 —— 一个月只有一次机会露馅,而露馅那次多半被当成「我记错了」。
 */
export function localMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 本地时区的 `YYYY`。同上,只在**元旦当天早上**才会给出去年。 */
export function localYear(d: Date = new Date()): string {
  return String(d.getFullYear())
}
