<script setup lang="ts">
// modules/app-settings/ui/LlmConfig.vue
// 系统设置 → AI 大模型:平台级 LLM 供应商/模型 + 各供应商加密 API Key。
// 主模型:全系统 AI 能力的默认模型 + 可选备用模型(主选异常时自动切)。
// 场景模型:PCB CAM、图片识别、向量化可单独覆盖模型;留空=继承主模型。
import { computed, reactive, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Sparkles } from '@lucide/vue'
import ConfirmButton from '../../../core/ui-kit/ConfirmButton.vue'
import ModelRoutingNotice from '../../../core/ui-kit/ModelRoutingNotice.vue'
import FormField from '../../../core/ui-kit/FormField.vue'
import {
  apiGetLlmConfig, apiMyPermissions, apiUpdateLlmConfig,
  apiSaveLlmProviderKey, apiDeleteLlmProviderKey,
  apiSaveLlmSceneConfig, apiDeleteLlmSceneConfig,
  type LlmConfigDTO, type LlmSceneConfigDTO, errorMessage,
} from '../../../src/api/client'

const queryClient = useQueryClient()
const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
const canManage = computed(() => { const c = myPermsQuery.data.value?.codes; return c === null || (Array.isArray(c) && c.includes('app-settings:manage')) })

const query = useQuery({ queryKey: ['llm', 'config'], queryFn: apiGetLlmConfig })
const cfg = computed(() => query.data.value)

// ── 网关接管时,这一页的模型设置**不生效** ────────────────────────────────
// ★2026-08-22:这里原来只有一条提示。线上实测提示挡不住 —— 用户照着报错来这一页把
//   「图片识别」改成了一个实测能看图的模型、保存、以为配好了,再试还是同一个错。
//   所以现在把不生效的输入**真的禁用**:提示会被略过,禁用不会。
// ★不是死锁:撤下网关(服务器去掉 TB_*)之后本页就是兜底,提前配是正当需求 ——
//   点「仍要编辑」解锁,但那一刻他已经知道自己配的是「以后才生效」的那份。
// ★「深度思考」**不锁**:它是随每次请求下发的参数,网关模式下照样生效(见组件里的说明)。
const unlockAnyway = ref(false)
const locked = computed(() => !!cfg.value?.gatewayActive && !unlockAnyway.value)
const canEdit = computed(() => canManage.value && !locked.value)
// 看不到 AI 网关那一页就别给跳转按钮:si:navigate 会被可见性白名单静默丢弃,那是个死按钮
const canGoGateway = computed(() => {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes('ai-gateway:view'))
})

// ── 主模型(含备用)──────────────────────────────────────────────
const draftProvider = ref('')
const draftModel = ref('')
const draftFallbackProvider = ref('')
const draftFallbackModel = ref('')
const draftThinking = ref(false)
watch(cfg, (v) => {
  if (!v) return
  draftProvider.value = v.provider
  draftModel.value = v.model
  draftFallbackProvider.value = v.fallbackProvider ?? ''
  draftFallbackModel.value = v.fallbackModel ?? ''
  draftThinking.value = v.thinkingEnabled
}, { immediate: true })

const selectedMeta = computed(() => cfg.value?.providers.find((p) => p.id === draftProvider.value))
const modelPlaceholder = computed(() => (selectedMeta.value ? `默认:${selectedMeta.value.defaultModel}(可直接填模型 code)` : '输入模型 code'))
function providerLabel(id: string | null | undefined): string {
  if (!id) return ''
  return cfg.value?.providers.find((p) => p.id === id)?.label ?? id
}

const saveMutation = useMutation({
  mutationFn: () => apiUpdateLlmConfig({
    provider: draftProvider.value,
    model: draftModel.value,
    fallbackProvider: draftFallbackProvider.value,
    fallbackModel: draftFallbackModel.value,
    thinkingEnabled: draftThinking.value,
  }),
  onSuccess: async (data: LlmConfigDTO) => {
    ElMessage.success('AI 大模型配置已保存')
    await queryClient.setQueryData(['llm', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 场景模型覆盖 ────────────────────────────────────────────────
// thinking 是三态,而 el-select 只吃字符串:'inherit'=继承主模型 / 'on'=开 / 'off'=关。
// ★别拿空串当「继承」:el-select 匹配不上 value="" 的选项,会退回显示默认占位符「Select」。
type ThinkingChoice = 'inherit' | 'on' | 'off'
type SceneDraft = { provider: string; model: string; fallbackProvider: string; fallbackModel: string; thinking: ThinkingChoice }
const THINKING_OF = (v: boolean | null): ThinkingChoice => (v === null ? 'inherit' : v ? 'on' : 'off')
const THINKING_TO = (v: ThinkingChoice): boolean | null => (v === 'inherit' ? null : v === 'on')
const sceneDrafts = reactive<Record<string, SceneDraft>>({})
watch(cfg, (v) => {
  if (!v) return
  for (const s of v.scenes) {
    sceneDrafts[s.scene] = {
      provider: s.provider ?? '',
      model: s.model ?? '',
      fallbackProvider: s.fallbackProvider ?? '',
      fallbackModel: s.fallbackModel ?? '',
      thinking: THINKING_OF(s.thinkingEnabled),
    }
  }
}, { immediate: true })

const CAP_LABEL: Record<string, string> = { chat: '对话', vision: '视觉', embedding: '向量' }
function primaryPlaceholder(s: LlmSceneConfigDTO): string {
  if (s.capability === 'chat') return `跟随主模型(${cfg.value?.model || cfg.value?.provider || ''})`
  return s.defaultModel ? `默认:${s.defaultModel}` : '输入模型 code'
}
function hasOverride(s: LlmSceneConfigDTO): boolean {
  return !!(s.provider || s.model || s.fallbackProvider || s.fallbackModel) || s.thinkingEnabled !== null
}
// 向量化(embedding)走的不是 chat 接口,没有「思考」这回事,不给开关免得误导。
const supportsThinking = (s: LlmSceneConfigDTO): boolean => s.capability !== 'embedding'
// 折叠态摘要:未覆盖=跟随主模型/能力默认;已覆盖=显示实际 provider·model(+ 备用)。
function sceneSummary(s: LlmSceneConfigDTO): string {
  const think = s.thinkingEnabled === null ? '' : ` ｜ 思考${s.thinkingEnabled ? '开' : '关'}`
  const modelOverridden = !!(s.provider || s.model || s.fallbackProvider || s.fallbackModel)
  if (!modelOverridden) {
    const base = s.capability === 'chat' ? '跟随主模型' : s.defaultModel ? `能力默认 · ${s.defaultModel}` : '跟随主模型'
    return base + think
  }
  const prov = s.provider ? providerLabel(s.provider) : '主供应商'
  const model = s.model || '默认模型'
  let out = `${prov} · ${model}`
  if (s.fallbackProvider || s.fallbackModel) out += ` ｜ 备 ${s.fallbackModel || providerLabel(s.fallbackProvider)}`
  return out + think
}
// 场景默认折叠成一行,点「自定义/编辑」才展开内联编辑器——场景变多也不会撑长页面。
// 模板里写 `sceneDrafts[s.scene].provider`,在 noUncheckedIndexedAccess 下每次索引都是
// 「可能 undefined」—— 外层 v-if 只挡运行时,挡不住类型。把场景和它的草稿配好再交给 v-for,
// 模板就不必再索引。(运行时本来就一定有:草稿是照着同一份 cfg.scenes 建的。)
const sceneRows = computed(() =>
  (cfg.value?.scenes ?? []).flatMap((s) => {
    const draft = sceneDrafts[s.scene]
    return draft ? [{ s, draft }] : []
  }),
)
const editingScenes = reactive<Record<string, boolean>>({})
function toggleSceneEdit(scene: string) { editingScenes[scene] = !editingScenes[scene] }

const saveSceneMutation = useMutation({
  mutationFn: (scene: string) => {
    const d = sceneDrafts[scene]
    return apiSaveLlmSceneConfig({
      scene,
      provider: d?.provider ?? '',
      model: d?.model ?? '',
      fallbackProvider: d?.fallbackProvider ?? '',
      fallbackModel: d?.fallbackModel ?? '',
      thinkingEnabled: THINKING_TO(d?.thinking ?? 'inherit'),
    })
  },
  onSuccess: async (data: LlmConfigDTO, scene: string) => {
    ElMessage.success('场景模型已保存')
    editingScenes[scene] = false
    await queryClient.setQueryData(['llm', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
const clearSceneMutation = useMutation({
  mutationFn: (scene: string) => apiDeleteLlmSceneConfig(scene),
  onSuccess: async (data: LlmConfigDTO, scene: string) => {
    ElMessage.success('已清除,该场景改用主模型')
    editingScenes[scene] = false
    await queryClient.setQueryData(['llm', 'config'], data)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 各供应商 API Key ────────────────────────────────────────────
const draftKeys = reactive<Record<string, string>>({})
function keySource(id: string): { label: string; type: 'success' | 'info' | 'warning' } {
  if (cfg.value?.savedKeyStatus[id]) return { label: '已自定义', type: 'success' }
  if (cfg.value?.envKeyStatus[id]) return { label: '环境变量', type: 'info' }
  return { label: '未配置', type: 'warning' }
}
const saveKeyMutation = useMutation({
  mutationFn: (vars: { provider: string; apiKey: string }) => apiSaveLlmProviderKey(vars.provider, vars.apiKey),
  onSuccess: async (_d, vars) => {
    ElMessage.success('API Key 已保存')
    draftKeys[vars.provider] = ''
    await queryClient.invalidateQueries({ queryKey: ['llm', 'config'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
// SixAM 智能云账户卡:配了 sixam key(库内或环境变量)才渲染 —— 没 key 时接口必 401,渲染只会是一行报错

const deleteKeyMutation = useMutation({
  mutationFn: (provider: string) => apiDeleteLlmProviderKey(provider),
  onSuccess: async () => {
    ElMessage.success('已清除,该供应商改用环境变量')
    await queryClient.invalidateQueries({ queryKey: ['llm', 'config'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
</script>

<template>
  <section class="panel llm-panel">
    <div class="panel-toolbar">
      <h2 class="panel-title"><Sparkles :size="16" /> AI 大模型</h2>
    </div>
    <!-- 「模型到底在哪一页配」的唯一说法,与 AI 网关那一页共用同一个组件 -->
    <ModelRoutingNotice
      v-if="cfg"
      page="local"
      :gateway-active="cfg.gatewayActive"
      :can-go-other="canGoGateway"
      :locked="locked"
    />
    <p v-if="cfg?.gatewayActive && canManage" class="llm-unlock">
      <el-button link type="primary" size="small" @click="unlockAnyway = !unlockAnyway">
        {{ unlockAnyway ? '重新锁住' : '仍要编辑(为以后撤下网关预配)' }}
      </el-button>
    </p>
    <p class="t-caption muted" style="margin-bottom: var(--sb-space-4)">
      平台级基础设施:全系统 AI 能力统一使用「主模型」;不同场景可单独指定模型,未指定的场景继承主模型。
      每个模型都可配备用模型,主选返回限流/超时/服务端错误时自动切备用重试一次。
    </p>

    <div class="llm-layout">
      <div class="llm-main">
    <!-- 主模型 -->
    <el-form label-position="top" class="config-form" @submit.prevent="saveMutation.mutate()">
      <span class="t-label section-label">主模型(默认)</span>
      <el-row :gutter="16">
        <el-col :span="12">
          <FormField label="供应商">
            <el-select v-model="draftProvider" :disabled="locked" style="width: 100%">
              <el-option v-for="p in cfg?.providers" :key="p.id" :label="p.label" :value="p.id" />
            </el-select>
          </FormField>
        </el-col>
        <el-col :span="12">
          <FormField label="模型 code">
            <el-input v-model="draftModel" :disabled="locked" :placeholder="modelPlaceholder" />
          </FormField>
        </el-col>
      </el-row>
      <el-row :gutter="16">
        <el-col :span="12">
          <FormField label="备用供应商(可选)">
            <el-select v-model="draftFallbackProvider" :disabled="locked" clearable placeholder="无备用" style="width: 100%">
              <el-option v-for="p in cfg?.providers" :key="p.id" :label="p.label" :value="p.id" />
            </el-select>
          </FormField>
        </el-col>
        <el-col :span="12">
          <FormField label="备用模型 code(可选)">
            <el-input v-model="draftFallbackModel" :disabled="locked" placeholder="留空=无备用" />
          </FormField>
        </el-col>
      </el-row>
      <FormField label="深度思考">
        <div class="thinking-field">
          <el-switch v-model="draftThinking" :disabled="!canManage" />
          <span class="t-caption muted">
            默认关闭。仅对火山方舟的混合推理模型(doubao-seed 系列)生效:开启后模型会先输出思维链再作答,
            交互式场景会慢很多,且不提升准确率。只有确实需要复杂推理的场景才建议单独打开。
          </span>
        </div>
      </FormField>
      <div class="form-actions">
        <el-button v-if="canManage" type="primary" native-type="submit" :loading="saveMutation.isPending.value">保存主模型</el-button>
      </div>
    </el-form>

    <!-- 场景模型:默认折叠成一行摘要,点「自定义/编辑」展开内联编辑器(场景变多也不撑长页面) -->
    <div class="scenes">
      <div class="section-head">
        <span class="t-label section-label">场景模型</span>
        <span class="t-caption muted">未单独配置的场景一律继承主模型;点「自定义」为某场景指定专属模型 + 备用。</span>
      </div>
      <ul class="scene-list">
        <li
          v-for="{ s, draft } in sceneRows"
          :key="s.scene"
          class="scene-item"
          :class="{ 'scene-item--override': hasOverride(s), 'scene-item--editing': editingScenes[s.scene] }"
        >
          <div class="scene-summary">
            <div class="scene-summary__label">
              <span class="t-card-title">{{ s.label }}</span>
              <!-- disable-transitions:ElTag 默认包一层 el-zoom-in-center 过渡,过渡类残留时标签会卡住——
                   撤下的(如清除覆盖后的「已覆盖」)不消失,新挂的停在 opacity:0/scaleX(0) 上看不见。
                   这几个只是静态状态标记,不需要缩放动效,一律关掉过渡。 -->
              <el-tag effect="plain" round size="small" disable-transitions>{{ CAP_LABEL[s.capability] }}</el-tag>
              <el-tag v-if="hasOverride(s)" type="success" effect="light" round size="small" disable-transitions>已覆盖</el-tag>
            </div>
            <span class="scene-summary__value t-caption" :class="{ muted: !hasOverride(s) }">{{ sceneSummary(s) }}</span>
            <el-button
              v-if="canEdit"
              link
              type="primary"
              size="small"
              class="scene-summary__toggle"
              @click="toggleSceneEdit(s.scene)"
            >
              {{ editingScenes[s.scene] ? '收起' : (hasOverride(s) ? '编辑' : '自定义') }}
            </el-button>
          </div>
          <div v-if="editingScenes[s.scene]" class="scene-editor">
            <div class="scene-grid">
              <div class="scene-col">
                <span class="t-caption muted">主选</span>
                <el-select v-model="draft.provider" clearable placeholder="跟随主模型" size="small">
                  <el-option v-for="p in cfg?.providers" :key="p.id" :label="p.label" :value="p.id" />
                </el-select>
                <el-input v-model="draft.model" size="small" :placeholder="primaryPlaceholder(s)" />
              </div>
              <div class="scene-col">
                <span class="t-caption muted">备用</span>
                <el-select v-model="draft.fallbackProvider" clearable placeholder="无备用" size="small">
                  <el-option v-for="p in cfg?.providers" :key="p.id" :label="p.label" :value="p.id" />
                </el-select>
                <el-input v-model="draft.fallbackModel" size="small" placeholder="备用模型 code" />
              </div>
              <div v-if="supportsThinking(s)" class="scene-col">
                <span class="t-caption muted">深度思考</span>
                <el-select v-model="draft.thinking" size="small">
                  <el-option label="跟随主模型" value="inherit" />
                  <el-option label="开启(更慢,适合复杂推理)" value="on" />
                  <el-option label="关闭(更快)" value="off" />
                </el-select>
              </div>
            </div>
            <div class="scene-actions" v-if="canManage">
              <el-button size="small" type="primary" :loading="saveSceneMutation.isPending.value" @click="saveSceneMutation.mutate(s.scene)">保存</el-button>
              <ConfirmButton
                v-if="hasOverride(s)"
                label="清除"
                size="small"
                confirm-text="清除后该场景改用主模型,确认?"
                :disabled="clearSceneMutation.isPending.value"
                @confirm="clearSceneMutation.mutate(s.scene)"
              />
            </div>
          </div>
        </li>
      </ul>
    </div>
      </div>

      <aside class="llm-side">
    <!-- 各供应商 API Key -->
    <div class="provider-keys">
      <div class="section-head">
        <span class="t-label section-label">各供应商 API Key</span>
        <span class="t-caption muted">密钥加密存储,供上方所有模型/场景共用;留空则回落到环境变量。</span>
      </div>
      <p v-if="cfg && !cfg.keyStoreReady" class="t-caption provider-keys__warn">
        未配置 AUTH_SECRET / CONFIG_ENC_KEY,无法在此安全保存密钥;可改用环境变量。
      </p>
      <div v-for="p in cfg?.providers" :key="p.id" class="provider-key-row">
        <div class="provider-key-head">
          <span class="t-card-title">{{ p.label }}</span>
          <el-tag :type="keySource(p.id).type" effect="light" round size="small" disable-transitions>{{ keySource(p.id).label }}</el-tag>
        </div>
        <div class="provider-key-input">
          <el-input
            v-model="draftKeys[p.id]"
            :disabled="locked"
            type="password"
            show-password
            :placeholder="cfg?.savedKeyStatus[p.id] ? '已配置,输入新值可替换' : '输入 API Key'"
          />
          <el-button
            v-if="canManage"
            type="primary"
            :disabled="locked || !cfg?.keyStoreReady || !draftKeys[p.id]"
            :loading="saveKeyMutation.isPending.value"
            @click="saveKeyMutation.mutate({ provider: p.id, apiKey: draftKeys[p.id] ?? '' })"
          >
            保存
          </el-button>
          <ConfirmButton
            v-if="canManage && cfg?.savedKeyStatus[p.id]"
            label="清除"
            confirm-text="清除后该供应商改用环境变量 Key,确认?"
            :disabled="deleteKeyMutation.isPending.value"
            @confirm="deleteKeyMutation.mutate(p.id)"
          />
        </div>
      </div>
    </div>
      </aside>
    </div>

  </section>
</template>

<style scoped>
.llm-unlock { margin: calc(-1 * var(--sb-space-3)) 0 var(--sb-space-3); }
/* 模型路由(主模型+场景)占主体宽度;供应商 API Key 单独靠到右侧,两边都不再互相挤。 */
.llm-panel { max-width: 1280px; margin-top: var(--sb-space-5); }
.config-form { padding-top: 0; }
.section-label { display: block; margin: var(--sb-space-4) 0 var(--sb-space-2); font-weight: 600; }
.section-head { margin: var(--sb-space-4) 0 var(--sb-space-2); }
.section-head .section-label { margin: 0 0 2px; }
.form-actions { margin-top: var(--sb-space-2); }
.thinking-field { display: flex; align-items: flex-start; gap: 12px; }
.thinking-field .t-caption { line-height: 1.5; }

/* 左:模型路由(主模型+场景),占大头;右:供应商与 API Key,独立成栏 */
.llm-layout { display: flex; gap: var(--sb-space-6, 32px); align-items: flex-start; }
.llm-main { flex: 1; min-width: 0; }
.llm-side { width: 400px; flex-shrink: 0; border-left: 1px solid var(--sb-border); padding-left: var(--sb-space-6, 32px); }
.llm-side .provider-keys { margin-top: 0; }
.llm-side .section-head { margin-top: 0; }
@media (max-width: 1080px) {
  .llm-layout { flex-direction: column; }
  .llm-side { width: 100%; border-left: none; border-top: 1px solid var(--sb-border); padding-left: 0; padding-top: var(--sb-space-4); }
  .llm-side .section-head { margin-top: var(--sb-space-2); }
}

/* 场景模型:一行摘要,点开才展开编辑器——加到几十个场景也是紧凑列表 */
.scenes { display: flex; flex-direction: column; }
.scene-list { list-style: none; margin: var(--sb-space-2) 0 0; padding: 0; }
.scene-item { border-top: 1px solid var(--sb-border); }
.scene-item:last-child { border-bottom: 1px solid var(--sb-border); }
.scene-item--override { background: var(--sb-bg-subtle, transparent); }
.scene-summary { display: flex; align-items: center; gap: 12px; padding: 10px 0; flex-wrap: wrap; }
.scene-summary__label { display: flex; align-items: center; gap: 8px; min-width: 160px; }
.scene-summary__value { flex: 1; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scene-summary__toggle { flex-shrink: 0; margin-left: auto; }
.scene-editor { padding: 0 0 12px; }
.scene-grid { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
.scene-col { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 200px; }
.scene-actions { display: flex; gap: 8px; margin-top: 10px; }

.provider-keys { display: flex; flex-direction: column; gap: var(--sb-gap-control, 8px); margin-top: var(--sb-space-4); }
.provider-keys__warn { color: var(--sb-color-warning); }
.provider-key-row { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; border-top: 1px solid var(--sb-border); }
.provider-key-row:first-of-type { border-top: none; }
.provider-key-head { display: flex; align-items: center; gap: 8px; }
.provider-key-input { display: flex; gap: 8px; align-items: center; }
.provider-key-input .el-input { flex: 1; }
</style>
