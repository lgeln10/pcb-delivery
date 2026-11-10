<script setup lang="ts">
// core/org/ui/MobileQrLogin.vue — 「移动端扫码登录」:电脑出示一张动态二维码,手机 App 扫码,
// **回到电脑上按一次确认**,手机就拿到一枚 3 个月的登录令牌。
//
// ★方向与微信那种扫码登录相反:那边是手机(可信认证器)给网页发会话;这里是已经登录的电脑
//   把自己的身份授出去。所以威胁不是钓鱼网站,而是**别人看到了你这块屏幕** ——
//   拍照、投屏、录屏、会议共享。完整威胁模型与四道闸写在 core/auth/qr-login.ts 的文件头。
//
// ★这一页只负责「显示 + 确认」。真正的闸全在服务端:
//   码里没有任何凭据(只有一次性随机票)、票 2 分钟就死、必须 scanned→approved 才签令牌、
//   兑换一次性。前端把哪一步画错都不会削弱它们。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { ElMessage } from 'element-plus'
import { Smartphone, RefreshCw } from '@lucide/vue'
import {
  apiCreateQrTicket,
  apiDecideQrTicket,
  apiListLoginDevices,
  apiQrTicketStatus,
  apiRevokeLoginDevice,
  errorMessage,
  type LoginDeviceDTO,
  type QrScanDeviceDTO,
} from '../../../src/api/client'
import { onQrLoginRequest, takeQrLoginRequest } from './qr-login-open'

/** 轮询周期。★不能太快 —— 服务端那个端点有配额;也不能太慢,人扫完在等确认框弹出来。 */
const POLL_MS = 1500

const open = ref(false)
const qrDataUrl = ref('')
const ticket = ref('')
const phase = ref<'loading' | 'waiting' | 'scanned' | 'done' | 'rejected' | 'expired' | 'error'>('loading')
const scanned = ref<QrScanDeviceDTO | null>(null)
const failMsg = ref('')
const deciding = ref(false)

/** 手机要访问的地址。★就是这台电脑打开本站用的那个地址 —— 手机连不上它,扫了也没用。 */
const serverOrigin = computed(() => window.location.origin)

let pollTimer: ReturnType<typeof setInterval> | null = null
let rotateTimer: ReturnType<typeof setTimeout> | null = null

function stopTimers(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (rotateTimer) { clearTimeout(rotateTimer); rotateTimer = null }
}

/**
 * 二维码里装什么。★只有一次性票和地址,没有任何凭据 ——
 * 拍下这张图的人拿到的是一张 2 分钟后就作废、且还需要我在这台电脑上点确认的纸条。
 * 手机侧的解析在 mobile-app/shell/app.js 的 parseScan()(改这里两边一起改)。
 */
function payloadOf(t: string): string {
  return JSON.stringify({ v: 1, t: 'aios-qr-login', server: serverOrigin.value, ticket: t })
}

async function newTicket(): Promise<void> {
  stopTimers()
  phase.value = 'loading'
  scanned.value = null
  try {
    const r = await apiCreateQrTicket()
    ticket.value = r.ticket
    qrDataUrl.value = await QRCode.toDataURL(payloadOf(r.ticket), { width: 240, margin: 1 })
    phase.value = 'waiting'
    pollTimer = setInterval(() => void poll(), POLL_MS)
    // ★到点自动换新码。rotateAfterMs 由服务端给,且服务端保证它小于票的有效期 ——
    //   前端自己算的话,两边一改就会出现「手里这张已经死了但还在显示」的窗口。
    rotateTimer = setTimeout(() => { if (open.value && phase.value === 'waiting') void newTicket() }, r.rotateAfterMs)
  } catch (e) {
    phase.value = 'error'
    failMsg.value = errorMessage(e)
  }
}

async function poll(): Promise<void> {
  if (!ticket.value || !open.value) return
  try {
    const s = await apiQrTicketStatus(ticket.value)
    if (s.status === 'scanned' && s.device) {
      scanned.value = s.device
      phase.value = 'scanned'
      stopTimers() // 有人在等你按确认,这时候换码等于把他的票作废
    } else if (s.status === 'consumed') {
      phase.value = 'done'
      stopTimers()
      void devices.refresh()
    } else if (s.status === 'rejected') {
      phase.value = 'rejected'
      stopTimers()
    } else if (s.status === 'expired') {
      phase.value = 'expired'
      stopTimers()
    }
  } catch {
    /* 轮询失败不打断:下一次继续。网络抖一下不该把二维码判死 */
  }
}

async function decide(approve: boolean): Promise<void> {
  deciding.value = true
  try {
    const r = await apiDecideQrTicket(ticket.value, approve)
    if (!r.ok) {
      // 后端只认 scanned→approved。走到这儿多半是票已过期(顺延窗口也用完了)
      phase.value = 'expired'
      return
    }
    if (approve) {
      // 批准之后手机还要来兑换一次,所以继续轮到 consumed 才算真的登上了
      phase.value = 'waiting'
      pollTimer = setInterval(() => void poll(), POLL_MS)
    } else {
      phase.value = 'rejected'
    }
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    deciding.value = false
  }
}

function start(): void {
  open.value = true
  void newTicket()
}

/**
 * 关窗。★如果此刻正卡在「有设备在等确认」,**关窗视同拒绝** ——
 * 留着不管的话那张票还有 90 秒的确认窗口,而人已经离开这块屏幕了。
 */
function onClosed(): void {
  stopTimers()
  if (phase.value === 'scanned' && ticket.value) void apiDecideQrTicket(ticket.value, false).catch(() => {})
  ticket.value = ''
  qrDataUrl.value = ''
  scanned.value = null
}

watch(open, (v) => { if (!v) onClosed() })
onBeforeUnmount(onClosed)

// 右上角账号菜单里的「扫码登录移动端」捷径:跳到本页后**直接把码亮出来**,
// 不用再在页面上找一次「显示二维码」。为什么要两条路(便条 + 事件)见 ./qr-login-open.ts。
onMounted(() => { if (takeQrLoginRequest()) start() })
const stopQrShortcut = onQrLoginRequest(() => { takeQrLoginRequest(); start() })
onBeforeUnmount(stopQrShortcut)

// ── 我的登录设备 ─────────────────────────────────────────────────────────────
const devices = (() => {
  const rows = ref<LoginDeviceDTO[]>([])
  const loading = ref(false)
  const err = ref('')
  async function refresh(): Promise<void> {
    loading.value = true
    err.value = ''
    try {
      rows.value = (await apiListLoginDevices()).devices
    } catch (e) {
      err.value = errorMessage(e)
    } finally {
      loading.value = false
    }
  }
  return { rows, loading, err, refresh }
})()
void devices.refresh()

const revoking = ref('')
async function revoke(d: LoginDeviceDTO): Promise<void> {
  revoking.value = d.jti
  try {
    await apiRevokeLoginDevice(d.jti)
    ElMessage.success(`已下线「${d.label}」`)
    await devices.refresh()
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    revoking.value = ''
  }
}

function fmt(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="panel settings-panel">
    <div class="panel-toolbar"><h2 class="panel-title">移动端扫码登录</h2></div>

    <el-alert type="info" :closable="false" show-icon class="qr-hint">
      用手机 App 扫这台电脑上的二维码,就能以你的身份登录,不用再输一次密码。扫完需要你在这台电脑上再点一次确认 —— 这样别人拍下屏幕也登不进去。登录后可保持 3 个月。
    </el-alert>

    <div class="qr-actions">
      <el-button type="primary" :icon="Smartphone" @click="start">显示二维码</el-button>
      <span class="qr-origin">手机需要能访问:{{ serverOrigin }}</span>
    </div>

    <!-- 我的登录设备 -->
    <div class="qr-devices">
      <div class="qr-devices__head">
        <h3 class="qr-devices__title">我的登录设备</h3>
        <el-button link :icon="RefreshCw" :loading="devices.loading.value" @click="devices.refresh()">刷新</el-button>
      </div>
      <p v-if="devices.err.value" class="qr-devices__err">{{ devices.err.value }}</p>
      <p v-else-if="!devices.rows.value.length" class="qr-devices__empty">还没有用扫码登录过的手机。</p>
      <ul v-else class="qr-devices__list">
        <li v-for="d in devices.rows.value" :key="d.jti" class="qr-device">
          <div class="qr-device__main">
            <span class="qr-device__label">{{ d.label }}</span>
            <el-tag v-if="d.current" size="small" type="success">当前设备</el-tag>
          </div>
          <div class="qr-device__meta">
            {{ d.platform }}<template v-if="d.appVersion"> · App {{ d.appVersion }}</template>
            · 登录于 {{ fmt(d.issuedAt) }} · 到期 {{ fmt(d.expiresAt) }}
          </div>
          <el-popconfirm title="下线这台设备?它需要重新扫码登录。" confirm-button-text="下线" @confirm="revoke(d)">
            <template #reference>
              <el-button size="small" type="danger" plain :loading="revoking === d.jti">下线</el-button>
            </template>
          </el-popconfirm>
        </li>
      </ul>
    </div>

    <el-dialog v-model="open" title="扫码登录移动端" width="380px" align-center>
      <div class="qr-box">
        <template v-if="phase === 'loading'">
          <p class="qr-box__msg">正在生成二维码…</p>
        </template>

        <template v-else-if="phase === 'waiting'">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="扫码登录二维码" class="qr-box__img" />
          <p class="qr-box__msg">用 App 首页的扫码按钮扫描</p>
          <p class="qr-box__sub">二维码会自动刷新;扫完请回到这里点确认</p>
        </template>

        <!-- ★这一屏是整套设计的主闸:显示是**哪台设备**在扫,让人有机会说不。 -->
        <template v-else-if="phase === 'scanned'">
          <p class="qr-box__title">有设备正在请求登录</p>
          <dl class="qr-scan">
            <div><dt>设备</dt><dd>{{ scanned?.label }}</dd></div>
            <div><dt>系统</dt><dd>{{ scanned?.platform }}</dd></div>
            <div v-if="scanned?.ip"><dt>来源 IP</dt><dd>{{ scanned.ip }}</dd></div>
            <div><dt>时间</dt><dd>{{ scanned ? fmt(scanned.scannedAt) : '' }}</dd></div>
          </dl>
          <p class="qr-box__sub qr-box__sub--warn">不是你本人操作的话,请点「不是我」。</p>
          <div class="qr-box__acts">
            <el-button :loading="deciding" @click="decide(false)">不是我</el-button>
            <el-button type="primary" :loading="deciding" @click="decide(true)">确认登录</el-button>
          </div>
        </template>

        <template v-else-if="phase === 'done'">
          <p class="qr-box__title">手机已登录</p>
          <p class="qr-box__sub">这台设备会出现在下面的「我的登录设备」里,登录状态保持 3 个月。</p>
          <div class="qr-box__acts"><el-button type="primary" @click="open = false">完成</el-button></div>
        </template>

        <template v-else-if="phase === 'rejected'">
          <p class="qr-box__title">已拒绝</p>
          <p class="qr-box__sub">那台设备没有登录。如果不是你操作的,建议顺手改一次密码。</p>
          <div class="qr-box__acts"><el-button @click="newTicket()">再来一次</el-button></div>
        </template>

        <template v-else-if="phase === 'expired'">
          <p class="qr-box__title">二维码已过期</p>
          <div class="qr-box__acts"><el-button type="primary" :icon="RefreshCw" @click="newTicket()">换一张</el-button></div>
        </template>

        <template v-else>
          <p class="qr-box__msg">{{ failMsg || '生成二维码失败' }}</p>
          <div class="qr-box__acts"><el-button @click="newTicket()">重试</el-button></div>
        </template>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.qr-hint { margin-bottom: 14px; }
.qr-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.qr-origin { font-size: 13px; color: var(--el-text-color-secondary); word-break: break-all; }

.qr-devices { margin-top: 22px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 14px; }
.qr-devices__head { display: flex; align-items: center; justify-content: space-between; }
.qr-devices__title { margin: 0; font-size: 15px; font-weight: 600; }
.qr-devices__empty, .qr-devices__err { margin: 8px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }
.qr-devices__err { color: var(--el-color-warning); }
.qr-devices__list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.qr-device {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'main act' 'meta act';
  gap: 2px 12px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
.qr-device__main { grid-area: main; display: flex; align-items: center; gap: 8px; }
.qr-device__label { font-weight: 500; }
.qr-device__meta { grid-area: meta; font-size: 12px; color: var(--el-text-color-secondary); }
.qr-device :deep(.el-popconfirm), .qr-device > :last-child { grid-area: act; }

.qr-box { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; }
.qr-box__img { width: 240px; height: 240px; image-rendering: pixelated; }
.qr-box__title { margin: 0; font-size: 16px; font-weight: 600; }
.qr-box__msg { margin: 24px 0; color: var(--el-text-color-secondary); }
.qr-box__sub { margin: 0; font-size: 13px; color: var(--el-text-color-secondary); }
.qr-box__sub--warn { color: var(--el-color-warning); }
.qr-box__acts { margin-top: 14px; display: flex; gap: 10px; }
.qr-scan { margin: 10px 0 4px; display: flex; flex-direction: column; gap: 6px; width: 100%; }
.qr-scan > div { display: flex; gap: 10px; font-size: 13px; }
.qr-scan dt { flex: 0 0 64px; text-align: right; color: var(--el-text-color-secondary); margin: 0; }
.qr-scan dd { margin: 0; text-align: left; word-break: break-all; }
</style>
