<script setup lang="ts">
// modules/inapp-notify/ui/PushSelfTest.vue
// 手机推送自检:一个按钮 + 一行诊断。铃铛面板底部与通知整页底部共用同一份。
//
// 为什么值得单独存在:推送链路有四段(服务器凭据 / 设备登记 / 服务器到 APNs 可达 / 手机通知权限),
// 任一段断了现象**一模一样**——「什么都没发生」。没有这两行,「收不到推送」只能逐段猜。
// 所以提示按段分开写,不要笼统说「失败」——那样等于没说,客户还是不知道该找谁。
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { apiTestPush, errorMessage } from '../../../src/api/client'
import { isNativeShell, pushDiagnostic } from '../../../src/native-app'

const inApp = isNativeShell()
const testing = ref(false)

async function testPush() {
  testing.value = true
  try {
    const r = await apiTestPush()
    if (!r.configured) ElMessage.warning('本系统还没配手机推送凭据,请联系管理员')
    // ★「登记了但通道未接」必须与「没登记」分开说:安卓设备现在一律登记成 fcm(壳侧厂商 SDK 未接),
    //   过滤后 devices=0 —— 旧文案会说「你还没有登记手机,请在 App 里登录一次」,
    //   而人家明明登录了、诊断行还写着「已登记 ✓」。两句自相矛盾会把排查带向完全错误的方向。
    else if (r.devices === 0 && r.unsupportedDevices > 0)
      ElMessage.warning(`已登记 ${r.unsupportedDevices} 台安卓设备,但厂商推送通道尚未接入,暂时收不到横幅(iPhone 不受影响)`)
    else if (r.devices === 0) ElMessage.warning('你还没有登记手机:请在手机 App 里登录一次,并允许通知')
    else if (r.sent === 0) ElMessage.error(`已登记 ${r.devices} 台设备,但一台都没发出去(服务器到 Apple 的网络或推送环境配置有问题)`)
    else ElMessage.success(`已发往 ${r.sent} 台设备,请看手机(App 在前台时 iOS 不显示横幅,需切后台或锁屏)`)
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="push-selftest">
    <button type="button" class="push-selftest__btn" :disabled="testing" @click="testPush">
      {{ testing ? '发送中…' : '测试手机推送' }}
    </button>
    <!-- 本机推送注册走到哪一步。★浏览器里也显示(写明「不在 App 内」)—— 之前做成只在 App 内出现,
         结果是「点测试」在电脑、「看诊断」要在手机,来回切屏还容易误以为没部署上。 -->
    <p class="push-selftest__diag">
      本机推送:{{ inApp ? pushDiagnostic : '当前不在 App 内(浏览器不接收推送,请在手机 App 里看这行)' }}
    </p>
  </div>
</template>

<style scoped>
/* 低调的次要入口,别和通知内容抢注意力 */
.push-selftest {
  text-align: center;
}
.push-selftest__btn {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.push-selftest__btn:hover:not(:disabled) {
  color: var(--sb-color-primary);
  text-decoration: underline;
}
.push-selftest__btn:disabled { opacity: 0.5; cursor: default; }
/* 触屏:11px 字的裸文字按钮点不准,垫出触控面(视觉不变,padding 不带背景) */
@media (any-pointer: coarse) {
  .push-selftest__btn { padding: var(--sb-space-2) var(--sb-space-3); }
}
.push-selftest__diag {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--sb-text-tertiary);
  word-break: break-all;
}
</style>
