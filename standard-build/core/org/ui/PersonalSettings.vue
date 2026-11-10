<script setup lang="ts">
// core/org/ui/PersonalSettings.vue — 个人设置(每个人管自己的那一份)。
//
// 四块:头像 / 修改密码 / 企业邮箱 / 移动端扫码登录(2026-08-25 加,组件在 ./MobileQrLogin.vue)。后两块是从 App.vue 右上角账号菜单的两个弹窗**搬过来**的
// (2026-08-16):账号菜单里塞表单是个死角 —— 手机上下拉菜单本来就难点,弹窗里再套「高级设置」
// 就更没人找得到。菜单现在只留一个「个人设置」跳到这里,加退出登录。
//
// ★这一页刻意**不设权限码**(nav-permission-guard 的 UNGATED 白名单里有它):
//   「能不能改自己的头像/密码/邮箱」立不成一个权限点,挡住它等于让人改不了自己的密码。
//   后端三个口子(POST/DELETE /api/me/avatar、POST /api/me/change-password、/api/my-mailbox)
//   全部只认当前登录人,不接受 employeeId —— 越权在服务端就不成立,不靠这一页的可见性。
//
// ★头像:**没设过就是没有**,显示姓名首字 + 种子底色。不按 id 从数字人图库挑一张顶上
//   (那是 src/avatars.ts,数字员工专用)。见 modules/messenger/ui/MessengerPage.vue 文件头。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { ImageUp, Trash2, UserRound } from '@lucide/vue'
import AsyncState from '../../ui-kit/AsyncState.vue'
import MobileQrLogin from './MobileQrLogin.vue'
import FormField from '../../ui-kit/FormField.vue'
import { compressImage } from '../../../src/image-compress'
import {
  API_CLIENT_VERSION,
  apiChangeOwnPassword,
  apiClearMyAvatar,
  apiDeleteMyMailbox,
  apiGetMyMailbox,
  apiMe,
  apiSaveMyMailbox,
  apiTestMyMailbox,
  apiUploadMyAvatar,
  errorMessage,
} from '../../../src/api/client'

const queryClient = useQueryClient()

// ── 我的资料(头像在这份数据里)──────────────────────────────────────────────
const meQuery = useQuery({ queryKey: ['me', 'profile', API_CLIENT_VERSION], queryFn: apiMe })
const me = computed(() => meQuery.data.value ?? null)
const initials = computed(() => (me.value?.name ?? '').slice(0, 2))
// 头像底色:与消息页/通讯录同一套五行小函数(同一个人到哪都是同一个颜色)
const AVATAR_VARS = ['--sb-avatar-1', '--sb-avatar-2', '--sb-avatar-3', '--sb-avatar-4', '--sb-avatar-5', '--sb-avatar-6']
const avatarBg = computed(() => {
  const seed = me.value?.id ?? ''
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return `var(${AVATAR_VARS[Math.abs(h) % AVATAR_VARS.length]})`
})

const avatarInput = ref<HTMLInputElement | null>(null)
const uploadingAvatar = ref(false)
function pickAvatar() {
  avatarInput.value?.click()
}
async function onAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 先清,否则连传同一张不会再触发 change
  if (!file) return
  uploadingAvatar.value = true
  try {
    // 手机拍/选的原图是 4–8MB,直传必被 2MB 上限拒掉;压缩同时按 EXIF 摆正(见 src/image-compress.ts)
    await apiUploadMyAvatar(await compressImage(file))
    ElMessage.success('头像已更新')
    await refreshAvatarEverywhere()
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    uploadingAvatar.value = false
  }
}
const clearAvatarMutation = useMutation({
  mutationFn: apiClearMyAvatar,
  onSuccess: async () => {
    ElMessage.success('已移除头像')
    await refreshAvatarEverywhere()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
/**
 * 头像变了要把**别处**也刷掉:消息列表、会话详情、通讯录 picker 各自缓存着一份头像地址,
 * 只刷本页的话,切到消息页还是旧的(而且用户会以为没保存成功)。
 */
async function refreshAvatarEverywhere() {
  await meQuery.refetch()
  // key 前缀匹配即可(TanStack 默认),不用把 API_CLIENT_VERSION 那一段也写出来
  for (const key of [['org-emp-picker'], ['messenger-emp-picker'], ['messenger-conversations'], ['messenger-conv']]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

// ── 修改密码(原 App.vue 账号菜单弹窗)────────────────────────────────────────
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
const pwdErrors = ref<Record<string, string>>({})
const changePasswordMutation = useMutation({
  mutationFn: () => apiChangeOwnPassword({ oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword }),
  onSuccess: () => {
    ElMessage.success('密码已修改')
    pwdForm.oldPassword = ''
    pwdForm.newPassword = ''
    pwdForm.confirmPassword = ''
  },
  onError: (e) => {
    // 原密码错误:定位到「原密码」字段;其余弹全局错误提示
    if ((e as { code?: string }).code === 'WRONG_PASSWORD') pwdErrors.value = { oldPassword: errorMessage(e) }
    else ElMessage.error(errorMessage(e))
  },
})
function submitChangePassword() {
  pwdErrors.value = {}
  if (!pwdForm.oldPassword) pwdErrors.value.oldPassword = '请输入原密码'
  if (pwdForm.newPassword.length < 8) pwdErrors.value.newPassword = '新密码至少 8 位'
  else if (pwdForm.newPassword === pwdForm.oldPassword) pwdErrors.value.newPassword = '新密码不能与原密码相同'
  if (pwdForm.confirmPassword !== pwdForm.newPassword) pwdErrors.value.confirmPassword = '两次输入不一致'
  if (Object.keys(pwdErrors.value).length > 0) return
  changePasswordMutation.mutate()
}

// ── 企业邮箱(原 App.vue 账号菜单弹窗)────────────────────────────────────────
// 员工自助配置自己的企业邮箱(地址 + 授权密码;服务器按域名自动带出可手改)。
// 用于在线索页与客户邮件收发。授权密码留空=不修改;后端只加密存、不回显。
const mailboxAdvanced = ref(false)
const mailboxForm = reactive({
  emailAddress: '',
  authPassword: '',
  displayName: '',
  imapHost: '',
  imapPort: 993,
  imapUseTls: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  enabled: true,
})
const mailboxHasAccount = ref(false)
const mailboxHasPassword = ref(false)
const mailboxLastError = ref<string | null>(null)
const mailboxQuery = useQuery({ queryKey: ['my-mailbox'], queryFn: apiGetMyMailbox })
watch(
  () => mailboxQuery.data.value,
  (data) => {
    const a = data?.account
    mailboxHasAccount.value = !!a
    mailboxHasPassword.value = !!a?.hasAuthPassword
    mailboxLastError.value = a?.lastError ?? null
    if (a) {
      mailboxForm.emailAddress = a.emailAddress
      mailboxForm.displayName = a.displayName ?? ''
      mailboxForm.imapHost = a.imapHost
      mailboxForm.imapPort = a.imapPort
      mailboxForm.imapUseTls = a.imapUseTls
      mailboxForm.smtpHost = a.smtpHost
      mailboxForm.smtpPort = a.smtpPort
      mailboxForm.smtpSecure = a.smtpSecure
      mailboxForm.enabled = a.enabled
    }
  },
  { immediate: true },
)
const saveMailboxMutation = useMutation({
  mutationFn: () =>
    apiSaveMyMailbox({
      emailAddress: mailboxForm.emailAddress.trim(),
      authPassword: mailboxForm.authPassword ? mailboxForm.authPassword : undefined,
      displayName: mailboxForm.displayName.trim() || null,
      // 高级设置留空则后端按域名自动带出
      imapHost: mailboxForm.imapHost.trim() || undefined,
      imapPort: mailboxForm.imapPort,
      imapUseTls: mailboxForm.imapUseTls,
      smtpHost: mailboxForm.smtpHost.trim() || undefined,
      smtpPort: mailboxForm.smtpPort,
      smtpSecure: mailboxForm.smtpSecure,
      enabled: mailboxForm.enabled,
    }),
  onSuccess: () => {
    ElMessage.success('邮箱配置已保存')
    mailboxForm.authPassword = ''
    queryClient.invalidateQueries({ queryKey: ['my-mailbox'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
const testMailboxMutation = useMutation({
  mutationFn: apiTestMyMailbox,
  onSuccess: () => ElMessage.success('收发连接测试通过'),
  onError: (e) => ElMessage.error(errorMessage(e)),
})
const deleteMailboxMutation = useMutation({
  mutationFn: apiDeleteMyMailbox,
  onSuccess: () => {
    ElMessage.success('已清除邮箱配置')
    mailboxHasAccount.value = false
    mailboxHasPassword.value = false
    mailboxForm.emailAddress = ''
    mailboxForm.authPassword = ''
    queryClient.invalidateQueries({ queryKey: ['my-mailbox'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
function submitMailbox() {
  if (!mailboxForm.emailAddress.trim()) return ElMessage.warning('请填写企业邮箱地址')
  if (!mailboxHasPassword.value && !mailboxForm.authPassword) return ElMessage.warning('首次配置请填写邮箱授权密码')
  saveMailboxMutation.mutate()
}
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">你自己的账号设置——头像、登录密码、手机扫码登录、企业邮箱。只作用于你本人。</p>
    </div>

    <!-- ① 个人资料 -->
    <AsyncState
      :loading="meQuery.isLoading.value"
      :error="meQuery.error.value ? errorMessage(meQuery.error.value) : null"
      :empty="false"
      @retry="meQuery.refetch"
    >
      <section class="panel settings-panel">
        <div class="panel-toolbar"><h2 class="panel-title">个人资料</h2></div>

        <FormField label="头像">
          <div class="ps-avatar-row">
            <span class="ps-avatar" :style="{ background: me?.avatarUrl ? 'transparent' : avatarBg }">
              <!-- 没设过头像就露出姓名首字;系统不替任何人挑一张 -->
              <img v-if="me?.avatarUrl" class="ps-avatar__img" :src="me.avatarUrl" alt="我的头像" />
              <span v-else-if="initials" class="ps-avatar__ini">{{ initials }}</span>
              <UserRound v-else :size="32" />
            </span>
            <div class="ps-avatar__acts">
              <el-button :icon="ImageUp" :loading="uploadingAvatar" @click="pickAvatar">
                {{ me?.avatarUrl ? '更换头像' : '上传头像' }}
              </el-button>
              <el-button
                v-if="me?.avatarUrl"
                text
                :icon="Trash2"
                :loading="clearAvatarMutation.isPending.value"
                @click="clearAvatarMutation.mutate()"
              >移除</el-button>
              <input
                ref="avatarInput"
                class="sr-only-file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                @change="onAvatarChange"
              />
            </div>
          </div>
          <p class="t-caption muted">
            支持 PNG/JPG/WEBP/GIF,不超过 2MB(手机照片会自动压缩)。不设头像就显示你姓名的前两个字——
            系统不会替你分配头像。
          </p>
        </FormField>

        <FormField label="姓名"><el-input :model-value="me?.name ?? ''" disabled /></FormField>
        <FormField label="手机号(登录名)"><el-input :model-value="me?.phone ?? ''" disabled /></FormField>
        <FormField label="工号"><el-input :model-value="me?.empNo ?? ''" disabled /></FormField>
        <p class="t-caption muted">姓名、手机号、工号、部门由管理员在「组织及账号管理」维护。</p>
      </section>
    </AsyncState>

    <!-- ② 移动端扫码登录(整块在 ./MobileQrLogin.vue —— 它自带弹窗、轮询与设备台账,
         塞进本页只会让这个已经 400 行的文件更难读) -->
    <MobileQrLogin />

    <!-- ③ 修改密码 -->
    <section class="panel settings-panel">
      <div class="panel-toolbar"><h2 class="panel-title">修改密码</h2></div>
      <div class="pwd-form">
        <label class="pwd-field">
          <span class="pwd-field__label">原密码</span>
          <el-input v-model="pwdForm.oldPassword" type="password" show-password autocomplete="current-password" placeholder="请输入当前密码" @keyup.enter="submitChangePassword" />
          <span v-if="pwdErrors.oldPassword" class="pwd-field__err">{{ pwdErrors.oldPassword }}</span>
        </label>
        <label class="pwd-field">
          <span class="pwd-field__label">新密码</span>
          <el-input v-model="pwdForm.newPassword" type="password" show-password autocomplete="new-password" placeholder="至少 8 位" @keyup.enter="submitChangePassword" />
          <span v-if="pwdErrors.newPassword" class="pwd-field__err">{{ pwdErrors.newPassword }}</span>
        </label>
        <label class="pwd-field">
          <span class="pwd-field__label">确认新密码</span>
          <el-input v-model="pwdForm.confirmPassword" type="password" show-password autocomplete="new-password" placeholder="再次输入新密码" @keyup.enter="submitChangePassword" />
          <span v-if="pwdErrors.confirmPassword" class="pwd-field__err">{{ pwdErrors.confirmPassword }}</span>
        </label>
      </div>
      <div class="form-actions">
        <el-button type="primary" :loading="changePasswordMutation.isPending.value" @click="submitChangePassword">修改密码</el-button>
      </div>
    </section>

    <!-- ④ 企业邮箱 -->
    <AsyncState
      :loading="mailboxQuery.isLoading.value"
      :error="mailboxQuery.error.value ? errorMessage(mailboxQuery.error.value) : null"
      :empty="false"
      @retry="mailboxQuery.refetch"
    >
      <section class="panel settings-panel">
        <div class="panel-toolbar"><h2 class="panel-title">企业邮箱</h2></div>
        <el-alert type="info" :closable="false" show-icon class="mailbox-hint">
          配置你的企业邮箱后,即可在「线索」详情里与客户邮件往来、AI 起草回复、接收客户回信。授权密码即企业邮箱的「客户端授权码/专用密码」。
        </el-alert>
        <el-alert v-if="mailboxLastError" type="warning" :closable="false" show-icon class="mailbox-hint">
          上次收发报错:{{ mailboxLastError }}
        </el-alert>
        <div class="pwd-form">
          <label class="pwd-field">
            <span class="pwd-field__label">企业邮箱地址</span>
            <el-input v-model="mailboxForm.emailAddress" placeholder="name@company.com" autocomplete="email" />
          </label>
          <label class="pwd-field">
            <span class="pwd-field__label">授权密码{{ mailboxHasPassword ? '(已配置,留空则不修改)' : '' }}</span>
            <el-input v-model="mailboxForm.authPassword" type="password" show-password autocomplete="off" :placeholder="mailboxHasPassword ? '留空保留原授权密码' : '企业邮箱客户端授权码/专用密码'" />
          </label>
          <label class="pwd-field">
            <span class="pwd-field__label">发件人显示名(选填)</span>
            <el-input v-model="mailboxForm.displayName" placeholder="留空则用你的姓名" />
          </label>
          <label class="pwd-field pwd-field--row">
            <span class="pwd-field__label">启用</span>
            <el-switch v-model="mailboxForm.enabled" />
          </label>
          <el-link type="primary" :underline="false" class="mailbox-adv-toggle" @click="mailboxAdvanced = !mailboxAdvanced">
            {{ mailboxAdvanced ? '收起高级设置' : '高级设置(服务器地址,通常自动识别无需填写)' }}
          </el-link>
          <template v-if="mailboxAdvanced">
            <label class="pwd-field">
              <span class="pwd-field__label">IMAP 收件服务器</span>
              <div class="mailbox-server-row">
                <el-input v-model="mailboxForm.imapHost" placeholder="留空自动识别,如 imap.exmail.qq.com" />
                <el-input-number v-model="mailboxForm.imapPort" :min="1" :max="65535" controls-position="right" />
                <el-checkbox v-model="mailboxForm.imapUseTls">SSL</el-checkbox>
              </div>
            </label>
            <label class="pwd-field">
              <span class="pwd-field__label">SMTP 发件服务器</span>
              <div class="mailbox-server-row">
                <el-input v-model="mailboxForm.smtpHost" placeholder="留空自动识别,如 smtp.exmail.qq.com" />
                <el-input-number v-model="mailboxForm.smtpPort" :min="1" :max="65535" controls-position="right" />
                <el-checkbox v-model="mailboxForm.smtpSecure">SSL</el-checkbox>
              </div>
            </label>
          </template>
        </div>
        <div class="form-actions">
          <el-button type="primary" :loading="saveMailboxMutation.isPending.value" @click="submitMailbox">保存</el-button>
          <el-button :disabled="!mailboxHasAccount" :loading="testMailboxMutation.isPending.value" @click="testMailboxMutation.mutate()">测试连接</el-button>
          <el-button v-if="mailboxHasAccount" type="danger" plain :loading="deleteMailboxMutation.isPending.value" @click="deleteMailboxMutation.mutate()">清除配置</el-button>
        </div>
      </section>
    </AsyncState>
  </section>
</template>

<style scoped>
.settings-panel {
  max-width: 640px;
}
.settings-panel + .settings-panel,
.sb-state + .settings-panel,
.settings-panel + .sb-state,
.sb-state + .sb-state {
  margin-top: var(--sb-space-4);
}
.sr-only-file {
  display: none;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sb-space-2);
  margin-top: var(--sb-space-5);
}
.ps-avatar-row {
  display: flex;
  align-items: center;
  gap: var(--sb-space-4);
  flex-wrap: wrap;
}
/* 头像:与消息页同构(底色 + 图盖首字);这里是唯一能改它的地方,所以给得大一点 */
.ps-avatar {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  border-radius: 20px;
  overflow: hidden;
  color: #fff;
  font-size: var(--sb-font-xl);
  font-weight: 600;
}
.ps-avatar__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ps-avatar__acts {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  flex-wrap: wrap;
}
</style>
