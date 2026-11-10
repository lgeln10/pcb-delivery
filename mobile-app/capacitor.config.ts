import type { CapacitorConfig } from '@capacitor/cli'

// 统一壳:一套 App 服务所有租户。webDir 里只有本地登录壳,登录成功后整个
// webview 跳到租户自己的域名,之后跑的就是 standard-build 的 H5。
const config: CapacitorConfig = {
  appId: 'ai.sixamtech.aios',
  appName: '企业AI操作系统',
  webDir: 'shell',
  // 给 H5 一个可靠的「在壳内」信号(window.Capacitor 之外的备份判据)。
  //
  // ★必须放在**顶层**,不能放进 server —— Capacitor 读的是顶层 `appendUserAgent`
  //   (可被 `android.appendUserAgent` / `ios.appendUserAgent` 覆盖),`server` 只认
  //   hostname / iosScheme / androidScheme / url / cleartext / allowNavigation /
  //   errorPath / appStartPath 这几个键。放错层级**不报错也不警告**,只是被整个忽略,
  //   于是 UA 里永远没有 AIOSShell —— 而 src/native-app.ts 的 isNativeShell() 把它
  //   当成 window.Capacitor 之外的备份判据。这条从壳的第一个提交起就错着(2026-08-21 修):
  //   iOS/安卓靠 isNativePlatform() 撑着没现形,鸿蒙壳则是自己在原生侧拼 UA,也碰不到。
  //   等于「备份判据」这个设计从来没生效过 —— 主判据一旦出问题就没有第二条腿。
  //   规格锁在 standard-build/src/native-app.test.ts。
  appendUserAgent: 'AIOSShell/0.1.0',
  server: {
    // 租户域名是用户运行时输入的,构建期无法枚举 → 只能放开全部导航。
    // 代价:H5 里指向外部站点的整页跳转也会留在 webview 内(桥随之暴露)。
    // H5 侧约定对外链接一律 window.open/target=_blank(走系统浏览器),见 src/native-app.ts。
    allowNavigation: ['*'],
  },
  ios: {
    // 不让 WKWebView 自动加滚动内边距;刘海/灵动岛由页面自己用 safe-area CSS 处理
    contentInset: 'never',
  },
  plugins: {
    // ★保持关闭:开了会把 webview 里所有 fetch/XHR 换成原生代理,
    // H5 的 SSE 流式对话会被它断流。壳自己的请求显式调 CapacitorHttp 插件,不受此开关影响。
    CapacitorHttp: { enabled: false },
  },
}

export default config
