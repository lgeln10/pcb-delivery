// core/llm/scenes.ts
// 平台 LLM「场景」注册表:PCB CAM、图片识别、向量化各一个场景 key。
// 系统设置里可为每个场景单独指定 provider+model + 各自的备用模型;未指定的场景一律继承主模型
// (default)。这是「场景为主、未选即继承」的模型路由基座——加场景只在此加一条。
//
// 能力(capability):
//  - chat:普通对话补全。未指定 → 继承主模型的 provider/model。
//  - vision / embedding:非对话能力(视觉识别 / 向量化),不能用文本主模型跑。未指定 →
//    用 defaultByProvider 按当前 provider 取默认模型(把原来散在 knowledge/vision、knowledge/embed
//    里的硬编码模型集中到这里),而不是继承主模型。
export type LlmCapability = 'chat' | 'vision' | 'embedding'

export type LlmSceneKey =
  | 'default'
  | 'pcb_cam'
  | 'vision'
  | 'embedding'

/** 主模型场景:所有未单独配置的场景都继承它。 */
export const DEFAULT_SCENE: LlmSceneKey = 'default'

export type LlmScene = {
  key: LlmSceneKey
  label: string
  capability: LlmCapability
  /** 非 chat 场景未配置时按 provider 取的默认模型(chat 场景留空 → 继承主模型)。 */
  defaultByProvider?: Record<string, string>
  /**
   * 这个场景由**自托管 agent 进程(dsh)**直接调模型出口,**不经过 `core/llm/caller.ts`**。
   *
   * ★标它是为了说一句实话:`caller.ts` 里那个「网关上没有这条路由 → 退到主模型」的兜底
   *   **够不着这些场景**。模型名在 spawn 时就烤进 cordis profile 了(agent-host/logic.ts),
   *   之后是 dsh 自己拿着它去调网关 —— 我们的调用层一次都没被执行。
   *   于是网关上**必须**有它自己的规则,否则每一轮都是
   *   `provider or model not configured for request model 'aios-<scene>'`。
   *   2026-08-16 日程助手、08-23 问 AI、以及这次的考勤助手,是同一个洞的三次。
   *
   * ★这个字段**不改变任何运行时行为** —— 它只让「AI 网关 → 场景路由」页把缺口显示出来,
   *   并让主模型那行的说明不再是半句真话。真正的修法是一键补齐(fillMissingSceneRoutes)。
   */
  viaAgentHost?: true
  /**
   * 这个场景单次回复的**输出上限**(`max_tokens`)。不填 = 不下发,与加这个字段之前完全一样。
   *
   * ★为什么要有(2026-08-28,base.sixamtech.ai 实打):在此之前**聊天场景一个输出上限都没设过**
   *   (`grep max_tokens` 只有 core/llm/vision.ts 有)。而耗时几乎线性跟着输出长度走
   *   —— 直连方舟实测 11~17 ms/token —— 于是「一次调用能慢到什么程度」根本没有上界。
   *   线上真实的一次:需求助手 37 次调用里 36 次 ≤1365 token,有一次吐了 3312 token、
   *   跑了 37.5 秒,离 45 秒的客户端超时只差 7.5 秒。用同一份提示词(入参 2774 vs 2694)
   *   复现 10 次,出参 101~546、耗时 2.5~9.1 秒 —— **复现不出来,它就是模型自己的长尾**。
   *   提示词里写「写短一点」拦不住这种事(那次存下来的需求正文本来就只有 442 字);
   *   能硬性兜住的只有 max_tokens。
   *
   * ★取值按各场景**成功调用的真实分布**定,给正常上限留约一倍余量,宁可宽不可窄 ——
   *   这道闸是拦病态长尾的,不是用来省钱的。截断的代价(见 caller.ts 对 finish_reason
   *   'length' 的处理)比「等 40 秒」更难受,所以不要为了省 token 往下调。
   *
   * ★**`viaAgentHost` 的场景不要填**:那些场景由 dsh 自己拿模型名去调网关,
   *   压根不经过 core/llm/caller.ts —— 填了不会报错,只是**永远不生效**。
   *   这正是本文件上面反复记录的那个洞的形状。护栏见 tests/max-output-tokens.test.ts。
   */
  maxOutputTokens?: number
}

/** 可在系统设置里单独覆盖的场景(不含 default;default=主模型,前端单独一块配)。 */
export const LLM_SCENES: LlmScene[] = [
  { key: 'pcb_cam', label: 'PCB CAM 审单(制作要求抽取/层识别/EQ 文案)', capability: 'chat', maxOutputTokens: 3000 },
  {
    key: 'vision',
    label: '图片识别',
    capability: 'vision',
    /**
     * ★**方舟这个默认值 2026-08-21 被实测证伪过一次,别再照抄文档里的老型号。**
     *   原值 `doubao-1.5-vision-pro-32k-250115` 在我们自己的账号上 404
     *   (`InvalidEndpointOrModel.NotFound`)—— 它压根不在方舟的模型目录里
     *   (那一代真正的 id 是**中划线** `doubao-1-5-vision-pro-32k-250115`),
     *   而目录里那个也早已 Shutdown/未开通。表现出来就是「图片没能读取成功」,
     *   没有任何线索指向这里。现值是拿真 key + 一张真名片跑通的(5.7s 全字段读对)。
     * ★方舟的 id 带日期,**会随时间失效**;百炼的 `qwen-vl-max` 是别名,不会。
     *   所以这条早晚还要动 —— 但它失效时现在会当场说清楚
     *   (见 core/llm/vision.ts 的 explain:404 → 「多半不支持看图或没开通,去模型接入换一个」),
     *   不再是一句查不动的「图片没能读取成功」。
     */
    // sixam:走自营中转,模型名是中转目录的对外名;seed-2-1-pro 的视觉能力已实测(image_url 透传)。
    defaultByProvider: { bailian: 'qwen-vl-max', ark: 'doubao-seed-2-1-turbo-260628', sixam: 'doubao-seed-2-1-pro' },
  },
  {
    key: 'embedding',
    label: '向量化',
    capability: 'embedding',
    /**
     * ★sixam 用 `doubao-embedding-vision`(2026-08-23 拿真 key 实测通过:2048 维,批量 3 条
     *   index 不串位)。这条路上有两件事值得知道:
     *   ① 那个账号里**只有多模态那一族 embedding 是开通的** —— 纯文本的四个型号
     *      (`doubao-embedding-{large-,}text-*`)全报 `InvalidEndpointOrModel.NotFound`。
     *      **目录里列着 ≠ 账号能调**,与上面 vision 那条 404 是同一个坑。
     *   ② 方舟的多模态向量**不在标准 `/embeddings` 上**:路径是 `/embeddings/multimodal`、
     *      入参是 `[{type:'text',text}]`、出参 `data` 是对象且整组只出一个向量。
     *      这些差异**由中转站吃掉**(offering 的 api_shape=ark_multimodal_embedding),
     *      所以这一侧照旧只说标准 OpenAI —— 这正是走中转的好处。
     * ★`ark` 那个 `doubao-embedding-text-240715` 在我们账号上**同样 404**,即直连方舟的租户
     *   其实一直用不了知识库,只是没人用 ark 跑过向量化。没动它:那是直连侧的账号开通问题。
     */
    defaultByProvider: { bailian: 'text-embedding-v4', ark: 'doubao-embedding-text-240715', sixam: 'doubao-embedding-vision' },
  },
]

const BY_KEY = new Map<string, LlmScene>(LLM_SCENES.map((s) => [s.key, s]))

/** 取场景定义;default 或未知 key 返回 undefined(解析层按主模型处理)。 */
export function getScene(key: string): LlmScene | undefined {
  return BY_KEY.get(key)
}

/** 是否为合法场景 key(含 default)。写入/路由层用来校验。 */
export function isSceneKey(key: string): boolean {
  return key === DEFAULT_SCENE || BY_KEY.has(key)
}

/**
 * 该场景的输出上限(`max_tokens`);未登记 = `undefined` = 不下发,行为与加这个字段前一致。
 * ★刻意**没有全局默认值**:给一个默认值就等于给所有没量过的场景拍一个数,
 *   而拍小了是静默截断(用户看到半句话)。只给有真实分布支撑的场景设,才不会伤到没量过的。
 */
export function sceneMaxOutputTokens(key: string): number | undefined {
  return LLM_SCENES.find((s) => s.key === key)?.maxOutputTokens
}
