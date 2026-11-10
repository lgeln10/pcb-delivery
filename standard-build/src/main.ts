import { createApp } from 'vue'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
// ★element-plus 按需(vite.config.ts 的 unplugin-vue-components + ElementPlusResolver):
//   模板里的 <el-xxx> 由 resolver 逐个引入组件与样式,所以这里**不再** `app.use(ElementPlus)`、
//   也不再引整包 index.css。
//   ★但**命令式 API 的样式 resolver 管不到** —— 它只扫模板。ElMessage(全仓 1119 处)、
//     ElMessageBox(38)、ElNotification(4)、ElLoading(v-loading 指令)是代码里直接 import 的,
//     漏掉这四行的表现是:提示框照常弹出、但**没有任何样式**(一坨裸文字糊在左上角),
//     而且只有真触发那条提示才看得见。
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/notification/style/css'
import 'element-plus/es/components/loading/style/css'
import '../core/ui-kit/tokens.css'
import './styles.css'
import App from './App.vue'
import { nativeShellBootstrap } from './native-app'
import { initKeyboardInset } from './keyboard-inset'
import { initEdgeSwipeBack } from './edge-swipe-back'
import { vDrawerAutofocus } from './drawer-autofocus'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      // 回窗即重拉过期数据:让后端重启窗口/网络抖动期间失败的查询在用户回来时自愈,
      // 否则错误态会一直挂着,表现成「已登录但数据访问不到」。staleTime 10s 兜住重拉频率。
      refetchOnWindowFocus: true,
    },
  },
})

// App 壳内要在挂载前完成会话领养与落地页预置(App.vue setup 同步读它们);
// 浏览器里 bootstrap 立刻返回,挂载时序不变。引导失败不阻塞挂载:退化成浏览器行为。
// 软键盘遮挡贴底输入区的兜底(只在 iOS 那种「键盘盖上来但不压缩布局」的情况下生效)
initKeyboardInset()
// 从屏幕左缘右滑 = 返回上一页(手机浏览器与 App 内都生效;安卓实体返回键另在 native-app.ts)
initEdgeSwipeBack()

// ★挂载最多等 1.5 秒。bootstrap 里 await 的是原生桥调用(Preferences),桥没就绪或调用卡住时
//   会把挂载一起拖住,表现为「登录后白屏很久」。超时后照常挂载:会话领养没赶上的话,
//   H5 自己的登录页兜底,比一直白屏好得多。正常情况下这个读取是毫秒级,超时永远不会触发。
const BOOTSTRAP_BUDGET_MS = 1500
void Promise.race([
  nativeShellBootstrap().catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_BUDGET_MS)),
]).then(() => {
  createApp(App)
    .use(VueQueryPlugin, { queryClient })
    // 抽屉/弹层打开即聚焦首字段(UI_SPEC §7)。全局注册,页面只需在表单外层挂 v-drawer-autofocus。
    .directive('drawer-autofocus', vDrawerAutofocus)
    .mount('#app')
})
