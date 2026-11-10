// core/llm/config.ts
// 平台 LLM 配置的读/写(每租户一行)+ 运行时解析。所有业务模块的 AI 能力都走这里拿生效的
// provider/model + 库内加密 key(在「系统设置 → AI 大模型」维护),不各自读 env、不另设配置。
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Ctx, Db } from '../db/client'
import { auditedUpdate, scope, softDelete } from '../db/soft-delete'
import { decryptSecret, encryptSecret, isKeyStoreAvailable } from '../crypto/secret-box'
import { envKeyStatus, LLM_PROVIDERS, resolveApiKey, resolveModel, type LLMProviderId } from './providers'
import { makeLLMCaller, makeResilientCaller, type LLMCaller } from './caller'
import { resolveLLMTransport, type LLMTransport } from './transport'
import { LlmError } from './errors'
import { recordUsage } from './usage'
import { DEFAULT_SCENE, getScene, LLM_SCENES, sceneMaxOutputTokens, type LlmCapability, type LlmScene } from './scenes'
import { llmConfigs, llmProviderKeys, llmSceneConfigs, type LlmConfig, type LlmSceneConfig } from './model'

async function ensureConfig(db: Db, ctx: Ctx): Promise<LlmConfig> {
  const rows = await db
    .select()
    .from(llmConfigs)
    .where(and(eq(llmConfigs.tenantId, ctx.tenantId), eq(llmConfigs.isDeleted, false)))
    .limit(1)
  if (rows[0]) return rows[0]
  // ★首行**跟随 env**(`LLM_PROVIDER` / `LLM_MODEL`),不吃建表默认值 `bailian`。
  //
  //   不这么做的话:运维在 compose 里明明写了 `LLM_PROVIDER=eazytec`,场景路由却完全
  //   不看它 —— 那两个环境变量只被 `activeProvider()` 那条 env 兜底路读,而所有走
  //   `resolveLLMRuntimeConfig` 的场景(Ask AI / 个人助手 / 销售助理 / 视觉…)一律
  //   解析成 bailian,然后报「未配置 阿里百炼 的 API Key」。
  //   2026-08-19 江南自托管上实打:env 全对、key 也在,第一轮对话就是这条错。
  //   典型的静默失效 —— 配了等于没配,而报错指向一个运维压根没打算用的供应商。
  //
  //   ★只影响**首次插入**。已经有行的租户一个字不动(那是人在设置页里选的,
  //     env 不该反过来覆盖它)。
  const envProvider = (process.env.LLM_PROVIDER ?? process.env.FEEDBACK_LLM_PROVIDER ?? '').trim()
  const seed = envProvider && envProvider in LLM_PROVIDERS
    ? {
        provider: envProvider,
        // 空串 = 回落该 provider 的默认模型,所以没配 LLM_MODEL 时留空是对的。
        model: (process.env.LLM_MODEL ?? process.env.FEEDBACK_LLM_MODEL ?? '').trim(),
      }
    // env 没指定 → 默认自营中转(sixam)。显式写在这,不吃建表默认值 `bailian`
    // (改列默认要动迁移,且已有租户的行不该被碰 —— 见上一段的教训)。
    : { provider: 'sixam' }
  const inserted = await db
    .insert(llmConfigs)
    .values({ id: randomUUID(), tenantId: ctx.tenantId, createdBy: ctx.employeeId, updatedBy: ctx.employeeId, ...seed })
    .returning()
  return inserted[0]!
}

// 单个场景的当前配置(覆盖列为 null = 继承主模型)。defaultModel 供前端占位提示:
// chat 场景=null(占位显示主模型),vision/embedding=该 provider 的能力默认模型。
export type LlmSceneConfigDTO = {
  scene: string
  label: string
  capability: LlmCapability
  provider: string | null
  model: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  defaultModel: string | null
  thinkingEnabled: boolean | null // null = 继承主模型开关(三态)
}

export type LlmConfigDTO = {
  /**
   * ★网关已接入时,这一页配的东西**不生效** —— 出口和模型都由「AI 网关」的场景路由决定。
   * 不把这个状态给出去,这一页就是第二个「同一件事两处能改、还看不出哪个在生效」。
   */
  gatewayActive: boolean
  provider: LLMProviderId
  model: string
  fallbackProvider: string | null // 主模型的备用 provider(null=无)
  fallbackModel: string | null // 主模型的备用 model(null=无)
  thinkingEnabled: boolean // 主模型的深度思考总开关(默认 false;仅方舟生效)
  envKeyStatus: Record<string, boolean> // 各供应商 env 是否配了 key
  savedKeyStatus: Record<string, boolean> // 各供应商库内是否存了自定义 key(不含明文)
  keyStoreReady: boolean // 加密主密钥(env)是否就绪,可往库里存 key
  providers: Array<{ id: string; label: string; defaultModel: string }>
  scenes: LlmSceneConfigDTO[] // 各可覆盖场景(不含 default)的当前配置
}

/** 各供应商库内是否已存自定义 key(只返回布尔,绝不回明文) */
async function savedKeyStatus(db: Db, ctx: Ctx): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ provider: llmProviderKeys.provider })
    .from(llmProviderKeys)
    .where(scope(llmProviderKeys, ctx.tenantId))
  const saved = new Set(rows.map((r) => r.provider))
  const result = {} as Record<string, boolean>
  for (const p of Object.values(LLM_PROVIDERS)) result[p.id] = saved.has(p.id)
  return result
}

export async function getConfig(db: Db, ctx: Ctx): Promise<LlmConfigDTO> {
  const cfg = await ensureConfig(db, ctx)
  const rows = await db.select().from(llmSceneConfigs).where(scope(llmSceneConfigs, ctx.tenantId))
  const byScene = new Map(rows.map((r) => [r.scene, r]))
  const scenes: LlmSceneConfigDTO[] = LLM_SCENES.map((s) => {
    const r = byScene.get(s.key)
    const provider = r?.provider ?? null
    return {
      scene: s.key,
      label: s.label,
      capability: s.capability,
      provider,
      model: r?.model ?? null,
      fallbackProvider: r?.fallbackProvider ?? null,
      fallbackModel: r?.fallbackModel ?? null,
      // chat 场景默认继承主模型(占位显示主模型,故 null);vision/embedding 取该 provider 的能力默认
      defaultModel: s.capability === 'chat' ? null : (s.defaultByProvider?.[provider ?? cfg.provider] ?? null),
      thinkingEnabled: r?.thinkingEnabled ?? null, // null = 继承主模型
    }
  })
  return {
    // ★网关已接入时,这一页配的东西**不生效** —— 出口和模型都由网关决定。
    //   不把这个状态给出去,页面就是第二个「同一件事两处能改、还看不出哪个在生效」。
    gatewayActive: await isGatewayActive(db, ctx),
    provider: cfg.provider as LLMProviderId,
    model: cfg.model,
    fallbackProvider: cfg.fallbackProvider ?? null,
    fallbackModel: cfg.fallbackModel ?? null,
    thinkingEnabled: cfg.thinkingEnabled,
    envKeyStatus: envKeyStatus(),
    savedKeyStatus: await savedKeyStatus(db, ctx),
    keyStoreReady: isKeyStoreAvailable(),
    providers: Object.values(LLM_PROVIDERS).map(({ id, label, defaultModel }) => ({ id, label, defaultModel })),
    scenes,
  }
}

/** 这个租户的调用现在是不是走网关(拿主模型场景探一次即可 —— 出口是全局的,不按场景分)。 */
async function isGatewayActive(db: Db, ctx: Ctx): Promise<boolean> {
  return (await resolveLLMTransport(db, ctx, DEFAULT_SCENE)) !== null
}

// 空串/纯空白归一为 null(清除该字段);否则 trim。
const normField = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null)
const assertProvider = (p: string | null | undefined) => {
  if (p && p.trim() && !LLM_PROVIDERS[p as LLMProviderId]) throw new LlmError('INVALID_INPUT', `未知 provider: ${p}`)
}

/** 更新主模型:provider/model + 备用 provider/model(备用传空串=清除)。 */
export async function updateConfig(
  db: Db,
  ctx: Ctx,
  patch: { provider?: string; model?: string; fallbackProvider?: string | null; fallbackModel?: string | null; thinkingEnabled?: boolean },
): Promise<LlmConfigDTO> {
  assertProvider(patch.provider)
  assertProvider(patch.fallbackProvider)
  const cfg = await ensureConfig(db, ctx)
  await auditedUpdate(db, llmConfigs, ctx.tenantId, cfg.id, ctx.employeeId, {
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.fallbackProvider !== undefined ? { fallbackProvider: normField(patch.fallbackProvider) } : {}),
    ...(patch.fallbackModel !== undefined ? { fallbackModel: normField(patch.fallbackModel) } : {}),
    ...(patch.thinkingEnabled !== undefined ? { thinkingEnabled: patch.thinkingEnabled } : {}),
  })
  return getConfig(db, ctx)
}

/** 加载某场景的覆盖行(default/未知场景 → undefined)。 */
async function loadSceneRow(db: Db, ctx: Ctx, scene: string): Promise<LlmSceneConfig | undefined> {
  if (scene === DEFAULT_SCENE || !getScene(scene)) return undefined
  const rows = await db
    .select()
    .from(llmSceneConfigs)
    .where(and(scope(llmSceneConfigs, ctx.tenantId), eq(llmSceneConfigs.scene, scene)))
    .limit(1)
  return rows[0]
}

/** 新建/更新某场景的模型覆盖(4 列传空串=清除该列 → 继承主模型)。default 不可经此配(它是主模型)。 */
export async function upsertSceneConfig(
  db: Db,
  ctx: Ctx,
  input: {
    scene: string
    provider?: string | null
    model?: string | null
    fallbackProvider?: string | null
    fallbackModel?: string | null
    thinkingEnabled?: boolean | null // null/省略 = 继承主模型开关
  },
): Promise<LlmConfigDTO> {
  if (!getScene(input.scene)) throw new LlmError('INVALID_INPUT', `未知场景: ${input.scene}`)
  assertProvider(input.provider)
  assertProvider(input.fallbackProvider)
  const values = {
    provider: normField(input.provider),
    model: normField(input.model),
    fallbackProvider: normField(input.fallbackProvider),
    fallbackModel: normField(input.fallbackModel),
    thinkingEnabled: input.thinkingEnabled ?? null,
  }
  const existing = await loadSceneRow(db, ctx, input.scene)
  if (existing) {
    await auditedUpdate(db, llmSceneConfigs, ctx.tenantId, existing.id, ctx.employeeId, values)
  } else {
    await db.insert(llmSceneConfigs).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      scene: input.scene,
      ...values,
    })
  }
  return getConfig(db, ctx)
}

/** 清除某场景覆盖 → 回到继承主模型。 */
export async function deleteSceneConfig(db: Db, ctx: Ctx, scene: string): Promise<LlmConfigDTO> {
  const existing = await loadSceneRow(db, ctx, scene)
  if (existing) await softDelete(db, llmSceneConfigs, ctx.tenantId, existing.id, ctx.employeeId)
  return getConfig(db, ctx)
}

/** 保存某供应商的 api-key:加密后 upsert(明文不进库)。主密钥未就绪则报错。 */
export async function saveProviderKey(db: Db, ctx: Ctx, provider: string, apiKey: string): Promise<void> {
  if (!LLM_PROVIDERS[provider as LLMProviderId]) throw new LlmError('INVALID_INPUT', `未知 provider: ${provider}`)
  if (!apiKey.trim()) throw new LlmError('INVALID_INPUT', 'api-key 不能为空')
  const enc = encryptSecret(apiKey.trim()) // 主密钥缺失会抛 KEY_STORE_UNAVAILABLE
  const existing = await db
    .select({ id: llmProviderKeys.id })
    .from(llmProviderKeys)
    .where(and(scope(llmProviderKeys, ctx.tenantId), eq(llmProviderKeys.provider, provider)))
    .limit(1)
  if (existing[0]) {
    await auditedUpdate(db, llmProviderKeys, ctx.tenantId, existing[0].id, ctx.employeeId, { apiKeyEnc: enc })
  } else {
    await db.insert(llmProviderKeys).values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      createdBy: ctx.employeeId,
      updatedBy: ctx.employeeId,
      provider,
      apiKeyEnc: enc,
    })
  }
}

/** 清除某供应商的库内 key(软删),之后回退用 env key。 */
export async function deleteProviderKey(db: Db, ctx: Ctx, provider: string): Promise<void> {
  const existing = await db
    .select({ id: llmProviderKeys.id })
    .from(llmProviderKeys)
    .where(and(scope(llmProviderKeys, ctx.tenantId), eq(llmProviderKeys.provider, provider)))
    .limit(1)
  if (existing[0]) await softDelete(db, llmProviderKeys, ctx.tenantId, existing[0].id, ctx.employeeId)
}

/** 解析某供应商有效 api-key:库内(解密)优先,否则 env 兜底。解密失败(主密钥变更)也回退 env。 */
export async function resolveProviderApiKey(db: Db, ctx: Ctx, provider: string): Promise<string | undefined> {
  const rows = await db
    .select({ apiKeyEnc: llmProviderKeys.apiKeyEnc })
    .from(llmProviderKeys)
    .where(and(scope(llmProviderKeys, ctx.tenantId), eq(llmProviderKeys.provider, provider)))
    .limit(1)
  if (rows[0]) {
    try {
      return decryptSecret(rows[0].apiKeyEnc)
    } catch {
      // 主密钥变更/密文损坏 → 回退 env,不泄露任何明文
    }
  }
  const p = LLM_PROVIDERS[provider as LLMProviderId]
  return p ? resolveApiKey(p) : undefined
}

// ── 场景解析:把「主模型 + 场景覆盖」合成生效的主选/备用模型槽 ────────────────────────
// model 为 null = 这个**非 chat 能力**在当前 provider 下没有可用模型(见 effectiveModel)。
// ★不在这一层抛:走网关时本地模型压根不参与(真模型由网关路由决定),抛了会把
//   「网关模式 + provider 恰好没有视觉默认」的租户误伤成不可用。判定放到 toRuntimeConfig,
//   它拿得到 transport,知道这次到底走不走网关。
type Slot = { provider: string; model: string | null; apiKey?: string; thinkingEnabled: boolean }
type SceneSlots = { primary: Slot; fallback?: Slot }

/**
 * 生效 model:场景覆盖优先;否则 chat 继承主 model,vision/embedding 取该 provider 的能力默认模型。
 *
 * ★**非 chat 场景拿不到能力默认模型时返回 null,绝不回落到主模型**(2026-08-21 修)。
 *   原来最后一句是 `?? mainModel` —— 与本文件和 scenes.ts 写了两遍的「不能用文本主模型跑」
 *   正好相反。后果:provider 是 deepseek/hunyuan(vision 默认表里没有它们)时,
 *   「图片识别」会拿主模型这个**文本**模型去看图,上游要么 400 要么胡说,
 *   而错误在三层之外表现成一句「图片没能读取成功」—— 没有任何线索指向「该去配个视觉模型」。
 *   销售助理传图上线当天就是这么挂的。
 */
function effectiveModel(sceneModel: string | null | undefined, mainModel: string, provider: string, def?: LlmScene): string | null {
  if (sceneModel && sceneModel.trim()) return sceneModel.trim()
  if (!def || def.capability === 'chat') return mainModel
  return def.defaultByProvider?.[provider] ?? null
}

/** 非 chat 场景没模型可用时的**人话**:说清为什么不能借用主模型,并指到具体页面。 */
function noCapabilityModelError(def: LlmScene, provider: string): LlmError {
  const label = LLM_PROVIDERS[provider as LLMProviderId]?.label ?? provider
  const what = def.capability === 'vision' ? '看图' : '做向量化'
  return new LlmError(
    'LLM_NOT_CONFIGURED',
    `「${def.label}」还没有可用的模型:当前主模型用的是${label},它${what}的默认模型我们没有登记,`
      + `而主模型是文本模型、不能拿来${what}。请到「系统管理 → 模型接入」给「${def.label}」单独选一个模型。`,
  )
}

/** 解析某场景生效的主选 + 备用模型槽(字段级继承主模型;备用与主选完全一致则视为无备用)。 */
async function resolveSceneSlots(db: Db, ctx: Ctx, scene: string): Promise<SceneSlots> {
  const main = await ensureConfig(db, ctx)
  const row = await loadSceneRow(db, ctx, scene)
  const def = getScene(scene)

  const provider = normField(row?.provider) ?? main.provider
  const model = effectiveModel(row?.model, main.model, provider, def)
  const apiKey = await resolveProviderApiKey(db, ctx, provider)
  // 深度思考:场景那列是三态 —— null 继承主模型总开关,true/false 为本场景显式覆盖。
  // 备用模型沿用同一取值(同一场景换个模型顶上,思考口径不该跟着变)。
  const thinkingEnabled = row?.thinkingEnabled ?? main.thinkingEnabled

  // 备用:字段级继承主模型的备用列;只填 model 未填 provider → 用主选 provider。
  // ★仅 chat 场景继承主模型备用;vision/embedding 若继承会拿到文本备用模型(能力不符),故只认场景自配。
  const inheritMainFb = !def || def.capability === 'chat'
  const fbProvider = normField(row?.fallbackProvider) ?? (inheritMainFb ? normField(main.fallbackProvider) : null)
  const fbModel = normField(row?.fallbackModel) ?? (inheritMainFb ? normField(main.fallbackModel) : null)
  let fallback: Slot | undefined
  if (fbModel || fbProvider) {
    const fp = fbProvider ?? provider
    const fModel = effectiveModel(fbModel, main.model, fp, def)
    // 备用没模型可用 → 就是没有备用。**不能因此让主选也不可用** —— 主选是好的。
    if (fModel !== null && !(fp === provider && fModel === model)) {
      fallback = { provider: fp, model: fModel, apiKey: await resolveProviderApiKey(db, ctx, fp), thinkingEnabled }
    }
  }
  return { primary: { provider, model, apiKey, thinkingEnabled }, fallback }
}

/**
 * ★统一 LLM 运行时 caller:按当前租户「系统设置」里该场景生效的 provider/model + 库内加密 key 构造 LLMCaller,
 * 并带上该场景/主模型的备用模型(主选返回 429/5xx/超时时自动切备用再试一次)。
 * scene 省略 = 用主模型(default),现有调用方不改也照常工作。
 */
export async function buildTenantLLMCaller(
  db: Db,
  ctx: Ctx,
  scene: string = DEFAULT_SCENE,
  opts: { requirementTools?: boolean } = {},
): Promise<LLMCaller> {
  const { primary, fallback } = await resolveSceneSlots(db, ctx, scene)
  // 网关已接入时,出口整体换成网关(见 core/llm/transport.ts:不做自动回退)
  const transport = await resolveLLMTransport(db, ctx, scene)
  if (primary.model === null && !transport) throw noCapabilityModelError(getScene(scene)!, primary.provider)
  // 输出上限按场景取(未登记的场景 = undefined = 不下发,与加这个字段之前完全一样)。
  // 主选与备用取同一个值:切备用是为了绕开一次上游故障,不是为了换一种回答长度。
  const maxOutputTokens = sceneMaxOutputTokens(scene)
  const inner = makeResilientCaller(
    { providerId: primary.provider, model: primary.model ?? '', apiKey: primary.apiKey, thinkingEnabled: primary.thinkingEnabled, transport: transport ?? undefined, requirementTools: opts.requirementTools, maxOutputTokens },
    fallback
      ? { providerId: fallback.provider, model: fallback.model ?? '', apiKey: fallback.apiKey, thinkingEnabled: fallback.thinkingEnabled, requirementTools: opts.requirementTools, maxOutputTokens }
      : undefined,
  )
  // ★用量埋点挂在这一层:8 个场景共用同一个 caller,挂在这里一处覆盖全部,
  //   不必在每个业务模块各埋一遍(那样既漏又会腐烂)。记录整段吞异常,绝不连累业务。
  return async (messages) => {
    const t0 = Date.now()
    try {
      const r = await inner(messages)
      await recordUsage(db, ctx.tenantId, {
        scene, provider: primary.provider, model: primary.model ?? '',
        promptTokens: r.usage?.promptTokens, completionTokens: r.usage?.completionTokens, cachedTokens: r.usage?.cachedTokens,
        latencyMs: Date.now() - t0, ok: true,
      })
      return r
    } catch (e) {
      // 失败也要记 —— 否则「一直在报错」会显示成「没人用」,那是最误导的一种空
      await recordUsage(db, ctx.tenantId, {
        scene, provider: primary.provider, model: primary.model ?? '',
        latencyMs: Date.now() - t0, ok: false,
        errorCode: e instanceof LlmError ? e.code : 'UNKNOWN',
      })
      throw e
    }
  }
}

/** 运行时 LLM 原始配置(baseURL/model/apiKey),供需自建 OpenAI 调用(自定义工具/流式)的模块用,如 crm-assistant/knowledge。 */
export type LLMRuntimeConfig = {
  provider: string
  label: string
  baseURL: string
  model: string
  apiKey: string
  thinkingEnabled: boolean // 该场景生效的深度思考开关(默认 false;仅方舟生效,见 core/llm/thinking.ts)
  /** 网关模式下必须原样透传给自建 OpenAI client 的 defaultHeaders(含 X-Scene);直连时为空。 */
  /**
   * ★这次调用是不是走**统一网关**。
   * 走网关时:baseURL/apiKey 是网关的,model 是虚拟模型名(真模型由网关路由决定),
   * 所以调用方**不要再做 provider 专属塑形**(它并不知道真实上游是谁),也不要再配备用。
   */
  viaGateway?: boolean
  /**
   * 网关上没有这个模型名的路由时,给用户看的那句人话(由 modules/ai-gateway 撰写)。
   * ★自建 OpenAI 调用的模块(core/llm/vision、knowledge)必须用它包装 400 ——
   *   否则用户拿到的是网关原文「provider or model not configured」,真实反馈是
   *   「400 是大模型没余额了吗」。
   */
  unconfiguredHint?: string
}

// slot → LLMRuntimeConfig;无 key/未知 provider 抛错(与旧行为一致)。
function toRuntimeConfig(slot: Slot, scene: string, transport?: LLMTransport | null): LLMRuntimeConfig {
  const provider = LLM_PROVIDERS[slot.provider as LLMProviderId]
  if (!provider) throw new LlmError('INVALID_INPUT', `未知 provider: ${slot.provider}`)
  if (transport) {
    // 网关模式:凭据在网关侧,base 本就不该持有 provider key —— 不走「未配置 key」那条早退
    return {
      provider: provider.id,
      label: provider.label,
      baseURL: transport.baseURL,
      model: transport.model,
      apiKey: transport.apiKey,
      viaGateway: true,
      // ★带上去:自建 OpenAI 调用的模块(vision/knowledge)不走 makeLLMCaller,
      //   拿不到这句话就只能把网关原文「provider or model not configured」丢给用户。
      unconfiguredHint: transport.unconfiguredHint,
      // ★深度思考仍要显式下发:不发就退回「默认 auto=开着」,正是 0165 那条修复要治的坑
      thinkingEnabled: slot.thinkingEnabled,
    }
  }
  // ★走到这里说明是直连:此时「这个能力没有模型」就是真的不可用了(理由见 effectiveModel)
  if (slot.model === null) throw noCapabilityModelError(getScene(scene)!, slot.provider)
  if (!slot.apiKey) {
    throw new LlmError('LLM_NOT_CONFIGURED', `未配置 ${provider.label} 的 API Key(可在系统设置页填写,或设环境变量 ${provider.apiKeyEnv})`)
  }
  return {
    provider: provider.id,
    label: provider.label,
    baseURL: provider.baseURL,
    model: slot.model || resolveModel(provider),
    apiKey: slot.apiKey,
    thinkingEnabled: slot.thinkingEnabled,
  }
}

/** 解析某场景生效的主选运行时配置(仅主选,签名向后兼容;scene 省略=主模型)。 */
export async function resolveLLMRuntimeConfig(db: Db, ctx: Ctx, scene: string = DEFAULT_SCENE): Promise<LLMRuntimeConfig> {
  const { primary } = await resolveSceneSlots(db, ctx, scene)
  return toRuntimeConfig(primary, scene, await resolveLLMTransport(db, ctx, scene))
}

/** 解析主选 + 备用运行时配置,供自建 OpenAI 的模块配合 runWithLLMFallback 做兜底(备用无 key 则省略,主选仍可用)。 */
export async function resolveLLMRuntimeConfigWithFallback(
  db: Db,
  ctx: Ctx,
  scene: string = DEFAULT_SCENE,
): Promise<{ primary: LLMRuntimeConfig; fallback?: LLMRuntimeConfig }> {
  const slots = await resolveSceneSlots(db, ctx, scene)
  const transport = await resolveLLMTransport(db, ctx, scene)
  const primary = toRuntimeConfig(slots.primary, scene, transport)
  let fallback: LLMRuntimeConfig | undefined
  // ★网关模式不返回备用:一个场景 = 网关上一条路由,备用会解析成同一个端点 + 同一个场景,
  //   打两遍既不换模型也让失败原因更难读。备用该由网关侧做。
  if (slots.fallback && !primary.viaGateway) {
    try {
      fallback = toRuntimeConfig(slots.fallback, scene)
    } catch {
      // 备用无 key / 无效 → 无备用,主选仍可用
    }
  }
  return { primary, fallback }
}

/** 某个场景**实际生效**的模型解析结果(智能体管理页「模型接入」用)。 */
export type EffectiveRoute = {
  scene: string
  label: string
  capability: string
  provider: string
  providerLabel: string
  model: string
  thinkingEnabled: boolean
  /**
   * 配置来自哪:场景覆盖 / 主模型继承 / **平台路由(走 AI 网关)**。
   * ★`gateway` 这一支是 2026-08-21 补的,补之前这一页在**骗人**:网关开着时,真正用哪个
   *   模型由网关的场景路由决定,而这一页照样把本地那条显示成生效中。线上真出过事 ——
   *   用户照着这一页把「图片识别」改成了能看图的模型,再试还是同样的错,因为改的不是生效的那处。
   */
  source: 'scene' | 'main' | 'gateway'
  keyReady: boolean
  /**
   * 有值 = 这个场景**现在根本用不了**,值就是原因(人话)。
   * ★为什么要有:非 chat 场景在某些 provider 下没有可用模型(见 effectiveModel)。
   *   不显示的话,这一页会把一个用不了的场景画得和别的一模一样 ——
   *   而用户是在这一页判断「AI 到底配好没有」的。
   */
  unavailable?: string
}

/**
 * 全部场景的生效路由。
 *
 * ★为什么要有:此前「模型接入」只显示 getdeployed 网关的配置 —— 没接平台就整页空,
 *   而本地 LLM 配置才是当前真正生效的那个。那一页该回答的是
 *   **「每个场景现在实际用的是哪个模型」**,配置在哪只是其中一列。
 * ★走 resolveSceneSlots(与真正发请求时同一条路径),不是另写一份推导 ——
 *   另写一份迟早与实际不一致,而这一页的价值恰恰是「说的是真的」。
 */
export async function listEffectiveRoutes(db: Db, ctx: Ctx): Promise<EffectiveRoute[]> {
  const out: EffectiveRoute[] = []
  const main = await ensureConfig(db, ctx)
  for (const s of LLM_SCENES) {
    const row = await loadSceneRow(db, ctx, s.key)
    // ★先问网关:开着的话,本地这几列**都不生效**,显示本地配置等于误导(见 source 的注释)。
    const transport = await resolveLLMTransport(db, ctx, s.key)
    if (transport) {
      out.push({
        scene: s.key, label: s.label, capability: s.capability,
        provider: 'gateway', providerLabel: 'AI 网关(平台路由)',
        // 发出去的就是这个虚拟模型名;真模型在「AI 网关 → 场景路由」那一页
        model: transport.model,
        thinkingEnabled: row?.thinkingEnabled ?? main.thinkingEnabled,
        source: 'gateway',
        keyReady: true,
      })
      continue
    }
    let primary: Slot
    let unavailable: string | undefined
    try {
      primary = (await resolveSceneSlots(db, ctx, s.key)).primary
      // 直连 + 非 chat 能力没有可用模型 → 这一页必须**说出来**,它正是用来发现这件事的
      if (primary.model === null) unavailable = noCapabilityModelError(getScene(s.key)!, primary.provider).message
    } catch (e) {
      // ★别的原因(未知 provider 等)也不能让整页打不开
      const pid = normField(row?.provider) ?? main.provider
      out.push({
        scene: s.key, label: s.label, capability: s.capability,
        provider: pid, providerLabel: LLM_PROVIDERS[pid as LLMProviderId]?.label ?? pid,
        model: '', thinkingEnabled: row?.thinkingEnabled ?? main.thinkingEnabled,
        source: row?.provider || row?.model ? 'scene' : 'main',
        keyReady: false,
        unavailable: e instanceof Error ? e.message : '这个场景当前没有可用模型',
      })
      continue
    }
    const provider = LLM_PROVIDERS[primary.provider as LLMProviderId]
    out.push({
      scene: s.key,
      label: s.label,
      capability: s.capability,
      provider: primary.provider,
      providerLabel: provider?.label ?? primary.provider,
      // 继承主模型时 slot.model 为空 —— 显示成空白会让人以为没配。回落到该供应商的默认模型,
      // 与真正发请求时 makeChatRun 的 `model || resolveModel(provider)` 同口径。
      model: unavailable ? '' : primary.model || (provider ? resolveModel(provider) : ''),
      thinkingEnabled: primary.thinkingEnabled,
      source: row?.provider || row?.model ? 'scene' : 'main',
      keyReady: !unavailable && !!primary.apiKey,
      unavailable,
    })
  }
  return out
}
