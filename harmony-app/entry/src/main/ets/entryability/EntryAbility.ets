// 应用入口。职责只有两件:装载首页、把定位权限一次性要到。
//
// ★权限在这里申请而不是等 H5 用到时再要:鸿蒙的定位属于 user_grant,
//   弹窗必须由 UIAbility 发起。等 webview 里的 H5 触发时再弹,时机与生命周期都更难对。
import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Prefs } from '../util/Prefs';
import { LocationTracker } from '../service/LocationTracker';

const LOCATION_PERMS: Array<Permissions> = [
  'ohos.permission.APPROXIMATELY_LOCATION',
  'ohos.permission.LOCATION',
];

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    LocationTracker.bind(this.context);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    await Prefs.init(this.context);
    windowStage.loadContent('pages/Login');

    try {
      const win: window.Window = windowStage.getMainWindow ? await windowStage.getMainWindow() : null as unknown as window.Window;
      if (win !== null && win !== undefined) {
        // 沉浸式:状态栏不压内容,顶部留白由 H5 的 safe-area CSS 处理(与 iOS 壳同一口径)
        await win.setWindowLayoutFullScreen(true);
      }
    } catch (e) {
    }

    // 定位权限:拒绝也照常进 App —— 打卡页会显式提示「定位权限被拒绝」,
    // 比在启动时拦住人更容易让用户明白发生了什么。
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      await atManager.requestPermissionsFromUser(this.context, LOCATION_PERMS);
    } catch (e) {
    }
  }

  onDestroy(): void {
    // App 被销毁必须撤掉长时任务,否则通知栏会残留一条撤不掉的常驻通知
    LocationTracker.stop();
  }
}
