// core/http/tests/errors.test.ts
// 「所有后端报错都要让用户知道发生了什么」这条要求的护栏。
//
// ── 为什么要有这份 ─────────────────────────────────────────────────────────
// 2026-08-10 线上:销售在飞书说「今天跟进 XX,做了机房需求评估…」,助手第一步「认领线索」
// 撞上「线索在待分配池」,他看到的是「执行失败,请稍后重试或到系统里操作。」——
// 既不知道发生了什么(线索不归他),也不知道下一步该干什么(找管理员分配;跟进其实照样能记),
// 只能反复重说,而每重说一次就多一份重复档案。
//
// 排查发现这不是个例:全仓 1528 处业务错误里 **762 处 message 是英文技术串**
// (`lead is in pending-assignment pool; use assign instead` / `only draft can be edited`),
// mapError 把它们原样发给前端 —— 对用户而言,一句看不懂的英文和「调用失败」是同一件事。
//
// ── 护栏钉的是「新错误码不许没有人话」 ────────────────────────────────────
// 这类问题的病灶一贯是「护栏只查已存在的东西 → 整份缺失反而不报警」。所以这里正着反着各查一遍:
// CODE_STATUS 有而 CODE_HINT 没有 → 红(新增错误码忘了写人话);反过来也红(留下死条目)。
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { AuthError } from '../../auth/errors'
import { allErrorCodes, allHintedCodes, humanizeError, isBusinessError, mapError } from '../errors'

const HAS_HAN = /\p{Script=Han}/u

describe('业务错误码 ↔ 人话:双向齐全', () => {
  it('★每个业务错误码都写了给用户看的人话(新增错误码忘了写 → 这条红)', () => {
    const missing = allErrorCodes().filter((c) => !allHintedCodes().includes(c))
    expect(missing, `以下错误码没有中文说明,请到 core/http/errors.ts 的 CODE_HINT 补一行: ${missing.join(', ')}`).toEqual([])
  })

  it('CODE_HINT 里没有已经不存在的死条目(mapError 自产的几个除外)', () => {
    const selfMade = ['VALIDATION', 'DUPLICATE', 'CONSTRAINT_VIOLATION', 'INTERNAL']
    const dead = allHintedCodes().filter((c) => !allErrorCodes().includes(c) && !selfMade.includes(c))
    expect(dead, `以下 code 已从 CODE_STATUS 移除,人话也该删: ${dead.join(', ')}`).toEqual([])
  })

  it('每句人话本身都是中文,且不是敷衍的一句「失败」', () => {
    for (const code of allHintedCodes()) {
      const hint = humanizeError(code, '')
      expect(HAS_HAN.test(hint), `${code} 的说明不是中文`).toBe(true)
      expect(hint.length, `${code} 的说明太短,说不清发生了什么`).toBeGreaterThanOrEqual(8)
    }
  })
})

describe('humanizeError 的取舍', () => {
  it('message 本来就是中文 → 原样用(它比按 code 查的通用文案更具体)', () => {
    const specific = '线索「南京卓尔博」在待分配池,只能由管理员分配'
    expect(humanizeError('CONFLICT', specific)).toBe(specific)
  })

  it('★message 是英文技术串 → 换成人话(用户看不懂英文,等同于没说)', () => {
    const out = humanizeError('CONFLICT', 'lead is in pending-assignment pool; use assign instead')
    expect(out).not.toContain('pending-assignment')
    expect(HAS_HAN.test(out)).toBe(true)
  })

  it('★没登记过的 code → 兜底也要说清「不是系统故障」并带上 code(用户知道找谁,支持知道查哪)', () => {
    const out = humanizeError('SOME_NEW_CODE', 'boom')
    expect(out).toContain('SOME_NEW_CODE')
    expect(out).toContain('不是系统故障')
  })
})

describe('mapError:响应里的 message 一律是人话', () => {
  it('业务错误(英文 message)→ 状态码不变,message 变中文', () => {
    const r = mapError(Object.assign(new Error('only draft can be edited'), { code: 'INVALID_TRANSITION' }))
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('INVALID_TRANSITION')
    expect(HAS_HAN.test(r.body.error.message)).toBe(true)
    expect(r.body.error.message).not.toContain('only draft')
  })

  it('★内部故障也别只说 internal server error —— 说清不是用户的问题 + 下一步', () => {
    const r = mapError(new TypeError('x.y is not a function'))
    expect(r.status).toBe(500)
    expect(r.body.error.message).not.toContain('internal server error')
    expect(r.body.error.message).toContain('不是你操作的问题')
    expect(r.body.error.message).not.toContain('is not a function') // 内部细节不外泄
  })

  it('zod 校验错误:仍带字段路径,message 变人话', () => {
    const ze = new ZodError([{ code: 'custom', path: ['name'], message: 'Required' }])
    const r = mapError(ze)
    expect(r.status).toBe(422)
    expect(r.body.error.fields?.[0]?.path).toBe('name')
    expect(HAS_HAN.test(r.body.error.message)).toBe(true)
  })

  it('AuthError 的会话级拒绝仍给 401(不能被人话化改掉状态码)', () => {
    const r = mapError(new AuthError('TENANT_SUSPENDED', 'tenant suspended or not found'))
    expect(r.status).toBe(401)
    expect(HAS_HAN.test(r.body.error.message)).toBe(true)
  })
})

describe('isBusinessError:区分「业务规则拦下」与「真出故障」', () => {
  it('注册过的 code → 业务错误', () => {
    expect(isBusinessError(Object.assign(new Error('x'), { code: 'INSUFFICIENT_STOCK' }))).toBe(true)
  })
  it('没 code 的普通异常 → 不是业务错误(该走内部故障那支)', () => {
    expect(isBusinessError(new TypeError('boom'))).toBe(false)
  })
  it('code 没注册过 → 不算业务错误(防止随手挂个 code 就绕过内部故障口径)', () => {
    expect(isBusinessError(Object.assign(new Error('x'), { code: 'MADE_UP' }))).toBe(false)
  })
})
