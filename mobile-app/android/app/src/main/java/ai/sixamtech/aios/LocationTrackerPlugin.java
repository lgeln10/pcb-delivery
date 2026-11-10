package ai.sixamtech.aios;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 工作时段位置追踪(考勤)的**安卓**实现。与 iOS 的 LocationTrackerPlugin.swift 同一份契约:
 *   - 方法:`start({ distanceFilterM })` / `stop()`
 *   - 事件:`location` → { lat, lng, accuracyM, speedMps }
 * H5 只在「打上班卡 → 打下班卡」之间调 start/stop(见 standard-build/src/native-app.ts)。
 *
 * ★★为什么非有不可(2026-08-16 排查):在这个插件出现之前,**安卓根本没有后台定位** ——
 *   H5 检测不到 LocationTracker 插件就退化成 webview 前台 `watchPosition`,
 *   员工把手机揣进兜里(息屏)或切到别的 App,上报立刻停;
 *   而服务端有失联判定(lostAlertMinutes 内无上报即标 lost)会给管理者发预警。
 *   净效果:**安卓员工正常上班,系统却告诉老板他失联了**。iOS 一切正常,所以现场表现成
 *   「安卓的人老是失联」,极易被误判成员工问题而不是系统问题。
 *
 * ★为什么用系统 LocationManager 而不是 FusedLocationProvider:
 *   Fused 属于 Google Play 服务(com.google.android.gms)。本 App 的主战场是国行机,
 *   华为(无 GMS)与部分定制 ROM 上那套依赖根本不存在,一引入就是「装得上、跑起来崩」。
 *   LocationManager 是 AOSP 自带的,谁都有。代价是省电策略要自己写(下面的 minTime/minDistance)。
 *
 * ★为什么必须挂前台服务(LocationForegroundService):Android 8 起后台定位被限频到
 *   「每小时几次」,Android 10 起没有 ACCESS_BACKGROUND_LOCATION 更是拿不到后台位置,
 *   国产 ROM 的省电策略还会直接冻结进程。前台服务(带常驻通知)是唯一稳定的做法,
 *   而且那条通知本身就是**对员工的告知** —— 与 iOS 那边刻意打开状态栏蓝条是同一个决定:
 *   被定位这件事必须看得见。
 *
 * ★权限拿不全时**不报错、只降级**:有「使用期间」就先跑起来(前台有轨迹,息屏没有),
 *   与旧壳行为一致;后台权限要靠 H5 在合适时机单独引导(Android 11+ 系统强制分两步弹,
 *   一次同时申请前台+后台会被直接拒)。打卡本身任何时候都不受影响。
 */
@CapacitorPlugin(name = "LocationTracker")
public class LocationTrackerPlugin extends Plugin {

    /** 上报节流:最短间隔 30s / 最小位移由 H5 传(默认 30m)。与服务端建议间隔同数量级。 */
    private static final long MIN_TIME_MS = 30_000L;

    private LocationManager manager;
    private LocationListener listener;
    private boolean running = false;

    @PluginMethod
    public void start(PluginCall call) {
        float distance = call.getFloat("distanceFilterM", 30f);

        boolean fine = hasRuntimePermission(Manifest.permission.ACCESS_FINE_LOCATION);
        boolean coarse = hasRuntimePermission(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (!fine && !coarse) {
            // 与 iOS 同口径:被拒就明确 reject。打卡页已有显式提示,这里不重复打扰。
            call.reject("denied");
            return;
        }

        if (running) stopUpdates(); // 幂等:再次 start 视为更新参数

        try {
            if (manager == null) manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (manager == null) {
                call.reject("no location service");
                return;
            }

            listener = new LocationListener() {
                @Override
                public void onLocationChanged(Location loc) {
                    if (loc == null) return;
                    JSObject data = new JSObject();
                    data.put("lat", loc.getLatitude());
                    data.put("lng", loc.getLongitude());
                    data.put("accuracyM", Math.max(0f, loc.getAccuracy()));
                    data.put("speedMps", Math.max(0f, loc.getSpeed()));
                    notifyListeners("location", data);
                }

                // 老 API 的三个空实现:不写的话在 API < 30 上会抛 AbstractMethodError
                @Override
                public void onStatusChanged(String provider, int status, Bundle extras) {}

                @Override
                public void onProviderEnabled(String provider) {}

                @Override
                public void onProviderDisabled(String provider) {}
            };

            // 先把前台服务拉起来再注册回调:顺序反了的话,Android 12+ 可能把这次
            // 「后台启动前台服务」判成违规,服务起不来 = 息屏照样断。
            startForegroundService();
            requestUpdates(distance, fine);
            running = true;
            call.resolve();
        } catch (Throwable t) {
            stopForegroundService(); // 别留一条「在记录中」的通知却没有真的在记录
            call.reject("start failed: " + t.getClass().getSimpleName());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopUpdates();
        stopForegroundService();
        running = false;
        call.resolve();
    }

    @SuppressLint("MissingPermission") // start() 已按运行时权限拦过
    private void requestUpdates(float distance, boolean fine) {
        if (manager == null || listener == null) return;
        // GPS 与网络两个 provider 都挂:室内几乎只有网络定位有结果,而户外 GPS 更准。
        // 重复上报由服务端按时间/距离去重,多一条远好过整段没有。
        if (fine && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, MIN_TIME_MS, distance, listener, Looper.getMainLooper());
        }
        if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            manager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, MIN_TIME_MS, distance, listener, Looper.getMainLooper());
        }
    }

    private void stopUpdates() {
        try {
            if (manager != null && listener != null) manager.removeUpdates(listener);
        } catch (Throwable ignored) {
            // 已经停了/权限被中途撤销:stop 必须幂等且不抛
        }
        listener = null;
    }

    private void startForegroundService() {
        Intent intent = new Intent(getContext(), LocationForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(getContext(), intent);
        } else {
            getContext().startService(intent);
        }
    }

    private void stopForegroundService() {
        try {
            getContext().stopService(new Intent(getContext(), LocationForegroundService.class));
        } catch (Throwable ignored) {
            // 服务没起来时是空操作,这里只是防御
        }
    }

    /**
     * ★名字不能叫 hasPermission:Capacitor 的 Plugin 基类有一个 **public** 的
     * `hasPermission(String)`(已 @Deprecated)。私有方法签名撞上它 = 编译期直接失败
     * (「attempting to assign weaker access privileges」),连 App 都构建不出来。
     * 也不复用基类那个 —— 它已废弃,下一个 Capacitor 大版本随时会没。
     */
    private boolean hasRuntimePermission(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }
}
