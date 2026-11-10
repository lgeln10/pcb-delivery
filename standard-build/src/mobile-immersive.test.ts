// @vitest-environment jsdom
// 沉浸视图(手机聊天窗里收起底部 tab 栏)的计数语义 + 两处接线不许分叉。
import { describe, expect, it, beforeEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isMobileImmersive, useMobileImmersive, __resetMobileImmersive } from './mobile-immersive'

/** 一个只做「声明自己是不是沉浸视图」的壳组件 */
const Holder = defineComponent({
  props: { active: { type: Boolean, default: false } },
  setup(props) {
    const active = ref(props.active)
    useMobileImmersive(active)
    return () => h('i')
  },
})

describe('移动端沉浸视图', () => {
  beforeEach(() => __resetMobileImmersive())

  it('没有页面声明时是关的', () => {
    expect(isMobileImmersive.value).toBe(false)
  })

  it('声明为真的页面挂载 → 开;卸载 → 关', () => {
    const w = mount(Holder, { props: { active: true } })
    expect(isMobileImmersive.value).toBe(true)
    w.unmount()
    expect(isMobileImmersive.value).toBe(false)
  })

  it('声明为假的页面既不开也不会在卸载时把计数扣成负数', () => {
    const w = mount(Holder, { props: { active: false } })
    expect(isMobileImmersive.value).toBe(false)
    w.unmount()
    expect(isMobileImmersive.value).toBe(false)
    // 再挂一个真的:如果上面扣成了 -1,这里会是 0 → false
    const w2 = mount(Holder, { props: { active: true } })
    expect(isMobileImmersive.value).toBe(true)
    w2.unmount()
  })

  // ★这条是这个模块用计数而不是布尔的**全部理由**:切页时 Vue 先挂新页、后卸旧页。
  //   布尔实现下,后卸载的旧页会把新页刚打开的状态抹掉 —— 表现是「从消息切到别的页,
  //   tab 栏该回来却没回来」,或反过来「进了聊天栏还在」,取决于哪边先跑。
  it('两个页面交叠(新页先挂、旧页后卸)时不会互相抹掉', () => {
    const oldPage = mount(Holder, { props: { active: true } })
    const newPage = mount(Holder, { props: { active: true } })
    oldPage.unmount()
    expect(isMobileImmersive.value).toBe(true)
    newPage.unmount()
    expect(isMobileImmersive.value).toBe(false)
  })
})

describe('★tab 栏的显示开关与布局 class 必须同源', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8')

  // `.app-shell--tabbar` 不只是显示开关:它同时下发 --sb-tabbar-h(内容区让位高度)与
  // --sb-page-foot-pad。只把 <MobileTabBar> 藏掉、class 留着,页面底部会平白空出
  // 56px + 安全区的死白,而那里什么都没有 —— 而且不报错、不失败,只有真机上看得见。
  it('两处都用 tabbarVisible,不许一处写成 mobileTabs.length', () => {
    expect(app).toContain("'app-shell--tabbar': tabbarVisible")
    expect(app).toContain('v-if="tabbarVisible"')
    expect(app).toMatch(/const tabbarVisible = computed\(\(\) =>[^\n]*!isMobileImmersive\.value/)
  })

  it('沉浸时另挂 .app-shell--immersive,且样式表里真的用到了它', () => {
    expect(app).toContain("'app-shell--immersive'")
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toContain('.app-shell--immersive .app-main')
    // 顶栏也要收起 —— 只收底部 tab 栏的话,聊天窗顶上仍叠着两条说同一件事的头
    expect(css).toMatch(/\.app-shell--immersive \.app-topbar \{\s*display: none;/)
    // ★顶栏的 margin-bottom(space-4)必须补进 .app-main 的 padding-top:全幅页用负边距往上顶进
    //   这一段(.de-shell 的 -space-4 / .cv-mbar 的 -space-3),不补的话页面自己的顶栏会被切掉半行。
    expect(css).toMatch(/\.app-shell--immersive \.app-main \{\s*padding-top: var\(--sb-space-4\);/)
    // App 壳里还要再叠状态栏高度,否则返回键与系统时间/信号叠在一起
    expect(css).toMatch(/html\.in-native-app \.app-shell--immersive \.app-main \{\s*padding-top: calc\(var\(--sb-space-4\) \+ var\(--sb-safe-top\)\)/)
    // ★底部保留 space-8:全幅页用写死的 -space-8 抵它,只留安全区会被那个负边距一起吃掉
    expect(css).toMatch(/html\.in-native-app \.app-shell--immersive \.app-main \{\s*padding-bottom: calc\(var\(--sb-space-8\) \+ var\(--sb-safe-bottom\)\)/)
    // 输入条自身不再额外留呼吸位:tab 栏没了,这段留白就会变成发送按钮下面的空洞。
    expect(css).toMatch(/\.app-shell--immersive \{\s*--sb-page-foot-pad: 0px;/)
  })
})
