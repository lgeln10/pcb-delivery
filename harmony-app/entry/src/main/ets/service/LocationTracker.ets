// 工作时段位置追踪(对应 iOS 的 LocationTrackerPlugin.swift)。
//
// ★鸿蒙这边比安卓好办:continuousTask(长时任务)是系统正式支持的后台持续定位方式,
//   申请后会在通知栏挂一条常驻通知,用户随时看得见「正在被定位」—— 这既是系统要求,
//   也正好是我们要的合规姿态(员工必须知道自己在被追踪)。
//
// 边界仍然由**服务端**裁决:H5 收到 reportLocations 回的 tracking:false 就调 stop()。
// 这里只负责「开了就持续吐点」,不自己判断该不该追 —— 端上判会和服务端打架。
import geoLocationManager from '@ohos.geoLocationManager';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';
import common from '@ohos.app.ability.common';
import wantAgent from '@ohos.app.ability.wantAgent';

export interface TrackPoint {
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number;
}

export type TrackListener = (p: TrackPoint) => void;

export class LocationTracker {
  private static running: boolean = false;
  private static listener: TrackListener | null = null;
  private static ctx: common.UIAbilityContext | null = null;

  static bind(context: common.UIAbilityContext): void {
    LocationTracker.ctx = context;
  }

  static isRunning(): boolean {
    return LocationTracker.running;
  }

  /**
   * 开始追踪。distanceFilterM 与 iOS 侧同义:移动超过这么多米才吐一个点。
   * 幂等:已在跑就直接返回,不重复申请长时任务。
   */
  static async start(distanceFilterM: number, onPoint: TrackListener): Promise<void> {
    if (LocationTracker.running) {
      LocationTracker.listener = onPoint;
      return;
    }
    LocationTracker.listener = onPoint;
    await LocationTracker.startContinuousTask();

    const req: geoLocationManager.LocationRequest = {
      priority: geoLocationManager.LocationRequestPriority.ACCURACY,
      scenario: geoLocationManager.LocationRequestScenario.NAVIGATION,
      // 单位秒。上报节流真正靠 distanceInterval,时间间隔给一个不至于空烧电的下限。
      timeInterval: 10,
      distanceInterval: distanceFilterM > 0 ? distanceFilterM : 30,
      maxAccuracy: 0,
    };
    try {
      geoLocationManager.on('locationChange', req, (loc: geoLocationManager.Location) => {
        const cb: TrackListener | null = LocationTracker.listener;
        if (cb !== null) {
          cb({
            lat: loc.latitude,
            lng: loc.longitude,
            accuracyM: loc.accuracy,
            speedMps: loc.speed,
          });
        }
      });
      LocationTracker.running = true;
    } catch (e) {
      // 拿不到定位(没授权/定位总开关关着):撤掉长时任务,别留一条什么都不干的常驻通知
      await LocationTracker.stopContinuousTask();
      LocationTracker.running = false;
    }
  }

  static async stop(): Promise<void> {
    if (!LocationTracker.running) {
      return;
    }
    LocationTracker.running = false;
    LocationTracker.listener = null;
    try {
      geoLocationManager.off('locationChange');
    } catch (e) {
    }
    await LocationTracker.stopContinuousTask();
  }

  /**
   * 申请长时任务(LOCATION 类型)。没有它,息屏几十秒后系统就会停掉定位回调,
   * 表现成「锁屏一会儿轨迹就断了」——而且不会有任何报错。
   */
  private static async startContinuousTask(): Promise<void> {
    const context: common.UIAbilityContext | null = LocationTracker.ctx;
    if (context === null) {
      return;
    }
    try {
      const wantAgentInfo: wantAgent.WantAgentInfo = {
        wants: [
          {
            bundleName: context.abilityInfo.bundleName,
            abilityName: context.abilityInfo.name,
          },
        ],
        // 点通知栏那条常驻通知要能回到 App(让员工随时能看到自己在被定位、能去关掉)
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0,
        actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
      };
      const agent: object = await wantAgent.getWantAgent(wantAgentInfo);
      await backgroundTaskManager.startBackgroundRunning(
        context,
        backgroundTaskManager.BackgroundMode.LOCATION,
        agent,
      );
    } catch (e) {
      // 申请失败(未声明 KEEP_BACKGROUND_RUNNING / 系统拒绝):
      // 仍然继续前台定位 —— 前台有轨迹总好过完全没有,失联预警会把异常捞出来。
    }
  }

  private static async stopContinuousTask(): Promise<void> {
    const context: common.UIAbilityContext | null = LocationTracker.ctx;
    if (context === null) {
      return;
    }
    try {
      await backgroundTaskManager.stopBackgroundRunning(context);
    } catch (e) {
    }
  }
}
