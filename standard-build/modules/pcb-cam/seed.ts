// modules/pcb-cam/seed.ts
// 演示数据:把 pcb 仓 cases/ 下的验收案例(每个 = 一个客户资料包 + 故意植入的缺陷)造成项目 + 任务,
// 推进器像对真实上传一样跑它们;`registerDemoAutopilot` 让每个案例自动走到设计好的停点,演示租户一进来
// 就能看到「等层确认 / 等审单 / 停在钻孔问题点 / 已完成 / 被网络比较阻断」各种状态。
// 只在本机演示模式(server.ts 无 DATABASE_URL → PGlite + seed)下有意义;找不到 cases 目录就只建空项目。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Ctx, Db } from '../../core/db/client'
import { putObject } from '../../core/storage/api'
import { registerDemoAutopilot, type DemoStop } from './automation'
import { createJob, createProject, storagePrefix, upsertFactoryProfile } from './logic'
import { and, eq, inArray } from 'drizzle-orm'
import { pcbCamJobs, pcbCamProjects } from './model'

export type DemoCase = { dir: string; name: string; blurb: string; stopAt: DemoStop }

/** 与 pcb 仓 cases/README.md 的案例表一致;stopAt 是演示要停的地方(none = 一路自动到完成 / 被阻断) */
export const DEMO_CASES: DemoCase[] = [
  { dir: 'C01_two_layer_clean', name: 'C01 双面板 · 干净', blurb: '层识别全对、孔表一致、零误报;一路自动跑到完成,看完整成果物', stopAt: 'none' },
  { dir: 'C02_drill_defects', name: 'C02 钻孔缺陷', blurb: '多余孔 / 缺孔 / 两孔重叠 / NPTH 近板边;停在钻孔阶段的问题点等你拍板', stopAt: 'eq:drill' },
  { dir: 'C03_order_spec', name: 'C03 附件审单', blurb: '制作要求 xlsx/pdf 里钻孔表故意写错 1 个孔径;停在「规格确认」看 AI 候选与程序核对', stopAt: 'order_spec' },
  { dir: 'C04_messy_names', name: 'C04 命名混乱', blurb: 'top.art / L2.pho / 阻焊面.gbr 这种文件名;停在「层识别确认」看规则 + LLM 兜底', stopAt: 'layers' },
  { dir: 'C05_four_layer_dfm', name: 'C05 四层 DFM 缺陷', blurb: '线宽线距 3mil、焊环 5mil、负片隔离环 8mil、字符压焊盘、开窗小于 PAD;本地引擎修掉大半,停在内层问题点', stopAt: 'eq:inner' },
  { dir: 'C06_net_guard', name: 'C06 网络守门', blurb: '短接两网 + 断一根线;停在网络比较的问题点,看开短路定位(改图后仍按客户原稿的网名比对)', stopAt: 'eq:net_compare' },
  { dir: 'C07_panel_output', name: 'C07 拼板 + 输出', blurb: '工作板方案、阻流块、定位孔、生产版 Gerber/钻带/锣带;一路自动到完成', stopAt: 'none' },
  { dir: 'C08_blind_buried', name: 'C08 盲埋孔六层', blurb: '三套钻带的 span 识别、盲埋孔流程单、叠层图;一路自动到完成', stopAt: 'none' },
  { dir: 'C10_native_b1', name: 'C10 本地引擎改图', blurb: 'B 线反向构造:植入的缺陷被本地几何引擎修掉;停在外层问题点,勾「对原稿」看改动', stopAt: 'eq:outer' },
  { dir: 'C09_real_6l_3oz', name: 'C09 真板 · 六层 3oz', blurb: '第一份真实客户资料(六层内外 3oz);工厂标准从工程师成品反推(该案例自带 profile.yaml);一路自动到完成,成果物按厂规命名', stopAt: 'none' },
  { dir: 'C11_real_4l_altium', name: 'C11 真板 · 四层 1oz · Altium 源文件 3×3', blurb: '客户给的是 .PcbDoc 源文件,引擎直接读并按 Altium 方式导 Gerber;成品是 3×3 拼板(V-cut + 锣槽 + 工艺边);厂规从工程师成品反推(自带 profile.yaml);一路自动到完成', stopAt: 'none' },
  { dir: 'C12_real_4l_protel99', name: 'C12 真板 · 四层 1oz · Protel 99 SE 源文件 2×2', blurb: '客户给的是 Protel 99 SE .pcb 源文件;Keep-Out 层的锣槽/板边孔按客户说明做非金属化;2×2 拼板四边工艺边;一路自动到完成', stopAt: 'none' },
]

const CONTENT_TYPES: Record<string, string> = {
  zip: 'application/zip', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', md: 'text/markdown',
}
/** 案例输入里不是「客户上传」的文件:order_spec.json 是网页确认后的规格(自动驾驶用),profile.yaml 是工厂标准覆盖 */
const NOT_UPLOADED = new Set(['order_spec.json', 'profile.yaml'])

/** Prefer the bundled engine; retain the previous sibling-repository layouts. */
export function findCasesDir(): string | null {
  const candidates = [process.env.PCB_CAM_CASES_DIR, fileURLToPath(new URL('../../../pcb-worker/cases/', import.meta.url)), '../../pcb/cases', '../pcb/cases', './pcb/cases'].filter((x): x is string => Boolean(x))
  for (const c of candidates) {
    const abs = path.resolve(process.cwd(), c)
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs
  }
  return null
}

export async function seedPcbCamDemo(db: Db, ctx: Ctx, opts: { profileId?: string; casesDir?: string | null } = {}): Promise<{ projects: number; jobs: number }> {
  const casesDir = opts.casesDir === undefined ? findCasesDir() : opts.casesDir
  if (!casesDir) {
    await createProject(db, ctx, { name: '演示板 C01(双面板)', customerName: '示例客户', factoryProfileId: opts.profileId })
    console.warn('[pcb-cam seed] 找不到 pcb 仓 cases/ 目录(PCB_CAM_CASES_DIR),只建了空项目;资料包按 cases/*/CHECKLIST.md 手动上传')
    return { projects: 1, jobs: 0 }
  }
  let projects = 0
  let jobs = 0
  // PCB_CAM_DEMO_CASES=C09_real_6l_3oz,C01_two_layer_clean → only those (a real board takes the worker
  // 40 min when ten demos run at once; two is enough to look at)
  const only = new Set((process.env.PCB_CAM_DEMO_CASES || '').split(',').map((x) => x.trim()).filter(Boolean))
  for (const c of only.size ? DEMO_CASES.filter((c) => only.has(c.dir)) : DEMO_CASES) {
    const input = path.join(casesDir, c.dir, 'input')
    if (!existsSync(input)) continue
    // a case that ships its own factory standard (input/profile.yaml: the rules reverse-engineered from the
    // engineer's work/) gets its own profile; the others share the demo one
    const yamlPath = path.join(input, 'profile.yaml')
    let profileId = opts.profileId
    if (existsSync(yamlPath)) {
      const own = await upsertFactoryProfile(db, ctx, { name: `${c.name} · 工厂标准(从成品反推)`, yaml: readFileSync(yamlPath, 'utf-8') })
      profileId = own.id
    }
    const project = await createProject(db, ctx, { name: `演示 · ${c.name}`, customerName: `演示客户 · ${c.blurb}`, factoryProfileId: profileId })
    projects++
    const files = readdirSync(input).filter((f) => !f.startsWith('.') && !NOT_UPLOADED.has(f) && statSync(path.join(input, f)).isFile())
    // a customer package is an archive, or (M6i) the raw source file + notes the customer sent as-is
    if (!files.some((f) => /\.(zip|rar|7z|pcbdoc|pcb)$/i.test(f))) continue
    const jobId = randomUUID()
    const keyPrefix = `${storagePrefix(ctx.tenantId, jobId)}input`
    const inputKeys: string[] = []
    for (const f of files) {
      const ext = f.split('.').pop()?.toLowerCase() ?? ''
      const stored = await putObject(db, ctx, { bytes: readFileSync(path.join(input, f)), filename: f, contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream', keyPrefix, visibility: 'private' })
      inputKeys.push(stored.key)
    }
    const job = await createJob(db, ctx, project.id, { jobId, inputKeys })
    jobs++
    const specPath = path.join(input, 'order_spec.json')
    const orderSpec = existsSync(specPath) ? (JSON.parse(readFileSync(specPath, 'utf-8')) as Record<string, unknown>) : null
    registerDemoAutopilot(job.id, { ctx, stopAt: c.stopAt, orderSpec })
  }
  return { projects, jobs }
}

/** 自动驾驶只在进程内存里登记(见 automation.ts);库是持久的(本机 Postgres + SEED_DEMO)时,重启后 seed 不再跑,
 * 演示任务就会停在第一个人工节点。这里按项目名把还没到终态的演示任务重新登记上,停点仍按 DEMO_CASES。 */
export async function reattachDemoAutopilot(db: Db, ctx: Ctx, opts: { casesDir?: string | null } = {}): Promise<number> {
  const casesDir = opts.casesDir === undefined ? findCasesDir() : opts.casesDir
  let n = 0
  for (const c of DEMO_CASES) {
    const projects = await db.select({ id: pcbCamProjects.id }).from(pcbCamProjects)
      .where(and(eq(pcbCamProjects.tenantId, ctx.tenantId), eq(pcbCamProjects.name, `演示 · ${c.name}`), eq(pcbCamProjects.isDeleted, false)))
    if (projects.length === 0) continue
    const jobs = await db.select({ id: pcbCamJobs.id }).from(pcbCamJobs)
      .where(and(eq(pcbCamJobs.tenantId, ctx.tenantId), inArray(pcbCamJobs.projectId, projects.map((p) => p.id)), eq(pcbCamJobs.isDeleted, false),
        inArray(pcbCamJobs.status, ['pending', 'running', 'needs_review'])))
    if (jobs.length === 0) continue
    const specPath = casesDir ? path.join(casesDir, c.dir, 'input', 'order_spec.json') : ''
    const orderSpec = specPath && existsSync(specPath) ? (JSON.parse(readFileSync(specPath, 'utf-8')) as Record<string, unknown>) : null
    for (const j of jobs) {
      registerDemoAutopilot(j.id, { ctx, stopAt: c.stopAt, orderSpec })
      n++
    }
  }
  return n
}
