// core/backup/tests/public-prefix-guard.test.ts
// 一条护栏,钉住一句话:**backups/ 前缀下的对象绝不能匿名可读。**
//
// 为什么值得单开一个文件:core/storage 的 PUBLIC_KEY_PREFIXES 是「哪些 key 免登录可下载」的
// 唯一定义(现为 branding/、website/),往里加一个前缀 = 宣布该前缀下的文件任何人都能下载。
// 而 backups/ 下面是**整库 dump** —— 一旦被加进去,一条 URL 就能把全公司数据拖走。
// 这道闸挡不住「有人存心要加」,但挡得住「有人顺手加错」,而后者是真实会发生的那种。
import { describe, expect, it } from 'vitest'
import { isPublicStorageKey, PUBLIC_KEY_PREFIXES } from '../../storage/api'
import { BACKUP_KEY_PREFIX } from '../service'

describe('★备份对象不可匿名读', () => {
  it('backups/ 不在公开前缀白名单里', () => {
    expect(PUBLIC_KEY_PREFIXES as readonly string[]).not.toContain(`${BACKUP_KEY_PREFIX}/`)
    expect(PUBLIC_KEY_PREFIXES as readonly string[]).not.toContain(BACKUP_KEY_PREFIX)
  })

  it('一个真实形状的备份 key 判定为非公开', () => {
    expect(isPublicStorageKey(`${BACKUP_KEY_PREFIX}/2f0c1d9e-base_prod-2026-08-17.dump`)).toBe(false)
  })

  it('公开前缀本身没被误删(这条是给上面两条做对照的:判定函数确实在工作)', () => {
    // 没有这条,上面两条在 isPublicStorageKey 恒返回 false 时也会绿 —— 那就成了假护栏
    expect(PUBLIC_KEY_PREFIXES.length).toBeGreaterThan(0)
    expect(isPublicStorageKey(`${PUBLIC_KEY_PREFIXES[0]}anything.png`)).toBe(true)
  })
})
