package ai.sixamtech.aios;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/**
 * 安卓壳的窗口适配:全屏(edge-to-edge)+ 把系统栏尺寸喂给 H5。
 *
 * ★为什么非做不可(2026-08-03):targetSdkVersion = 35。
 *   Android 15 起,targetSdk ≥ 35 的应用**强制 edge-to-edge**,内容一律铺到状态栏和
 *   导航栏底下,而且 `Window#setStatusBarColor`、`View#setSystemUiVisibility` 这些老 API
 *   全部被废成空操作 —— @capacitor/status-bar 的 `setOverlaysWebView(false)` 正是用
 *   `setSystemUiVisibility` 实现的(见 node_modules/.../statusbar/StatusBar.java),
 *   所以 H5 里那句「把状态栏设为非沉浸」在 Android 15+ 上**根本没生效**。
 *   表现:顶栏标题被状态栏的时间/信号盖住,底部 tab 栏被手势条/导航键盖住。
 *
 * ★为什么不能靠 CSS 的 env(safe-area-inset-*):安卓 WebView 只把**刘海(display cutout)**
 *   算进 safe-area,状态栏高度和导航栏高度它一概不报。没有刘海的机器 top 恒为 0,
 *   底部手势条更是永远为 0。所以这里从原生取真实 inset,注入成 CSS 变量交给 H5。
 *
 * 与 H5 的契约(standard-build/src/styles.css 的 :root 定义了同名回退值,
 * 由 standard-build/src/safe-area-contract.test.ts 钉住两边不许改歪):
 *   --sb-safe-top / --sb-safe-bottom / --sb-safe-left / --sb-safe-right
 * 单位 px(CSS 像素,已除过 density)。iOS 与浏览器里这四个变量回退到 env(),行为不变。
 */
public class MainActivity extends BridgeActivity {

    /**
     * 低于这个 Chromium 大版本就先给一屏说明(**可以继续**,不是硬拦)。
     *
     * 92 的由来:H5 产物里实际用到的最高**运行时 API** 是 `Array.prototype.at()`(Chromium 92,
     * 2021-07)。再往上的那些(`color-mix()` 111、`:has()` 105、`dvh` 108、`text-wrap` 114)
     * 全是 CSS,不支持时只是那一条声明被丢弃 —— 掉样式,不白屏,所以不作为门槛。
     * ★这个数字**必须跟着 H5 走**:哪天代码里出现了更高门槛的运行时 API,这里要一起抬。
     *   `standard-build/src/legacy-engine-contract.test.ts` 负责在 H5 那侧钉住这条底线。
     *
     * ★刻意做成「警告 + 继续」而不是硬闸:门槛是个估计值,估高了就等于把一台本来能用的机器
     *   砸掉;而白屏时用户一无所知才是真正要解决的问题。给解释、给出路、留后门。
     */
    private static final int WEBVIEW_WARN_MAJOR = 92;

    /** 日志 tag。★安全区这类问题在真机上无法用 DevTools 查(熄屏时渲染进程被冻结),只能靠 logcat。 */
    private static final String TAG = "AIOSShell";

    /** 最近一次算出的注入脚本。页面跳转会清掉 documentElement 上的行内样式,重放它。 */
    private String lastInsetScript = null;

    /** 内容根视图。老 H5 兜底让位时由它来垫(见 probeSafeArea)。 */
    private View contentView = null;

    /** 最近一次算出的系统栏 inset(px,已含刘海)。 */
    private Insets lastBars = Insets.NONE;

    /** 最近一次软键盘高度(px)。 */
    private int lastIme = 0;

    /**
     * 页面是否自己会读 `--sb-safe-*` 让位(新 H5 的 `html.in-native-app`,或本地登录壳)。
     *
     * ★默认 true —— 宁可晚垫一次,也绝不能垫两次:双重让位比不让位更难看,而且更难查
     *   (看起来像「顶栏莫名其妙很高」,没人会想到是两边都让了)。
     */
    private boolean pageHandlesSafeArea = true;

    /** 每次页面加载递增,用来作废上一页还在排队的探测回调。 */
    private int probeGeneration = 0;

    /** 启动时探到的内核信息;注入给 H5 供降级与排障用,也用于兜底页文案。 */
    private String webViewPkg = "";
    private String webViewVersion = "";
    private int webViewMajor = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // ★自研插件必须在 super.onCreate 之前注册 —— Capacitor 在 super 里建桥并加载页面,
        //   晚一步注册,H5 首帧就检测不到 LocationTracker,会退化成前台 watchPosition
        //   (= 息屏断轨迹的老行为,而且不报错)。与 iOS 侧 capacitorDidLoad 里那句是同一件事。
        registerPlugin(LocationTrackerPlugin.class);

        inspectWebView();

        // ★super.onCreate 里 Capacitor 就会创建 WebView 并开始加载 —— 机器上**根本没有**
        //   WebView 实现时(部分精简 ROM / WebView 被停用)这一步直接抛
        //   AndroidRuntimeException,表现为「点开图标闪一下就没了」,用户和我们都拿不到任何线索。
        //   兜住它,改成一屏能读懂的说明。
        //   (这里能安全 setContentView:BridgeActivity.onCreate 是先走完 AppCompat 的 onCreate
        //    再 load(),抛的是后半段。)
        try {
            super.onCreate(savedInstanceState);
        } catch (Throwable t) {
            showEngineNotice(true, t.getClass().getSimpleName() + ": " + t.getMessage());
            return; // 桥没建起来,后面全是空转
        }

        // 内核偏旧:盖一层可关掉的说明。★用**浮层**而不是 setContentView 换页 ——
        // 换页要处理「继续」时把 Capacitor 那棵树装回去(View 只能有一个父),
        // 浮层则是加一个、移一个,WebView 在后面照常加载,点「继续」立刻就是已经加载好的页面。
        if (webViewMajor > 0 && webViewMajor < WEBVIEW_WARN_MAJOR) {
            showEngineNotice(false, null);
        }

        // 统一走 edge-to-edge:Android 15+ 本来就强制,低版本也主动开,免得同一套 CSS
        // 要面对「有的机器铺满、有的机器不铺满」两种布局(那种差异只在特定机型上复现)。
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // ≤ API 34 才需要显式透明;35+ 上这两个调用是空操作,留着是为了低版本表现一致。
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 不关的话系统会在透明系统栏后面自己刷一层半透明灰底(尤其是三键导航那条),
            // 表现为底部凭空多一条与页面配色不搭的灰带。
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 横屏时不让系统把整个窗口从刘海边让开(那会在屏幕一侧留一条黑边),
            // 改为铺过去,由下面的 left/right inset 让 H5 自己避。
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        final View content = findViewById(android.R.id.content);
        if (content == null) return;
        contentView = content;

        ViewCompat.setOnApplyWindowInsetsListener(
            content,
            (v, insets) -> {
                lastBars = stableBars(insets);
                lastIme = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
                syncSafeArea();
                return insets;
            }
        );
        ViewCompat.requestApplyInsets(content);

        // 跳到租户域名(以及每次页面重载)后,行内样式没了,syncSafeArea 会重算重推。
        if (getBridge() != null) {
            getBridge()
                .addWebViewListener(
                    new WebViewListener() {
                        @Override
                        public void onPageLoaded(WebView webView) {
                            // 每次加载都从「页面自己会让位」重新开始:上一页的判定不能带到下一页
                            // (壳登录页 → 租户 H5 就是一次跨判定的跳转)。
                            pageHandlesSafeArea = true;
                            probeGeneration++;
                            syncSafeArea();
                            pushEnvironmentIfConsented(webView);
                            probeSafeArea(webView, 0, probeGeneration);
                        }

                        /**
                         * 渲染进程被系统杀掉(低内存机器上很常见,国产 ROM 的后台清理尤其狠)。
                         *
                         * ★不接这个回调的话,WebView 会永久变成一块白板 —— 进程没了,
                         *   谁再点都没反应,而 App 本身还活着,看起来就是「卡死了」。
                         *   返回 true 表示我们自己处理:重建 WebView 不现实(桥都挂在上面),
                         *   但 reload 能把渲染进程拉回来,代价是丢一次页面状态。
                         *   detail.didCrash() 为 false 表示是系统主动回收而不是崩溃,两种都得救。
                         */
                        @Override
                        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                            if (webView == null) return false;
                            try {
                                webView.reload();
                                return true;
                            } catch (Throwable ignored) {
                                return false;
                            }
                        }
                    }
                );
        }
    }

    // ── 内核探测与兜底 ────────────────────────────────────────────────────────

    /**
     * 探当前 WebView 实现是谁、什么版本。
     *
     * 各家实现的包名并不统一 —— 谷歌系是 `com.google.android.webview` / `com.android.webview`,
     * 华为是 `com.huawei.webview`,部分国产 ROM 用自家 Chromium 分支。
     * `versionName` 一律是 Chromium 风格的 `114.0.5735.196`,取前段即可。
     * ★探不到时(某些 ROM 返回 null)三个字段留空、major 记 0 ——
     *   **0 不触发警告页**:探不到不等于旧,凭一个空值把人挡在门外是最糟的一种误判。
     */
    private void inspectWebView() {
        try {
            PackageInfo info = WebViewCompat.getCurrentWebViewPackage(this);
            if (info == null) return;
            webViewPkg = info.packageName == null ? "" : info.packageName;
            webViewVersion = info.versionName == null ? "" : info.versionName;
            int dot = webViewVersion.indexOf('.');
            String head = dot > 0 ? webViewVersion.substring(0, dot) : webViewVersion;
            webViewMajor = Integer.parseInt(head.trim());
        } catch (Throwable ignored) {
            // 包名/版本号形状不符合预期:当作探不到,别把解析失败升级成「不给用」
        }
    }

    /**
     * 把设备与内核信息注入 H5:`window.__AIOS_NATIVE__`。
     *
     * 用途有两个,都不是锦上添花:
     *   ① 排障 —— 用户报「显示不对」时,不用问他机型和系统版本,页面自己知道;
     *   ② 降级 —— H5 可以按 `webviewMajor` 关掉依赖新特性的效果(目前还没有页面这么做,
     *      先把数据递过去,免得将来要用时还得改原生再发一次版)。
     * 每次 onPageLoaded 都重放,理由同 insets:跳到租户域名后这个全局变量就没了。
     */
    /**
     * 设备信息注入,但**先问过同意**。
     *
     * ★为什么加这道判断:`__AIOS_NATIVE__` 里带着厂商、机型、系统版本 ——
     *   国内应用商店的隐私检测把「启动即读取设备信息」当作违规项,不管你有没有把它传出去。
     *   壳登录页在用户点「同意」之前不该拿到这些。
     *
     * 判据两条,满足其一即可:
     *   · 页面自己声明了 `__AIOS_CONSENT__`(壳的同意闸过了);
     *   · 页面不是本地壳页 —— 那就是已登录后的租户 H5,同意早就发生过了。
     * 取不到结果时**不注入**(默认拒绝),代价只是 H5 少一份降级用的环境信息。
     */
    private void pushEnvironmentIfConsented(WebView webView) {
        if (webView == null) return;
        webView.evaluateJavascript(
            "(function(){try{return (window.__AIOS_CONSENT__===true" +
            "||!/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname))?'1':'0'}catch(e){return '0'}})()",
            value -> {
                if (value != null && value.contains("1")) pushEnvironment();
            }
        );
    }

    private void pushEnvironment() {
        String script = String.format(
            Locale.US,
            "(function(){window.__AIOS_NATIVE__={platform:'android',sdkInt:%d,release:'%s'," +
            "manufacturer:'%s',model:'%s',webviewPackage:'%s',webviewVersion:'%s',webviewMajor:%d};" +
            "try{document.documentElement.setAttribute('data-webview-major','%d')}catch(e){}})()",
            Build.VERSION.SDK_INT,
            js(Build.VERSION.RELEASE),
            js(Build.MANUFACTURER),
            js(Build.MODEL),
            js(webViewPkg),
            js(webViewVersion),
            webViewMajor,
            webViewMajor
        );
        evaluate(script);
    }

    /** 拼进单引号 JS 字面量前的转义。机型名里出现引号/反斜杠不是天方夜谭(定制 ROM 见过)。 */
    private static String js(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", " ");
    }

    /**
     * 内核太旧 / 压根没有内核时的说明浮层。
     *
     * ★全部用代码搭而不是 layout xml:这是「别的东西已经坏了」的那条路径,
     *   越少依赖(资源解析、主题、第三方 View)越好。文案也直接写在这 ——
     *   本 App 只有中文,把它放进 strings.xml 只是多一层可能取不到的间接。
     */
    private void showEngineNotice(boolean fatal, String detail) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setBackgroundColor(Color.WHITE);
        int pad = dp(24);
        box.setPadding(pad, pad, pad, pad);
        // 不透明 + 可点击:否则手指会穿过去点到后面的 WebView
        box.setClickable(true);

        box.addView(text(fatal ? "这台设备上没有可用的浏览器内核" : "系统浏览器内核偏旧", 20, true));

        String body = fatal
            ? "本 App 的界面运行在系统的「Android System WebView」上,而这台设备上它不存在或被停用了。"
                + "请到应用商店安装/启用「Android System WebView」(华为设备为「华为浏览器服务」),再重新打开本 App。"
            : "当前内核版本 "
                + (webViewVersion.isEmpty() ? "未知" : webViewVersion)
                + ",低于本 App 建议的 "
                + WEBVIEW_WARN_MAJOR
                + "。可以继续使用,但部分页面的配色与排版可能不正常。"
                + "建议到应用商店把「Android System WebView」更新到最新版。";
        box.addView(text(body, 15, false));

        StringBuilder env = new StringBuilder();
        env.append(Build.MANUFACTURER).append(' ').append(Build.MODEL);
        env.append(" · Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(')');
        if (!webViewPkg.isEmpty()) env.append("\n内核 ").append(webViewPkg).append(' ').append(webViewVersion);
        if (detail != null) env.append('\n').append(detail);
        TextView envView = text(env.toString(), 12, false);
        envView.setTextColor(0xFF8A8F99);
        envView.setTextIsSelectable(true); // 让用户能长按复制发给我们
        box.addView(envView);

        Button store = new Button(this);
        store.setText("去应用商店更新内核");
        store.setOnClickListener(v -> openWebViewStorePage());
        box.addView(store);

        if (!fatal) {
            Button go = new Button(this);
            go.setText("仍然继续");
            go.setOnClickListener(v -> {
                View parent = (View) box.getParent();
                if (parent instanceof android.view.ViewGroup) ((android.view.ViewGroup) parent).removeView(box);
            });
            box.addView(go);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setFitsSystemWindows(true); // 这一屏不玩 edge-to-edge,自己躲开系统栏
        scroll.addView(box);
        addContentView(
            scroll,
            new android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
    }

    private TextView text(String s, int sp, boolean bold) {
        TextView tv = new TextView(this);
        tv.setText(s);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        tv.setTextColor(bold ? 0xFF1B1F27 : 0xFF4A5160);
        if (bold) tv.setTypeface(tv.getTypeface(), android.graphics.Typeface.BOLD);
        tv.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.bottomMargin = dp(12);
        tv.setLayoutParams(lp);
        return tv;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /**
     * 跳到内核那个包的商店详情页。`market://` 会被系统里任意一个应用市场接走
     * (华为 AppGallery / 小米应用商店 / 应用宝都注册了它),没有市场时退到网页版 Google Play。
     * ★两层都要 try:没有任何 Activity 能处理时 startActivity 会抛,而这条路径本来就是给
     *   「环境已经不正常」的机器走的。
     */
    private void openWebViewStorePage() {
        String pkg = webViewPkg.isEmpty() ? "com.google.android.webview" : webViewPkg;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
            return;
        } catch (Throwable ignored) {
            // 没装任何应用市场
        }
        try {
            startActivity(
                new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + pkg))
            );
        } catch (Throwable ignored) {
            // 连浏览器都没有:这一步失败也没有别的路可走了,上面的机型信息已经可以复制
        }
    }

    /**
     * 算出**稳定的**系统栏 inset(含刘海)。
     *
     * ★为什么不能用 `getInsets(systemBars())`:那个是「按当前可见性」算的 —— 状态栏在这一瞬间
     *   不可见(启动闪屏、三星全屏手势、临时沉浸)就返回 0。而 inset 回调之后不会再触发,
     *   那个 0 会被存进 lastInsetScript,然后在**每次页面加载时被忠实地重放**,
     *   于是「顶栏被状态栏盖住」变成永久状态,且全程不报错。
     *   `getInsetsIgnoringVisibility` 返回的是「这条栏可见时会占多高」,与可见性无关。
     *
     * ★还留了一道地板:两个来源都是 0 时用系统资源里的 status_bar_height。
     *   多垫 24dp 只是浪费一点空间,少垫就是标题被盖住 —— 这两种错的代价不对等。
     *   (本 App 从不隐藏状态栏,所以 top=0 基本可以断定是取值出了问题。)
     */
    private Insets stableBars(WindowInsetsCompat insets) {
        Insets stable = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars());
        Insets cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout());
        int top = Math.max(stable.top, cutout.top);
        int bottom = Math.max(stable.bottom, cutout.bottom);
        int left = Math.max(stable.left, cutout.left);
        int right = Math.max(stable.right, cutout.right);
        if (top == 0) {
            int fallback = statusBarHeightPx();
            if (fallback > 0) {
                Log.w(TAG, "systemBars top = 0,退回资源里的 status_bar_height = " + fallback + "px");
                top = fallback;
            }
        }
        return Insets.of(left, top, right, bottom);
    }

    /** 系统资源里的状态栏高度(px)。取不到返回 0。 */
    private int statusBarHeightPx() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            return id > 0 ? getResources().getDimensionPixelSize(id) : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /**
     * 把当前 inset 落到该落的地方。**让位只由一边做,不许两边都做**:
     *   · 页面自己会让位(新 H5 / 本地壳)→ 注入真实值,原生这边只垫键盘;
     *   · 页面不会(老 H5,构建早于安全区契约)→ 注入 0,由原生把内容整体顶下来。
     */
    private void syncSafeArea() {
        applyWindowPadding();
        if (pageHandlesSafeArea) {
            // 键盘起来时导航栏藏在键盘后面,底部 inset 已经含在 ime 里,再算一次就是重复让位
            int bottom = lastIme > 0 ? 0 : lastBars.bottom;
            pushInsets(lastBars.top, bottom, lastBars.left, lastBars.right);
        } else {
            pushInsets(0, 0, 0, 0);
        }
    }

    private void applyWindowPadding() {
        if (contentView == null) return;
        if (pageHandlesSafeArea) {
            // ★软键盘仍用**真的把内容区顶上去**的老办法(给根视图垫底部内边距),不走 CSS。
            //   edge-to-edge 之后窗口不再随键盘 resize,而 H5 的 keyboard-inset.ts 是靠
            //   「window.innerHeight 与 visualViewport.height 对不上」判定键盘的;
            //   窗口不 resize、WebView 尺寸不变,那条判定在安卓上就永远不触发,
            //   输入框会被键盘盖住。这里把 WebView 实际高度压下去,行为与改造前一致。
            contentView.setPadding(0, 0, 0, lastIme);
        } else {
            int bottom = lastIme > 0 ? lastIme : lastBars.bottom;
            contentView.setPadding(lastBars.left, lastBars.top, lastBars.right, bottom);
        }
    }

    /**
     * 探测脚本:返回 `1|<body 背景色>|<诊断>` / `0|<body 背景色>|<诊断>`。1 = 页面自己会让位。
     *
     * 诊断段(URL / 有没有 Capacitor 桥 / UA 里有没有 AIOSShell)只在判成「老 H5」时打进日志 ——
     * 判错时这三项就是全部线索,而真机上没有别的窗口能看到它们。
     */
    private static final String SAFE_AREA_PROBE_JS =
        "(function(){var a='0',b='',d='';try{" +
        "if(/^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname)||location.protocol==='file:'" +
        "||document.documentElement.classList.contains('in-native-app'))a='1';" +
        "}catch(e){a='1'}" +
        "try{b=getComputedStyle(document.body).backgroundColor||''}catch(e){}" +
        "try{d=location.href.slice(0,60)+' cap='+(typeof window.Capacitor)" +
        "+' shellUA='+/AIOSShell/.test(navigator.userAgent)}catch(e){}" +
        "return a+'|'+b+'|'+d})()";

    /**
     * 探页面到底会不会自己让位,顺便取一次背景色。
     *
     * ★为什么要探而不是写死:安全区那套 CSS 是 2026-08-03 才进 base 的,而 9 个客户分支
     *   各自构建、各自发版 —— **任何一个 H5 构建早于那天的客户,装上壳就是顶栏被盖住**,
     *   壳这边完全正常。探一下,老 H5 由壳自己顶下来,这样壳一升级所有客户一次性都好,
     *   不用等每个客户分支重新构建。
     *
     * ★为什么要探好几次:`in-native-app` 是 H5 启动时**异步**加上去的,onPageLoaded 那一刻
     *   往往还没有。前几次不算数(默认按「会让位」),1.8s 后还没有才判定成老 H5;
     *   之后继续探到 ~10s —— 慢机器上类名迟到时能**退回去**,不会留下双重让位。
     */
    private void probeSafeArea(WebView webView, int attempt, int generation) {
        if (webView == null || generation != probeGeneration || attempt > 8) return;
        webView.evaluateJavascript(
            SAFE_AREA_PROBE_JS,
            value -> {
                if (generation != probeGeneration) return;
                String raw = value == null ? "" : value.replace("\"", "");
                boolean declared = raw.startsWith("1");
                // 前三次(0 / .6 / 1.2s)只接受肯定答案,给 SPA 启动留时间
                boolean handles = declared || attempt < 3;
                if (attempt == 0) {
                    // 每页打一行。★「没有报错」不等于「判对了」—— 判定结果必须自己说出来,
                    //   否则下次再出问题,日志里依然只有一片安静。
                    Log.i(TAG, "safe-area probe: " + raw);
                }
                if (handles != pageHandlesSafeArea) {
                    pageHandlesSafeArea = handles;
                    if (!handles) applyLegacyWindowBackground(raw);
                    syncSafeArea();
                    Log.i(TAG, "safe-area: page-handles=" + handles + " bars=" + lastBars + " probe=" + raw);
                }
                webView.postDelayed(
                    () -> probeSafeArea(webView, attempt + 1, generation),
                    attempt < 3 ? 600L : 2000L
                );
            }
        );
    }

    /**
     * 老 H5 兜底时,状态栏后面露出的是**窗口背景**而不是页面背景 —— 不刷就是一条与页面
     * 不搭的色带(深色主题下尤其明显)。拿页面 body 的背景色刷上去。
     */
    private void applyLegacyWindowBackground(String probeResult) {
        String[] parts = probeResult.split("\\|");
        int color = parseCssColor(parts.length >= 2 ? parts[1] : "");
        try {
            getWindow().setBackgroundDrawable(new ColorDrawable(color));
        } catch (Throwable ignored) {
            // 窗口已销毁:下一次页面加载会重来
        }
    }

    /** 解析 `rgb(r, g, b)` / `rgba(r, g, b, a)`。解析不出或全透明时给白色(总比黑色带强)。 */
    private int parseCssColor(String css) {
        try {
            int open = css.indexOf('(');
            int close = css.indexOf(')');
            if (open > 0 && close > open) {
                String[] parts = css.substring(open + 1, close).split(",");
                if (parts.length >= 3) {
                    float alpha = parts.length >= 4 ? Float.parseFloat(parts[3].trim()) : 1f;
                    if (alpha > 0.01f) {
                        return Color.rgb(
                            Integer.parseInt(parts[0].trim()),
                            Integer.parseInt(parts[1].trim()),
                            Integer.parseInt(parts[2].trim())
                        );
                    }
                }
            }
        } catch (Throwable ignored) {
            // 走下面的白色
        }
        return Color.WHITE;
    }

    private void pushInsets(int topPx, int bottomPx, int leftPx, int rightPx) {
        float density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int top = Math.round(topPx / density);
        int bottom = Math.round(bottomPx / density);
        int left = Math.round(leftPx / density);
        int right = Math.round(rightPx / density);

        // ★Locale.US:默认语言环境下 %d 也可能带分组分隔符(阿拉伯语数字更是另一套字形),
        //   拼进 CSS 就是一条无效声明,而且只在那些机器上复现。
        String script = String.format(
            Locale.US,
            "(function(){var d=document&&document.documentElement;if(!d)return;" +
            "var s=d.style;s.setProperty('--sb-safe-top','%dpx');s.setProperty('--sb-safe-bottom','%dpx');" +
            "s.setProperty('--sb-safe-left','%dpx');s.setProperty('--sb-safe-right','%dpx');" +
            "d.setAttribute('data-native-insets','1');" +
            "try{window.dispatchEvent(new Event('sb:insets'))}catch(e){}})()",
            top,
            bottom,
            left,
            right
        );
        lastInsetScript = script;
        // ★真机上查安全区只能靠这行:熄屏时 WebView 渲染进程被冻结,DevTools 一连就超时。
        //   `adb logcat -s AIOSShell` 能直接看到到底推了什么值过去。
        Log.i(TAG, "insets → css: top=" + top + " bottom=" + bottom + " left=" + left + " right=" + right + " (dp/css px)");
        evaluate(script);
    }


    private void evaluate(String script) {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        // inset 回调与 onPageLoaded 都在主线程,直接调即可;WebView 还没就绪时这次静默失败无妨,
        // onPageLoaded 会再放一次。
        try {
            webView.evaluateJavascript(script, null);
        } catch (Exception ignored) {
            // WebView 已销毁:下一次 inset 变化或页面加载会重来
        }
    }
}
