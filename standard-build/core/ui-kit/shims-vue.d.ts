// 让 tsc 认识 .vue 导入(SFC 内部类型由 vitest 的 @vitejs/plugin-vue 编译时保证)
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
