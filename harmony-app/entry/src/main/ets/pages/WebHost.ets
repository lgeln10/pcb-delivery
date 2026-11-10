// 租户 H5 宿主:Web 组件加载租户域名,并把 window.Capacitor 垫片注入进去。
//
// ★四处容易踩的坑,都写在下面对应位置:
//   ① 垫片必须走 javaScriptOnDocumentStart 注入 —— 晚一步 H5 就读不到 window.Capacitor;
//   ② javaScriptProxy 的 methodList 漏写方法名 → JS 侧调用**静默失败**,不报错;
//   ③ 退出登录时 H5 会跳 https://localhost/(它以为自己在安卓壳里),必须拦下来回登录页;
//   ④ 全屏(沉浸式)之后必须把状态栏/导航条高度注入成 --sb-safe-*,H5 才避得开 —— 见 pushInsets。
import webview from '@ohos.web.webview';
import router from '@ohos.router';
import common from '@ohos.app.ability.common';
import window from '@ohos.window';
import { CAPACITOR_SHIM_JS } from '../bridge/CapacitorShim';
import { NativeBridge } from '../bridge/NativeBridge';
import { LocationTracker } from '../service/LocationTracker';
import { Prefs, PREF_SERVER } from '../util/Prefs';

/** 与 iOS/安卓壳同一个标记:H5 的 isNativeShell() 有一条 UA 兜底判据认它。 */
const UA_SUFFIX: string = ' AIOSShell/0.1.0 HarmonyOS';
/** H5 退出登录会跳到这个地址(它按 getPlatform()==='android' 走的分支) */
const LOGOUT_SENTINEL: string = 'https://localhost/';

interface WebHostParams {
  origin: string;
}

@Entry
@Component
struct WebHost {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: NativeBridge | null = null;
  private win: window.Window | null = null;
  /** 最近一次算好的安全区注入脚本(见 pushInsets) */
  private lastInsetJs: string = '';
  @State origin: string = '';
  @State loadError: string = '';

  aboutToAppear(): void {
    const params = router.getParams() as WebHostParams;
    this.origin = params !== null && params !== undefined ? params.origin : '';
    const context = getContext(this) as common.UIAbilityContext;
    LocationTracker.bind(context);
    this.bridge = new NativeBridge(this.controller, context, () => { this.backToLogin(); });
    this.enterFullScreen();
  }

  aboutToDisappear(): void {
    // 页面销毁必须停掉长时任务,否则通知栏会留一条撤不掉的常驻通知,而且真的在后台烧电
    LocationTracker.stop();
    // 沉浸式只属于这一页:不还原的话回到 ArkTS 写的登录页,标题会顶到状态栏里
    this.exitFullScreen();
  }

  /**
   * 沉浸式 + 安全区注入。
   *
   * ★为什么要沉浸式:H5 是整屏应用(顶栏 sticky、底部 tab 栏 fixed),留着系统栏的
   *   实心占位会在页面上下各切一条与配色不搭的带子,和 iOS/安卓壳长得不一样。
   * ★为什么注入完还得再注一次:H5 侧读的是 --sb-safe-*(见 standard-build/src/styles.css
   *   「安全区四变量」一节)。Web 组件里 env(safe-area-inset-*) 拿不到系统栏高度,
   *   只能由这里从 avoidArea 取真值喂进去 —— 与安卓壳 MainActivity 同一份契约、同一组变量名。
   */
  private enterFullScreen(): void {
    window.getLastWindow(getContext(this)).then((win: window.Window) => {
      this.win = win;
      win.setWindowLayoutFullScreen(true);
      this.pushInsets();
      // 转屏、折叠屏展开、导航方式在「手势/三键」之间切换,都会改 avoidArea
      win.on('avoidAreaChange', () => { this.pushInsets(); });
    }).catch(() => { /* 拿不到窗口:退化成非沉浸,H5 的安全区取 0,不会压内容 */ });
  }

  private exitFullScreen(): void {
    const win = this.win;
    if (win === null) return;
    this.win = null;
    try {
      win.off('avoidAreaChange');
      win.setWindowLayoutFullScreen(false);
    } catch (e) { /* 窗口已销毁 */ }
  }

  private pushInsets(): void {
    const win = this.win;
    if (win === null) return;
    let top: number = 0;
    let bottom: number = 0;
    let left: number = 0;
    let right: number = 0;
    try {
      // TYPE_SYSTEM = 状态栏 + 导航栏;TYPE_NAVIGATION_INDICATOR = 全面屏的底部指示条(手势条);
      // TYPE_CUTOUT = 挖孔/刘海。三者取各边最大值,免得某一类在某些机型上恰好为 0。
      const system = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const indicator = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
      const cutout = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_CUTOUT);
      top = Math.max(system.topRect.height, cutout.topRect.height);
      bottom = Math.max(system.bottomRect.height, indicator.bottomRect.height);
      left = Math.max(system.leftRect.width, cutout.leftRect.width);
      right = Math.max(system.rightRect.width, cutout.rightRect.width);
    } catch (e) {
      return;
    }
    // avoidArea 是物理像素,CSS 像素要按 vp 折算(px2vp 是 ArkTS 的全局函数)
    this.lastInsetJs = '(function(){var d=document&&document.documentElement;if(!d)return;var s=d.style;'
      + `s.setProperty('--sb-safe-top','${Math.round(px2vp(top))}px');`
      + `s.setProperty('--sb-safe-bottom','${Math.round(px2vp(bottom))}px');`
      + `s.setProperty('--sb-safe-left','${Math.round(px2vp(left))}px');`
      + `s.setProperty('--sb-safe-right','${Math.round(px2vp(right))}px');`
      + "d.setAttribute('data-native-insets','1');"
      + "try{window.dispatchEvent(new Event('sb:insets'))}catch(e){}})()";
    this.replayInsets();
  }

  /** 页面跳转会清掉行内样式,onPageEnd 里要重放一次。 */
  private replayInsets(): void {
    if (this.lastInsetJs.length === 0) return;
    try {
      this.controller.runJavaScript(this.lastInsetJs);
    } catch (e) { /* Web 组件还没初始化:onPageEnd 会再放一次 */ }
  }

  private backToLogin(): void {
    LocationTracker.stop();
    router.replaceUrl({ url: 'pages/Login' });
  }

  build() {
    Column() {
      if (this.loadError.length > 0) {
        Column() {
          Text('打不开企业服务器').fontSize(17).fontWeight(FontWeight.Bold)
          Text(this.loadError).fontSize(13).fontColor('#8a94a6').margin({ top: 8 }).textAlign(TextAlign.Center)
          Button('重试').margin({ top: 20 }).onClick(() => {
            this.loadError = '';
            this.controller.loadUrl(`${this.origin}/`);
          })
          Button('退出登录')
            .backgroundColor(Color.Transparent).fontColor('#2f6bed').margin({ top: 8 })
            .onClick(async () => {
              await Prefs.remove(PREF_SERVER);
              this.backToLogin();
            })
        }
        .width('100%').height('100%').justifyContent(FlexAlign.Center).padding(28)
      } else {
        Web({ src: `${this.origin}/`, controller: this.controller })
          // ① 垫片在文档开始时注入:H5 的 native-app.ts 在模块顶层就会读 window.Capacitor,
          //    用 onPageBegin + runJavaScript 来不及,必须是 document-start 这条通道。
          .javaScriptOnDocumentStart([
            { script: CAPACITOR_SHIM_JS, scriptRules: ['*'] } as ScriptItem,
          ])
          // ② methodList 必须列全 —— 少一个名字,JS 那边调用不会抛错,只会永远 pending。
          .javaScriptProxy({
            object: this.bridge,
            name: 'aiosNative',
            methodList: ['call'],
            controller: this.controller,
          })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .fileAccess(true)
          .geolocationAccess(true)
          .mixedMode(MixedMode.None)
          .userAgent(this.buildUserAgent())
          .width('100%')
          .height('100%')
          // 光有 setWindowLayoutFullScreen 还不够:ArkUI 默认仍把组件摆在安全区**以内**,
          // 要显式声明「我要铺过去」,页面才真的到屏幕上下沿(高度也才对得上 100vh)。
          .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
          // 页面跳转/重载会把行内样式清掉,安全区变量要重放一次
          .onPageEnd(() => { this.replayInsets(); })
          // ③ 退出登录拦截:H5 以为自己在安卓壳,会 location.replace('https://localhost/')。
          //    不拦的话用户会看到一个「无法连接」的错误页,而不是回到登录。
          .onLoadIntercept((event) => {
            const url: string = event.data.getRequestUrl();
            if (url.indexOf(LOGOUT_SENTINEL) === 0) {
              this.backToLogin();
              return true;
            }
            return false;
          })
          .onErrorReceive((event) => {
            // 只认主文档失败:子资源(图片/字体)加载失败不该把整页换成错误页
            if (event.request.isMainFrame()) {
              this.loadError = `${event.error.getErrorInfo()}(${this.origin})`;
            }
          })
          .onPermissionRequest((event) => {
            // H5 的定位/麦克风请求:壳已经在系统层要过权限,这里直接放行,
            // 否则会出现「系统给了权限,网页里还是拿不到」的死结。
            event.request.grant(event.request.getAccessibleResource());
          })
      }
    }
    .width('100%')
    .height('100%')
  }

  private buildUserAgent(): string {
    try {
      return this.controller.getUserAgent() + UA_SUFFIX;
    } catch (e) {
      return UA_SUFFIX.trim();
    }
  }

  /**
   * 系统返回手势/返回键:先让 webview 回退,没有历史了再回登录页。
   * ★H5 侧也注册了 Capacitor 的 backButton 监听(关浮层 / 回上一页 / 最小化),
   *   两边都想处理同一个手势会打架 —— 这里的规则是「webview 能回就交给它」,
   *   与 H5 的 history 机制天然对齐。
   */
  onBackPress(): boolean {
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }
}
