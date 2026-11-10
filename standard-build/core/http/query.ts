// core/http/query.ts
// 查询串参数的 zod 字段助手(分页的 limit/offset 在 pagination.ts,布尔在这里)。
//
// ★boolField 存在的唯一理由:**`z.coerce.boolean()` 用在查询串上永远是错的**。
//   查询串里的值只可能是字符串,而 coerce 走的是 `Boolean(v)` —— `Boolean('false') === true`。
//   于是 `?flag=false` 被读成 `true`,而且**不报错、不进日志**,只是行为悄悄反过来:
//   - inapp-notify:`unreadOnly=false` 读成 true → 「切到未读」正常、「切回全部」也只剩未读;
//   - crm-todo:`includeResolved=false` 读成 true → 已完成的待办照样带回列表(只是灰一档),
//     用户看到的是「点了完成还在逾期列表里」(2026-08-15 实测复现,就是这条)。
//   前端不会把 `false` 从查询串里省掉(见 src/api/client.ts 的 request:只跳过 undefined/null/''),
//   所以「默认值是 false 就不会传」这种侥幸不成立。
//   两次都是同一个形状,故收成一个助手 + 一条护栏测试(tests/query-bool-guard.test.ts)。
import { z } from 'zod'

/**
 * 查询串里的布尔参数:只认 `'true'` / `'false'` 两个字面量,解析成真正的 boolean;未传即 undefined。
 *
 * 传其它值(如 `?flag=1`)是 422 而不是猜 —— 猜正是 `z.coerce.boolean()` 的病。
 *
 * @example includeResolved: boolField()
 */
export const boolField = () =>
  z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'))
