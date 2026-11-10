// 原生侧的桥实现:接 H5 发来的 aiosNative.call(...),办完事回调 __aiosResolve / __aiosEvent。
//
// 这个类的实例通过 Web 组件的 javaScriptProxy 注册成 window.aiosNative,
// 方法名要出现在 methodList 里,否则 JS 侧调用会静默失败(不报错,只是什么都不发生)。
import webview from '@ohos.web.webview';
import common from '@ohos.app.ability.common';
import { Prefs } from '../util/Prefs';
import { LocationTracker } from '../service/LocationTracker';

export class NativeBridge {
  private controller: webview.WebviewController;
  private context: common.UIAbilityContext;
  /** 退出登录时把 webview 拉回壳登录页;由 WebHost 注入 */
  private onLogout: () => void;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext, onLogout: () => void) {
    this.controller = controller;
    this.context = context;
    this.onLogout = onLogout;
  }

  /**
   * H5 侧唯一入口。★方法名必须列进 javaScriptProxy 的 methodList。
   * 全部 catch 到底:桥里抛出去的异常在 ArkTS 侧没人接,只会让这一次调用永远 pending,
   * H5 表现为「按钮点了没反应」。宁可回一个失败,让 H5 有机会提示。
   */
  call(callId: string, plugin: string, method: string, argsJson: string): void {
    this.dispatch(callId, plugin, method, argsJson).catch((e: Error) => {
      this.reject(callId, e.message);
    });
  }

  private async dispatch(callId: string, plugin: string, method: string, argsJson: string): Promise<void> {
    if (method === '__subscribe') {
      // 订阅信号:目前不需要按需开销(定位由 LocationTracker.start 显式起停),留着占位
      return;
    }
    if (plugin === 'Preferences') {
      await this.handlePreferences(callId, method, argsJson);
      return;
    }
    if (plugin === 'App') {
      if (method === 'minimizeApp') {
        // 鸿蒙没有「最小化」API,moveAbilityToBackground 是等价语义
        try {
          await this.context.moveAbilityToBackground();
        } catch (e) {
        }
        this.resolve(callId, '{}');
        return;
      }
      this.resolve(callId, '{}');
      return;
    }
    if (plugin === 'StatusBar') {
      // 状态栏跟随主题:交给 WebHost 的 window stage 处理,这里只回成功不报错。
      // ★H5 会在 android 分支调 setOverlaysWebView(false);鸿蒙壳本来就是
      //   「状态栏不压 webview + 页面自己用 safe-area」,所以这个调用是 no-op 而不是错误。
      this.resolve(callId, '{}');
      return;
    }
    if (plugin === 'LocationTracker') {
      await this.handleLocationTracker(callId, method, argsJson);
      return;
    }
    this.reject(callId, `未实现的原生能力:${plugin}.${method}`);
  }

  private async handlePreferences(callId: string, method: string, argsJson: string): Promise<void> {
    const key: string = NativeBridge.field(argsJson, 'key');
    if (method === 'get') {
      const value: string = await Prefs.get(key);
      // Capacitor 的契约:没有就是 null,不是空串 —— H5 用 `if (!value)` 判,两者等价,
      // 但类型上要给 null,免得将来有人写 `value === null` 判不出来。
      this.resolve(callId, value.length > 0 ? `{"value":${JSON.stringify(value)}}` : '{"value":null}');
      return;
    }
    if (method === 'set') {
      await Prefs.set(key, NativeBridge.field(argsJson, 'value'));
      this.resolve(callId, '{}');
      return;
    }
    if (method === 'remove') {
      await Prefs.remove(key);
      // 会话被清 = H5 正在退出登录,把 webview 拉回壳登录页
      if (key === 'aios.session') {
        this.onLogout();
      }
      this.resolve(callId, '{}');
      return;
    }
    this.reject(callId, `未实现:Preferences.${method}`);
  }

  private async handleLocationTracker(callId: string, method: string, argsJson: string): Promise<void> {
    if (method === 'start') {
      const df: number = NativeBridge.numberField(argsJson, 'distanceFilterM', 30);
      await LocationTracker.start(df, (p) => {
        const payload: string =
          `{"lat":${p.lat},"lng":${p.lng},"accuracyM":${Math.round(p.accuracyM)},"speedMps":${p.speedMps}}`;
        this.emit('LocationTracker', 'location', payload);
      });
      this.resolve(callId, '{}');
      return;
    }
    if (method === 'stop') {
      await LocationTracker.stop();
      this.resolve(callId, '{}');
      return;
    }
    this.reject(callId, `未实现:LocationTracker.${method}`);
  }

  // ── 回 JS ──────────────────────────────────────────────────────────────────

  private resolve(callId: string, payloadJson: string): void {
    this.run(`window.__aiosResolve(${JSON.stringify(callId)}, true, ${JSON.stringify(payloadJson)})`);
  }

  private reject(callId: string, message: string): void {
    const payload: string = `{"message":${JSON.stringify(message)}}`;
    this.run(`window.__aiosResolve(${JSON.stringify(callId)}, false, ${JSON.stringify(payload)})`);
  }

  emit(plugin: string, event: string, payloadJson: string): void {
    this.run(`window.__aiosEvent(${JSON.stringify(plugin)}, ${JSON.stringify(event)}, ${JSON.stringify(payloadJson)})`);
  }

  private run(js: string): void {
    try {
      this.controller.runJavaScript(js);
    } catch (e) {
      // webview 已销毁(用户退出/切页):忽略,不是错误
    }
  }

  // ── 参数解析(壳的参数都是标量,不引入完整 JSON 反序列化)──────────────────

  private static field(json: string, name: string): string {
    const m: RegExpMatchArray | null = json.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (m === null || m[1] === undefined) {
      return '';
    }
    // 还原 JSON 转义(会话是一整段 JSON 字符串,里面全是转义引号)
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch (e) {
      return m[1];
    }
  }

  private static numberField(json: string, name: string, fallback: number): number {
    const m: RegExpMatchArray | null = json.match(new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (m === null || m[1] === undefined) {
      return fallback;
    }
    const n: number = parseFloat(m[1]);
    return isNaN(n) ? fallback : n;
  }
}
