// 注入进租户 H5 的 `window.Capacitor` 垫片。
//
// ★这是整个鸿蒙壳最关键的一个设计决定:**不发明新桥,而是伪装成 Capacitor**。
//   standard-build/src/native-app.ts 已经把「壳能力」这件事表达成一组 window.Capacitor 调用了。
//   鸿蒙壳只要把同样的形状摆出来,H5 **一行都不用改** —— 一套 H5 同时跑在浏览器、iOS 壳、
//   安卓壳、鸿蒙壳里,不会长出第四条分支。反过来若自造 `window.HarmonyBridge`,
//   H5 侧每加一个能力就要维护两套判空,迟早漂移。
//
// 通信走消息传递而不是 javaScriptProxy 的同步返回值:
//   JS → 原生   aiosNative.call(callId, plugin, method, argsJson)   (void,不依赖同步返回)
//   原生 → JS   window.__aiosResolve(callId, ok, payloadJson)
//   原生 → JS   window.__aiosEvent(plugin, event, payloadJson)      (可反复触发)
// 这么设计的原因和 Capacitor 自己一样:事件必须能多次回调,而同步返回值做不到;
// 且各 API 版本对 javaScriptProxy 异步返回的支持不一致,消息传递是最稳的那条。
//
// ★注入时机必须是 document start(Web 组件的 javaScriptOnDocumentStart),
//   晚于 H5 自己的脚本就来不及了 —— native-app.ts 在模块顶层就会读 window.Capacitor。

export const CAPACITOR_SHIM_JS: string = `
(function () {
  if (window.Capacitor) { return; }

  var callSeq = 0;
  var pending = {};          // callId -> {resolve, reject}
  var listeners = {};        // "plugin:event" -> [cb]

  window.__aiosResolve = function (callId, ok, payloadJson) {
    var p = pending[callId];
    if (!p) { return; }
    delete pending[callId];
    var data = null;
    if (payloadJson) {
      try { data = JSON.parse(payloadJson); } catch (e) { data = null; }
    }
    if (ok) { p.resolve(data); } else { p.reject(new Error((data && data.message) || '原生调用失败')); }
  };

  window.__aiosEvent = function (plugin, event, payloadJson) {
    var arr = listeners[plugin + ':' + event];
    if (!arr || !arr.length) { return; }
    var data = null;
    if (payloadJson) {
      try { data = JSON.parse(payloadJson); } catch (e) { data = null; }
    }
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](data); } catch (e) { /* 单个订阅者抛错不该拖垮其他订阅者 */ }
    }
  };

  function call(plugin, method, args) {
    return new Promise(function (resolve, reject) {
      var id = String(++callSeq);
      pending[id] = { resolve: resolve, reject: reject };
      try {
        aiosNative.call(id, plugin, method, JSON.stringify(args || {}));
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  function addListener(plugin, event, cb) {
    var key = plugin + ':' + event;
    if (!listeners[key]) { listeners[key] = []; }
    listeners[key].push(cb);
    // 让原生侧知道有人在听(定位/返回键都是原生主动推,需要按需开销)
    try { aiosNative.call('0', plugin, '__subscribe', JSON.stringify({ event: event })); } catch (e) {}
    return {
      remove: function () {
        var arr = listeners[key] || [];
        var i = arr.indexOf(cb);
        if (i >= 0) { arr.splice(i, 1); }
        return Promise.resolve();
      }
    };
  }

  window.Capacitor = {
    isNativePlatform: function () { return true; },
    // ★刻意自称 android:H5 里「安卓返回键 / 状态栏 setOverlaysWebView / 退出登录跳
    //   https://localhost/」三条分支都挂在这个值上,鸿蒙的行为与安卓一致,复用即可。
    //   真要区分平台看 UA 里的 HarmonyOS 标记(见 WebHost.ets 的 customUserAgent)。
    //   等接了 HMS Push 再引入真正的 'harmony' 分支 —— 那时 H5 的推送登记要改 provider。
    getPlatform: function () { return 'android'; },
    addListener: addListener,
    Plugins: {
      Preferences: {
        get: function (o) { return call('Preferences', 'get', o); },
        set: function (o) { return call('Preferences', 'set', o); },
        remove: function (o) { return call('Preferences', 'remove', o); }
      },
      App: {
        addListener: function (ev, cb) { return Promise.resolve(addListener('App', ev, cb)); },
        minimizeApp: function () { return call('App', 'minimizeApp', {}); }
      },
      StatusBar: {
        setOverlaysWebView: function (o) { return call('StatusBar', 'setOverlaysWebView', o); },
        setStyle: function (o) { return call('StatusBar', 'setStyle', o); }
      },
      // 自研后台定位(对应 iOS 的 LocationTrackerPlugin.swift);事件走 Capacitor.addListener
      LocationTracker: {
        start: function (o) { return call('LocationTracker', 'start', o); },
        stop: function () { return call('LocationTracker', 'stop', {}); }
      }
      // ★v1 刻意不暴露 PushNotifications / SpeechRecognition:
      //   H5 侧对两者都是「插件不在就整块跳过」,暴露一个半成品反而会让它一直转圈。
      //   接 HMS Push Kit / Core Speech Kit 时再加进来,见 README「没做的部分」。
    }
  };
})();
`;
