import Capacitor
import CoreLocation

/// 工作时段位置追踪(考勤):后台持续定位,事件推给 H5(native-app.ts 的 syncAttendanceTracking)。
/// H5 只在「打上班卡 → 打下班卡」之间调 start/stop;服务端拒收上报时 H5 也会调 stop。
/// ★注册走 MyViewController.capacitorDidLoad(app 内自研插件,不在 Capacitor 的 pod 扫描范围)。
@objc(LocationTrackerPlugin)
public class LocationTrackerPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "LocationTrackerPlugin"
    public let jsName = "LocationTracker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private var manager: CLLocationManager?

    @objc func start(_ call: CAPPluginCall) {
        let distance = call.getDouble("distanceFilterM") ?? 30
        DispatchQueue.main.async {
            if self.manager == nil {
                let m = CLLocationManager()
                m.delegate = self
                self.manager = m
            }
            guard let m = self.manager else { return call.reject("init failed") }
            m.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            m.distanceFilter = distance
            // 息屏/后台持续:必须配合 Info.plist 的 UIBackgroundModes=location 与「始终允许」授权
            m.allowsBackgroundLocationUpdates = true
            m.pausesLocationUpdatesAutomatically = false
            m.showsBackgroundLocationIndicator = true // 状态栏蓝条:员工看得见自己被定位,这是刻意的
            switch m.authorizationStatus {
            case .notDetermined:
                m.requestAlwaysAuthorization() // 先弹「使用期间」,iOS 稍后自行升级弹「始终」
            case .denied, .restricted:
                return call.reject("denied")
            default: break
            }
            m.startUpdatingLocation()
            m.startMonitoringSignificantLocationChanges() // 被系统杀掉后靠它把 App 拉起来续命
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.manager?.stopUpdatingLocation()
            self.manager?.stopMonitoringSignificantLocationChanges()
            call.resolve()
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        notifyListeners("location", data: [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "accuracyM": max(0, loc.horizontalAccuracy),
            "speedMps": max(0, loc.speed),
        ])
    }
}
