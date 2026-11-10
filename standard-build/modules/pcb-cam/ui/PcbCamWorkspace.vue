<script setup lang="ts">
// modules/pcb-cam/ui/PcbCamWorkspace.vue
// PCB CAM 工程自动化工作台:项目/任务列表(骨架 A)+ 任务抽屉(stage 时间线 / 层确认 / 规格确认 / EQ 决策 / 报告 / 预览 / 成果物)。
// 权限:菜单 pcb-cam:menu;写按钮逐个 v-if(operate=上传/确认,approve=EQ 决策/重跑/取消,config=工厂标准)。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { Download, FolderPlus, Maximize2, Minimize2, RefreshCw, Upload } from '@lucide/vue'
import AsyncState from '../../../core/ui-kit/AsyncState.vue'
import ConfirmButton from '../../../core/ui-kit/ConfirmButton.vue'
import FilterBar from '../../../core/ui-kit/FilterBar.vue'
import { useIsMobile } from '../../../src/composables/useIsMobile'
import WorkbenchPane from './parts/WorkbenchPane.vue'
import EngineLog from './parts/EngineLog.vue'
import LayerStack3D from './parts/LayerStack3D.vue'
import TimeScrub from './parts/TimeScrub.vue'
import AskBoard from './parts/AskBoard.vue'
import CurtainCompare from './parts/CurtainCompare.vue'
import DiffMinimap from './parts/DiffMinimap.vue'
import { useSfx } from './parts/useSfx'
import { useScopeSkin } from './parts/useScopeSkin'
import { viewBoxOf } from './parts/svg-geo'
import './parts/scope.css'
import {
  API_CLIENT_VERSION,
  apiMyPermissions,
  apiPcbCamCancelJob,
  apiPcbCamConfirmLayers,
  apiPcbCamConfirmOrderSpec,
  apiPcbCamCreateProject,
  apiPcbCamEqSheetUrl,
  apiPcbCamGetJob,
  apiPcbCamJobStats,
  apiPcbCamRelease,
  apiPcbCamDefaultFactoryProfile,
  apiPcbCamGetFactoryProfile,
  apiPcbCamLayerSvg,
  apiPcbCamSaveFactoryProfile,
  apiPcbCamValidateFactoryProfile,
  apiPcbCamArtifactJson,
  apiPcbCamCompare,
  apiPcbCamCompareSvg,
  apiPcbCamUploadGolden,
  apiPcbCamListArtifacts,
  apiPcbCamSubscribeJob,
  apiPcbCamListFactoryProfiles,
  apiPcbCamListJobs,
  apiPcbCamListProjects,
  apiPcbCamMiSheet,
  apiPcbCamDownloadMiSheet,
  apiPcbCamDownloadArtifactsZip,
  apiPcbCamStackupSvg,
  apiPcbCamRetryStage,
  apiPcbCamStageReport,
  apiPcbCamUploadJob,
  apiPcbCamWorkerHealth,
  errorMessage,
  isForbidden,
  type PcbCamFactoryProfileDTO,
  type PcbCamJobListItem,
  type PcbCamJobStatus,
  type PcbCamProfileField,
  type PcbCamArtifactDTO,
  type PcbCamCompareCluster,
  type PcbCamCompareLayer,
  type PcbCamQueryHit,
  type PcbCamReportItem,
  type PcbCamStage,
} from '../../../src/api/client'
import { artifactKindLabel, kindLabel, layerTypeLabel, opLabel, severityLabel, summaryLabel } from './labels'

const queryClient = useQueryClient()
const isMobile = useIsMobile()
// 观感开关:「示波器」皮肤(只作用于本页)与提示音;都是 localStorage 记忆的个人偏好
const { scopeOn, toggleScope } = useScopeSkin()
const { sfxOn, toggleSfx, sfx } = useSfx()

const myPermsQuery = useQuery({ queryKey: ['me', 'permissions'], queryFn: apiMyPermissions })
function hasPerm(code: string) {
  const c = myPermsQuery.data.value?.codes
  return c === null || (Array.isArray(c) && c.includes(code))
}
const canOperate = computed(() => hasPerm('pcb-cam:operate'))
const canApprove = computed(() => hasPerm('pcb-cam:approve'))
const canConfig = computed(() => hasPerm('pcb-cam:config'))

// ── 工厂标准(profile):表单视图 = 平铺的 dotted key(来自 worker default.yaml,带页码说明);YAML 视图 = 租户覆盖原文。
// 表单只改「覆盖项」,保存的 YAML 只含被改过的键(默认值留在 worker 里,升级默认不用改租户数据)。
const profileDialog = ref(false)
const profileView = ref<'form' | 'yaml'>('form')
const profileEditId = ref<string | null>(null)
const profileForm = ref({ name: '', yaml: '', isDefault: false })
const profileFields = ref<PcbCamProfileField[]>([])
const profileErrors = ref<string[]>([])
const profileOverrides = ref<Record<string, string>>({})
const profileFilter = ref('')
const profileBusy = ref(false)
const profileFieldsShown = computed(() => {
  const q = profileFilter.value.trim().toLowerCase()
  return q ? profileFields.value.filter((f) => f.key.toLowerCase().includes(q) || f.doc.toLowerCase().includes(q)) : profileFields.value
})
function fmtVal(v: unknown): string {
  return Array.isArray(v) ? `[${v.map((x) => fmtVal(x)).join(', ')}]` : v === null || v === undefined ? '' : String(v)
}
function scalarYaml(text: string): string {
  const t = text.trim()
  if (/^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false' || t.startsWith('[')) return t
  return JSON.stringify(t)
}
function yamlFromOverrides(): string {
  const tree: Record<string, unknown> = {}
  for (const [key, text] of Object.entries(profileOverrides.value)) {
    if (text.trim() === '') continue
    const parts = key.split('.')
    let node = tree
    for (const part of parts.slice(0, -1)) {
      node = (node[part] ??= {}) as Record<string, unknown>
    }
    node[parts[parts.length - 1]!] = scalarYaml(text)
  }
  const lines: string[] = ['# 租户工厂标准(只含覆盖项;其余取 pcb-worker 内置默认)']
  const emit = (node: Record<string, unknown>, indent: string) => {
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') {
        lines.push(`${indent}${k}:`)
        emit(v as Record<string, unknown>, indent + '  ')
      } else lines.push(`${indent}${k}: ${String(v)}`)
    }
  }
  emit(tree, '')
  return lines.join('\n') + '\n'
}
function applyValidation(v: { ok: boolean; errors: string[]; fields: PcbCamProfileField[] }) {
  profileErrors.value = v.errors
  if (v.fields.length) profileFields.value = v.fields
  profileOverrides.value = Object.fromEntries(v.fields.filter((f) => f.overridden).map((f) => [f.key, fmtVal(f.value)]))
}
async function openProfileDialog(filter = '') {
  profileDialog.value = true
  profileEditId.value = null
  profileForm.value = { name: '', yaml: '', isDefault: false }
  profileErrors.value = []
  profileOverrides.value = {}
  profileFilter.value = filter
  try {
    const d = await apiPcbCamDefaultFactoryProfile()
    profileFields.value = d.fields
  } catch (e) {
    ElMessage.error(errorMessage(e))
  }
}
async function selectProfile(id: string) {
  profileBusy.value = true
  try {
    const p = await apiPcbCamGetFactoryProfile(id)
    profileEditId.value = p.id
    profileForm.value = { name: p.name, yaml: p.yaml ?? '', isDefault: p.isDefault }
    applyValidation(await apiPcbCamValidateFactoryProfile(p.yaml ?? ''))
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    profileBusy.value = false
  }
}
function setProfileField(key: string, text: string) {
  const f = profileFields.value.find((x) => x.key === key)
  if (!f) return
  if (text.trim() === '' || text === fmtVal(f.default)) delete profileOverrides.value[key]
  else profileOverrides.value[key] = text
  profileForm.value.yaml = yamlFromOverrides()
}
async function validateProfile() {
  profileBusy.value = true
  try {
    applyValidation(await apiPcbCamValidateFactoryProfile(profileForm.value.yaml))
    if (!profileErrors.value.length) ElMessage.success('校验通过')
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    profileBusy.value = false
  }
}
const saveProfileMutation = useMutation({
  mutationFn: () =>
    apiPcbCamSaveFactoryProfile({ id: profileEditId.value ?? undefined, name: profileForm.value.name.trim(), yaml: profileForm.value.yaml || '# 全部取内置默认\n', isDefault: profileForm.value.isDefault }),
  onSuccess: async (p) => {
    profileEditId.value = p.id
    ElMessage.success('工厂标准已保存')
    await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'profiles'] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 元数据 ──
const STAGES: PcbCamStage[] = ['intake', 'order_spec', 'align', 'drill', 'inner', 'outer', 'mask', 'silk', 'net_compare', 'panel', 'output', 'gatekeeper']
const STAGE_LABEL: Record<PcbCamStage, string> = {
  intake: '资料整理',
  order_spec: '审单',
  align: '对齐/Profile',
  drill: '钻孔',
  inner: '内层',
  outer: '外层',
  mask: '阻焊',
  silk: '字符',
  net_compare: '网络比较',
  panel: '拼板',
  output: '输出',
  gatekeeper: '回读校验',
}
const JOB_STATUS: Record<PcbCamJobStatus, { label: string; type: 'info' | 'warning' | 'success' | 'danger' | 'primary' }> = {
  pending: { label: '排队中', type: 'info' },
  running: { label: '处理中', type: 'primary' },
  needs_review: { label: '待确认', type: 'warning' },
  blocked: { label: '已阻断', type: 'danger' },
  done: { label: '已完成', type: 'success' },
  failed: { label: '失败', type: 'danger' },
  cancelled: { label: '已取消', type: 'info' },
}
const RUN_STATUS: Record<string, { label: string; type: 'info' | 'warning' | 'success' | 'danger' | 'primary' }> = {
  running: { label: '执行中', type: 'primary' },
  ok: { label: '通过', type: 'success' },
  needs_review: { label: '待确认', type: 'warning' },
  blocked: { label: '阻断', type: 'danger' },
  failed: { label: '失败', type: 'danger' },
}
const REVIEW_LABEL: Record<string, string> = {
  layers: '请确认每个文件对应的层',
  order_spec: '请核对 AI 读出的制作规格',
  eq: '有问题点需要决策',
  blocked: '流程被阻断,需人工处理',
}
const LAYER_TYPES = [
  'top_copper', 'inner_copper', 'bottom_copper', 'top_mask', 'bottom_mask', 'top_silk', 'bottom_silk',
  'top_paste', 'bottom_paste', 'outline', 'drill_pth', 'drill_npth', 'drill_unknown', 'drill_blind', 'drawing', 'unknown',
]
function fmt(value?: string | null) {
  return value ? value.replace('T', ' ').slice(0, 16) : '-'
}
function fmtBytes(n: number) {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`
}

// ── 列表 ──
const projectFilter = ref('')
// 快捷筛选:工程师打开这页第一件事是找「等我处理的」,所以按「要不要我动手」分段,而不是按 7 个状态枚举
type QuickFilter = '' | 'mine' | 'active' | 'done' | 'trouble'
const QUICK_FILTERS: Array<{ value: QuickFilter; label: string; statuses: PcbCamJobStatus[] }> = [
  { value: '', label: '全部', statuses: [] },
  { value: 'mine', label: '需要我处理', statuses: ['needs_review', 'blocked'] },
  { value: 'active', label: '进行中', statuses: ['pending', 'running'] },
  { value: 'done', label: '已完成', statuses: ['done'] },
  { value: 'trouble', label: '失败 / 取消', statuses: ['failed', 'cancelled'] },
]
const quickFilter = ref<QuickFilter>('')
// 列表默认按「该谁动」排(工作队列):待我拍板的在最前、同档等得久的在前;要看最新上传的切「最新」
const sortMode = ref<'queue' | 'newest'>('queue')
const statsQuery = useQuery({ queryKey: ['pcb-cam', 'job-stats', API_CLIENT_VERSION], queryFn: apiPcbCamJobStats, refetchInterval: 15_000 })
const stats = computed(() => statsQuery.data.value ?? null)
const now = ref(Date.now())
const nowTimer = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(nowTimer))
/** 等了多久:只对停在人工节点的任务算(从最后一次状态变化起);超 4 小时飘红、超 1 天深红 */
function waiting(row: { status: PcbCamJobStatus; updatedAt: string }): { text: string; level: 0 | 1 | 2 } | null {
  if (!['needs_review', 'blocked', 'failed'].includes(row.status)) return null
  const ms = now.value - new Date(row.updatedAt).getTime()
  const h = ms / 3_600_000
  const text = h < 1 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : h < 24 ? `${h.toFixed(h < 10 ? 1 : 0)} 小时` : `${(h / 24).toFixed(1)} 天`
  return { text, level: h >= 24 ? 2 : h >= 4 ? 1 : 0 }
}
function rowClass({ row }: { row: PcbCamJobListItem }): string {
  const w = waiting(row)
  return w?.level === 2 ? 'row-wait-2' : w?.level === 1 ? 'row-wait-1' : ''
}
function ago(iso: string | null): string {
  if (!iso) return '-'
  const h = (now.value - new Date(iso).getTime()) / 3_600_000
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} 分钟` : h < 24 ? `${h.toFixed(0)} 小时` : `${(h / 24).toFixed(1)} 天`
}
const quickStatuses = computed(() => QUICK_FILTERS.find((f) => f.value === quickFilter.value)?.statuses ?? [])
// 关键词(项目名 / 客户名 / 任务 id 前缀),敲字 300ms 后才发请求
const keywordInput = ref('')
const keyword = ref('')
let keywordTimer: ReturnType<typeof setTimeout> | null = null
watch(keywordInput, (v) => {
  if (keywordTimer) clearTimeout(keywordTimer)
  keywordTimer = setTimeout(() => (keyword.value = v.trim()), 300)
})
const pageSize = ref(20)
const pageIndex = ref(0)
const pageCursors = ref<Array<string | undefined>>([undefined])
function resetPage() {
  pageIndex.value = 0
  pageCursors.value = [undefined]
}
watch([projectFilter, quickFilter, keyword, pageSize, sortMode], resetPage)

const projectsQuery = useQuery({ queryKey: ['pcb-cam', 'projects', API_CLIENT_VERSION], queryFn: () => apiPcbCamListProjects({ limit: 50 }) })
const projects = computed(() => projectsQuery.data.value?.items ?? [])
const projectName = (id: string) => projects.value.find((p) => p.id === id)?.name ?? id.slice(0, 8)
const profilesQuery = useQuery({ queryKey: ['pcb-cam', 'profiles', API_CLIENT_VERSION], queryFn: apiPcbCamListFactoryProfiles })
const healthQuery = useQuery({ queryKey: ['pcb-cam', 'worker-health', API_CLIENT_VERSION], queryFn: apiPcbCamWorkerHealth, refetchInterval: 30_000 })

const jobsQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'jobs', projectFilter.value, quickFilter.value, keyword.value, pageSize.value, pageIndex.value, sortMode.value, API_CLIENT_VERSION]),
  queryFn: () =>
    apiPcbCamListJobs({
      projectId: projectFilter.value || undefined,
      status: quickStatuses.value.length ? quickStatuses.value : undefined,
      q: keyword.value || undefined,
      limit: pageSize.value,
      cursor: pageCursors.value[pageIndex.value],
      sort: sortMode.value,
    }),
  refetchInterval: 10_000,
})
const jobs = computed(() => jobsQuery.data.value?.items ?? [])
const hasNext = computed(() => Boolean(jobsQuery.data.value?.nextCursor))
function nextPage() {
  const c = jobsQuery.data.value?.nextCursor
  if (!c) return
  pageCursors.value[pageIndex.value + 1] = c
  pageIndex.value += 1
}
function prevPage() {
  if (pageIndex.value > 0) pageIndex.value -= 1
}
const activeFilters = computed(() => [
  projectFilter.value && { label: `项目:${projectName(projectFilter.value)}`, clear: () => (projectFilter.value = '') },
  keyword.value && { label: `搜索:${keyword.value}`, clear: () => (keywordInput.value = keyword.value = '') },
])
/** 列表里给用户看的是客户资料包的文件名,不是任务 uuid(uuid 放 title 里,要对账时能看到)。
    存储 key 形如 `…/input/<uuid>-<原文件名>`(core/storage putObject),去掉前面的 uuid。 */
function archiveName(row: PcbCamJobListItem): string {
  const keys = row.inputKeys ?? []
  const k = keys.find((x) => /\.(zip|rar|7z)$/i.test(x)) ?? keys[0]
  return k ? k.slice(k.lastIndexOf('/') + 1).replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '') : '-'
}

// ── 新建项目 ──
const projectDialog = ref(false)
const projectForm = ref({ name: '', customerName: '', factoryProfileId: '' })
const createProjectMutation = useMutation({
  mutationFn: () =>
    apiPcbCamCreateProject({
      name: projectForm.value.name,
      customerName: projectForm.value.customerName || null,
      factoryProfileId: projectForm.value.factoryProfileId || null,
    }),
  onSuccess: async (p) => {
    ElMessage.success('项目已创建')
    projectDialog.value = false
    projectForm.value = { name: '', customerName: '', factoryProfileId: '' }
    await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'projects'] })
    projectFilter.value = p.id
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// ── 上传 ──
const uploadDialog = ref(false)
const uploadProjectId = ref('')
const uploadFiles = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
function onFilesPicked(ev: Event) {
  uploadFiles.value = Array.from((ev.target as HTMLInputElement).files ?? [])
}
const hasArchive = computed(() => uploadFiles.value.some((f) => /\.(zip|rar|7z)$/i.test(f.name)))
const uploadMutation = useMutation({
  mutationFn: () => apiPcbCamUploadJob(uploadProjectId.value, uploadFiles.value, crypto.randomUUID()),
  onSuccess: async (job) => {
    ElMessage.success('资料已上传,开始整理')
    uploadDialog.value = false
    uploadFiles.value = []
    if (fileInput.value) fileInput.value.value = ''
    await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'jobs'] })
    openJob(job.id)
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
function openUpload() {
  uploadProjectId.value = projectFilter.value || projects.value[0]?.id || ''
  uploadDialog.value = true
}

// ── 任务抽屉 ──
const selectedJobId = ref<string | null>(null)
const drawerTab = ref<'todo' | 'timeline' | 'report' | 'plan' | 'preview' | 'compare' | 'mi' | 'artifacts'>('timeline')
function openJob(id: string) {
  selectedJobId.value = id
  drawerTab.value = 'timeline'
}
const jobQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'job', selectedJobId.value ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamGetJob(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value)),
  // 抽屉开着时任务可能被推进器 / 别的工程师推走(演示时 API 放行后抽屉停在「待确认」不动):
  // 跑着的 3s 一刷,停在人工节点的 10s 一刷,只有终态才不刷。
  refetchInterval: (q) => {
    const s = q.state.data?.status
    if (!s) return false
    if (s === 'pending' || s === 'running') return 3_000
    return s === 'needs_review' || s === 'blocked' ? 10_000 : false
  },
})
const job = computed(() => jobQuery.data.value ?? null)
/** 要人动手的任务:层确认 / 规格确认 / 问题点决策 / 阻断或失败后重跑。这些都收在「待处理」页签里,
    抽屉顶部只留一行状态,页签区才有整块高度放表格和板图(2026-09-07 评审:上半部太重)。 */
const needsAction = computed(() => Boolean(job.value && ['needs_review', 'blocked', 'failed'].includes(job.value.status)))
const todoCount = computed(() => (job.value?.eqPending ? job.value.eqPending : needsAction.value ? 1 : 0))
// 打开一个要处理的任务直接落在「待处理」;推进器把它推到人工节点时,只在用户还停在时间线上才跳过去(别打断看图)
watch(
  () => [job.value?.id, needsAction.value] as const,
  ([id, need], [prevId]) => {
    if (!id) return
    if (id !== prevId) drawerTab.value = need ? 'todo' : 'timeline'
    else if (need && drawerTab.value === 'timeline') drawerTab.value = 'todo'
    else if (!need && drawerTab.value === 'todo') drawerTab.value = 'timeline'
  },
)

// 打开的任务订阅后端推送(MODULE.md:stage 时间线要即时)。推来的 job 直接写进查询缓存,
// 时间线/问题点/成果物按钮都跟着走。上面的轮询保留作兜底:反向代理缓冲 SSE 时流可能不吐数据。
let stopJobStream: (() => void) | null = null
watch(
  selectedJobId,
  (id) => {
    stopJobStream?.()
    stopJobStream = null
    if (!id) return
    stopJobStream = apiPcbCamSubscribeJob(
      id,
      (j) => {
        if (selectedJobId.value !== j.id) return // 迟到的帧属于上一个任务
        queryClient.setQueryData(['pcb-cam', 'job', j.id, API_CLIENT_VERSION], j)
      },
      () => {
        stopJobStream = null // 流断了(终态/超时/代理)——轮询接着兜
      },
    )
  },
  { immediate: true },
)
onBeforeUnmount(() => stopJobStream?.())

async function refreshJob() {
  await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'job', selectedJobId.value ?? ''] })
  await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'jobs'] })
  await queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'job-stats'] })
}
// 每步跑完一记短音(推送来的 job 里 stage 状态变了)
watch(
  () => job.value?.stages.map((s) => `${s.stage}:${s.status}`).join(','),
  (cur, prev) => {
    if (!prev || !cur || cur === prev) return
    if (job.value?.status === 'done') sfx('done')
    else if (job.value?.status === 'failed' || job.value?.status === 'blocked') sfx('error')
    else sfx('stage')
  },
)
// 一键「放行并下发」:成果物 + 流程单 + 问单 + 决策记录一个包;盖章动效 + 一记章音
const stamping = ref(false)
const releaseMutation = useMutation({
  mutationFn: () => apiPcbCamRelease(selectedJobId.value!, `${projectName(job.value!.projectId)}-${job.value!.id.slice(0, 8)}-下发包.zip`),
  onSuccess: async () => {
    stamping.value = true
    sfx('stamp')
    setTimeout(() => (stamping.value = false), 1600)
    ElMessage.success('已下发:成果物 + 流程单 + 问单 已打包')
    await refreshJob()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
const eqSheetUrl = computed(() => (selectedJobId.value ? apiPcbCamEqSheetUrl(selectedJobId.value) : '#'))

// 层确认:把 layer_map.files 展开成可编辑行
type LayerRow = { file: string; type: string; index: number | null; side: string | null; polarity?: string | null; drill_span: string | null; confidence: number; reason: string; needs_llm?: boolean }
const COPPER_TYPES = new Set(['top_copper', 'inner_copper', 'bottom_copper'])
const layerRows = ref<LayerRow[]>([])
watch(
  () => job.value?.layerMap,
  (lm) => {
    const files = (lm as { files?: LayerRow[] } | null)?.files
    layerRows.value = Array.isArray(files) ? files.map((f) => ({ ...f })) : []
  },
  { immediate: true },
)
const confirmLayersMutation = useMutation({
  mutationFn: () => apiPcbCamConfirmLayers(selectedJobId.value!, { ...(job.value?.layerMap ?? {}), files: layerRows.value, confirmed: true }),
  onSuccess: async () => {
    ElMessage.success('层识别已确认,继续处理')
    await refreshJob()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// 规格确认:候选 JSON 文本编辑后提交
const orderSpecText = ref('')
watch(
  () => job.value?.orderSpecCandidate,
  (c) => {
    orderSpecText.value = c ? JSON.stringify(c, null, 2) : ''
  },
  { immediate: true },
)
/** 引擎 order_spec 阶段附在候选上的交叉核对结果(冲突 warn / 提示 info),不是 EQ:工程师改 JSON 后确认即可 */
const orderSpecChecks = computed<Array<{ level: string; message: string }>>(() => {
  const c = job.value?.orderSpecCandidate as { _checks?: unknown } | null | undefined
  return Array.isArray(c?._checks) ? (c!._checks as Array<{ level: string; message: string }>).filter((x) => x && typeof x.message === 'string') : []
})
const orderSpecError = computed(() => {
  if (!orderSpecText.value.trim()) return '规格不能为空'
  try {
    const v = JSON.parse(orderSpecText.value)
    return v && typeof v === 'object' && !Array.isArray(v) ? '' : '必须是 JSON 对象'
  } catch {
    return 'JSON 格式不正确'
  }
})
const confirmOrderSpecMutation = useMutation({
  mutationFn: () => apiPcbCamConfirmOrderSpec(selectedJobId.value!, JSON.parse(orderSpecText.value)),
  onSuccess: async () => {
    ElMessage.success('规格已确认,继续处理')
    await refreshJob()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

// 问题点决策整块在 parts/WorkbenchPane.vue(板图 + 决策流同屏、按组判、键盘连打、决策记忆)
// 重跑 / 取消
const retryStageSel = ref<PcbCamStage>('intake')
watch(job, (j) => {
  if (j?.currentStage) retryStageSel.value = j.currentStage
})
const retryMutation = useMutation({
  mutationFn: () => apiPcbCamRetryStage(selectedJobId.value!, retryStageSel.value),
  onSuccess: async () => {
    ElMessage.success('已安排重跑')
    await refreshJob()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
const cancelMutation = useMutation({
  mutationFn: () => apiPcbCamCancelJob(selectedJobId.value!),
  onSuccess: async () => {
    ElMessage.success('任务已取消')
    await refreshJob()
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})

const stageRun = (s: PcbCamStage) => job.value?.stages.find((r) => r.stage === s) ?? null

// 处理记录:引擎的操作序列(op_plan 成果物,每个 stage 后重算):每一步谁做的 —— 本地引擎(B 线)已执行 / 交 Genesis 脚本(A 线) / 需人工判断
type PlanCall = { n: number; stage: PcbCamStage; op: string; layer: string | null; kind: string; applied: boolean; needs_human: boolean; pages: number[]; item_ids: string[]; step?: string; params?: Record<string, unknown> }
const planQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'plan', selectedJobId.value ?? '', job.value?.updatedAt ?? '', API_CLIENT_VERSION]),
  queryFn: async () => {
    const { items } = await apiPcbCamListArtifacts(selectedJobId.value!)
    const latest = items.filter((a) => a.kind === 'op_plan').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
    if (!latest) return null
    return await apiPcbCamArtifactJson<{ calls: PlanCall[]; stages: string[]; problems?: string[]; notes?: string[] }>(latest.url)
  },
  enabled: computed(() => Boolean(selectedJobId.value) && drawerTab.value === 'plan'),
})
const planCalls = computed(() => planQuery.data.value?.calls ?? [])
const planStats = computed(() => {
  const c = planCalls.value
  return { total: c.length, applied: c.filter((x) => x.applied).length, human: c.filter((x) => !x.applied && x.needs_human).length, genesis: c.filter((x) => !x.applied && !x.needs_human).length }
})
const planStageFilter = ref<'' | PcbCamStage>('')
const planRows = computed(() => (planStageFilter.value ? planCalls.value.filter((c) => c.stage === planStageFilter.value) : planCalls.value))
function executorOf(c: PlanCall): { label: string; type: 'success' | 'warning' | 'info' } {
  if (c.applied) return { label: '本地引擎已执行(B 线)', type: 'success' }
  if (c.needs_human) return { label: '需人工判断(脚本在此停)', type: 'warning' }
  return { label: '交 Genesis 脚本(A 线)', type: 'info' }
}

/** 时间线一行的正文:计数已经用色块单独画了,这里把摘要里的「错误 x · 警告 y …」段去掉,只留这一步做了什么 */
function stageBrief(s: { summary: string; errorMessage: string | null }): string {
  const t = summaryLabel(s.summary).replace(/错误 \d+ · 警告 \d+ · 提示 \d+ · 需决策 \d+/, '').replace(/^[;;\s]+|[;;\s]+$/g, '')
  return t || s.errorMessage || ''
}

// 报告
const reportStage = ref<PcbCamStage>('intake')
watch(job, (j) => {
  if (j?.currentStage) reportStage.value = j.currentStage
})
const reportQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'report', selectedJobId.value ?? '', reportStage.value, job.value?.updatedAt ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamStageReport(selectedJobId.value!, reportStage.value),
  enabled: computed(() => Boolean(selectedJobId.value) && (drawerTab.value === 'report' || drawerTab.value === 'preview')),
})
const reportItems = computed(() => reportQuery.data.value?.report?.items ?? [])

// 报告明细折叠:同 类型+层+级别 的 warn/info 超过 GROUP_MIN 条就折成一行「×N」,点展开才铺开;
// error 永远单独列。阻焊阶段 163 条 mask_expansion 逐开窗明细把真正要看的项淹掉了(2026-09-07 演示)。
const GROUP_MIN = 6
type ReportRow = PcbCamReportItem & { _group?: string; _count?: number }
const reportSeverity = ref<'' | 'error' | 'warn'>('')
const expandedGroups = ref<Set<string>>(new Set())
watch([reportStage, selectedJobId], () => {
  expandedGroups.value = new Set()
})
const groupKey = (i: PcbCamReportItem) => `${i.kind}|${i.layer ?? ''}|${i.severity}`
const reportRows = computed<ReportRow[]>(() => {
  const items = reportItems.value.filter((i) => !reportSeverity.value || (reportSeverity.value === 'error' ? i.severity === 'error' : i.severity !== 'info'))
  const groups = new Map<string, number>()
  for (const i of items) if (i.severity !== 'error') groups.set(groupKey(i), (groups.get(groupKey(i)) ?? 0) + 1)
  const rows: ReportRow[] = []
  const folded = new Set<string>()
  for (const i of items) {
    const k = groupKey(i)
    const n = groups.get(k) ?? 0
    if (n < GROUP_MIN) {
      rows.push(i)
      continue
    }
    if (expandedGroups.value.has(k)) {
      rows.push(folded.has(k) ? i : { ...i, _group: k }) // 「收起」只挂在展开组的第一行
      folded.add(k)
      continue
    }
    if (folded.has(k)) continue
    folded.add(k)
    rows.push({ ...i, _group: k, _count: n, message: `共 ${n} 处,例如:${i.message}` })
  }
  return rows
})
// 按筛选后的条数算:选「只看错误」时没有折叠任何东西,不能拿未筛选的总数去减
const foldedCount = computed(() => {
  const shown = reportItems.value.filter((i) => !reportSeverity.value || (reportSeverity.value === 'error' ? i.severity === 'error' : i.severity !== 'info'))
  return shown.length - reportRows.value.length
})
function toggleGroup(k: string) {
  const next = new Set(expandedGroups.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  expandedGroups.value = next
}

// 图上定位:报告项带 location(mm, y 向上)→ 在层预览的内联 SVG 里叠加高亮框;选中一项时 viewBox 缩放到该处
const highlightId = ref<string | null>(null)
// 定位框是单只坐标;工作板预览的画框是整块工作板,叠上去位置对不上 —— 那里不画
const overlayItems = computed(() =>
  isPanelLayer(previewLayer.value) || previewLayer.value.startsWith('_')
    ? []
    : reportItems.value.filter((i) => i.location?.bbox && (!i.layer || i.layer === previewLayer.value)),
)
function locate(row: PcbCamReportItem) {
  if (row.layer && layerOptions.value.includes(row.layer)) previewLayer.value = row.layer
  else if (!previewLayer.value && layerOptions.value[0]) previewLayer.value = layerOptions.value[0]
  highlightId.value = row.id
  drawerTab.value = 'preview'
}
function resetView() {
  highlightId.value = null
}

// ── 层预览全屏 ──
// 抽屉里的预览只有半屏,看整板细节不够。全屏用一个盖满视口的浮层(Teleport 到 body,避开抽屉的
// 滚动与层级),同时尝试浏览器原生全屏(能盖住浏览器工具栏,内嵌页面里可能被拒,拒了就只用浮层)。
const previewFullscreen = ref(false)
const previewStageEl = ref<HTMLElement | null>(null)
function onFsChange() {
  if (document.fullscreenElement) return
  if (previewFullscreen.value) previewFullscreen.value = false
  if (cmpFullscreen.value) cmpFullscreen.value = false
}
function onFsKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || document.fullscreenElement) return
  if (previewFullscreen.value) previewFullscreen.value = false
  if (cmpFullscreen.value) cmpFullscreen.value = false
}
/** ↑/↓ 直接切上一层/下一层(抽屉的「层预览」页和全屏都生效);焦点在输入框/下拉里时不抢键。 */
function onPreviewKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  if (!previewFullscreen.value && !(selectedJobId.value && drawerTab.value === 'preview')) return
  const t = e.target
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"], .el-select, .el-slider')) return
  const all = previewOptions.value
  if (all.length === 0) return
  const i = all.indexOf(previewLayer.value)
  const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length
  previewLayer.value = all[next]!
  e.preventDefault()
}
onMounted(() => document.addEventListener('keydown', onPreviewKey))
async function enterPreviewFullscreen() {
  previewFullscreen.value = true
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('keydown', onFsKey)
  await nextTick()
  try {
    await previewStageEl.value?.requestFullscreen?.()
  } catch {
    // 原生全屏被拒(内嵌 iframe / 权限策略)——浮层已经盖满视口,继续用浮层
  }
}
async function exitPreviewFullscreen() {
  previewFullscreen.value = false
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('keydown', onFsKey)
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
}
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('keydown', onFsKey)
  document.removeEventListener('keydown', onPreviewKey)
})
const svgWithOverlay = computed(() => {
  const svg = svgQuery.data.value
  if (!svg) return svg
  const askRects = askOnLayer.value
    .map((h) => {
      const [x0, y0, x1, y1] = h.bbox
      return `<rect class="pcb-ask" x="${x0}" y="${y0}" width="${Math.max(x1 - x0, 0.05)}" height="${Math.max(y1 - y0, 0.05)}" vector-effect="non-scaling-stroke"><title>${escapeXml(`${h.kind}${h.measured != null ? ` ${h.measured} mm` : ''}${h.symbol ? ` ${h.symbol}` : ''}${h.net ? ` ${h.net}` : ''}${h.op ? ` ${h.op}` : ''}`)}</title></rect>`
    })
    .join('')
  const rects = overlayItems.value
    .map((i) => {
      const [x0, y0, x1, y1] = i.location!.bbox!
      const sel = i.id === highlightId.value
      const cls = `pcb-hit pcb-hit--${i.severity}${sel ? ' pcb-hit--selected' : ''}`
      const w = Math.max(x1 - x0, 0.05)
      const h = Math.max(y1 - y0, 0.05)
      return `<rect class="${cls}" x="${x0}" y="${y0}" width="${w}" height="${h}" vector-effect="non-scaling-stroke"><title>${escapeXml(i.message)}</title></rect>`
    })
    .join('')
  const base = showCompare.value ? recolor(svg, layerColor(previewLayer.value)) : svg
  const out = base.replace(/<\/svg>\s*$/, `<g class="pcb-overlay" transform="scale(1,-1)" fill="none">${rects}${askRects}</g></svg>`)
  return applyViewBox(out)
})
/** 选中一条定位项时,把 viewBox 缩放到那一处;主层与对照层共用,两者才会同步缩放。 */
function applyViewBox(svg: string): string {
  const sel = overlayItems.value.find((i) => i.id === highlightId.value)
  if (!sel?.location?.bbox) return svg
  const [x0, y0, x1, y1] = sel.location.bbox
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 1.5
  return svg.replace(/viewBox="[^"]*"/, `viewBox="${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}"`)
}
function escapeXml(t: string): string {
  return t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
}

// 预览:取 SVG 文本内联(worker 产出,经服务端代理)
const previewLayer = ref('')
const layerOptions = computed(() => layerRows.value.filter((r) => !r.type.startsWith('drill') && r.type !== 'unknown').map((r) => r.file))
// 工作板副本:本地引擎拼板后每层 nx×ny 的实图(`panel:<file>`,worker ?step=panel);`_panel` 只是排布方案图
const isPanelLayer = (l: string) => l.startsWith('panel:')
const panelLayerOptions = computed(() => (job.value?.stages.find((r) => r.stage === 'panel')?.status === 'ok' ? layerOptions.value.map((f) => `panel:${f}`) : []))
const previewOptions = computed(() => [...layerOptions.value, ...panelLayerOptions.value, '_panel'])
// 定位目标所在的层:报告(可能是刚切过来才开始加载)到了就把主层切过去
watch([highlightId, reportItems], ([hid, items]) => {
  if (!hid) return
  const hit = items.find((i) => i.id === hid)
  if (hit?.layer && layerOptions.value.includes(hit.layer) && previewLayer.value !== hit.layer) previewLayer.value = hit.layer
})
// 进「层预览」不该是空白:没选层时挑当前这步报告里错误最多的那层,否则第一层铜
watch([drawerTab, layerOptions, reportItems], ([tab, layers, items]) => {
  if (tab !== 'preview' || previewLayer.value || layers.length === 0) return
  const score = new Map<string, number>()
  for (const i of items) if (i.layer && i.location && layers.includes(i.layer)) score.set(i.layer, (score.get(i.layer) ?? 0) + (i.severity === 'error' ? 10 : 1))
  const best = [...score.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const copper = layerRows.value.find((r) => COPPER_TYPES.has(r.type) && layers.includes(r.file))?.file
  previewLayer.value = best ?? copper ?? layers[0]!
})
// worker 按文件名找层(第一块真板:26 个层共用一个主干名「六层内外3oz (1)」,只去扩展名会全指到第一层)
const stem = (f: string) => f.replace(/^panel:/, '')
// 画框:真实层按板外形出图(各层同坐标系,叠加才不会错位);工作板层按工作板出图;`_panel` 是拼板阶段自带画框的预览
const frameOf = (layer: string) => (layer.startsWith('_') ? undefined : ('board' as const))
const stepOf = (layer: string) => (isPanelLayer(layer) ? ('panel' as const) : undefined)
const svgQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'svg', selectedJobId.value ?? '', previewLayer.value, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamLayerSvg(selectedJobId.value!, stem(previewLayer.value), frameOf(previewLayer.value), undefined, stepOf(previewLayer.value)),
  enabled: computed(() => Boolean(selectedJobId.value && previewLayer.value) && drawerTab.value === 'preview'),
})

// ── 多层叠加对照(第6/7章:内外层、阻焊与线路要对着看) ──
// 主层在最上层(定位框挂在它上面),选中的对照层按各自的层色半透明垫在下面;
// 全部用 frame=board 出图,viewBox 一致才叠得准。
const compareLayers = ref<string[]>([])
const compareOptions = computed(() => layerOptions.value.filter((f) => f !== previewLayer.value))
/** 拼板预览(`_panel`)是阶段产出的整版图,自带画框,跟单层不同坐标系 —— 此时不叠对照层
    (选择保留,切回真实层就恢复) */
/** 对原稿(p144「这一步很关键」):把客户原稿(src)半透明垫在 edit 副本下面,改过的地方一眼能看出 */
const compareOrig = ref(false)
const ORIG_KEY = '__orig__'
const showCompare = computed(() => !previewLayer.value.startsWith('_') && !isPanelLayer(previewLayer.value) && (compareLayers.value.length > 0 || compareOrig.value))
/** 叠加对照时按选中顺序取色:两个内层的层类型相同,用类型色会同色,分不出谁是谁 */
const STACK_COLORS = ['#c8322b', '#2b5fc8', '#1f9d55', '#b07a2b', '#7a2bb0', '#0891b2', '#c2410c', '#4d7c0f']
const stackPalette = computed(
  () => new Map([previewLayer.value, ...compareLayers.value].map((l, i) => [l, STACK_COLORS[i % STACK_COLORS.length]!])),
)
/** worker 出的 SVG 根 <g> 上带层类型色;叠加时按调色板改写,图例才对得上 */
function recolor(svg: string, color: string): string {
  return svg.replace(/(<g transform="scale\(1,-1\)"[^>]*?)fill="#[0-9a-fA-F]{3,8}"/, `$1fill="${color}"`)
}
/** 与 worker engine/geom/svg.py 的 LAYER_COLORS 对齐:单层查看时用层类型色(颜色本身有含义) */
const LAYER_COLOR: Record<string, string> = {
  top_copper: '#c8322b', bottom_copper: '#2b5fc8', inner_copper: '#b07a2b',
  top_mask: '#7a2bb0', bottom_mask: '#2bb0a0', top_silk: '#e6c800', bottom_silk: '#a0a000',
  top_paste: '#888888', bottom_paste: '#666666', outline: '#000000',
  drill_pth: '#111111', drill_npth: '#444444', drill_unknown: '#444444', drill_blind: '#333333',
}  // eslint-disable-line @stylistic/object-property-newline
function layerColor(file: string): string {
  if (file === ORIG_KEY) return '#6b7280'
  if (showCompare.value) return stackPalette.value.get(file) ?? '#333333'
  const t = layerRows.value.find((r) => r.file === file)?.type
  return (t && LAYER_COLOR[t]) || '#333333'
}
// 自然语言查板的命中:叠在当前层上(青色框);命中最多的层若不是当前层,切过去
const askHits = ref<PcbCamQueryHit[]>([])
function onAskHits(hits: PcbCamQueryHit[], byLayer: Record<string, number>) {
  askHits.value = hits
  const best = Object.entries(byLayer).sort((a, b) => b[1] - a[1])[0]?.[0]
  if (best && layerOptions.value.includes(best) && !byLayer[stem(previewLayer.value)]) previewLayer.value = best
  highlightId.value = null
}
const askOnLayer = computed(() => askHits.value.filter((h) => h.layer === stem(previewLayer.value)))
// 层预览的模式:平面(默认)/ 叠层 3D(爆炸视图)/ 时间轴(从原稿刷到生产稿)
const previewMode = ref<'flat' | 'stack' | 'scrub'>('flat')
const scrubLayer = ref('')
watch(previewLayer, (v) => { if (!v.startsWith('_') && !isPanelLayer(v)) scrubLayer.value = v })
const stackLayers = computed(() => layerRows.value.filter((r) => !r.type.startsWith('drill') && r.type !== 'unknown').map((r) => ({ file: r.file, type: r.type })))
const stackColor = (_file: string, type: string) => LAYER_COLOR[type] ?? '#333333'
// 进场扫描线(示波器皮肤):板图换了就扫一次
const scanning = ref(false)
let scanTimer: ReturnType<typeof setTimeout> | null = null
watch(() => svgQuery.data.value, (v) => {
  if (!v || !scopeOn.value) return
  scanning.value = false
  requestAnimationFrame(() => {
    scanning.value = true
    if (scanTimer) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => (scanning.value = false), 1200)
  })
})
const compareOpacity = ref(0.45)
watch(previewLayer, (v) => {
  compareLayers.value = compareLayers.value.filter((l) => l !== v)
})
const compareQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'svg-compare', selectedJobId.value ?? '', previewLayer.value, compareOrig.value, [...compareLayers.value].sort().join('|'), API_CLIENT_VERSION]),
  queryFn: async () => {
    const id = selectedJobId.value!
    const layers = [...compareLayers.value]
    const svgs = await Promise.all(layers.map((l) => apiPcbCamLayerSvg(id, stem(l), frameOf(l))))
    const out = layers.map((layer, i) => ({ layer, svg: svgs[i]! }))
    if (compareOrig.value && previewLayer.value && !previewLayer.value.startsWith('_')) {
      out.push({ layer: ORIG_KEY, svg: await apiPcbCamLayerSvg(id, stem(previewLayer.value), frameOf(previewLayer.value), 'orig') })
    }
    return out
  },
  enabled: computed(() => Boolean(selectedJobId.value) && showCompare.value && drawerTab.value === 'preview'),
})
/** 对照层跟着主层一起缩放:主层 locate 后 viewBox 变了,这里同步改写 */
const compareSvgs = computed(() =>
  showCompare.value
    ? (compareQuery.data.value ?? []).map((e) => ({ layer: e.layer, svg: applyViewBox(recolor(e.svg, layerColor(e.layer))) }))
    : [],
)

// ── 终稿对比:系统输出 vs 人工终稿(工程师改好的成品),逐层自动对比、标出差异 ──
// 数据来自 worker engine/compare.py:每层按差异带宽度分三档(<0.01 噪声 / 0.01–0.1 尺寸差 / >0.1 形体差),
// 形体差聚成「簇」= 一处一边有一边没有的东西;这才是看 AI 改得对不对的清单,百分比只给参考。
const cmpOutputStatus = computed(() => job.value?.stages.find((r) => r.stage === 'output')?.status ?? '')
const compareQuery2 = useQuery({
  // 键里带「输出」步的状态:任务跑到输出之前切进来会拿到「还没有输出」,输出一完成要自动重取,不能让人手点刷新
  queryKey: computed(() => ['pcb-cam', 'compare', selectedJobId.value ?? '', cmpOutputStatus.value, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamCompare(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value) && drawerTab.value === 'compare'),
  staleTime: 60_000,
})
const cmpData = computed(() => compareQuery2.data.value ?? null)
const cmpLayers = computed(() => cmpData.value?.layers ?? [])
const cmpLayer = ref('')
watch([cmpLayers, drawerTab], ([layers, tab]) => {
  if (tab !== 'compare' || layers.length === 0) return
  if (!layers.some((l) => l.suffix === cmpLayer.value)) {
    // 进来先看差得最厉害的那层(字符层不算:字体不同,几何差不代表内容差)
    const judged = layers.filter((l) => !l.note)
    const worst = [...(judged.length ? judged : layers)].sort((a, b) => b.shape_pct - a.shape_pct)[0]
    cmpLayer.value = worst?.suffix ?? layers[0]!.suffix
  }
})
const cmpCurrent = computed<PcbCamCompareLayer | null>(() => cmpLayers.value.find((l) => l.suffix === cmpLayer.value) ?? null)
const cmpSvgQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'compare-svg', selectedJobId.value ?? '', cmpLayer.value, cmpOutputStatus.value, cmpData.value?.golden_files.join('|') ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamCompareSvg(selectedJobId.value!, cmpLayer.value),
  enabled: computed(() => Boolean(selectedJobId.value && cmpLayer.value) && drawerTab.value === 'compare'),
  staleTime: 5 * 60_000,
})
// 拉帘模式(左我们的、右终稿)与差异热力小地图
const cmpCurtain = ref(false)
const cmpFrame = computed(() => viewBoxOf(cmpSvgQuery.data.value))
// 任务头上的信任仪表:终稿对比一句话(有终稿且输出完成才有;worker 侧缓存,不重算)
const trustQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'compare', selectedJobId.value ?? '', cmpOutputStatus.value, API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamCompare(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value) && cmpOutputStatus.value === 'ok'),
  staleTime: 60_000,
  retry: false,
})
const trust = computed(() => {
  const d = trustQuery.data.value
  if (!d || !d.has_golden) return null
  const judged = d.layers.filter((l) => !l.note)
  const clusters = judged.reduce((a, l) => a + l.n_clusters, 0)
  const clean = judged.filter((l) => l.n_clusters === 0).length
  const worst = [...judged].sort((a, b) => b.n_clusters - a.n_clusters)[0]
  return { clusters, layers: judged.length, clean, worst: worst && worst.n_clusters ? `${worst.suffix} ${worst.n_clusters} 处` : null, drill: d.drill ? d.drill.n_mismatch === 0 : null }
})
/** 图上显示什么:终稿灰底 / 客户原稿(琥珀) / 我们的 / 少了(红) / 多了(蓝) / 簇框 —— 用 CSS 类切换,SVG 不重取 */
const cmpShow = ref({ gold: true, orig: true, ours: true, missing: true, extra: true, boxes: true })
const cmpOursOpacity = ref(0.35)
const cmpSelected = ref<number | null>(null)
const cmpDir = ref<'all' | 'missing' | 'extra' | 'changed'>('all')
const cmpClusterList = computed<PcbCamCompareCluster[]>(() => {
  const all = cmpCurrent.value?.clusters ?? []
  return cmpDir.value === 'all' ? all : all.filter((c) => c.direction === cmpDir.value)
})
/** 选中一簇:viewBox 缩到那一处(留 1.5 倍边距),并给对应的框加高亮类 */
const cmpSvg = computed(() => {
  const svg = cmpSvgQuery.data.value
  if (!svg) return svg
  let out = svg
  const sel = cmpSelected.value
  if (sel !== null) {
    const c = (cmpCurrent.value?.clusters ?? []).find((x) => x.id === sel)
    if (c) {
      const [x0, y0, x1, y1] = c.bbox
      const pad = Math.max(x1 - x0, y1 - y0, 1) * 1.5
      out = out.replace(/viewBox="[^"]*"/, `viewBox="${x0 - pad} ${-(y1 + pad)} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}"`)
      // rect 已有 class 属性,再加一个 class= 浏览器只认第一个 —— 要改写原来的那个
      out = out.replace(`class="cmp-cluster cmp-cluster--${c.direction}" data-cluster="${sel}"`, `class="cmp-cluster cmp-cluster--${c.direction} cmp-cluster--selected" data-cluster="${sel}"`)
    }
  }
  return out
})
function cmpLocate(c: PcbCamCompareCluster) {
  cmpSelected.value = cmpSelected.value === c.id ? null : c.id
}
watch(cmpLayer, () => {
  cmpSelected.value = null
})
const cmpStageClass = computed(() => ({
  'cmp-stage': true,
  'cmp-hide-gold': !cmpShow.value.gold,
  'cmp-hide-orig': !cmpShow.value.orig,
  'cmp-hide-ours': !cmpShow.value.ours,
  'cmp-hide-missing': !cmpShow.value.missing,
  'cmp-hide-extra': !cmpShow.value.extra,
  'cmp-hide-boxes': !cmpShow.value.boxes,
}))
const cmpOursStyle = computed(() => ({ '--cmp-ours-opacity': String(cmpOursOpacity.value) }))
// ── 终稿对比全屏:和层预览同一套做法(Teleport 浮层 + 尽量原生全屏),叠加图和差异清单并排铺满视口 ──
const cmpFullscreen = ref(false)
const cmpStageEl = ref<HTMLElement | null>(null)
async function enterCmpFullscreen() {
  cmpFullscreen.value = true
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('keydown', onFsKey)
  await nextTick()
  try {
    await cmpStageEl.value?.requestFullscreen?.()
  } catch {
    // 原生全屏被拒 —— 浮层已经盖满视口
  }
}
async function exitCmpFullscreen() {
  cmpFullscreen.value = false
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('keydown', onFsKey)
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
}
// 上传人工终稿(zip 或散 Gerber);传完重取对比
const goldenInput = ref<HTMLInputElement | null>(null)
const goldenMutation = useMutation({
  mutationFn: (files: File[]) => apiPcbCamUploadGolden(selectedJobId.value!, files),
  onSuccess: (m) => {
    const n = m.layers.filter((l) => l.golden).length
    if (m.errors.length) ElMessage.warning(`终稿已收下,但有 ${m.errors.length} 个文件没解开:${m.errors[0]}`)
    else if (n === 0) ElMessage.warning('终稿收下了,但没有一层能和输出按后缀配上对(要和输出文件同后缀:.gtl / .l2 / .gts / .drl …)')
    else ElMessage.success(`人工终稿已配上 ${n} 层${m.unmatched_output.length ? `,还有 ${m.unmatched_output.length} 层输出没找到对应终稿` : ''}`)
    cmpSelected.value = null
    void queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'compare', selectedJobId.value ?? ''] })
    void queryClient.invalidateQueries({ queryKey: ['pcb-cam', 'compare-svg', selectedJobId.value ?? ''] })
  },
  onError: (e) => ElMessage.error(errorMessage(e)),
})
function onGoldenPick(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (files.length) goldenMutation.mutate(files)
}
const CMP_DIR_LABEL = { missing: '人有我们没有', extra: '我们有人没有', changed: '两边都有、形状不同' } as const
function cmpDirLabel(d: PcbCamCompareCluster['direction']) {
  return CMP_DIR_LABEL[d]
}
function cmpPct(v: number) {
  return v < 0.005 && v > 0 ? '<0.01%' : `${v.toFixed(2)}%`
}
function cmpTypeLabel(l: PcbCamCompareLayer) {
  return `${layerTypeLabel(l.type)} ${l.suffix}`
}
/** 一行的判语:差异簇数 = 0 才叫「一致」;百分比不当门槛 */
function cmpVerdict(l: PcbCamCompareLayer): { text: string; type: 'success' | 'warning' | 'danger' | 'info' } {
  if (l.note) return { text: '字体差,不评', type: 'info' }
  if (l.n_clusters === 0) return { text: '一致', type: 'success' }
  if (l.n_clusters <= 10) return { text: `${l.n_clusters} 处差异`, type: 'warning' }
  return { text: `${l.n_clusters} 处差异`, type: 'danger' }
}

// MI 流程单(确定性板型判定 + 第 17 章模板;规格确认后会重算)
const miQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'mi', selectedJobId.value ?? '', job.value?.updatedAt ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamMiSheet(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value) && drawerTab.value === 'mi'),
})
const stackupQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'stackup', selectedJobId.value ?? '', job.value?.updatedAt ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamStackupSvg(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value) && drawerTab.value === 'mi'),
})
const miDownloading = ref(false)
async function downloadMi() {
  if (!job.value) return
  miDownloading.value = true
  try {
    await apiPcbCamDownloadMiSheet(job.value.id, `MI-${projectName(job.value.projectId)}-${job.value.id.slice(0, 8)}.html`)
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    miDownloading.value = false
  }
}

// 成果物
const artifactsQuery = useQuery({
  queryKey: computed(() => ['pcb-cam', 'artifacts', selectedJobId.value ?? '', job.value?.updatedAt ?? '', API_CLIENT_VERSION]),
  queryFn: () => apiPcbCamListArtifacts(selectedJobId.value!),
  enabled: computed(() => Boolean(selectedJobId.value) && drawerTab.value === 'artifacts'),
})
// 要交出去的(钻带 / Gerber / 锣带 / 网表 / 脚本 / 流程单 / 报告)和引擎的过程数据分开摆;过程数据默认收起
// 镜像自 modules/pcb-cam/model.ts PCB_CAM_DELIVERABLE_KINDS(model 带 drizzle,不能进浏览器包)
const DELIVERABLE_KINDS = new Set(['drill', 'drill_panel', 'gerber_panel', 'gerber_review', 'rout', 'ipc356', 'genesis_script', 'mi_sheet', 'stackup_svg', 'eq_report'])
const DELIVERABLE_ORDER = ['gerber_panel', 'drill_panel', 'rout', 'drill', 'gerber_review', 'ipc356', 'genesis_script', 'mi_sheet', 'stackup_svg', 'eq_report']
// 与 logic.ts isDeliverable 同一规则:输出阶段已按厂规重命名钻带后,钻孔阶段的过程钻带归过程文件
const isDeliverable = (a: PcbCamArtifactDTO, all: PcbCamArtifactDTO[]) =>
  DELIVERABLE_KINDS.has(a.kind) && !(a.kind === 'drill' && a.stage === 'drill' && all.some((x) => x.kind === 'drill' && x.stage === 'output'))
const deliverables = computed(() =>
  (artifactsQuery.data.value?.items ?? [])
    .filter((a, _i, all) => isDeliverable(a, all))
    .sort((a, b) => DELIVERABLE_ORDER.indexOf(a.kind) - DELIVERABLE_ORDER.indexOf(b.kind) || a.filename.localeCompare(b.filename)),
)
const processFiles = computed(() => (artifactsQuery.data.value?.items ?? []).filter((a, _i, all) => !isDeliverable(a, all)))
const processOpen = ref(false)
const zipBusy = ref<'' | 'deliverables' | 'all'>('')
async function downloadZip(group: 'deliverables' | 'all') {
  if (!job.value || zipBusy.value) return
  zipBusy.value = group
  try {
    const stem = `${projectName(job.value.projectId)}-${job.value.id.slice(0, 8)}`
    await apiPcbCamDownloadArtifactsZip(job.value.id, group, group === 'all' ? `${stem}-全部文件.zip` : `${stem}-成果物.zip`)
  } catch (e) {
    ElMessage.error(errorMessage(e))
  } finally {
    zipBusy.value = ''
  }
}
/** 文件名里的任务 uuid 对人没意义,显示时缩成 8 位(下载还是原名) */
const shortName = (f: string) => f.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, (m) => m.slice(0, 8))
</script>

<template>
  <section class="module-surface module-surface--fill" :class="{ 'pcb-scope': scopeOn }">
    <div class="module-toolbar">
      <div class="toolbar-left">
        <p class="t-caption">上传客户资料包,系统按工厂标准逐步整理、检查并生成钻带 / 流程单 / 问题点报告;需要人判断的地方会停下来等你确认。</p>
      </div>
      <div class="toolbar-actions">
        <el-tag v-if="healthQuery.data.value?.ok" type="success" effect="plain" round size="small" class="engine-pill">CAM 引擎在线</el-tag>
        <el-button size="small" text :title="scopeOn ? '关掉示波器皮肤' : '示波器皮肤:深底铜绿、网格、扫描线'" @click="toggleScope">{{ scopeOn ? '◉ 示波器' : '○ 示波器' }}</el-button>
        <el-button size="small" text :title="sfxOn ? '关提示音' : '每步完成 / 判一条 / 放行盖章各一记短音'" @click="toggleSfx">{{ sfxOn ? '🔔' : '🔕' }}</el-button>
        <el-button v-if="canOperate" :icon="FolderPlus" @click="projectDialog = true">新建项目</el-button>
        <el-button v-if="canConfig" @click="openProfileDialog">工厂标准</el-button>
        <el-button v-if="canOperate" type="primary" :icon="Upload" :disabled="projects.length === 0" @click="openUpload">上传资料</el-button>
        <el-button :icon="RefreshCw" :loading="jobsQuery.isFetching.value" @click="jobsQuery.refetch()">刷新</el-button>
      </div>
    </div>

    <!-- 引擎不在线要一眼看到:上传能成功但任务推不动,不提示的话用户会以为系统卡死 -->
    <el-alert
      v-if="healthQuery.data.value && !healthQuery.data.value.ok"
      type="error" :closable="false" show-icon class="job-alert"
      :title="`CAM 引擎离线:${healthQuery.data.value.detail ?? '连不上 pcb-worker'}。引擎恢复前新任务不会推进,已上传的任务会排队。`"
    />
    <!-- 工作队列的三个数:一个人一天该干什么,先看这里 -->
    <div v-if="stats" class="qstat">
      <button type="button" class="qstat__card" :class="{ 'qstat__card--active': quickFilter === 'mine' }" @click="quickFilter = quickFilter === 'mine' ? '' : 'mine'">
        <span class="qstat__n" :class="{ 'qstat__n--hot': stats.mine.jobs > 0 }">{{ stats.mine.jobs }}</span>
        <span class="qstat__l">待我处理的单<i v-if="stats.mine.decisions"> · {{ stats.mine.decisions }} 条决策</i><i v-if="stats.mine.oldestWaitingAt"> · 最久等了 {{ ago(stats.mine.oldestWaitingAt) }}</i></span>
      </button>
      <button type="button" class="qstat__card" :class="{ 'qstat__card--active': quickFilter === 'active' }" @click="quickFilter = quickFilter === 'active' ? '' : 'active'">
        <span class="qstat__n">{{ stats.running }}</span><span class="qstat__l">引擎在跑</span>
      </button>
      <button type="button" class="qstat__card" :class="{ 'qstat__card--active': quickFilter === 'done' }" @click="quickFilter = quickFilter === 'done' ? '' : 'done'">
        <span class="qstat__n">{{ stats.doneToday }}</span><span class="qstat__l">今天完成<i v-if="stats.releasedToday"> · 下发 {{ stats.releasedToday }}</i><i> · 累计 {{ stats.done }}</i></span>
      </button>
    </div>
    <FilterBar :active="activeFilters">
      <div class="filter-bar__field">
        <el-radio-group v-model="quickFilter" size="small">
          <el-radio-button v-for="f in QUICK_FILTERS" :key="f.value" :value="f.value">{{ f.label }}</el-radio-button>
        </el-radio-group>
      </div>
      <div class="filter-bar__field">
        <el-radio-group v-model="sortMode" size="small">
          <el-radio-button value="queue" title="该谁动排前面,等得久的在前">队列</el-radio-button>
          <el-radio-button value="newest" title="按上传时间倒序">最新</el-radio-button>
        </el-radio-group>
      </div>
      <div class="filter-bar__field">
        <span class="t-label">项目</span>
        <el-select v-model="projectFilter" clearable filterable placeholder="全部项目">
          <el-option v-for="p in projects" :key="p.id" :label="p.customerName ? `${p.name}(${p.customerName})` : p.name" :value="p.id" />
        </el-select>
      </div>
      <div class="filter-bar__field">
        <el-input v-model="keywordInput" clearable placeholder="搜项目 / 客户 / 任务号" class="keyword-input" />
      </div>
    </FilterBar>

    <div class="list-fill">
      <AsyncState
        :loading="jobsQuery.isLoading.value"
        :error="jobsQuery.error.value && !isForbidden(jobsQuery.error.value) ? errorMessage(jobsQuery.error.value) : null"
        :forbidden="isForbidden(jobsQuery.error.value)"
        :empty="jobs.length === 0"
        empty-title="还没有 CAM 任务"
        empty-hint="先新建一个项目,再上传客户的 Gerber 资料包(zip)和制作要求附件"
        @retry="jobsQuery.refetch"
      >
        <template #empty-action>
          <el-button v-if="canOperate && projects.length === 0" type="primary" @click="projectDialog = true">新建项目</el-button>
          <el-button v-else-if="canOperate" type="primary" @click="openUpload">上传资料</el-button>
        </template>
        <section class="panel panel--flush list-fill">
          <el-table v-if="!isMobile" :data="jobs" stripe height="100%" :row-class-name="rowClass" @row-click="(row: PcbCamJobListItem) => openJob(row.id)">
            <el-table-column label="项目 / 客户" min-width="200" show-overflow-tooltip>
              <template #default="{ row }: { row: PcbCamJobListItem }">{{ row.projectName }}<span v-if="row.customerName" class="t-caption"> · {{ row.customerName }}</span></template>
            </el-table-column>
            <el-table-column label="资料包" min-width="150" show-overflow-tooltip>
              <template #default="{ row }: { row: PcbCamJobListItem }"><span :title="`任务号 ${row.id}`">{{ archiveName(row) }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }: { row: PcbCamJobListItem }">
                <el-tag :type="JOB_STATUS[row.status].type" effect="light" round size="small">{{ JOB_STATUS[row.status].label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="要我判" width="80" align="right">
              <template #default="{ row }: { row: PcbCamJobListItem }"><b v-if="row.eqPending" class="cnt cnt--decide">{{ row.eqPending }} 条</b><span v-else class="t-caption">-</span></template>
            </el-table-column>
            <el-table-column label="等了多久" width="100">
              <template #default="{ row }: { row: PcbCamJobListItem }"><span v-if="waiting(row)" :class="['wait', `wait--${waiting(row)!.level}`]">{{ waiting(row)!.text }}</span><span v-else class="t-caption">-</span></template>
            </el-table-column>
            <el-table-column label="当前步骤 / 等什么" min-width="220" show-overflow-tooltip>
              <template #default="{ row }: { row: PcbCamJobListItem }">{{ row.currentStage ? STAGE_LABEL[row.currentStage] : '-' }}<span v-if="row.reviewReason || row.errorMessage" class="t-caption"> · {{ row.reviewReason ? REVIEW_LABEL[row.reviewReason] ?? row.reviewReason : row.errorMessage }}</span></template>
            </el-table-column>
            <el-table-column label="更新时间" width="150">
              <template #default="{ row }: { row: PcbCamJobListItem }">{{ fmt(row.updatedAt) }}</template>
            </el-table-column>
          </el-table>
          <div v-else class="crm-card-list">
            <div v-for="row in jobs" :key="row.id" class="crm-card" @click="openJob(row.id)">
              <div class="crm-card__head">
                <span class="crm-card__title">{{ projectName(row.projectId) }}</span>
                <el-tag :type="JOB_STATUS[row.status].type" effect="light" round size="small">{{ JOB_STATUS[row.status].label }}</el-tag>
              </div>
              <div class="crm-card__meta">
                <span>{{ archiveName(row) }}</span>
                <span>{{ row.currentStage ? STAGE_LABEL[row.currentStage] : '-' }}</span>
                <span>{{ row.reviewReason ? REVIEW_LABEL[row.reviewReason] ?? row.reviewReason : '' }}</span>
                <span>{{ fmt(row.updatedAt) }}</span>
              </div>
            </div>
          </div>
        </section>
      </AsyncState>
    </div>
    <div v-if="jobs.length > 0" class="list-pager">
      <el-pagination
        layout="sizes, prev, next"
        :page-sizes="[10, 20, 50]"
        v-model:page-size="pageSize"
        :current-page="pageIndex + 1"
        :page-count="hasNext ? pageIndex + 2 : pageIndex + 1"
        @prev-click="prevPage"
        @next-click="nextPage"
      />
    </div>

    <!-- 新建项目 -->
    <el-dialog v-model="projectDialog" title="新建 CAM 项目" width="520px" destroy-on-close>
      <el-form label-position="top" @submit.prevent="createProjectMutation.mutate()">
        <el-form-item label="项目名称" required>
          <el-input v-model="projectForm.name" maxlength="120" placeholder="如:客户料号 / 板名" />
        </el-form-item>
        <el-form-item label="客户">
          <el-input v-model="projectForm.customerName" maxlength="120" />
        </el-form-item>
        <el-form-item label="工厂标准">
          <el-select v-model="projectForm.factoryProfileId" clearable placeholder="不选则用租户默认 / 内置通用值">
            <el-option v-for="p in profilesQuery.data.value?.items ?? []" :key="p.id" :label="p.isDefault ? `${p.name}(默认)` : p.name" :value="p.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="projectDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!projectForm.name.trim()" :loading="createProjectMutation.isPending.value" @click="createProjectMutation.mutate()">创建</el-button>
      </template>
    </el-dialog>

    <!-- 工厂标准:左列表 / 右编辑(表单 ⇄ YAML 双视图) -->
    <el-dialog v-model="profileDialog" title="工厂标准(profile)" width="960px" destroy-on-close>
      <div class="profile-layout">
        <aside class="profile-list">
          <div class="review-actions">
            <strong>已有标准</strong>
            <span class="spacer" />
            <el-button size="small" @click="openProfileDialog">新建</el-button>
          </div>
          <el-table :data="profilesQuery.data.value?.items ?? []" size="small" highlight-current-row @row-click="(row: PcbCamFactoryProfileDTO) => selectProfile(row.id)">
            <el-table-column prop="name" label="名称" min-width="140" show-overflow-tooltip />
            <el-table-column label="" width="60">
              <template #default="{ row }: { row: PcbCamFactoryProfileDTO }"><el-tag v-if="row.isDefault" size="small" type="success" effect="light">默认</el-tag></template>
            </el-table-column>
          </el-table>
          <p class="t-caption muted">默认值来自 pcb-worker 内置标准(培训文档通用值);这里只保存与默认不同的项。改标准不影响已建任务(任务保存快照)。</p>
        </aside>
        <section class="profile-edit" v-loading="profileBusy">
          <el-form label-position="top" inline>
            <el-form-item label="名称" required>
              <el-input v-model="profileForm.name" maxlength="80" placeholder="如:XX 厂 2026 标准" style="width: 260px" />
            </el-form-item>
            <el-form-item label="&nbsp;">
              <el-checkbox v-model="profileForm.isDefault">设为租户默认</el-checkbox>
            </el-form-item>
            <el-form-item label="&nbsp;">
              <el-radio-group v-model="profileView" size="small">
                <el-radio-button value="form">表单</el-radio-button>
                <el-radio-button value="yaml">YAML</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-form>
          <el-alert v-if="profileErrors.length" type="error" :closable="false" show-icon :title="`不合法(${profileErrors.length})`">
            <ul class="t-caption"><li v-for="e in profileErrors" :key="e">{{ e }}</li></ul>
          </el-alert>
          <template v-if="profileView === 'form'">
            <div class="review-actions">
              <el-input v-model="profileFilter" size="small" clearable placeholder="筛选字段 / 说明(如 drill、p114)" style="width: 280px" />
              <span class="t-caption">{{ Object.keys(profileOverrides).length }} 项覆盖</span>
            </div>
            <el-table :data="profileFieldsShown" size="small" max-height="440" row-key="key">
              <el-table-column prop="key" label="字段" min-width="220" show-overflow-tooltip />
              <el-table-column label="值" width="170">
                <template #default="{ row }: { row: PcbCamProfileField }">
                  <el-input :model-value="profileOverrides[row.key] ?? fmtVal(row.value)" size="small" :disabled="!canConfig || row.type === 'mapping'" :class="{ 'is-overridden': row.key in profileOverrides }" @update:model-value="(v: string) => setProfileField(row.key, v)" />
                </template>
              </el-table-column>
              <el-table-column label="默认" width="110" show-overflow-tooltip>
                <template #default="{ row }: { row: PcbCamProfileField }">{{ fmtVal(row.default) }}</template>
              </el-table-column>
              <el-table-column prop="doc" label="说明 / 出处" min-width="260" show-overflow-tooltip />
            </el-table>
          </template>
          <el-input v-else v-model="profileForm.yaml" type="textarea" :rows="22" spellcheck="false" class="yaml-editor" placeholder="# 只写要覆盖的键,例如&#10;drill:&#10;  via_max_mm: 0.45" />
        </section>
      </div>
      <template #footer>
        <el-button @click="profileDialog = false">关闭</el-button>
        <el-button :loading="profileBusy" @click="validateProfile">校验</el-button>
        <el-button v-if="canConfig" type="primary" :disabled="!profileForm.name.trim()" :loading="saveProfileMutation.isPending.value" @click="saveProfileMutation.mutate()">保存</el-button>
      </template>
    </el-dialog>

    <!-- 上传资料 -->
    <el-dialog v-model="uploadDialog" title="上传客户资料" width="520px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="项目" required>
          <el-select v-model="uploadProjectId" filterable>
            <el-option v-for="p in projects" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="文件(1 个 Gerber 压缩包 + 制作要求附件)" required>
          <input ref="fileInput" class="file-input" type="file" multiple accept=".zip,.rar,.7z,.pdf,.xlsx,.xls,.png,.jpg,.jpeg,.txt,.csv" @change="onFilesPicked" />
          <ul v-if="uploadFiles.length" class="file-list t-caption">
            <li v-for="f in uploadFiles" :key="f.name">{{ f.name }} · {{ fmtBytes(f.size) }}</li>
          </ul>
          <p v-if="uploadFiles.length && !hasArchive" class="t-caption field-error">需要包含一个 zip / rar / 7z 压缩包</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="uploadDialog = false">取消</el-button>
        <el-button type="primary" :disabled="!uploadProjectId || !hasArchive" :loading="uploadMutation.isPending.value" @click="uploadMutation.mutate()">上传并开始</el-button>
      </template>
    </el-dialog>

    <!-- 任务抽屉 -->
    <el-drawer
      :model-value="Boolean(selectedJobId)"
      :title="job ? `${job.projectName} · ${job.id.slice(0, 8)}` : '任务'"
      :size="isMobile ? '100%' : '61.8%'"
      direction="rtl"
      destroy-on-close
      @update:model-value="(v: boolean) => { if (!v) selectedJobId = null }"
      @closed="selectedJobId = null"
    >
      <AsyncState
        :loading="jobQuery.isLoading.value"
        :error="jobQuery.error.value && !isForbidden(jobQuery.error.value) ? errorMessage(jobQuery.error.value) : null"
        :forbidden="isForbidden(jobQuery.error.value)"
        :empty="!job"
        empty-title="任务不存在"
        @retry="jobQuery.refetch"
      >
        <div v-if="job" class="job-head">
          <el-tag :type="JOB_STATUS[job.status].type" effect="dark" round>{{ JOB_STATUS[job.status].label }}</el-tag>
          <span class="t-caption">{{ job.currentStage ? STAGE_LABEL[job.currentStage] : '未开始' }} · 更新 {{ fmt(job.updatedAt) }}</span>
          <el-button v-if="needsAction && drawerTab !== 'todo'" link type="warning" size="small" @click="drawerTab = 'todo'">
            {{ job.reviewReason ? REVIEW_LABEL[job.reviewReason] ?? job.reviewReason : JOB_STATUS[job.status].label }} → 去处理
          </el-button>
          <span v-if="trust" class="trust" :class="{ 'trust--clean': trust.clusters === 0 }" title="终稿对比:我们的输出和工程师手改的成品差多少(点开「终稿对比」看每一处)" @click="drawerTab = 'compare'">
            <b>{{ trust.clusters === 0 ? '与终稿一致' : `${trust.clusters} 处差异` }}</b>
            <span class="t-caption"> · {{ trust.clean }}/{{ trust.layers }} 层一致<template v-if="trust.worst">,最差 {{ trust.worst }}</template><template v-if="trust.drill !== null">,钻孔{{ trust.drill ? '一致' : '有差' }}</template></span>
          </span>
          <span class="spacer" />
          <el-button v-if="canApprove && job.status === 'done'" size="small" type="primary" :loading="releaseMutation.isPending.value" :title="job.releasedAt ? `上次下发 ${fmt(job.releasedAt)};再点重新打包` : '成果物 + 流程单 + 问单 + 决策记录 打成一个包'" @click="releaseMutation.mutate()">
            {{ job.releasedAt ? '重新下发' : '放行并下发' }}
          </el-button>
          <span v-if="job.releasedAt" class="t-caption">已下发 {{ fmt(job.releasedAt) }}</span>
          <ConfirmButton
            v-if="canApprove && !['done', 'cancelled'].includes(job.status)"
            size="small"
            text
            label="取消任务"
            confirm-text="取消后不可恢复,需重新上传。确认取消?"
            :loading="cancelMutation.isPending.value"
            @confirm="cancelMutation.mutate()"
          />
        </div>

        <el-tabs v-if="job" v-model="drawerTab">
          <!-- 要人动手的都在这一页:层确认 / 规格确认 / 问题点决策 / 重跑。任务不需要人时这页不出现 -->
          <el-tab-pane v-if="needsAction" lazy name="todo">
            <template #label>
              <span class="tab-todo">待处理<i v-if="todoCount" class="tab-todo__n">{{ todoCount }}</i></span>
            </template>
        <el-alert v-if="job.reviewReason" :title="REVIEW_LABEL[job.reviewReason] ?? job.reviewReason" type="warning" :closable="false" show-icon class="job-alert" />
        <el-alert v-if="job.errorMessage && ['failed', 'blocked'].includes(job.status)" :title="job.errorMessage" type="error" :closable="false" show-icon class="job-alert" />

        <!-- 停等点 1:层确认 -->
        <section v-if="job.status === 'needs_review' && job.reviewReason === 'layers'" class="panel review-panel">
          <h4 class="t-subtitle">层识别确认</h4>
          <p class="t-caption">置信度低的行已高亮;把类型改对后确认。层号从 1 起(顶层=1)。</p>
          <el-table :data="layerRows" size="small" max-height="360">
            <el-table-column prop="file" label="文件" min-width="200" show-overflow-tooltip />
            <el-table-column label="层类型" width="180">
              <template #default="{ row }: { row: LayerRow }">
                <el-select v-model="row.type" size="small" :disabled="!canOperate">
                  <el-option v-for="t in LAYER_TYPES" :key="t" :label="layerTypeLabel(t)" :value="t" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="层号" width="90">
              <template #default="{ row }: { row: LayerRow }">
                <el-input-number v-model="row.index" size="small" :min="1" :max="64" controls-position="right" :disabled="!canOperate" />
              </template>
            </el-table-column>
            <el-table-column label="极性" width="96">
              <template #default="{ row }: { row: LayerRow }">
                <el-select v-if="COPPER_TYPES.has(row.type)" v-model="row.polarity" size="small" :disabled="!canOperate" placeholder="正片">
                  <el-option label="正片" value="positive" />
                  <el-option label="负片" value="negative" />
                </el-select>
                <span v-else class="t-caption muted">-</span>
              </template>
            </el-table-column>
            <el-table-column label="置信度" width="90">
              <template #default="{ row }: { row: LayerRow }">
                <el-tag :type="row.confidence >= 0.8 ? 'success' : 'warning'" size="small" effect="light">{{ Math.round(row.confidence * 100) }}%</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="reason" label="依据" min-width="160" show-overflow-tooltip />
          </el-table>
          <div class="review-actions">
            <el-button v-if="canOperate" type="primary" :loading="confirmLayersMutation.isPending.value" :disabled="layerRows.length === 0" @click="confirmLayersMutation.mutate()">确认层识别,继续</el-button>
          </div>
        </section>

        <!-- 停等点 2:规格确认 -->
        <section v-if="job.status === 'needs_review' && job.reviewReason === 'order_spec'" class="panel review-panel">
          <h4 class="t-subtitle">制作规格确认</h4>
          <p class="t-caption">下面是 AI 从制作要求附件读出的候选值;引擎已把它和资料包(层数、盲埋孔、金手指)及工厂标准(最小线宽线距)交叉核对,钻孔表在钻孔步骤逐孔比对。请核对后确认。</p>
          <ul v-if="orderSpecChecks.length" class="spec-checks">
            <li v-for="(c, i) in orderSpecChecks" :key="i" class="spec-checks__item">
              <el-tag :type="c.level === 'warn' ? 'warning' : 'info'" size="small" effect="light">{{ c.level === 'warn' ? '冲突' : '提示' }}</el-tag>
              <span>{{ c.message }}</span>
            </li>
          </ul>
          <el-input v-model="orderSpecText" type="textarea" :rows="12" :disabled="!canOperate" spellcheck="false" />
          <p v-if="orderSpecError" class="t-caption field-error">{{ orderSpecError }}</p>
          <div class="review-actions">
            <el-button v-if="canOperate" type="primary" :disabled="Boolean(orderSpecError)" :loading="confirmOrderSpecMutation.isPending.value" @click="confirmOrderSpecMutation.mutate()">确认规格,继续</el-button>
          </div>
        </section>

        <!-- 停等点 3:EQ 决策 -->
        <section v-if="job.eqTotal > 0 && ['needs_review', 'blocked'].includes(job.status)" class="panel review-panel">
          <h4 class="t-subtitle">问题点决策({{ job.eqPending }} / {{ job.eqTotal }} 待处理)<span class="t-caption"> —— 左图右流,按组判,键盘连打</span></h4>
          <WorkbenchPane
            :job-id="job.id" :status="job.status" :eq-total="job.eqTotal" :can-approve="canApprove" :is-mobile="isMobile"
            :stage-label="(s: string) => STAGE_LABEL[s as PcbCamStage] ?? s" :layer-files="layerOptions" :layer-color="layerColor"
            @changed="refreshJob" @open-profile="(k: string) => openProfileDialog(k)"
          />
        </section>

        <!-- 阻断/失败:重跑 -->
        <section v-if="canApprove && ['blocked', 'failed'].includes(job.status)" class="panel review-panel">
          <h4 class="t-subtitle">重跑</h4>
          <div class="review-actions">
            <el-select v-model="retryStageSel" size="small">
              <el-option v-for="s in STAGES" :key="s" :label="STAGE_LABEL[s]" :value="s" />
            </el-select>
            <el-button size="small" type="primary" :loading="retryMutation.isPending.value" @click="retryMutation.mutate()">从该步骤重跑</el-button>
          </div>
        </section>
          </el-tab-pane>

          <el-tab-pane lazy label="步骤" name="timeline">
            <details class="help-note">
              <summary class="t-caption">这些标记怎么看?</summary>
              <p class="t-caption">
                <strong>通过</strong> = 这步没有要人拍板的事;<strong>待确认</strong> = 这步报告里有问题点要人决策(处理过了也保留这个标记,表示任务在这里停过);
                <strong>阻断</strong> = 有硬伤(开短路、成果物对不上),处理后从这步重跑;<strong>失败</strong> = 引擎出错。
                色块:<b class="cnt cnt--error">错</b> 错误 <b class="cnt cnt--warn">警</b> 警告 <b class="cnt cnt--fix">修</b> 已自动修 <b class="cnt cnt--decide">拍板</b> 需人决策。
                每步做了什么改图看「处理记录」,发现了什么看「检查报告」。
              </p>
            </details>
            <ol class="timeline">
              <li v-for="s in STAGES" :key="s" class="timeline__item">
                <span class="timeline__name">{{ STAGE_LABEL[s] }}</span>
                <template v-if="stageRun(s)">
                  <el-tag :type="RUN_STATUS[stageRun(s)!.status]?.type ?? 'info'" size="small" effect="light" round :title="stageRun(s)!.status">
                    {{ RUN_STATUS[stageRun(s)!.status]?.label }}
                  </el-tag>
                  <span class="timeline__counts">
                    <b v-if="stageRun(s)!.errorCount" class="cnt cnt--error" title="错误">错 {{ stageRun(s)!.errorCount }}</b>
                    <b v-if="stageRun(s)!.warnCount" class="cnt cnt--warn" title="警告">警 {{ stageRun(s)!.warnCount }}</b>
                    <b v-if="stageRun(s)!.appliedCount" class="cnt cnt--fix" :title="`已自动修 ${stageRun(s)!.appliedCount} 项` + (stageRun(s)!.nativeOps ? `,本地引擎改图 ${stageRun(s)!.nativeOps} 步` : '')">修 {{ stageRun(s)!.appliedCount }}</b>
                    <b v-if="stageRun(s)!.decisionCount" class="cnt cnt--decide" title="需人决策">拍板 {{ stageRun(s)!.decisionCount }}</b>
                  </span>
                  <span class="t-caption timeline__brief" :title="summaryLabel(stageRun(s)!.summary)">{{ stageBrief(stageRun(s)!) }}</span>
                  <span v-if="stageRun(s)!.durationMs != null" class="t-caption muted timeline__dur">{{ (stageRun(s)!.durationMs! / 1000).toFixed(1) }}s</span>
                </template>
                <span v-else class="t-caption muted">未开始</span>
              </li>
            </ol>
            <EngineLog :job-id="job.id" :running="job.status === 'running' || job.status === 'pending'" :stage-label="(s: string) => STAGE_LABEL[s as PcbCamStage] ?? s" />
          </el-tab-pane>
          <el-tab-pane lazy label="检查报告" name="report">
            <div class="review-actions">
              <el-select v-model="reportStage" size="small">
                <el-option v-for="s in STAGES" :key="s" :label="STAGE_LABEL[s]" :value="s" />
              </el-select>
              <el-select v-model="reportSeverity" size="small" style="width: 120px">
                <el-option label="全部级别" value="" />
                <el-option label="只看错误" value="error" />
                <el-option label="错误+警告" value="warn" />
              </el-select>
              <span v-if="foldedCount > 0" class="t-caption">同类明细已折叠 {{ foldedCount }} 条</span>
            </div>
            <AsyncState :loading="reportQuery.isLoading.value" :error="reportQuery.error.value ? errorMessage(reportQuery.error.value) : null" :empty="!reportQuery.data.value?.report" empty-title="该步骤还没有报告" @retry="reportQuery.refetch">
              <p class="t-caption">{{ reportQuery.data.value?.report?.summary }}</p>
              <el-table :data="reportRows" size="small" max-height="420">
                <el-table-column label="级别" width="70">
                  <template #default="{ row }">
                    <el-tag :type="row.severity === 'error' ? 'danger' : row.severity === 'warn' ? 'warning' : 'info'" size="small" effect="light">{{ severityLabel(row.severity) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="类型" width="140" show-overflow-tooltip>
                  <template #default="{ row }: { row: PcbCamReportItem }"><span :title="row.kind">{{ kindLabel(row.kind) }}</span></template>
                </el-table-column>
                <el-table-column prop="layer" label="层" width="110" show-overflow-tooltip />
                <el-table-column prop="message" label="说明" min-width="220" show-overflow-tooltip />
                <el-table-column label="实测/阈值" width="120">
                  <template #default="{ row }">{{ row.measured ?? '-' }} / {{ row.threshold ?? '-' }}</template>
                </el-table-column>
                <el-table-column label="修复" width="110">
                  <template #default="{ row }">
                    <span :title="row.fix?.op ? `Genesis 操作:${row.fix.op}` : undefined">{{ row.fix ? (row.fix.applied ? '已自动' : row.fix.auto_fixable ? '可自动' : '需 Genesis') : '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="" width="120">
                  <template #default="{ row }: { row: ReportRow }">
                    <el-button v-if="row._group" link size="small" type="primary" @click="toggleGroup(row._group)">{{ row._count ? `展开 ${row._count}` : '收起' }}</el-button>
                    <el-button v-if="row.location" link size="small" type="primary" @click="locate(row)">定位</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </AsyncState>
          </el-tab-pane>
          <el-tab-pane lazy label="处理记录" name="plan">
            <details class="help-note">
              <summary class="t-caption">这张表怎么看?</summary>
              <p class="t-caption">
                引擎把这块板要做的每一步排成一份操作序列(教材第 4–13 章的必做步骤 + 检查发现附上的参数)。每一步由谁做:
                <el-tag size="small" type="success" effect="light">本地引擎已执行</el-tag> = B 线,几何引擎直接改了 edit 副本(层预览看得到,勾「对原稿」比对);
                <el-tag size="small" type="info" effect="light">交 Genesis 脚本</el-tag> = A 线,写进成果物 <code>genesis_*.csh</code>,在工厂 Genesis 主机上执行;
                <el-tag size="small" type="warning" effect="light">需人工判断</el-tag> = 脚本在这一步停下等工程师。
              </p>
            </details>
            <AsyncState :loading="planQuery.isLoading.value" :error="planQuery.error.value ? errorMessage(planQuery.error.value) : null" :empty="!planQuery.data.value" empty-title="还没有操作序列" empty-hint="资料整理跑过后每一步都会更新" @retry="planQuery.refetch">
              <div class="review-actions">
                <span>共 {{ planStats.total }} 步:本地引擎已执行 {{ planStats.applied }} · 交 Genesis {{ planStats.genesis }} · 需人工判断 {{ planStats.human }}</span>
                <span class="spacer" />
                <el-select v-model="planStageFilter" size="small" style="width: 130px">
                  <el-option label="全部阶段" value="" />
                  <el-option v-for="s in STAGES" :key="s" :label="STAGE_LABEL[s]" :value="s" />
                </el-select>
              </div>
              <el-alert v-for="pr in planQuery.data.value?.problems ?? []" :key="pr" :title="pr" type="error" :closable="false" show-icon class="job-alert" />
              <el-table :data="planRows" size="small" max-height="460">
                <el-table-column prop="n" label="#" width="50" />
                <el-table-column label="阶段" width="90">
                  <template #default="{ row }: { row: PlanCall }">{{ STAGE_LABEL[row.stage] ?? row.stage }}</template>
                </el-table-column>
                <el-table-column label="操作" width="150" show-overflow-tooltip>
                  <template #default="{ row }: { row: PlanCall }"><span :title="row.op">{{ opLabel(row.op) }}</span></template>
                </el-table-column>
                <el-table-column label="层" width="140" show-overflow-tooltip>
                  <template #default="{ row }: { row: PlanCall }">{{ row.layer ?? (row.step === 'panel' ? '工作板' : '整个 job') }}</template>
                </el-table-column>
                <el-table-column label="由谁做" width="165">
                  <template #default="{ row }: { row: PlanCall }">
                    <el-tag :type="executorOf(row).type" size="small" effect="light">{{ executorOf(row).label }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="来源" min-width="130" show-overflow-tooltip>
                  <template #default="{ row }: { row: PlanCall }">
                    <span :title="row.kind">{{ row.kind.startsWith('mandatory_') ? '教材必做步骤' : kindLabel(row.kind) }}</span>
                    <span v-if="row.item_ids?.length" class="t-caption"> · 关联 {{ row.item_ids.length }} 条发现</span>
                  </template>
                </el-table-column>
                <el-table-column label="教材页" width="72">
                  <template #default="{ row }: { row: PlanCall }">{{ row.pages?.length ? 'p' + row.pages.join('/') : '-' }}</template>
                </el-table-column>
              </el-table>
            </AsyncState>
          </el-tab-pane>
          <el-tab-pane lazy label="层预览" name="preview">
            <div class="review-actions preview-modes">
              <el-radio-group v-model="previewMode" size="small">
                <el-radio-button value="flat">平面</el-radio-button>
                <el-radio-button value="stack" title="所有层斜着拉成一摞,内外层对位一眼看全">叠层 3D</el-radio-button>
                <el-radio-button value="scrub" title="从客户原稿拖到生产稿,一步一帧">时间轴</el-radio-button>
              </el-radio-group>
              <span class="t-caption">{{ previewMode === 'stack' ? '拖动旋转 · 滚轮改层距 · 点一层压平' : previewMode === 'scrub' ? '一步一帧,上一帧红色垫底' : '' }}</span>
            </div>
            <div v-if="previewMode === 'flat'" class="review-actions">
              <el-select v-model="previewLayer" size="small" placeholder="选择层" filterable style="width: 240px">
                <el-option-group label="单只(edit 副本)">
                  <el-option v-for="f in layerOptions" :key="f" :label="f" :value="f" />
                </el-option-group>
                <el-option-group v-if="panelLayerOptions.length" label="工作板(拼板后的实图)">
                  <el-option v-for="f in panelLayerOptions" :key="f" :label="`工作板 · ${f.slice(6)}`" :value="f" />
                </el-option-group>
                <el-option-group label="方案图">
                  <el-option label="拼板排布方案(_panel)" value="_panel" />
                </el-option-group>
              </el-select>
              <!-- 手机档只留选层 + 全屏:叠加对照 / 对原稿 / 阶段筛选在 390 宽下挤成一团,反而不可用 -->
              <template v-if="!isMobile">
                <el-select
                  v-model="compareLayers" size="small" multiple collapse-tags collapse-tags-tooltip filterable
                  placeholder="叠加对照(可多选)" style="width: 240px" :disabled="previewLayer.startsWith('_') || isPanelLayer(previewLayer)"
                >
                  <el-option v-for="f in compareOptions" :key="f" :label="f" :value="f" />
                </el-select>
                <el-checkbox v-model="compareOrig" size="small" :disabled="previewLayer.startsWith('_') || isPanelLayer(previewLayer)">对原稿</el-checkbox>
                <el-select v-model="reportStage" size="small" style="width: 130px">
                  <el-option v-for="s in STAGES" :key="s" :label="STAGE_LABEL[s]" :value="s" />
                </el-select>
                <span class="t-caption nowrap">{{ overlayItems.length ? `${overlayItems.length} 处标记` : '无标记' }}</span>
              </template>
              <span class="spacer" />
              <el-button v-if="highlightId" size="small" @click="resetView">全图</el-button>
              <el-button size="small" :icon="Maximize2" :disabled="!svgWithOverlay" @click="enterPreviewFullscreen">全屏</el-button>
            </div>
            <LayerStack3D v-if="previewMode === 'stack'" :job-id="job.id" :layers="stackLayers" :color-of="stackColor" />
            <TimeScrub v-else-if="previewMode === 'scrub'" :job-id="job.id" :layer="scrubLayer || layerOptions[0] || ''" :layers="layerOptions" :stage-label="(s: string) => STAGE_LABEL[s as PcbCamStage] ?? s" :color="layerColor(scrubLayer || layerOptions[0] || '')" @update:layer="(v: string) => (scrubLayer = v)" />
            <template v-else>
              <AskBoard :job-id="job.id" @hits="onAskHits" @clear="askHits = []" />
              <AsyncState :loading="svgQuery.isLoading.value" :error="svgQuery.error.value ? errorMessage(svgQuery.error.value) : null" :empty="!previewLayer || !svgQuery.data.value" empty-title="选择一个层查看" :empty-hint="isPanelLayer(previewLayer) ? '工作板实图要本地引擎(native)跑过拼板阶段才有' : '层预览在「资料整理」确认后可用'" @retry="svgQuery.refetch">
                <!-- SVG 由本平台的 pcb-worker 生成、经服务端代理,不是用户输入;内联渲染以叠加检查报告的定位框(mm 坐标,与 viewBox 同系)。`_panel` 是拼板阶段生成的预览,拼板未跑时 404 -->
                <div v-if="!previewFullscreen" class="svg-stack" :class="{ 'is-scanning': scanning }">
                  <div v-for="c in compareSvgs" :key="c.layer" class="svg-stack__layer" :style="{ opacity: compareOpacity }" v-html="c.svg" />
                  <div class="svg-stack__layer" v-html="svgWithOverlay" />
                </div>
                <p v-else class="t-caption">已在全屏查看,按 Esc 或点「退出全屏」返回。</p>
              </AsyncState>
              <p v-if="askOnLayer.length" class="t-caption">青色框 = 查板命中(本层 {{ askOnLayer.length }} 个)</p>
            </template>
            <!-- 对照层的透明度/图例放在板图下面:选不选对照层,板图的位置都不动 -->
            <div v-if="showCompare && !previewFullscreen" class="review-actions pcb-legend-row">
              <span class="t-caption">对照层透明度</span>
              <el-slider v-model="compareOpacity" :min="0.15" :max="0.9" :step="0.05" size="small" style="width: 160px" />
              <span class="pcb-legend">
                <span class="pcb-legend__item"><i class="pcb-legend__dot" :style="{ background: layerColor(previewLayer) }" />{{ previewLayer }}(主)</span>
                <span v-for="l in compareLayers" :key="l" class="pcb-legend__item">
                  <i class="pcb-legend__dot" :style="{ background: layerColor(l), opacity: compareOpacity }" />{{ l }}
                </span>
                <span v-if="compareOrig" class="pcb-legend__item"><i class="pcb-legend__dot" :style="{ background: layerColor(ORIG_KEY), opacity: compareOpacity }" />原稿(客户文件)</span>
              </span>
            </div>
            <p v-if="!isMobile && previewMode === 'flat'" class="t-caption">↑ / ↓ 切换上一层 / 下一层</p>
          </el-tab-pane>
          <el-tab-pane lazy label="终稿对比" name="compare">
            <div class="review-actions">
              <input ref="goldenInput" type="file" multiple accept=".zip,.rar,.7z,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gko,.gko1,.drl,.txt,.g1,.g2,.g3,.g4,.l2,.l3,.l4,.l5,.l6,.gm1,.gp1,.gbr,.ger,.art,.pho" style="display:none" @change="onGoldenPick">
              <el-button size="small" type="primary" :icon="Upload" :loading="goldenMutation.isPending.value" @click="goldenInput?.click()">
                {{ cmpData?.has_golden ? '重传人工终稿' : '上传人工终稿' }}
              </el-button>
              <span v-if="cmpData?.has_golden" class="t-caption">终稿 {{ cmpData.golden_files.length }} 个文件,配上 {{ cmpLayers.length }} 层<template v-if="cmpData.unmatched_output.length">,{{ cmpData.unmatched_output.length }} 层输出没对应终稿</template></span>
              <span class="spacer" />
              <el-button size="small" :icon="RefreshCw" :loading="compareQuery2.isFetching.value" @click="compareQuery2.refetch()">刷新</el-button>
            </div>
            <AsyncState :loading="compareQuery2.isLoading.value" :error="compareQuery2.error.value ? errorMessage(compareQuery2.error.value) : null" :empty="!cmpData || !cmpData.has_golden || cmpLayers.length === 0" :empty-title="cmpData && !cmpData.has_output ? '还没有输出' : cmpData?.has_golden ? '终稿和输出没有配上对的层' : '还没有人工终稿'" :empty-hint="cmpData && !cmpData.has_output ? '「输出」这一步完成后才有生产版 Gerber 可比' : cmpData?.has_golden ? '终稿文件要和输出同后缀(.gtl / .l2 / .gts / .drl …)才能配对' : '把工程师改好的成品 Gerber(zip 或散文件)传上来,系统逐层自动对比、标出每一处差异'" @retry="compareQuery2.refetch">
              <div class="cmp-summary">
                <span>共 {{ cmpData!.summary.n_layers }} 层</span>
                <span :class="cmpData!.summary.n_clusters === 0 ? 't-success' : ''"><b>{{ cmpData!.summary.n_clusters }}</b> 处形体差异</span>
                <span v-if="cmpData!.drill" :class="cmpData!.drill.n_mismatch === 0 ? 't-success' : 't-danger'">
                  钻孔 {{ cmpData!.drill.n_mismatch === 0 ? `全等(${cmpData!.drill.holes_ours} 孔)` : `${cmpData!.drill.n_mismatch} 种孔径对不上(${cmpData!.drill.holes_ours} vs ${cmpData!.drill.holes_golden} 孔)` }}
                </span>
                <span class="t-caption">差异 = 带宽 &gt; 0.1 mm 的形体差(一边有一个东西另一边没有);百分比只作参考</span>
              </div>
              <el-table :data="cmpLayers" size="small" class="cmp-table" highlight-current-row :current-row-key="cmpLayer" row-key="suffix" @row-click="(row: PcbCamCompareLayer) => (cmpLayer = row.suffix)">
                <el-table-column label="层" min-width="150" show-overflow-tooltip>
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span :class="{ 'cmp-row--active': row.suffix === cmpLayer }">{{ cmpTypeLabel(row) }}</span></template>
                </el-table-column>
                <el-table-column label="判定" width="110">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><el-tag size="small" :type="cmpVerdict(row).type" effect="light">{{ cmpVerdict(row).text }}</el-tag></template>
                </el-table-column>
                <el-table-column label="人有我们没有" width="120" align="right">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span class="t-danger">{{ row.n_missing }} 处 · {{ row.bands.missing.shape.toFixed(1) }} mm²</span></template>
                </el-table-column>
                <el-table-column label="我们有人没有" width="120" align="right">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span class="t-info">{{ row.n_extra }} 处 · {{ row.bands.extra.shape.toFixed(1) }} mm²</span></template>
                </el-table-column>
                <el-table-column label="改了" width="70" align="right">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span class="t-changed">{{ row.n_changed }} 处</span></template>
                </el-table-column>
                <el-table-column v-if="!isMobile" label="尺寸差 / 噪声" width="130" align="right">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span class="t-caption">{{ (row.bands.missing.size + row.bands.extra.size).toFixed(1) }} / {{ (row.bands.missing.noise + row.bands.extra.noise).toFixed(1) }} mm²</span></template>
                </el-table-column>
                <el-table-column label="XOR" width="80" align="right">
                  <template #default="{ row }: { row: PcbCamCompareLayer }"><span class="t-caption">{{ cmpPct(row.xor_pct) }}</span></template>
                </el-table-column>
              </el-table>
              <div v-if="cmpCurrent" class="cmp-view">
                <div class="cmp-view__stage">
                  <div class="review-actions">
                    <strong>{{ cmpTypeLabel(cmpCurrent) }}</strong>
                    <!-- 不能包在 el-checkbox-group 里:组内的 el-checkbox 用组的 model,自己的 v-model 失效(渲染成空圈、点了没反应) -->
                    <span v-if="!isMobile" class="cmp-toggles">
                      <el-checkbox v-model="cmpShow.orig" size="small"><span class="cmp-dot cmp-dot--orig" />原稿</el-checkbox>
                      <el-checkbox v-model="cmpShow.ours" size="small">我们的</el-checkbox>
                      <el-checkbox v-model="cmpShow.gold" size="small">终稿(灰)</el-checkbox>
                      <el-checkbox v-model="cmpShow.missing" size="small"><span class="cmp-dot cmp-dot--missing" />少了</el-checkbox>
                      <el-checkbox v-model="cmpShow.extra" size="small"><span class="cmp-dot cmp-dot--extra" />多了</el-checkbox>
                      <el-checkbox v-model="cmpShow.boxes" size="small">差异框</el-checkbox>
                    </span>
                    <el-checkbox v-model="cmpCurtain" size="small" title="左边我们的、右边终稿,拖一根线擦着看">拉帘</el-checkbox>
                    <span class="spacer" />
                    <el-button v-if="cmpSelected !== null" size="small" @click="cmpSelected = null">全图</el-button>
                    <el-button size="small" :icon="Maximize2" :disabled="!cmpSvg" @click="enterCmpFullscreen">全屏</el-button>
                  </div>
                  <AsyncState :loading="cmpSvgQuery.isLoading.value" :error="cmpSvgQuery.error.value ? errorMessage(cmpSvgQuery.error.value) : null" :empty="!cmpSvg" empty-title="选一层查看叠加图" @retry="cmpSvgQuery.refetch">
                    <!-- SVG 由本平台的 pcb-worker 生成、经服务端代理,不是用户输入;内联渲染以便按类隐藏图层、高亮选中的簇 -->
                    <CurtainCompare v-if="!cmpFullscreen && cmpCurtain && cmpSvg" :svg="cmpSvg" :stage-class="cmpStageClass" :stage-style="cmpOursStyle" />
                    <div v-else-if="!cmpFullscreen" :class="cmpStageClass" :style="cmpOursStyle" v-html="cmpSvg" />
                    <p v-else class="t-caption">已在全屏查看,按 Esc 或点「退出全屏」返回。</p>
                  </AsyncState>
                  <div v-if="!isMobile" class="review-actions pcb-legend-row">
                    <span class="t-caption">我们的层透明度</span>
                    <el-slider v-model="cmpOursOpacity" :min="0.1" :max="1" :step="0.05" size="small" style="width: 140px" />
                    <span class="pcb-legend">
                      <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#f59e0b" />客户原稿</span>
                      <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#9ca3af" />人工终稿</span>
                      <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#dc2626" />人有我们没有</span>
                      <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#2563eb" />我们有人没有</span>
                      <span class="pcb-legend__item"><i class="pcb-legend__dot cmp-legend__dot--changed" />两边都有、形状不同(红蓝叠在一起)</span>
                    </span>
                  </div>
                  <p v-if="cmpCurrent.note" class="t-caption">{{ cmpCurrent.note }}</p>
                </div>
                <div class="cmp-view__list">
                  <DiffMinimap v-if="cmpCurrent.clusters.length" :clusters="cmpCurrent.clusters" :frame="cmpFrame" :selected="cmpSelected" @select="(id: number) => (cmpSelected = id)" />
                  <div class="review-actions">
                    <el-radio-group v-model="cmpDir" size="small">
                      <el-radio-button value="all">全部 {{ cmpCurrent.n_clusters }}</el-radio-button>
                      <el-radio-button value="missing">少了 {{ cmpCurrent.n_missing }}</el-radio-button>
                      <el-radio-button value="extra">多了 {{ cmpCurrent.n_extra }}</el-radio-button>
                      <el-radio-button value="changed">改了 {{ cmpCurrent.n_changed }}</el-radio-button>
                    </el-radio-group>
                  </div>
                  <p v-if="cmpClusterList.length === 0" class="t-caption">这一层没有形体差异</p>
                  <ul v-else class="cmp-clusters">
                    <li v-for="c in cmpClusterList" :key="c.id" :class="['cmp-clusters__item', `cmp-clusters__item--${c.direction}`, { 'cmp-clusters__item--selected': c.id === cmpSelected }]" @click="cmpLocate(c)">
                      <span class="cmp-clusters__no">#{{ c.id + 1 }}</span>
                      <span class="cmp-clusters__what">{{ cmpDirLabel(c.direction) }}</span>
                      <span class="cmp-clusters__size">
                        <template v-if="c.direction === 'changed'">少 {{ (c.area_missing_mm2 ?? 0).toFixed(2) }} / 多 {{ (c.area_extra_mm2 ?? 0).toFixed(2) }} mm²</template>
                        <template v-else>{{ c.area_mm2.toFixed(2) }} mm²</template>
                        · {{ c.size_mm[0].toFixed(2) }}×{{ c.size_mm[1].toFixed(2) }}<template v-if="c.pieces > 1"> · {{ c.pieces }} 块</template>
                      </span>
                      <span class="cmp-clusters__at t-caption">@ {{ c.at[0].toFixed(1) }}, {{ c.at[1].toFixed(1) }}</span>
                    </li>
                  </ul>
                  <p v-if="cmpCurrent.n_clusters > cmpCurrent.clusters.length" class="t-caption">只列了面积最大的 {{ cmpCurrent.clusters.length }} 处</p>
                </div>
              </div>
              <details v-if="cmpData!.drill && cmpData!.drill.n_mismatch > 0" class="help-note">
                <summary class="t-caption">钻孔对不上的孔径({{ cmpData!.drill.n_mismatch }})</summary>
                <el-table :data="cmpData!.drill.rows.filter((r) => !r.same)" size="small">
                  <el-table-column label="孔径" width="90"><template #default="{ row }">⌀{{ row.dia_mm }}</template></el-table-column>
                  <el-table-column label="类型" width="70"><template #default="{ row }">{{ row.kind === 'slot' ? '槽' : '孔' }}</template></el-table-column>
                  <el-table-column label="我们" width="80" align="right" prop="ours" />
                  <el-table-column label="工程师" width="80" align="right" prop="golden" />
                  <el-table-column label="差" width="80" align="right"><template #default="{ row }">{{ row.ours - row.golden > 0 ? '+' : '' }}{{ row.ours - row.golden }}</template></el-table-column>
                </el-table>
              </details>
              <p v-if="cmpData!.unmatched_output.length" class="t-caption">没有对应终稿的输出:{{ cmpData!.unmatched_output.map((u) => u.output).join('、') }}</p>
              <p v-if="cmpData!.unmatched_golden.length" class="t-caption">终稿里多出来、没配上的:{{ cmpData!.unmatched_golden.join('、') }}</p>
            </AsyncState>
          </el-tab-pane>
          <el-tab-pane lazy label="流程单" name="mi">
            <AsyncState :loading="miQuery.isLoading.value" :error="miQuery.error.value ? errorMessage(miQuery.error.value) : null" :empty="!miQuery.data.value" empty-title="还没有流程单" @retry="miQuery.refetch">
              <template v-if="miQuery.data.value">
                <div class="review-actions">
                  <strong>{{ miQuery.data.value.boardType }}</strong>
                  <span class="t-caption">{{ miQuery.data.value.category }} · 培训文档 p{{ miQuery.data.value.sourcePage }}</span>
                  <span class="spacer" />
                  <el-button size="small" :icon="Download" :loading="miDownloading" @click="downloadMi">下载流程单</el-button>
                </div>
                <p class="t-caption">判定依据:{{ miQuery.data.value.reasons.join(';') || '-' }}</p>
                <el-alert v-for="w in miQuery.data.value.warnings" :key="w" :title="w" type="warning" :closable="false" show-icon class="job-alert" />
                <el-table :data="miQuery.data.value.steps.map((s, i) => ({ no: i + 1, step: s, req: miQuery.data.value!.requirements.find((r) => r.startsWith(s + '：'))?.split('：').slice(1).join('：') ?? '' }))" size="small" max-height="460">
                  <el-table-column prop="no" label="#" width="50" />
                  <el-table-column prop="step" label="工序" width="140" />
                  <el-table-column prop="req" label="制作要求 / 备注" min-width="260" show-overflow-tooltip />
                </el-table>
                <p v-if="miQuery.data.value.note" class="t-caption">备注:{{ miQuery.data.value.note }}</p>
                <template v-if="miQuery.data.value.impedance">
                  <h5 class="t-subtitle">阻抗取值(第 15 章)</h5>
                  <el-table :data="miQuery.data.value.impedance.rows" size="small">
                    <el-table-column prop="layer" label="层" width="70" />
                    <el-table-column prop="type" label="类型" width="90" />
                    <el-table-column prop="targetOhm" label="Ω" width="60" />
                    <el-table-column prop="w1Mil" label="W1 线底" width="80" />
                    <el-table-column prop="w2Mil" label="W2 线面" width="80" />
                    <el-table-column prop="s1Mil" label="S1" width="60" />
                    <el-table-column label="T1 um" width="90">
                      <template #default="{ row }: { row: { t1Um: number; t1Note: string } }"><span :title="row.t1Note">{{ row.t1Um }}</span></template>
                    </el-table-column>
                    <el-table-column prop="model" label="计算模型" min-width="220" show-overflow-tooltip />
                  </el-table>
                  <p class="t-caption">阻焊 C1 {{ miQuery.data.value.impedance.soldermask.c1Um }} / C2 {{ miQuery.data.value.impedance.soldermask.c2Um }} / C3 {{ miQuery.data.value.impedance.soldermask.c3Um }} um,CEr {{ miQuery.data.value.impedance.soldermask.cer }};{{ miQuery.data.value.impedance.soldermask.note }}</p>
                  <p v-for="n in miQuery.data.value.impedance.notes" :key="n" class="t-caption">{{ n }}</p>
                </template>
                <!-- 叠层示意 SVG 由本平台服务端生成(mi/stackup.ts),不是用户输入 -->
                <div v-if="stackupQuery.data.value" class="svg-stage svg-stage--stackup" v-html="stackupQuery.data.value" />
              </template>
            </AsyncState>
          </el-tab-pane>
          <el-tab-pane lazy label="成果物" name="artifacts">
            <AsyncState :loading="artifactsQuery.isLoading.value" :error="artifactsQuery.error.value ? errorMessage(artifactsQuery.error.value) : null" :empty="(artifactsQuery.data.value?.items ?? []).length === 0" empty-title="还没有成果物" empty-hint="钻带、流程单、报告会在对应步骤完成后出现在这里" @retry="artifactsQuery.refetch">
              <div class="review-actions artifact-group__title">
                <h5 class="t-subtitle">生产成果物<span class="t-caption">({{ deliverables.length }})</span></h5>
                <span class="spacer" />
                <el-button v-if="canApprove && job.status === 'done'" size="small" type="primary" :loading="releaseMutation.isPending.value" title="成果物 + 流程单 + 问单 + 决策记录 一个包,并记下发时间" @click="releaseMutation.mutate()">{{ job.releasedAt ? '重新下发' : '放行并下发' }}</el-button>
                <el-button size="small" :icon="Download" :disabled="deliverables.length === 0" :loading="zipBusy === 'deliverables'" @click="downloadZip('deliverables')">只打成果物</el-button>
                <a :href="eqSheetUrl" target="_blank" rel="noopener" class="download-link" title="问客户 / 人工处理的条目,每条带板图局部;可直接打印">问单</a>
                <el-button v-if="processFiles.length" size="small" link :loading="zipBusy === 'all'" @click="downloadZip('all')">连过程文件一起打包</el-button>
              </div>
              <p v-if="deliverables.length === 0" class="t-caption">还没有可交付的文件:钻带在「钻孔」后出现,生产版 Gerber / 锣带在「输出」后出现</p>
              <el-table v-else :data="deliverables" size="small">
                <el-table-column label="类型" width="170">
                  <template #default="{ row }: { row: PcbCamArtifactDTO }"><span :title="row.kind">{{ artifactKindLabel(row.kind) }}</span></template>
                </el-table-column>
                <el-table-column label="文件" min-width="200" show-overflow-tooltip>
                  <template #default="{ row }: { row: PcbCamArtifactDTO }"><span :title="row.filename">{{ shortName(row.filename) }}</span></template>
                </el-table-column>
                <el-table-column label="大小" width="90">
                  <template #default="{ row }">{{ fmtBytes(row.size) }}</template>
                </el-table-column>
                <el-table-column label="" width="90">
                  <template #default="{ row }">
                    <a :href="row.url" target="_blank" rel="noopener" class="download-link"><Download :size="14" /> 下载</a>
                  </template>
                </el-table-column>
              </el-table>
              <details v-if="processFiles.length" class="help-note artifact-group" :open="processOpen" @toggle="(e: Event) => (processOpen = (e.target as HTMLDetailsElement).open)">
                <summary class="t-caption">过程 / 检查数据({{ processFiles.length }})—— 引擎中间文件,排查问题时才需要</summary>
                <el-table :data="processFiles" size="small">
                  <el-table-column label="类型" width="170">
                    <template #default="{ row }: { row: PcbCamArtifactDTO }"><span :title="row.kind">{{ artifactKindLabel(row.kind) }}</span></template>
                  </el-table-column>
                  <el-table-column label="文件" min-width="200" show-overflow-tooltip>
                    <template #default="{ row }: { row: PcbCamArtifactDTO }"><span :title="row.filename">{{ shortName(row.filename) }}</span></template>
                  </el-table-column>
                  <el-table-column label="大小" width="90">
                    <template #default="{ row }">{{ fmtBytes(row.size) }}</template>
                  </el-table-column>
                  <el-table-column label="" width="90">
                    <template #default="{ row }">
                      <a :href="row.url" target="_blank" rel="noopener" class="download-link"><Download :size="14" /> 下载</a>
                    </template>
                  </el-table-column>
                </el-table>
              </details>
            </AsyncState>
          </el-tab-pane>
        </el-tabs>
      </AsyncState>
    </el-drawer>
  </section>

  <!-- 层预览全屏:Teleport 到 body,盖住抽屉;工具条与抽屉里一致,SVG 等比放到最大 -->
  <Teleport to="body">
    <div v-if="previewFullscreen" ref="previewStageEl" class="pcb-fs" :class="{ 'pcb-scope pcb-scope-fs': scopeOn }" role="dialog" aria-label="层预览全屏">
      <div class="pcb-fs__bar">
        <!-- :teleported="false":原生全屏只显示 previewStageEl 这棵子树,挂到 body 的下拉面板看不见也点不到 -->
        <el-select v-model="previewLayer" size="small" placeholder="选择层" filterable :teleported="false" style="width: 260px">
          <el-option-group label="单只(edit 副本)">
            <el-option v-for="f in layerOptions" :key="f" :label="f" :value="f" />
          </el-option-group>
          <el-option-group v-if="panelLayerOptions.length" label="工作板(拼板后的实图)">
            <el-option v-for="f in panelLayerOptions" :key="f" :label="`工作板 · ${f.slice(6)}`" :value="f" />
          </el-option-group>
          <el-option-group label="方案图">
            <el-option label="拼板排布方案(_panel)" value="_panel" />
          </el-option-group>
        </el-select>
        <el-select
          v-model="compareLayers" size="small" multiple collapse-tags filterable :teleported="false"
          placeholder="叠加对照(可多选)" style="width: 260px" :disabled="previewLayer.startsWith('_') || isPanelLayer(previewLayer)"
        >
          <el-option v-for="f in compareOptions" :key="f" :label="f" :value="f" />
        </el-select>
        <el-checkbox v-model="compareOrig" size="small" :disabled="previewLayer.startsWith('_') || isPanelLayer(previewLayer)">对原稿</el-checkbox>
        <el-select v-model="reportStage" size="small" :teleported="false" style="width: 130px">
          <el-option v-for="s in STAGES" :key="s" :label="STAGE_LABEL[s]" :value="s" />
        </el-select>
        <span class="t-caption">{{ overlayItems.length ? `本层 ${overlayItems.length} 处标记` : '本层无标记' }}</span>
        <span class="t-caption">↑ / ↓ 切层</span>
        <span class="spacer" />
        <el-button v-if="highlightId" size="small" @click="resetView">全图</el-button>
        <el-button size="small" :icon="Minimize2" @click="exitPreviewFullscreen">退出全屏</el-button>
      </div>
      <!-- 同上:SVG 来自本平台 worker,经服务端代理 -->
      <div class="pcb-fs__stage">
        <div v-for="c in compareSvgs" :key="c.layer" class="svg-stack__layer" :style="{ opacity: compareOpacity }" v-html="c.svg" />
        <div class="svg-stack__layer" v-html="svgWithOverlay" />
      </div>
      <!-- 透明度/图例在板图下面,出现与否不挪板图 -->
      <div v-if="showCompare" class="pcb-fs__bar">
        <span class="t-caption">对照层透明度</span>
        <el-slider v-model="compareOpacity" :min="0.15" :max="0.9" :step="0.05" size="small" style="width: 160px" />
        <span class="pcb-legend">
          <span class="pcb-legend__item"><i class="pcb-legend__dot" :style="{ background: layerColor(previewLayer) }" />{{ previewLayer }}(主)</span>
          <span v-for="l in compareLayers" :key="l" class="pcb-legend__item">
            <i class="pcb-legend__dot" :style="{ background: layerColor(l), opacity: compareOpacity }" />{{ l }}
          </span>
          <span v-if="compareOrig" class="pcb-legend__item"><i class="pcb-legend__dot" :style="{ background: layerColor(ORIG_KEY), opacity: compareOpacity }" />原稿(客户文件)</span>
        </span>
      </div>
    </div>
  </Teleport>
  <!-- 终稿对比全屏:叠加图 + 差异清单并排铺满视口;工具条与抽屉里一致 -->
  <Teleport to="body">
    <div v-if="cmpFullscreen && cmpCurrent" ref="cmpStageEl" class="pcb-fs" :class="{ 'pcb-scope pcb-scope-fs': scopeOn }" role="dialog" aria-label="终稿对比全屏">
      <div class="pcb-fs__bar">
        <el-select v-model="cmpLayer" size="small" :teleported="false" style="width: 260px">
          <el-option v-for="l in cmpLayers" :key="l.suffix" :label="`${cmpTypeLabel(l)} · ${l.n_clusters} 处`" :value="l.suffix" />
        </el-select>
        <span class="cmp-toggles">
          <el-checkbox v-model="cmpShow.orig" size="small"><span class="cmp-dot cmp-dot--orig" />原稿</el-checkbox>
          <el-checkbox v-model="cmpShow.ours" size="small">我们的</el-checkbox>
          <el-checkbox v-model="cmpShow.gold" size="small">终稿(灰)</el-checkbox>
          <el-checkbox v-model="cmpShow.missing" size="small"><span class="cmp-dot cmp-dot--missing" />少了</el-checkbox>
          <el-checkbox v-model="cmpShow.extra" size="small"><span class="cmp-dot cmp-dot--extra" />多了</el-checkbox>
          <el-checkbox v-model="cmpShow.boxes" size="small">差异框</el-checkbox>
        </span>
        <span class="t-caption">我们的层透明度</span>
        <el-slider v-model="cmpOursOpacity" :min="0.1" :max="1" :step="0.05" size="small" style="width: 140px" />
        <span class="spacer" />
        <el-button v-if="cmpSelected !== null" size="small" @click="cmpSelected = null">全图</el-button>
        <el-button size="small" :icon="Minimize2" @click="exitCmpFullscreen">退出全屏</el-button>
      </div>
      <div class="pcb-fs__cmp">
        <!-- 同上:SVG 来自本平台 worker,经服务端代理 -->
        <div :class="[cmpStageClass, 'pcb-fs__cmp-stage']" :style="cmpOursStyle" v-html="cmpSvg" />
        <div class="pcb-fs__cmp-list">
          <el-radio-group v-model="cmpDir" size="small">
            <el-radio-button value="all">全部 {{ cmpCurrent.n_clusters }}</el-radio-button>
            <el-radio-button value="missing">少了 {{ cmpCurrent.n_missing }}</el-radio-button>
            <el-radio-button value="extra">多了 {{ cmpCurrent.n_extra }}</el-radio-button>
            <el-radio-button value="changed">改了 {{ cmpCurrent.n_changed }}</el-radio-button>
          </el-radio-group>
          <p v-if="cmpClusterList.length === 0" class="t-caption">这一层没有形体差异</p>
          <ul v-else class="cmp-clusters">
            <li v-for="c in cmpClusterList" :key="c.id" :class="['cmp-clusters__item', `cmp-clusters__item--${c.direction}`, { 'cmp-clusters__item--selected': c.id === cmpSelected }]" @click="cmpLocate(c)">
              <span class="cmp-clusters__no">#{{ c.id + 1 }}</span>
              <span class="cmp-clusters__what">{{ cmpDirLabel(c.direction) }}</span>
              <span class="cmp-clusters__size">
                <template v-if="c.direction === 'changed'">少 {{ (c.area_missing_mm2 ?? 0).toFixed(2) }} / 多 {{ (c.area_extra_mm2 ?? 0).toFixed(2) }} mm²</template>
                <template v-else>{{ c.area_mm2.toFixed(2) }} mm²</template>
                · {{ c.size_mm[0].toFixed(2) }}×{{ c.size_mm[1].toFixed(2) }}<template v-if="c.pieces > 1"> · {{ c.pieces }} 块</template>
              </span>
              <span class="cmp-clusters__at t-caption">@ {{ c.at[0].toFixed(1) }}, {{ c.at[1].toFixed(1) }}</span>
            </li>
          </ul>
        </div>
      </div>
      <div class="pcb-fs__bar">
        <span class="pcb-legend">
          <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#f59e0b" />客户原稿</span>
          <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#9ca3af" />人工终稿</span>
          <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#dc2626" />人有我们没有</span>
          <span class="pcb-legend__item"><i class="pcb-legend__dot" style="background:#2563eb" />我们有人没有</span>
          <span class="pcb-legend__item"><i class="pcb-legend__dot cmp-legend__dot--changed" />两边都有、形状不同(红蓝叠在一起)</span>
        </span>
      </div>
    </div>
  </Teleport>
  <!-- 放行盖章:下发成功时盖一枚「已下发」章 -->
  <Teleport to="body">
    <div v-if="stamping" class="stamp-wrap"><div class="stamp">已下发<small>RELEASED</small></div></div>
  </Teleport>
</template>

<style scoped>
/* 工作队列的三个数 */
.qstat { display: flex; gap: var(--sb-space-3); margin: 0 0 var(--sb-space-3); flex-wrap: wrap; }
.qstat__card { display: flex; align-items: baseline; gap: var(--sb-space-2); padding: var(--sb-space-2) var(--sb-space-4); border: 1px solid var(--sb-border); border-radius: 10px; background: var(--sb-bg-card); cursor: pointer; text-align: left; font: inherit; color: inherit; }
.qstat__card--active { border-color: var(--sb-color-primary); box-shadow: 0 0 0 1px var(--sb-color-primary) inset; }
.qstat__n { font-size: 26px; font-weight: 700; line-height: 1; }
.qstat__n--hot { color: var(--sb-color-danger); }
.qstat__l { font-size: var(--sb-font-sm); color: var(--sb-text-secondary); }
.qstat__l i { font-style: normal; }
/* 等了多久 */
.wait--1 { color: #b45309; font-weight: 600; }
.wait--2 { color: var(--sb-color-danger); font-weight: 700; }
:deep(.row-wait-1) td { background: rgba(245, 158, 11, 0.06) !important; }
:deep(.row-wait-2) td { background: rgba(220, 38, 38, 0.07) !important; }
/* 任务头上的信任仪表 */
.trust { cursor: pointer; padding: 2px 10px; border-radius: 999px; border: 1px solid #f59e0b; color: #b45309; font-size: var(--sb-font-sm); }
.trust--clean { border-color: #16a34a; color: #15803d; }
.preview-modes { margin-top: 0; margin-bottom: var(--sb-space-1, 4px); }
/* 查板命中 */
.svg-stack__layer :deep(.pcb-ask) { stroke: #06b6d4; stroke-width: 1.5; fill: rgba(6, 182, 212, 0.15); }
.pcb-fs__stage :deep(.pcb-ask) { stroke: #06b6d4; stroke-width: 1.5; fill: rgba(6, 182, 212, 0.15); }
/* 放行盖章 */
.stamp-wrap { position: fixed; inset: 0; z-index: 4000; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.stamp { border: 6px double #dc2626; color: #dc2626; border-radius: 12px; padding: 12px 36px; font-size: 56px; font-weight: 900; letter-spacing: 8px; transform: rotate(-12deg); background: rgba(255, 255, 255, 0.85); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25); animation: stamp-in 1.6s cubic-bezier(0.2, 1.4, 0.4, 1) forwards; text-align: center; }
.stamp small { display: block; font-size: 16px; letter-spacing: 6px; }
@keyframes stamp-in { 0% { transform: rotate(-12deg) scale(3); opacity: 0; } 20% { transform: rotate(-12deg) scale(1); opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--sb-space-3);
  min-width: 0;
}
.toolbar-actions {
  display: flex;
  gap: var(--sb-space-2);
  flex: none;
}
.file-input {
  width: 100%;
  font-size: var(--sb-font-sm);
}
.file-list {
  margin: var(--sb-space-2) 0 0;
  padding-left: var(--sb-space-4);
  color: var(--sb-text-secondary);
}
.field-error {
  color: var(--sb-color-danger);
}
.job-head {
  display: flex;
  align-items: center;
  gap: var(--sb-space-3);
  margin-bottom: var(--sb-space-3);
}
.job-head .spacer {
  flex: 1;
}
.job-alert {
  margin-bottom: var(--sb-space-3);
}
.review-panel {
  margin-bottom: var(--sb-space-4);
  padding: var(--sb-space-4);
}
.review-actions {
  display: flex;
  gap: var(--sb-space-2);
  align-items: center;
  margin-top: var(--sb-space-3);
}
.eq-item {
  border: 1px solid var(--sb-border);
  border-radius: 8px;
  padding: var(--sb-space-3);
  margin-bottom: var(--sb-space-2);
  background: var(--sb-bg-card);
}
.eq-item--done {
  opacity: 0.7;
}
.eq-item__head {
  display: flex;
  gap: var(--sb-space-2);
  align-items: center;
}
.eq-item__msg {
  margin: var(--sb-space-2) 0;
}
.eq-item__actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: var(--sb-space-2);
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
}
.timeline__item {
  display: flex;
  align-items: center;
  gap: var(--sb-space-3);
  min-width: 0;
}
.timeline__name {
  width: 6.5em;
  flex: none;
  font-weight: 600;
}
.timeline__item .t-caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline__counts {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.timeline__brief {
  flex: 1;
  min-width: 0;
}
.timeline__dur {
  flex: none;
}
/* 计数色块:一眼分出这一步是红是黄,比一串「错误 0 · 警告 2 · 提示 11」好扫 */
.cnt {
  display: inline-block;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--sb-font-xs);
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  color: var(--sb-text-secondary);
  background: var(--sb-bg-subtle);
}
/* 老内核没有 color-mix:先给一条静态底色,新内核再用 color-mix 覆盖成淡色调 */
.cnt--error {
  color: var(--sb-color-danger);
  background: var(--sb-bg-subtle);
  background: color-mix(in srgb, var(--sb-color-danger) 12%, transparent);
}
.cnt--warn {
  color: var(--sb-color-warning);
  background: var(--sb-bg-subtle);
  background: color-mix(in srgb, var(--sb-color-warning) 14%, transparent);
}
.cnt--fix {
  color: var(--sb-color-success);
  background: var(--sb-bg-subtle);
  background: color-mix(in srgb, var(--sb-color-success) 12%, transparent);
}
.cnt--decide {
  color: var(--sb-color-primary);
  background: var(--sb-bg-subtle);
  background: color-mix(in srgb, var(--sb-color-primary) 12%, transparent);
}
/* 页签上的待处理计数 */
.tab-todo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.tab-todo__n {
  font-style: normal;
  font-size: var(--sb-font-xs);
  line-height: 16px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  text-align: center;
  color: #fff;
  background: var(--sb-color-warning);
}
/* 说明文字默认收起,点一下才展开:每次开抽屉都读一遍同样的三行小字没有必要 */
.help-note {
  margin-bottom: var(--sb-space-2);
}
.help-note > summary {
  cursor: pointer;
  color: var(--sb-color-primary);
  list-style: none;
  user-select: none;
}
.help-note > summary::before {
  content: '▸ ';
}
.help-note[open] > summary::before {
  content: '▾ ';
}
.help-note > summary::-webkit-details-marker {
  display: none;
}
.help-note > p {
  margin: var(--sb-space-1) 0 0;
}
.artifact-group {
  margin-top: var(--sb-space-4);
}
.artifact-group__title {
  margin: 0 0 var(--sb-space-2);
}
.artifact-group__title .t-subtitle {
  margin: 0;
  display: flex;
  gap: var(--sb-space-2);
  align-items: baseline;
}
.eq-item__head .spacer {
  flex: 1;
}
.keyword-input {
  width: 220px;
}
.nowrap {
  white-space: nowrap;
}
.engine-pill {
  align-self: center;
}
/* 多层叠加:各层同 viewBox 的 SVG 绝对定位叠在一起,主层在最上面 */
.svg-stack {
  position: relative;
  border: 1px solid var(--sb-border);
  border-radius: 8px;
  background: var(--sb-bg-card);
  overflow: hidden;
  min-height: 320px;
  max-height: 70vh;
  aspect-ratio: 4 / 3;
}
.svg-stack__layer {
  position: absolute;
  inset: 0;
}
.svg-stack__layer :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.pcb-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sb-space-2);
}
.pcb-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85em;
  color: var(--sb-text-secondary, inherit);
}
.pcb-legend__dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}
.pcb-fs {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
  padding: var(--sb-space-3);
  background: var(--sb-bg-page, var(--sb-bg-card));
}
.pcb-fs__bar {
  display: flex;
  align-items: center;
  gap: var(--sb-space-2);
  flex-wrap: wrap;
  position: relative; /* 不 teleport 的下拉面板以它定位 */
}
.pcb-legend-row {
  margin-top: var(--sb-space-2);
}
.field-warn {
  color: var(--sb-color-warning);
}
.pcb-fs__stage {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--sb-border);
  border-radius: 8px;
  background: var(--sb-bg-card);
}
/* worker 出的 SVG 只有 viewBox 没有固有尺寸,width:auto 会塌成 0;填满容器交给
   preserveAspectRatio(默认 meet)等比留白 */
.pcb-fs__stage :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.pcb-fs__stage :deep(.pcb-hit) {
  stroke: var(--sb-color-warning);
  stroke-width: 1.5px;
  fill: var(--sb-color-warning);
  fill-opacity: 0.18;
}
.pcb-fs__stage :deep(.pcb-hit--error) {
  stroke: var(--sb-color-danger);
  fill: var(--sb-color-danger);
}
.pcb-fs__stage :deep(.pcb-hit--info) {
  stroke: var(--sb-color-primary);
  fill: var(--sb-color-primary);
}
.pcb-fs__stage :deep(.pcb-hit--selected) {
  stroke-width: 3px;
  fill-opacity: 0.35;
}
.svg-stage {
  border: 1px solid var(--sb-border);
  border-radius: 8px;
  background: var(--sb-bg-card);
  overflow: auto;
  max-height: 70vh;
}
.svg-stage :deep(svg) {
  width: 100%;
  height: auto;
  display: block;
}
.profile-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: var(--sb-space-4, 16px);
}
.profile-list .el-table {
  cursor: pointer;
}
.profile-edit :deep(.is-overridden .el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--sb-color-primary) inset;
}
.yaml-editor :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.svg-stage :deep(.pcb-hit) {
  stroke: var(--sb-color-warning);
  stroke-width: 1.5px;
  fill: var(--sb-color-warning);
  fill-opacity: 0.18;
}
.svg-stage :deep(.pcb-hit--error) {
  stroke: var(--sb-color-danger);
  fill: var(--sb-color-danger);
}
.svg-stage :deep(.pcb-hit--info) {
  stroke: var(--sb-color-primary);
  fill: var(--sb-color-primary);
}
.svg-stage :deep(.pcb-hit--selected) {
  stroke-width: 3px;
  fill-opacity: 0.35;
}
.svg-stage--stackup {
  margin-top: var(--sb-space-3);
}
.spec-checks {
  list-style: none;
  margin: 0 0 var(--sb-space-2);
  padding: 0;
  display: grid;
  gap: var(--sb-space-1);
}
.spec-checks__item {
  display: flex;
  align-items: flex-start;
  gap: var(--sb-space-2);
}
.download-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--sb-color-primary);
}
/* 窄屏(手机档 + 平板档 ≤920)两栏都收成单列;平板档按护栏要求显式带下界 */
@media (max-width: 768px) {
  .profile-layout,
  .eq-item__actions {
    grid-template-columns: 1fr;
  }
  .keyword-input {
    width: 100%;
  }
}
@media (min-width: 769px) and (max-width: 920px) {
  .profile-layout,
  .eq-item__actions {
    grid-template-columns: 1fr;
  }
}
/* ── 终稿对比 ── */
.cmp-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sb-space-3);
  align-items: baseline;
  margin-bottom: var(--sb-space-2);
}
.cmp-row--active {
  font-weight: 600;
}
.cmp-view {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: var(--sb-space-3);
  margin-top: var(--sb-space-3);
}
@media (max-width: 900px) {
  .cmp-view {
    grid-template-columns: 1fr;
  }
}
.cmp-view__stage {
  min-width: 0;
}
.cmp-stage {
  border: 1px solid var(--sb-border);
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  min-height: 320px;
  max-height: 70vh;
  aspect-ratio: 4 / 3;
}
.cmp-stage :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.cmp-stage :deep(.cmp-ours) {
  opacity: var(--cmp-ours-opacity, 0.35);
}
.cmp-stage :deep(.cmp-gold) {
  opacity: 0.5;
}
.cmp-stage :deep(.cmp-orig) {
  opacity: 0.45;
}
.cmp-hide-gold :deep(.cmp-gold),
.cmp-hide-orig :deep(.cmp-orig),
.cmp-hide-ours :deep(.cmp-ours),
.cmp-hide-missing :deep(.cmp-missing),
.cmp-hide-extra :deep(.cmp-extra),
.cmp-hide-boxes :deep(.cmp-clusters) {
  display: none;
}
.cmp-stage :deep(.cmp-cluster) {
  stroke: #dc2626;
  stroke-width: 1.5px;
  stroke-dasharray: 4 2;
}
.cmp-stage :deep(.cmp-cluster--extra) {
  stroke: #2563eb;
}
.cmp-stage :deep(.cmp-cluster--changed) {
  stroke: #a855f7;
  stroke-dasharray: none;
}
.cmp-stage :deep(.cmp-cluster--selected) {
  stroke: #f59e0b;
  stroke-width: 3px;
  stroke-dasharray: none;
}
/* 全屏:叠加图占满剩余高度,清单在右侧自己滚 */
.pcb-fs__cmp {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  grid-template-rows: minmax(0, 1fr); /* 行高定死,板图的 height:100% 才有参照;不然 SVG 按固有 mm 尺寸画成一小块 */
  gap: var(--sb-space-3);
}
.pcb-fs__cmp-stage.cmp-stage {
  max-height: none;
  aspect-ratio: auto;
  height: 100%;
  min-height: 0;
}
.pcb-fs__cmp-list {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sb-space-2);
}
.cmp-toggles {
  display: inline-flex;
  gap: var(--sb-space-2);
}
.cmp-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}
.cmp-dot--missing {
  background: #dc2626;
}
.cmp-dot--orig {
  background: #f59e0b;
}
.cmp-dot--extra {
  background: #2563eb;
}
.cmp-clusters {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 60vh;
  overflow: auto;
  border: 1px solid var(--sb-border);
  border-radius: 8px;
}
.cmp-clusters__item {
  display: grid;
  grid-template-columns: 44px 1fr;
  grid-template-areas: 'no what' 'no size' 'no at';
  gap: 0 var(--sb-space-2);
  padding: 6px 10px;
  border-left: 3px solid #dc2626;
  border-bottom: 1px solid var(--sb-border);
  cursor: pointer;
  font-size: 0.9em;
}
.cmp-clusters__item--extra {
  border-left-color: #2563eb;
}
.cmp-clusters__item--changed {
  border-left-color: #a855f7;
}
.cmp-legend__dot--changed {
  background: #a855f7;
}
.t-changed {
  color: #a855f7;
}
.cmp-clusters__item:hover {
  background: var(--sb-bg-hover, rgba(0, 0, 0, 0.03));
}
.cmp-clusters__item--selected {
  background: rgba(245, 158, 11, 0.12);
}
.cmp-clusters__no {
  grid-area: no;
  font-weight: 600;
  align-self: start;
}
.cmp-clusters__what {
  grid-area: what;
}
.cmp-clusters__size {
  grid-area: size;
}
.cmp-clusters__at {
  grid-area: at;
}
.t-success {
  color: var(--sb-color-success);
}
.t-danger {
  color: #dc2626;
}
.t-info {
  color: #2563eb;
}
</style>
