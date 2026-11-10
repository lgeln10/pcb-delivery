// 原生持久化(@ohos.data.preferences)。对应 Capacitor 的 Preferences 插件。
//
// ★键名与 iOS/安卓壳完全一致(aios.server / aios.session / aios.lastPhone)——
//   H5 侧 standard-build/src/native-app.ts 读的就是这三个键,换了名字 H5 就领养不到会话,
//   表现为「壳里登录成功,进去还是登录页」。三端同一套契约,改一处要改四处(含 H5)。
import preferences from '@ohos.data.preferences';
import common from '@ohos.app.ability.common';

export const PREF_SERVER: string = 'aios.server';
export const PREF_SESSION: string = 'aios.session';
export const PREF_LAST_PHONE: string = 'aios.lastPhone';

const STORE_NAME: string = 'aios_shell';

let store: preferences.Preferences | null = null;

export class Prefs {
  /** 冷启动时调一次;拿不到 store 时后续读写都退化成 no-op,不让存储故障把登录页打挂。 */
  static async init(context: common.UIAbilityContext): Promise<void> {
    try {
      store = await preferences.getPreferences(context, STORE_NAME);
    } catch (e) {
      store = null;
    }
  }

  static async get(key: string): Promise<string> {
    if (store === null) {
      return '';
    }
    try {
      const v: preferences.ValueType = await store.get(key, '');
      return typeof v === 'string' ? v : '';
    } catch (e) {
      return '';
    }
  }

  static async set(key: string, value: string): Promise<void> {
    if (store === null) {
      return;
    }
    try {
      await store.put(key, value);
      // ★必须 flush:put 只改内存副本,不落盘。漏了它,冷启动读到的还是上一次的值 ——
      //   表现为「登录成功,杀掉 App 再开又回到登录页」。
      await store.flush();
    } catch (e) {
      // 存不下就算了:壳还能用,只是下次要重新登录
    }
  }

  static async remove(key: string): Promise<void> {
    if (store === null) {
      return;
    }
    try {
      await store.delete(key);
      await store.flush();
    } catch (e) {
    }
  }
}
