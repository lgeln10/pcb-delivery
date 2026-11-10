// 通知点击的落点表。铃铛和通知整页共用这一份 —— 它分叉的表现是「在铃铛里点得开、在通知页点了没反应」,
// 两边都不报错,所以只能靠测试钉。
import { describe, expect, it } from 'vitest'
import { notificationTarget, notificationPushSection } from '../notification-target'
import { INAPP_NOTIFY_SOURCE_TYPES } from '../model'
import { NAV_CATALOG, flattenNavItems } from '../../../src/nav-catalog'

const ME = '11111111-1111-1111-1111-111111111111'
const SUBORDINATE = '22222222-2222-2222-2222-222222222222'

describe('通知落点', () => {
  it('每一种 sourceType 都有归属 —— 新增一种却忘了配,在这里变红', () => {
    // ★这条是「客户移交点了没反应」那个 bug 的护栏:'partner' 当年既没进枚举、也没有 case,
    //   而 source_type 那时没有库层 CHECK,于是它写得进库、点了什么都不发生、全链路不报错。
    const missing = INAPP_NOTIFY_SOURCE_TYPES.filter((t) => !notificationTarget({ sourceType: t, sourceId: ME }, ME))
    expect(missing).toEqual([])
  })

  it('落点必须是真实存在的菜单 key(拼错了点了也没反应)', () => {
    const known = new Set(NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).map((i) => i.key))
    for (const t of INAPP_NOTIFY_SOURCE_TYPES) {
      const target = notificationTarget({ sourceType: t, sourceId: SUBORDINATE }, ME)!
      // read 类的 section 是**次要动作**(抽屉底部那颗「去…」),可以没有;有就必须是真菜单
      if (target.kind === 'read' && !target.section) continue
      expect(known, `sourceType=${t} 落点 ${target.section}`).toContain(target.section)
    }
  })

  it('备份通知就地阅读,并可以去系统设置', () => {
    expect(notificationTarget({ sourceType: 'db_backup', sourceId: 'X' }, ME)).toEqual({ kind: 'read', section: 'app-settings' })
  })

  it('未知 sourceType 返回 null(老服务器写进来的新类型不该让页面乱跳)', () => {
    expect(notificationTarget({ sourceType: 'something_new', sourceId: 'X' })).toBeNull()
  })

  it('★推送的 section:read 类落收件箱页,不落业务列表(否则正文照样读不到)', () => {
    expect(notificationPushSection({ sourceType: 'db_backup', sourceId: 'T1' })).toBe('notifications')
    expect(notificationPushSection({ sourceType: 'something_new', sourceId: 'X' })).toBeUndefined()
    // 收件箱页必须真在导航里,而且**不挂权限**(挂了就会被 App 壳的可见性白名单吞掉)
    const inbox = NAV_CATALOG.flatMap((g) => flattenNavItems(g.items)).find((i) => i.key === 'notifications')
    expect(inbox, '收件箱页不在导航目录里').toBeTruthy()
    expect(inbox?.permission, '收件箱页挂了权限 —— read 类推送会点开没反应').toBeUndefined()
  })
})

