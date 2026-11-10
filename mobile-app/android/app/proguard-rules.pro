# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# ── 本项目的 keep(2026-08-09 补齐)────────────────────────────────────────────
# release 目前仍是 minifyEnabled false(理由见 app/build.gradle 的 buildTypes)。
# 这些规则是**提前备好的作业**:哪天要打开 R8,改那一行即可,不用临阵猜哪里被削了。
# Capacitor 自己的 keep 由 capacitor-android 的 consumerProguardFiles 自动带入,不必抄。

# 没有行号的崩溃栈等于没有栈。开了 R8 记得把 mapping.txt 随版本留档。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# MainActivity 的内核探测与兜底页挂在 Activity 生命周期 + 匿名 WebViewListener 上,
# 都在反射/回调路径。整个包留下 —— 一共一个文件,削它省不出什么。
-keep class ai.sixamtech.aios.** { *; }

# WebViewCompat 走的是「向 WebView 提供方查询能力」的反射协议
-keep class androidx.webkit.** { *; }
-dontwarn androidx.webkit.**

# 被 webview 里 JS 直接调到的方法。Capacitor 桥已被 consumer 规则覆盖,
# 这条是给将来自己写 @JavascriptInterface 时留的口子。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
