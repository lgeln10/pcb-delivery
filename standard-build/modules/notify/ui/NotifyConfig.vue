<script setup lang="ts">
// modules/notify/ui/NotifyConfig.vue
// 通知渠道配置:邮件(SMTP)+ 飞书群机器人(webhook)+ 企业IM主机器人(im-connect 自建应用外发)。
// 每个渠道一张子标签卡片(el-tabs[border-card])。套 UI_SPEC 设置页 recipe,五态齐全(AsyncState)。
// ★企业IM主机器人:凭证/回调/身份绑定在「企业IM接入」页配置,本页只读三平台状态 + 控制各平台是否作为通知渠道启用
//   (开关直接写 im-connect 的平台 enabled,与「企业IM接入」同一数据源;切 enabled 时密钥传占位符沿用原值)。
import { reactive, ref, computed, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Mail, SendHorizontal, MessageSquare, Bot } from '@lucide/vue'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import FormField from '../../../core/ui-kit/FormField.vue'
import {
  apiGetEmailConfig, apiMyPermissions, apiSaveEmailConfig, apiTestEmail,
  apiGetFeishuConfig, apiSaveFeishuConfig, apiTestFeishu,
  apiGetImConfig, apiSaveImConfig, IM_SECRET_PLACEHOLDER,
  NOTIFY_SECRET_PLACEHOLDER,
  type EmailConfigDTO,
  type FeishuConfigDTO,
  type ImConfigDTO,
  type ImPlatform,
  type SaveImInput,
  errorMessage, isForbidden,
} from '../../../src/api/client'

const queryClient = useQueryClient()

const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canConfig = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('notify:config')) })
// 企业IM主机器人开关写的是 im-connect 平台 enabled → 需 im-connect:config 权限
const canConfigIm = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('im-connect:config')) })

// 子标签:每个渠道一张卡片
const activeChannel = ref('email')

const query = useQuery({
  queryKey: ['notify', 'email-config'],
  queryFn: apiGetEmailConfig,
})
const cfg = computed(() => query.data.value)

// ── 邮件配置表单 ──────────────────────────────────────────────────────────
const draft = reactive({
  enabled: false,
  host: '',
  port: 465,
  secure: true,
  user: '',
  pass: '',
  fromName: '',
  fromAddress: '',
})
// 密码框是否被用户改过:未改则提交占位符(沿用原密码)。
const passTouched = ref(false)

watch(cfg, (v) => {
  if (!v) return
  draft.enabled = v.enabled
  draft.host = v.host
  draft.port = v.port
  draft.secure = v.secure
  draft.user = v.user
  draft.fromName = v.fromName
  draft.fromAddress = v.fromAddress
  draft.pass = ''
  passTouched.value = false
}, { immediate: true })

const passPlaceholder = computed(() =>
  cfg.value?.passSet ? '已配置,输入新值可替换(留空沿用原密码)' : '输入 SMTP 密码 / 授权码',
)

const saveMutation = useMutation({
  mutationFn: () => apiSaveEmailConfig({
    enabled: cfg.value?.enabled ?? false,
    host: draft.host,
    port: draft.port,
    secure: draft.secure,
    user: draft.user,
    // 用户没动密码且已存过 → 传占位符沿用;否则传输入值
    pass: passTouched.value || !cfg.value?.passSet ? draft.pass : NOTIFY_SECRET_PLACEHOLDER,
    fromName: draft.fromName,
    fromAddress: draft.fromAddress,
  }),
  onSuccess: async (data: EmailConfigDTO) => {
    ElMessage.success('邮件配置已保存')
    await queryClient.setQueryData(['notify', 'email-config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 启用开关即时生效(与下方 IM 平台行同款):拨了就算数,输入框才需要点保存 ──────────
// ★只带服务端**已保存**的其余字段,不带 draft —— 否则会把还没点保存的 SMTP 草稿一起提交。
const toggleEmailMutation = useMutation({
  mutationFn: (next: boolean) => {
    const v = cfg.value
    return apiSaveEmailConfig({
      enabled: next,
      host: v?.host ?? '',
      port: v?.port ?? 465,
      secure: v?.secure ?? true,
      user: v?.user ?? '',
      pass: NOTIFY_SECRET_PLACEHOLDER, // 沿用已存密码
      fromName: v?.fromName ?? '',
      fromAddress: v?.fromAddress ?? '',
    })
  },
  onSuccess: async (data: EmailConfigDTO) => {
    ElMessage.success(`邮件通知已${data.enabled ? '启用' : '停用'}`)
    await queryClient.setQueryData(['notify', 'email-config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const testMutation = useMutation({
  mutationFn: apiTestEmail,
  onSuccess: () => ElMessage.success('测试邮件已发送,请查收发件账号邮箱'),
  onError: (e) => ElMessage.error(errorMessage(e)),
})

function onPortPreset(secure: boolean) {
  draft.secure = secure
  draft.port = secure ? 465 : 587
}

// ── 飞书(群自定义机器人 webhook)配置 ──────────────────────────────────────
const feishuQuery = useQuery({
  queryKey: ['notify', 'feishu-config'],
  queryFn: apiGetFeishuConfig,
})
const fsCfg = computed(() => feishuQuery.data.value)

const fsDraft = reactive({ enabled: false, webhookUrl: '', secret: '' })
const fsWebhookTouched = ref(false)
const fsSecretTouched = ref(false)

watch(fsCfg, (v) => {
  if (!v) return
  fsDraft.enabled = v.enabled
  fsDraft.webhookUrl = ''
  fsDraft.secret = ''
  fsWebhookTouched.value = false
  fsSecretTouched.value = false
}, { immediate: true })

const fsWebhookPlaceholder = computed(() =>
  fsCfg.value?.webhookSet ? `已配置(${fsCfg.value.webhookHint}),输入新地址可替换` : 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxx',
)
const fsSecretPlaceholder = computed(() =>
  fsCfg.value?.secretSet ? '已开启加签,输入新值可替换(留空保持原样)' : '可选:群机器人「加签」密钥',
)

const fsSaveMutation = useMutation({
  mutationFn: () => apiSaveFeishuConfig({
    enabled: fsCfg.value?.enabled ?? false,
    webhookUrl: fsWebhookTouched.value || !fsCfg.value?.webhookSet ? fsDraft.webhookUrl : NOTIFY_SECRET_PLACEHOLDER,
    secret: fsSecretTouched.value || !fsCfg.value?.secretSet ? fsDraft.secret : NOTIFY_SECRET_PLACEHOLDER,
  }),
  onSuccess: async (data: FeishuConfigDTO) => {
    ElMessage.success('飞书配置已保存')
    await queryClient.setQueryData(['notify', 'feishu-config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// 飞书群机器人:同上,启用开关即时生效
const toggleFeishuMutation = useMutation({
  mutationFn: (next: boolean) =>
    apiSaveFeishuConfig({ enabled: next, webhookUrl: NOTIFY_SECRET_PLACEHOLDER, secret: NOTIFY_SECRET_PLACEHOLDER }),
  onSuccess: async (data: FeishuConfigDTO) => {
    ElMessage.success(`飞书群机器人已${data.enabled ? '启用' : '停用'}`)
    await queryClient.setQueryData(['notify', 'feishu-config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const fsTestMutation = useMutation({
  mutationFn: apiTestFeishu,
  onSuccess: () => ElMessage.success('测试消息已发送,请在飞书群查收'),
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 企业IM主机器人(im-connect 自建应用外发)────────────────────────────────
// 只读三平台状态 + 控制各平台是否启用(写 im-connect 平台 enabled);凭证/绑定在「企业IM接入」配置。
const IM_PLATFORM_LABEL: Record<ImPlatform, string> = { wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' }

const imQuery = useQuery({
  queryKey: ['notify', 'im-platforms'],
  queryFn: async () => {
    const [wecom, dingtalk, feishu] = await Promise.all([
      apiGetImConfig('wecom'), apiGetImConfig('dingtalk'), apiGetImConfig('feishu'),
    ])
    return [wecom, dingtalk, feishu] as ImConfigDTO[]
  },
  enabled: canConfigIm,
})

function imStatusOf(dto: ImConfigDTO): { label: string; type: 'success' | 'info' | 'warning' } {
  if (dto.enabled) return { label: '已启用', type: 'success' }
  if (dto.configured) return { label: '已配置未启用', type: 'info' }
  return { label: '未配置', type: 'warning' }
}

// 切 enabled:回传当前非密钥字段 + 密钥占位符(sever 端 keepOrNew 沿用原密钥),只改 enabled。
function buildImSaveInput(dto: ImConfigDTO, enabled: boolean): SaveImInput {
  if (dto.platform === 'wecom') {
    return { enabled, replyAgent: dto.replyAgent, corpId: dto.corpId, agentId: dto.agentId, secret: IM_SECRET_PLACEHOLDER, callbackToken: dto.callbackToken, callbackAesKey: IM_SECRET_PLACEHOLDER }
  }
  if (dto.platform === 'dingtalk') {
    return { enabled, replyAgent: dto.replyAgent, appKey: dto.appKey, appSecret: IM_SECRET_PLACEHOLDER, agentId: dto.agentId, robotCode: dto.robotCode }
  }
  return { enabled, replyAgent: dto.replyAgent, appId: dto.appId, appSecret: IM_SECRET_PLACEHOLDER, verificationToken: dto.verificationToken, encryptKey: IM_SECRET_PLACEHOLDER }
}

const imToggleMutation = useMutation({
  mutationFn: (v: { dto: ImConfigDTO; enabled: boolean }) => apiSaveImConfig(v.dto.platform, buildImSaveInput(v.dto, v.enabled)),
  onSuccess: async (_data, v) => {
    ElMessage.success(`${IM_PLATFORM_LABEL[v.dto.platform]}主机器人通知已${v.enabled ? '启用' : '停用'}`)
    await queryClient.invalidateQueries({ queryKey: ['notify', 'im-platforms'] })
  },
  onError: async (e) => {
    ElMessage.error(errorMessage(e))
    await queryClient.invalidateQueries({ queryKey: ['notify', 'im-platforms'] }) // 失败回滚开关到真实状态
  },
})

function goImConnectConfig() {
  window.dispatchEvent(new CustomEvent('si:navigate', { detail: 'app-settings' }))
}
</script>

<template>
  <section class="module-surface">
    <div class="module-toolbar">
      <p class="t-caption">
        配置系统对外发送通知所用的渠道。审批、跟进到期等站内提醒会同步走这里<b>已启用</b>的渠道外发。
        每个渠道一张子标签卡片,点标签切换。
      </p>
    </div>

    <AsyncState
      :loading="query.isLoading.value"
      :error="query.error.value && !isForbidden(query.error.value) ? errorMessage(query.error.value) : null"
      :forbidden="isForbidden(query.error.value)"
      :empty="false"
      @retry="query.refetch"
    >
      <!-- 每个通知渠道一张子标签卡片 -->
      <el-tabs v-model="activeChannel" type="border-card" class="notify-tabs">
        <!-- 邮件(SMTP)-->
        <el-tab-pane label="邮件" name="email" lazy>
          <div class="channel-head">
            <h2 class="channel-title"><Mail :size="16" /> 邮件(SMTP)</h2>
            <el-switch
              :model-value="cfg?.enabled ?? false"
              active-text="启用"
              inactive-text="停用"
              inline-prompt
              :loading="toggleEmailMutation.isPending.value"
              @update:model-value="(v: string | number | boolean) => toggleEmailMutation.mutate(Boolean(v))"
              :disabled="!canConfig"
            />
          </div>
          <p class="t-caption channel-desc">
            支持任意 SMTP 服务商:飞书企业邮(smtp.feishu.cn:465)、腾讯企业邮(smtp.exmail.qq.com:465)、自建 Exchange / Postfix 等。
          </p>

          <p v-if="cfg && !cfg.keyStoreReady" class="t-caption keystore-warn">
            未配置 CONFIG_ENC_KEY / AUTH_SECRET,无法安全保存邮件密码。请先在服务端设置加密主密钥。
          </p>

          <el-form label-position="top" class="config-form" @submit.prevent="saveMutation.mutate()">
            <el-row :gutter="16">
              <el-col :span="16">
                <FormField label="SMTP 主机">
                  <el-input v-model="draft.host" placeholder="如 smtp.feishu.cn" />
                </FormField>
              </el-col>
              <el-col :span="8">
                <FormField label="端口">
                  <el-input-number v-model="draft.port" :min="1" :max="65535" controls-position="right" style="width: 100%" />
                </FormField>
              </el-col>
            </el-row>

            <FormField label="加密方式">
              <el-radio-group :model-value="draft.secure" @update:model-value="(v) => onPortPreset(v as boolean)">
                <el-radio-button :value="true">SSL / TLS(465)</el-radio-button>
                <el-radio-button :value="false">STARTTLS(587 / 25)</el-radio-button>
              </el-radio-group>
            </FormField>

            <el-row :gutter="16">
              <el-col :span="12">
                <FormField label="用户名(登录账号)">
                  <el-input v-model="draft.user" placeholder="如 notify@your-company.com" />
                </FormField>
              </el-col>
              <el-col :span="12">
                <FormField label="密码 / 授权码">
                  <el-input
                    v-model="draft.pass"
                    type="password"
                    show-password
                    :placeholder="passPlaceholder"
                    @input="passTouched = true"
                  />
                </FormField>
              </el-col>
            </el-row>

            <el-row :gutter="16">
              <el-col :span="12">
                <FormField label="发件人名称">
                  <el-input v-model="draft.fromName" placeholder="如 企业管理平台" />
                </FormField>
              </el-col>
              <el-col :span="12">
                <FormField label="发件人地址">
                  <el-input v-model="draft.fromAddress" placeholder="留空则用登录账号" />
                </FormField>
              </el-col>
            </el-row>

            <div class="form-actions">
              <el-button
                v-if="canConfig"
                type="primary"
                native-type="submit"
                :loading="saveMutation.isPending.value"
                :disabled="cfg && !cfg.keyStoreReady"
              >
                保存
              </el-button>
              <el-button
                v-if="canConfig"
                :icon="SendHorizontal"
                :loading="testMutation.isPending.value"
                :disabled="!cfg?.configured"
                @click="testMutation.mutate()"
              >
                发送测试邮件
              </el-button>
            </div>
            <p class="t-caption test-hint">
              测试邮件会发送到发件账号自身;请先保存配置再测试。
            </p>
          </el-form>
        </el-tab-pane>

        <!-- 飞书(群自定义机器人 webhook)-->
        <el-tab-pane label="飞书群机器人" name="feishu" lazy>
          <div class="channel-head">
            <h2 class="channel-title"><MessageSquare :size="16" /> 飞书群机器人</h2>
            <el-switch
              :model-value="fsCfg?.enabled ?? false"
              active-text="启用"
              inactive-text="停用"
              inline-prompt
              :loading="toggleFeishuMutation.isPending.value"
              @update:model-value="(v: string | number | boolean) => toggleFeishuMutation.mutate(Boolean(v))"
              :disabled="!canConfig"
            />
          </div>

          <div class="feishu-guide">
            <p class="feishu-guide-title">三步接入(约 1 分钟):</p>
            <ol class="feishu-guide-steps">
              <li>
                在飞书<b>目标群</b>里点右上角「···」→「设置」→「群机器人」→「添加机器人」→ 选<b>「自定义机器人」</b>。
              </li>
              <li>
                给机器人起个名(如「企业管理平台」)→ 安全设置建议勾选<b>「签名校验」</b>(更安全)→ 复制它给出的
                <b>Webhook 地址</b>(和勾了签名校验时的<b>密钥</b>),分别粘到下方。
              </li>
              <li>
                打开右上角<b>「启用」</b>→ 点<b>「保存」</b>→ 再点<b>「发送测试消息」</b>,群里收到卡片即接入成功。
              </li>
            </ol>
            <p class="feishu-guide-foot">
              接入后,超级个体的工作流每次跑完会自动把结果推送到这个群(完成 / 失败 / 跳过 都会推)。
            </p>
          </div>

          <p v-if="fsCfg && !fsCfg.keyStoreReady" class="t-caption keystore-warn">
            未配置 CONFIG_ENC_KEY / AUTH_SECRET,无法安全保存 webhook 地址。请先在服务端设置加密主密钥。
          </p>

          <el-form label-position="top" class="config-form" @submit.prevent="fsSaveMutation.mutate()">
            <FormField label="Webhook 地址">
              <el-input
                v-model="fsDraft.webhookUrl"
                :placeholder="fsWebhookPlaceholder"
                @input="fsWebhookTouched = true"
              />
            </FormField>
            <FormField label="加签密钥(可选)">
              <el-input
                v-model="fsDraft.secret"
                type="password"
                show-password
                :placeholder="fsSecretPlaceholder"
                @input="fsSecretTouched = true"
              />
            </FormField>

            <div class="form-actions">
              <el-button
                v-if="canConfig"
                type="primary"
                native-type="submit"
                :loading="fsSaveMutation.isPending.value"
                :disabled="fsCfg && !fsCfg.keyStoreReady"
              >
                保存
              </el-button>
              <el-button
                v-if="canConfig"
                :icon="SendHorizontal"
                :loading="fsTestMutation.isPending.value"
                :disabled="!fsCfg?.configured"
                @click="fsTestMutation.mutate()"
              >
                发送测试消息
              </el-button>
            </div>
            <p class="t-caption test-hint">
              测试消息会发送到配置的飞书群;请先保存配置再测试。
            </p>
          </el-form>
        </el-tab-pane>

        <!-- 企业IM主机器人(im-connect 自建应用,发给员工个人)-->
        <el-tab-pane label="企业IM主机器人" name="im" lazy>
          <div class="channel-head">
            <h2 class="channel-title"><Bot :size="16" /> 企业IM主机器人</h2>
          </div>
          <p class="t-caption channel-desc">
            启用后,所有站内提醒会自动同步推送到员工绑定的企业IM<b>个人账号</b>(主机器人)。
            与「飞书群机器人」不同:那是往群里发,这里是<b>发给员工个人</b>。多平台启用时按 飞书 &gt; 企业微信 &gt; 钉钉 取首个可达。
            凭证、回调、员工身份绑定在<b>「企业IM接入」</b>页配置,这里只控制各平台是否作为通知渠道启用。
          </p>

          <div v-if="!canConfigIm" class="im-noperm">
            <p class="t-caption">需要「企业IM接入」权限才能查看与启用。</p>
            <el-button text type="primary" @click="goImConnectConfig">去企业IM接入 →</el-button>
          </div>

          <AsyncState
            v-else
            :loading="imQuery.isLoading.value"
            :error="imQuery.error.value && !isForbidden(imQuery.error.value) ? errorMessage(imQuery.error.value) : null"
            :forbidden="isForbidden(imQuery.error.value)"
            :empty="false"
            @retry="imQuery.refetch"
          >
            <div class="im-platform-list">
              <div v-for="dto in imQuery.data.value ?? []" :key="dto.platform" class="im-platform-row">
                <div class="im-platform-row__main">
                  <span class="im-platform-row__name">{{ IM_PLATFORM_LABEL[dto.platform] }}</span>
                  <el-tag :type="imStatusOf(dto).type" effect="light" round size="small">{{ imStatusOf(dto).label }}</el-tag>
                  <span v-if="!dto.configured" class="t-caption im-platform-row__hint">未配置凭证,请先到「企业IM接入」填写</span>
                </div>
                <el-switch
                  :model-value="dto.enabled"
                  active-text="启用"
                  inactive-text="停用"
                  inline-prompt
                  :disabled="!dto.configured || imToggleMutation.isPending.value"
                  @change="(val: string | number | boolean) => imToggleMutation.mutate({ dto, enabled: val as boolean })"
                />
              </div>
            </div>

            <div class="im-config-link">
              <el-button text type="primary" @click="goImConnectConfig">去「企业IM接入」配置凭证与身份绑定 →</el-button>
            </div>
          </AsyncState>
        </el-tab-pane>
      </el-tabs>
    </AsyncState>
  </section>
</template>

<style scoped>
/* border-card 自带外框;各渠道内容直接铺在 tab 内容区,标题/开关在内容区顶部 */
.notify-tabs :deep(.el-tabs__content) {
  padding: var(--sb-pad-card);
}

.channel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sb-gap-control);
  margin-bottom: var(--sb-gap-control);
}

.channel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--sb-font-md);
  font-weight: 600;
  color: var(--sb-text-primary);
}

.channel-desc {
  margin-bottom: var(--sb-gap-block);
}

.config-form {
  padding-top: 0;
}

.keystore-warn {
  color: var(--sb-color-warning);
  margin-bottom: var(--sb-gap-block);
}

.feishu-guide {
  margin: 0 0 var(--sb-gap-block);
  padding: var(--sb-pad-card);
  background: var(--sb-bg-subtle);
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md, 8px);
}

.feishu-guide-title {
  margin: 0 0 var(--sb-gap-control);
  font-weight: 600;
  color: var(--sb-text-primary);
}

.feishu-guide-steps {
  margin: 0;
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--sb-text-secondary);
  line-height: 1.6;
}

.feishu-guide-steps li {
  padding-left: 4px;
}

.feishu-guide-foot {
  margin: var(--sb-gap-control) 0 0;
  color: var(--sb-text-secondary);
}

.form-actions {
  display: flex;
  gap: var(--sb-gap-control);
  padding-top: var(--sb-gap-control);
}

.test-hint {
  margin-top: var(--sb-gap-control);
}

/* 企业IM主机器人:三平台行 */
.im-platform-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-md, 8px);
  overflow: hidden;
}

.im-platform-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sb-gap-control);
  padding: var(--sb-space-3) var(--sb-pad-card);
}

.im-platform-row + .im-platform-row {
  border-top: 1px solid var(--sb-border);
}

.im-platform-row__main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.im-platform-row__name {
  font-weight: 500;
  color: var(--sb-text-primary);
}

.im-platform-row__hint {
  color: var(--sb-text-secondary);
}

.im-noperm,
.im-config-link {
  margin-top: var(--sb-gap-block);
}
</style>
