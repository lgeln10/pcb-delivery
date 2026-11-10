import Capacitor

/// 自研插件注册点:app 内插件不在 Capacitor 的 pod 自动扫描里,必须在 bridge 就绪时手动注册。
/// Main.storyboard 的根控制器已指到本类。
class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LocationTrackerPlugin())
    }
}
