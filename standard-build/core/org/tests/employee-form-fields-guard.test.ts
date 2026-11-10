// 新建员工 / 编辑员工两张表单的字段对账。
//
// 组织页有两份各自维护的员工字段清单:一份在「新建员工」抽屉,一份在「编辑员工」抽屉。
// 两份清单一定会分叉,表现是填得进、不显示、不报错。
//
//   这里的两份清单故意不完全一样:
//     · 岗位:新建时可选,编辑时只读;
//     · 直属上级:只在新建时给;
//     · 密码:新建是开通登录用的默认密码,编辑是重置密码。
//   两边共有的字段少一个 → 红;各自独有的字段变了 → 红。要改产品决定,连这份清单一起改。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(import.meta.dirname, '../ui/OrgManagement.vue'), 'utf8')

/** 取出某个抽屉里所有 <FormField label="…"> 的标签,按出现顺序。 */
function formFieldLabels(drawerTitle: string): string[] {
  const head = source.indexOf(`title="${drawerTitle}"`)
  expect(head, `找不到标题为「${drawerTitle}」的抽屉`).toBeGreaterThan(-1)
  const end = source.indexOf('</el-drawer>', head)
  const block = source.slice(head, end)
  return [...block.matchAll(/<FormField[^>]*?\slabel="([^"]*)"/g)].map((m) => m[1]!)
}

const CREATE = '新建员工'
const EDIT = '编辑员工'

/** 两张表单都必须有的字段。少一个就是分叉。
    ★「岗位」两边都有,但编辑那份是 disabled 的只读展示。这条护栏管的是字段在不在。 */
const SHARED = ['姓名', '工号', '手机号', '岗位', '部门', '邮箱']
/** 只在新建里出现的,连同理由。 */
const CREATE_ONLY: Record<string, string> = {
  直属上级: '只在建档时指定',
  登录密码: '新建 = 开通登录用的默认密码',
}
/** 只在编辑里出现的,连同理由。 */
const EDIT_ONLY: Record<string, string> = {
  重置密码: '编辑 = 给已有账号重置密码(与新建的「登录密码」不是一件事)',
  新密码: '开了「重置密码」才出现',
}

describe('员工表单字段对账(新建 vs 编辑)', () => {
  it('两张表单共有的字段一个都不能少', () => {
    const create = formFieldLabels(CREATE)
    const edit = formFieldLabels(EDIT)
    const missing = SHARED.flatMap((f) => [
      ...(create.includes(f) ? [] : [`新建员工缺「${f}」`]),
      ...(edit.includes(f) ? [] : [`编辑员工缺「${f}」`]),
    ])
    expect(missing, '两份字段清单分叉了 —— 表现是「填得进、不显示、不报错」').toEqual([])
  })

  it('各自独有的字段就是清单里这些,多一个少一个都要连这份清单一起改', () => {
    const create = formFieldLabels(CREATE)
    const edit = formFieldLabels(EDIT)
    const createOnly = create.filter((f) => !edit.includes(f)).sort()
    const editOnly = edit.filter((f) => !create.includes(f)).sort()
    expect(createOnly, '新建独有的字段变了').toEqual(Object.keys(CREATE_ONLY).sort())
    expect(editOnly, '编辑独有的字段变了').toEqual(Object.keys(EDIT_ONLY).sort())
  })
})
