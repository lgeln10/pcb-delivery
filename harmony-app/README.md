# harmony-app — AIOS 鸿蒙 NEXT 壳

给 **HarmonyOS NEXT(鸿蒙 5,纯血鸿蒙)** 用的第三个壳。那批设备已经不跑 APK,
`mobile-app/` 里的 Capacitor 安卓包在上面装不上 —— 不是体验差,是根本装不了,
所以只能另起一个原生工程。

功能与 iOS/安卓壳一致:本地登录页(服务器域名 + 手机号 + 密码)→ 原生请求登录 →
Web 组件加载租户域名跑现有 H5,原生能力(定位、后台轨迹)经桥给 H5 用。

---

## ⚠️ 现状:代码写完了,但**一行都没编译过**

本机没有 DevEco Studio、没有鸿蒙 SDK、没有 NEXT 真机,所以这套工程是**按 API 文档写的,
未经编译与真机验证**。第一次在 DevEco Studio 里打开,大概率要按提示微调几处
(SDK 版本号、个别 API 的签名在小版本间有过调整)。把它当成「一份完成度很高的初稿」,
不是「拿来就能跑的成品」。

要跑起来,你需要先备齐三样(都是外部依赖,我这边办不了):

| 需要什么 | 怎么弄 | 耗时 |
|---|---|---|
| **华为开发者账号** | <https://developer.huawei.com> 注册 + 实名认证(企业认证要营业执照) | 1–3 天审核 |
| **DevEco Studio** | 华为开发者官网下载 macOS 版(约 2.5 GB),要登录账号才能下 | 半小时 |
| **一台鸿蒙 NEXT 真机** | 设置 → 关于手机 → HarmonyOS 版本是 `5.x` 的那种 | — |

**签名是硬门槛**:鸿蒙和 iOS 一样,连"装到自己手机上调试"都需要证书。
DevEco Studio 的「自动签名」会用你的华为账号自动生成调试证书,所以账号那一关绕不过去。

---

## 结构

```
AppScope/app.json5              bundleName=ai.sixamtech.aios(与 iOS/安卓壳同名)
entry/src/main/module.json5     权限声明(定位/后台定位/长时任务/相机)
entry/src/main/ets/
  entryability/EntryAbility     入口:装载首页 + 一次性申请定位权限
  pages/Login.ets               壳登录页(逻辑对齐 mobile-app/shell/app.js)
  pages/WebHost.ets             Web 组件宿主 + 垫片注入 + 退出登录拦截
  bridge/CapacitorShim.ets      注入 H5 的 window.Capacitor 垫片(核心设计,见下)
  bridge/NativeBridge.ets       原生侧桥实现(Preferences / App / StatusBar / LocationTracker)
  service/LocationTracker.ets   后台持续定位(continuousTask + 常驻通知)
  util/{ServerUrl,Prefs,Http}   域名归一化 / 原生存储 / 原生 HTTP
```

## 核心设计:伪装成 Capacitor,而不是自造一座桥

`standard-build/src/native-app.ts` 已经把"壳能力"表达成一组 `window.Capacitor` 调用了。
鸿蒙壳只要把**同样的形状**摆出来,H5 **一行都不用改**。

这是这个工程里最重要的一个决定。反过来若自造 `window.HarmonyBridge`,H5 侧每加一个
能力就要多维护一条判空分支,三端很快就会漂移;现在是一套 H5 同时跑在浏览器、iOS 壳、
安卓壳、鸿蒙壳里,只有一份契约。

几个具体后果,读代码前先知道:

- **`getPlatform()` 返回 `'android'`,这是刻意的。** H5 里"安卓返回键 / 状态栏
  `setOverlaysWebView` / 退出登录跳 `https://localhost/`"三条分支都挂在这个值上,
  鸿蒙的行为与安卓一致,复用即可。真要区分平台看 UA 里的 `HarmonyOS` 标记。
- **退出登录要拦。** H5 会 `location.replace('https://localhost/')`,`WebHost.ets` 的
  `onLoadIntercept` 认出这个地址后回登录页。不拦的话用户看到的是一张"无法连接"错误页。
- **垫片必须 document-start 注入。** `native-app.ts` 在模块顶层就读 `window.Capacitor`,
  用 `onPageBegin + runJavaScript` 来不及。
- **`javaScriptProxy` 的 `methodList` 漏名字会静默失败** —— 不报错,只是 JS 那边永远 pending。

## 后台定位:鸿蒙这块反而比安卓好办

安卓壳目前**没有**后台轨迹(只有前台 `watchPosition`)。鸿蒙有 `continuousTask` 长时任务,
是系统正式支持的后台持续定位方式:申请后通知栏挂一条常驻通知,用户随时看得见自己在被定位。

这既是系统要求,也正好是我们要的合规姿态 —— 员工必须知道自己在被追踪。

边界仍由**服务端**裁决:H5 收到 `reportLocations` 回的 `tracking:false` 就调 `stop()`,
端上不自己判断该不该追(端上判会和服务端打架)。

## 第一次跑起来

1. DevEco Studio → `File → Open` 选 `harmony-app/` 目录
2. 等它 Sync;报 SDK 版本不匹配就按提示装对应版本(`build-profile.json5` 里写的是
   `5.0.0(12)`,你装的 SDK 更新的话改成实际版本)
3. `File → Project Structure → Signing Configs` → 勾 **Automatically generate signature**,
   登录华为账号,它会生成调试证书并写回 `build-profile.json5`
4. 真机开**开发者模式**(设置 → 关于手机 → 连点"版本号"7 次)+ **USB 调试**
5. 连线,DevEco 顶部选到设备,点 ▶

**提交前注意**:第 3 步会把证书路径和密码写进 `build-profile.json5`,**别把那段改动提交上去**
(`.gitignore` 挡得住 `.p12/.cer`,但挡不住 json5 里的路径与口令)。

命令行构建(装好 DevEco 之后,`hvigorw` 在它的安装目录里):

```bash
cd /Users/yibing/coding/aios-base/harmony-app && ./hvigorw assembleHap --mode module -p product=default
```

调试用 `hdc`(鸿蒙的 adb,DevEco 自带):

```bash
hdc list targets && hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

## 没做的部分(有意留的,不是忘了)

| 项 | 为什么先不做 |
|---|---|
| **推送(HMS Push Kit)** | 要在 AGC 建应用、开 Push 服务、拿 `agconnect-services.json`,服务端还要新增一条 HMS 推送通道(现在只有 APNs/FCM)。工作量比其余所有项加起来还大,该单独立项。v1 干脆不暴露 `PushNotifications` 插件 —— H5 遇到插件不存在会整块跳过,好过给个半成品让它一直转圈。 |
| **语音输入(Core Speech Kit)** | 同上,H5 侧插件不在就不显示语音按钮,属预期降级。 |
| **应用图标** | `AppScope/resources/base/media/app_icon.png` 还是空的,得放一张 1024×1024。DevEco 首次构建会因为找不到它报错,随手放一张即可。 |
| **上架 AppGallery** | 需要软著、隐私政策页、应用备案。走到那一步再说。 |

## 与另外两个壳的关系

| | iOS | 安卓 | 鸿蒙 NEXT |
|---|---|---|---|
| 工程 | `mobile-app/ios` | `mobile-app/android` | `harmony-app/`(本目录) |
| 登录 + H5 宿主 | ✅ | ✅ | ✅(未验证) |
| 后台轨迹 | ✅ 原生插件 | ❌ 仅前台 | ✅ 长时任务(未验证) |
| 推送 | ✅ APNs | ❌ 缺 FCM 配置 | ❌ 未接 |
| 语音输入 | ✅ | ✅(无 GMS 机型降级) | ❌ 未接 |

三端共用同一套 Preferences 键(`aios.server` / `aios.session` / `aios.lastPhone`)和同一套
登录接口契约。**改契约要同时改四处**:三个壳 + `standard-build/src/native-app.ts`。
