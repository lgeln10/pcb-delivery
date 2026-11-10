// core/ui-kit/tests/vue-missing-import-guard.test.ts
// **在 .vue 里用了却没 import 的名字 —— 这一类错已经上线过 4 次。**
//
// 为什么需要专门写这条:
// - `tsc --noEmit` **完全不看 `.vue` 文件**,所以 typecheck 永远是绿的;
// - `vue-tsc` 在这个仓里跑不出语义错(实测:故意删掉 import 也不报,
//   排除掉那几个模板解析失败的文件后仍不报),当不了门禁;
// - 单测覆盖不到 —— 组件不渲染就不会执行到那一行。
// 于是它每次都要等**页面打开时白屏**才暴露:`ReferenceError: xxx is not defined`。
//
// 这条护栏不做完整作用域分析(那是重造 TS),只盯**实际踩过的三类名字**:
// Vue 组合式 API、`apiXxx` 接口函数、模板里用到的图标组件。
// 判据很粗但零误报:名字出现在文件里、却没出现在任何 import 里 → 红。
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../../', import.meta.url).pathname

/** 这些名字必须从 'vue' 导入才能用。 */
const VUE_APIS = [
  'ref', 'computed', 'watch', 'watchEffect', 'reactive', 'nextTick', 'shallowRef', 'toRef', 'toRefs',
  'onMounted', 'onUnmounted', 'onBeforeMount', 'onBeforeUnmount', 'onActivated', 'onDeactivated',
  'provide', 'inject', 'defineAsyncComponent', 'markRaw', 'useTemplateRef',
]

function vueFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) vueFiles(p, out)
    else if (name.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 所有 import 语句里出现过的名字(含默认导入、命名导入、别名后的名字)。 */
function importedNames(src: string): Set<string> {
  const names = new Set<string>()
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]+['"]/g)) {
    for (const part of m[1]!.replace(/[{}]/g, ',').split(',')) {
      const t = part.trim().replace(/^type\s+/, '')
      if (!t) continue
      // `A as B` → 用的是 B
      const as = t.split(/\s+as\s+/)
      names.add((as[1] ?? as[0])!.trim())
    }
  }
  return names
}

const FILES = vueFiles(join(ROOT, 'core')).concat(vueFiles(join(ROOT, 'modules')), vueFiles(join(ROOT, 'src')))

describe('★.vue 里不能用没 import 的名字(tsc 看不见这些文件)', () => {
  it('至少扫到了一批 .vue,不然这条护栏是空转的', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it.each(FILES.map((f) => [f.slice(ROOT.length), f] as const))('%s', (_rel, file) => {
    const src = readFileSync(file, 'utf8')
    const imported = importedNames(src)
    // 本地定义的同名(const x = / function x( / 形参解构等)不算漏 import
    const declared = new Set(
      [...src.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]!),
    )
    const missing: string[] = []

    for (const api of VUE_APIS) {
      // 作为函数调用出现:`onUnmounted(` / `ref<` / `ref(`
      const used = new RegExp(`\\b${api}\\s*[(<]`).test(src)
      if (used && !imported.has(api) && !declared.has(api)) missing.push(api)
    }
    // 接口函数:apiXxx(...)
    for (const m of src.matchAll(/\b(api[A-Z][\w$]*)\s*\(/g)) {
      const n = m[1]!
      if (!imported.has(n) && !declared.has(n)) missing.push(n)
    }

    expect(missing, `${_rel} 用了但没 import:${[...new Set(missing)].join(', ')}`).toEqual([])
  })
})
