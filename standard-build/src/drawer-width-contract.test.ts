// 抽屉宽度契约的护栏(扫源码,同 responsive-breakpoints.test.ts 的做法)。
//
// ★为什么值得写:详情/编辑抽屉曾经同时存在 46%/50%/55%/60%/75%/86% 与 420px/520px/900px,
//   同一类列表页打开后宽窄不一。抽屉宽度必须回到设计 token,页面只选「语义档位」,
//   不再手填具体数值。
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const tokensCss = readFileSync(join(root, 'core/ui-kit/tokens.css'), 'utf8')

const SCAN_DIRS = ['src', 'core', 'modules']
const DRAWER_SIZE_TOKENS = ['list', 'compact', 'wide'] as const

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

function drawerTags(): Array<{ file: string; tag: string }> {
  const out: Array<{ file: string; tag: string }> = []
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(root, dir))) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/<(?:el-drawer|ElDrawer)\b[\s\S]*?>/g)) {
        out.push({ file: relative(root, file), tag: m[0]! })
      }
    }
  }
  return out
}

function sizeAttr(tag: string): { bound: boolean; value: string } | null {
  const m = tag.match(/\s(:?)size\s*=\s*(["'])([\s\S]*?)\2/)
  return m ? { bound: m[1] === ':', value: m[3]! } : null
}

describe('抽屉宽度契约', () => {
  it('三档抽屉 token 都在 tokens.css 中定义,且按浏览器视口 vw 计算', () => {
    for (const token of DRAWER_SIZE_TOKENS) {
      const decl = new RegExp(`--sb-drawer-${token}:\\s*min\\(clamp\\([^;]*vw[^;]*\\),\\s*96vw\\);`)
      expect(tokensCss, `缺少 --sb-drawer-${token},或没有用 vw + 96vw 兜底`).toMatch(decl)
    }
  })

  it('所有 el-drawer 的 size 只能选语义 token,不许写回裸百分比/像素或 isMobile 分支', () => {
    const offenders = drawerTags()
      // ★上下方向的抽屉(bottom sheet)不在此列:EP 把 size 落成 **height**,
      //   而这三个 token 是宽度档,套上去在语义上就是错的。它们一律 size="auto"
      //   —— 高度按内容长,上限与滚动交给 CSS(见 styles.css 的 .sb-filter-sheet),
      //   免得字段少的页面弹出一块半空的板子。这一条 2026-08-27 随筛选抽屉加,
      //   在那之前全站只有左右抽屉,这个函数默认了「size 就是宽度」。
      // CAM 对照抽屉:手机全屏、桌面按黄金分割。它不是列表详情抽屉,不套三档宽度 token。
      .filter(({ file }) => file !== 'modules/pcb-cam/ui/PcbCamWorkspace.vue')
      .filter(({ tag }) => !/\sdirection\s*=\s*(["'])(btt|ttb)\1/.test(tag))
      .map(({ file, tag }) => ({ file, size: sizeAttr(tag) }))
      .filter(({ size }) => {
        if (size === null) return true
        if (size.bound) return true
        return !DRAWER_SIZE_TOKENS.some((token) => size.value === `var(--sb-drawer-${token})`)
      })
      .map(({ file, size }) => size === null ? `${file}: missing size` : `${file}: ${size.bound ? ':' : ''}size="${size.value}"`)

    expect(offenders, '抽屉宽度只允许 size=\"var(--sb-drawer-list|compact|wide)\"').toEqual([])
  })

  it('★上下方向的抽屉一律 size="auto" —— 高度按内容长,上限交给 CSS', () => {
    // 写死高度的 bottom sheet 会在「只有一个筛选字段」的页面上弹出一大块空板子;
    // 而 auto + max-height 既能贴合内容,又不会在字段多时顶穿屏幕。
    const offenders = drawerTags()
      .filter(({ tag }) => /\sdirection\s*=\s*(["'])(btt|ttb)\1/.test(tag))
      .filter(({ tag }) => {
        const size = sizeAttr(tag)
        return size === null || size.bound || size.value !== 'auto'
      })
      .map(({ file, tag }) => `${file}: ${sizeAttr(tag) ? `size="${sizeAttr(tag)!.value}"` : 'missing size'}`)

    expect(offenders, '上下抽屉只允许 size="auto",高度上限写在 CSS 里(如 .sb-filter-sheet 的 max-height)').toEqual([])
  })
})
