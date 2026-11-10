package ai.sixamtech.aios;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * 工作时段追踪期间的前台服务。**它自己不定位** —— 定位在 LocationTrackerPlugin 里,
 * 这个服务只负责让进程在息屏/后台时活着,并让「你正在被定位」这件事一直看得见。
 *
 * ★为什么要它:Android 8 起后台定位被限频到每小时几次,Android 10 起没有前台服务
 *   基本拿不到后台位置,国产 ROM 还会直接冻结进程。没有它,安卓的轨迹在息屏那一刻就断了,
 *   而服务端会把「没有上报」判成失联并给管理者发预警(见插件头注)。
 *
 * ★那条常驻通知是**特性不是噪音**:员工必须知道自己此刻在被定位。与 iOS 侧刻意打开
 *   状态栏蓝条(showsBackgroundLocationIndicator)是同一个决定。文案写清楚「下班打卡后自动停止」,
 *   让人知道它什么时候会结束 —— 否则会被当成偷偷跟踪。
 *
 * ★通知渠道单列一个(不复用推送渠道):用户可以单独把推送静音而不影响这条,反之亦然;
 *   而且这条必须是 LOW 而不是 MIN —— MIN 在部分 ROM 上会被折叠进「后台运行」聚合条目里,
 *   等于又看不见了。
 */
public class LocationForegroundService extends Service {

    private static final String CHANNEL_ID = "attendance_tracking";
    private static final int NOTIFICATION_ID = 4101;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel(this);
        Notification notification = build(this);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 10+ 必须声明前台服务类型,否则 startForeground 抛
            // SecurityException / ForegroundServiceTypeException(14+),表现为服务起不来、轨迹照样断。
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        // START_STICKY:被系统回收后尽量拉回来。★但**不**在这里自己恢复定位 ——
        // 该不该追踪由服务端说了算(H5 的 syncAttendanceTracking 会在下次进页面时校准),
        // 服务自作主张续上,就可能在员工已经下班之后还在采位置。
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // 不给别的组件绑,纯保活
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "工作时段位置记录", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("上班打卡后记录工作轨迹,下班打卡后自动停止");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private static Notification build(Context ctx) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle("工作轨迹记录中")
            .setContentText("下班打卡后自动停止")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true) // 不可滑动清除:清掉了服务就没了,轨迹又断
            .setShowWhen(false)
            .setContentIntent(pi)
            .build();
    }
}
