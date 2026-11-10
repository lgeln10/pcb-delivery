# mobile-app — AIOS 移动 App 壳(iOS / Android)

全租户**统一的一套壳**:本地登录页(服务器域名 + 手机号 + 密码)→ 原生请求登录 →
整个 webview 跳到租户域名跑现有 H5,原生能力(语音听写、定位)经 Capacitor 桥给 H5 用。
设计与验收标准见 `../standard-build/docs/design/MOBILE_APP_SHELL.md`(先读它)。

> **鸿蒙 NEXT 不在这个工程里。** 那批设备不跑 APK,`android/` 出的包在上面**装不上**,
> 单独一个 ArkTS 工程在 `../harmony-app/`。它靠注入垫片伪装成 Capacitor,所以下面这张
> Preferences 契约表是**三端共用**的 —— 改任何一行要同时改四处(三个壳 + H5)。

## 结构

```
shell/                本地壳登录页(纯 HTML/CSS/JS,**无构建步骤** —— 三个文件被 cap sync 直接拷进包)
shell/vendor/         第三方(jsQR:iOS 扫码解码用;按需注入,不挂 index.html)
capacitor.config.ts   appId=ai.sixamtech.aios;CapacitorHttp 全局补丁保持关闭(★别开,开了断 H5 的 SSE)
ios/ android/         原生工程(已含权限声明,提交入库;Pods/build 产物已 gitignore)
```

与 H5 的契约(改动要两边同步):

| 键(Preferences) | 谁写 | 谁读 |
| --- | --- | --- |
| `aios.server` | 壳**点登录时**(成败都写) | 壳冷启动预填 |
| `aios.session`(JSON `{token, employee}`) | 壳登录成功 / H5 重新登录镜像 | 壳冷启动校验 / H5 挂载前领养(`standard-build/src/native-app.ts`) |
| `aios.lastPhone` | 壳**点登录时**(成败都写) | 壳预填 |
| `aios.lastPassword` | 壳**点登录时**(成败都写) | 壳预填 ⚠️**明文**,见下 |

★ 后三个键**成败都写**,是有意的:需求要的是「服务器抽风登不进去时,人停在壳登录页且三项都填好,
直接再点一次登录」。只在成功回调里写的话,失败那次重启 App 回来又是空白的。

⚠️ **`aios.lastPassword` 是明文**(安卓 SharedPreferences / iOS UserDefaults 都不加密),
且主动退出登录后也不清 —— 2026-08-18 需求方在知悉代价后选定。要收紧改用系统安全存储需加插件并重新出包。
详见 `standard-build/docs/design/MOBILE_APP_SHELL.md` §16。

## ⚠️ 推送:构建前必须先做两件事(否则 iOS 构建会失败)

工程已配好 `App.entitlements`(`aps-environment`)与 `@capacitor/push-notifications`。
但**签名要求 Apple 账号侧先就位**,否则 `xcodebuild` 直接报错:

```
error: PLA Update available: ... agree to the latest Program License Agreement
error: Provisioning profile "..." doesn't include the Push Notifications capability
```

1. 登录 <https://developer.apple.com/account>,**接受最新的 Program License Agreement**
   (账号持有人才能点;不接受的话 Xcode 无权改 App ID,自动签名会一直失败)。
2. 确认 App ID `ai.sixamtech.aios` 已勾选 **Push Notifications** 能力
   (接受 PLA 后,带 `-allowProvisioningUpdates` 的构建通常会自动加上)。

**急着构建但暂时不想弄推送**:把 `ios/App/App.xcodeproj/project.pbxproj` 里两处
`CODE_SIGN_ENTITLEMENTS = App/App.entitlements;` 删掉即可(其余功能不受影响)。

后端侧的 4 个环境变量见 `../standard-build/modules/push/MODULE.md`;
`APNS_ENV` **必须**与本工程 entitlement 里的 `aps-environment` 一致(Debug=development,
发布=production)—— 不一致的表现是「发送成功但手机永远收不到」,最难查的一种。

## 日常开发

```bash
npm install
npm run preview            # 壳登录页浏览器预览(http://localhost:4380,原生插件为降级 shim)
npx cap sync               # 改了 shell/ 或插件依赖后,同步进 ios/ android/
npm run open:ios           # 打开 Xcode(本机 Xcode 26 + CocoaPods 可直接跑模拟器/真机)
npm run open:android       # 打开 Android Studio(本机没装 SDK 的话在装了的机器上跑)
```

- iOS 真机/发布需要 Apple Developer 签名:Xcode → App target → Signing & Capabilities 选团队。
- Android 发布包:Android Studio → Generate Signed Bundle;keystore 自建后**存密码管理器,别进仓库**。
- 语音插件是 `@capacitor-community/speech-recognition`(iOS SFSpeechRecognizer / 安卓系统 SpeechRecognizer)。
  **无 Google 服务的国产安卓机不可用是预期**(按钮自动隐藏),兜底方案见设计文档 §11。
- **Capacitor 锁在 7.x**:语音插件还没出 8 兼容版;升级前先查它的 releases。

## 改动流程

1. 壳 UI/逻辑:改 `shell/` → `npx cap sync` → 真机/模拟器验证。
2. 桥契约(Preferences 键、登录接口形状):`shell/app.js` 与 `standard-build/src/native-app.ts` **两边一起改**,
   纯函数行为以 `standard-build/src/native-app.test.ts` 为规格。
3. 加新原生能力:`npm i @capacitor/<plugin>` → `npx cap sync` → iOS `Info.plist` / 安卓 `AndroidManifest.xml`
   补权限声明 → H5 侧经 `window.Capacitor.Plugins.<Name>` 取用(参照 `native-app.ts`,H5 不 import @capacitor 包)。

## 工作时段位置追踪:两端都靠自研插件,别只测 iPhone

契约两端一致:`LocationTracker.start({distanceFilterM}) / stop()` + `location` 事件
(H5 侧 `standard-build/src/native-app.ts` 的 `syncAttendanceTracking`)。

| | 实现 | 后台持续靠什么 |
|---|---|---|
| iOS | `ios/App/App/LocationTrackerPlugin.swift` | `allowsBackgroundLocationUpdates` + 状态栏蓝条 + significant-change 续命 |
| Android | `android/.../LocationTrackerPlugin.java` + `LocationForegroundService.java` | **前台服务(常驻通知)** + `ACCESS_BACKGROUND_LOCATION` |

★**2026-08-16 之前安卓这一半根本不存在**:H5 检测不到插件就退化成前台 `watchPosition`,
员工一息屏上报就停,而服务端的失联判定会给管理者发预警 —— **人正常上班,系统说他失联**。
iOS 一切正常,所以现场表现成「安卓的人老是失联」,极易被当成员工问题。

三条实现约束,改的时候别拆:
- **插件注册必须在 `super.onCreate` 之前**(`MainActivity.registerPlugin`)。晚一步,H5 首帧
  检测不到插件就走了降级路径,而且不报错。
- **前台服务的 `foregroundServiceType="location"` 必填**(清单里)。Android 10+ 不声明,
  `startForeground` 直接抛,服务起不来 = 息屏照样断,现象与没做一样。
- **用系统 `LocationManager`,不要 FusedLocationProvider**:后者属 Google Play 服务,
  华为等无 GMS 的国行机上装得上、跑起来崩。

那条常驻通知是**特性不是噪音**:员工必须知道自己在被定位(与 iOS 的状态栏蓝条同一个决定)。

## 真机回归清单

按设计文档 §9 的 7 条走一遍;重点:冷启动免登录直进、语音听写流入输入框、退出回壳、
安卓返回键三段式(关浮层→退历史→收后台)、iOS 刘海不遮顶栏。
