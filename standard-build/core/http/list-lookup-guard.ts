// core/http/list-lookup-guard.ts
// 质量护栏:**分页列表的结果不得用于 `.find()` 反查**。
//
// 这类 bug 的形态:页面为了「快速反查」把某实体的列表拉进内存当缓存,却只拉了一页
// (limit 默认 20 / 上限 50),于是第 51 条之后的实体「查不到」——列表里名字显示成 `-`,
// 下拉里选不中。数据量小的租户永远发现不了,数据一多就零星报错,极难定位。
//
// 正确做法有三条,按优先级:
//   ① 反查值由**后端随行带出**(如 contract 的 `ct.partnerName ?? …`)——首选,前端不需要缓存;
//   ② 下拉/选择器用 **picker 全集端点**(`/employees/picker`、`/departments/picker`),
//      它不分页、不门控;见 `src/api/client.ts` 里 apiListEmployeePicker 的注释;
//   ③ 确需按 id 批量取名,加专用 resolve 端点,上限按 ids 长度而非分页 limit。
//
// 三种要抓的形态(都是「拿有上限的列表当全集」):
//   · `list.find(x => x.id === id)`
//   · `new Map(list.map(x => [x.id, x]))` 然后 `.get(id)` —— 本质相同,只是写法不同
//   · **经一层中间 computed 派生**的上面两种 —— 2026-07-29 就是这个盲区漏掉了
//     FinanceWorkspace / RevenueRecognitionPanel 两处 `partnerNameById`
//
// 两类「有上限」的接口:
//   · 带 limit 参数的分页接口(默认 20 / 上限 50);
//   · **picker 全集端点**(URL 含 /picker)—— 不收 limit,但后端有硬上限兜底
//     (core/org/logic/employee.ts 的 PICKER_MAX_LIMIT = 500)。
//
// ★但 picker 分两类,只有后者算违反:
//   · **按公司规模有界**的实体(员工、部门)—— 500 是有余量的设计上限(注释:「目标 ~200 人」),
//     不随业务增长,拿它反查是**正当**的。见 BOUNDED_PICKERS。
//   · **随业务增长**的实体(客户、商品、订单…)—— 即使做成 picker 也会被 500 截断,
//     反查必须走「后端随行带出」。
//
// 白名单只放**天生小集合的配置类实体**(阶段、请假类型、职级、部门…),它们不随业务增长。

import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const ROOT = process.cwd() // 运行/测试均在 standard-build/ 下

export type ListLookupIssue = { file: string; varName: string; api: string; reason: string }

/**
 * 白名单:`<文件名>:<变量名>` → 放行原因。
 * 加进来前先自问:这个实体会不会随客户业务增长?会 → 不该放行,该按上面三条之一改。
 */
/**
 * 豁免的 picker:实体总量**按公司规模有界**,不随业务增长,故拿它反查是正当的。
 * 加新条目前先问:这个实体会不会随客户做生意而增长?会 → 不该加,反查得让后端随行带出。
 */
const BOUNDED_PICKERS = new Set([
  'apiListEmployeePicker', // 员工:PICKER_MAX_LIMIT=500,注释「员工数按公司规模有界,目标 ~200 人」
  'apiListDepartmentPicker', // 部门:同上,量级更小
])

const ALLOWLIST: Record<string, string> = {
  // ── 安全:反查值后端已随行带出,.find() 只是兜底 ──
  'ContractManagement.vue:partners':
    '合同行自带 ct.partnerName,find 仅兜底(见该文件 118 行注释:列表客户名由后端带出,不靠这份反查)',
  'OpportunityBoard.vue:partners':
    '商机行自带 o.partnerName,find 仅兜底',
  'PcbCamWorkspace.vue:projects':
    '任务行/抽屉标题用后端随行带出的 job.projectName;剩下的 find 只给筛选条上的项目名,值就是从这份 projects 下拉里选出来的',

  // ── 安全:选中那一刻同步取用,列表此时必然含该项 ──
  'QuoteDocEditor.vue:catalogOptions':
    'addSectionFromCatalog 由 el-select 的 @change 同步调用,选中项此刻就在 catalogOptions 里',
  'ContractManagement.vue:createOpps':
    '同上,创建表单里选中商机后同步取用',
  'PaymentVoucherWorkspace.vue:suppliers':
    '2026-07-29 已按①修复:选中那一刻把供应商捕获进 pickedSupplier 留存,列表后续变化(远程搜索/清空搜索框)不再抹掉已选。find 只在捕获时用一次。',

  // ── 天生小集合的配置类实体 ──
  'ContractManagement.vue:templates':
    '合同模板是租户配置项(个位数~几十),不随业务增长',

}

/**
 * 解析出「返回条数有上限」的 API 函数名:
 *   ① 接受 limit 参数的分页接口;
 *   ② URL 含 /picker 的全集端点(后端硬上限,见顶部说明)。
 */
async function paginatedApis(): Promise<Set<string>> {
  const src = await readFile(resolve(ROOT, 'src/api/client.ts'), 'utf8')
  const out = new Set<string>()
  // 形如:export async function apiListXxx(input: { …; limit?: number } = {}) {
  for (const m of src.matchAll(/export async function (api\w+)\(([^)]*)\)/g)) {
    if (/\blimit\??\s*:/.test(m[2] ?? '')) out.add(m[1]!)
  }
  // 形如:多行参数对象(签名跨行),退一步整段扫函数体前 400 字符
  for (const m of src.matchAll(/export async function (api\w+)\(/g)) {
    const seg = src.slice(m.index!, m.index! + 400)
    if (/\blimit\??\s*:\s*number/.test(seg)) out.add(m[1]!)
    // picker 全集端点:不收 limit,但后端有硬上限(PICKER_MAX_LIMIT)
    if (/'\/api\/[^']*\/picker'/.test(seg)) out.add(m[1]!)
  }
  return out
}

async function vueFiles(): Promise<string[]> {
  const out: string[] = []
  for (const base of ['modules', 'src']) {
    const stack = [resolve(ROOT, base)]
    while (stack.length) {
      const dir = stack.pop()!
      let entries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const p = resolve(dir, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name.endsWith('.vue')) out.push(p)
      }
    }
  }
  return out.sort()
}

/**
 * 扫所有 .vue:找「由分页 API 喂出来的 items 列表」被 `.find()` 反查的地方。
 * 返回空数组即合规。
 */
export async function listPaginatedLookupIssues(): Promise<ListLookupIssue[]> {
  const paged = await paginatedApis()
  const issues: ListLookupIssue[] = []
  for (const file of await vueFiles()) {
    const src = await readFile(file, 'utf8')
    const short = file.slice(file.indexOf('/modules/') >= 0 ? file.indexOf('/modules/') + 9 : file.lastIndexOf('/src/') + 1)
    // 形态一:const X = computed(() => Q.data.value?.items …)  之后 X.find(…)
    // 形态二:const X = computed(() => new Map((Q.data.value?.items ?? []).map(…)))  —— 反查 Map,等价
    const sites: Array<{ varName: string; queryName: string; kind: string }> = []
    for (const m of src.matchAll(/const (\w+) = computed\(\(\) => (\w+)\.data\.value\?\.items/g)) {
      sites.push({ varName: m[1]!, queryName: m[2]!, kind: 'find' })
    }
    for (const m of src.matchAll(/const (\w+) = computed\(\(\) => new Map\(\((\w+)\.data\.value\?\.items/g)) {
      sites.push({ varName: m[1]!, queryName: m[2]!, kind: 'map' })
    }
    // 派生一层:const list = computed(() => Q.data.value?.items…) 之后
    //           const byId = computed(() => new Map(list.value.map(…)))  ← 同样是拿有上限的列表当全集
    const listVarToQuery = new Map(sites.filter((x) => x.kind === 'find').map((x) => [x.varName, x.queryName]))
    for (const m of src.matchAll(/const (\w+) = computed\(\(\) => new Map\((\w+)\.value\.map\(/g)) {
      const q = listVarToQuery.get(m[2]!)
      if (q) sites.push({ varName: m[1]!, queryName: q, kind: 'map' })
    }
    for (const site of sites) {
      const { varName, queryName, kind } = site
      // find 形态要真的出现 .find(;map 形态本身就是反查表,建出来即算
      if (kind === 'find' && !new RegExp(`\\b${varName}(?:\\.value)?\\.find\\(`).test(src)) continue
      // 该 query 的 queryFn 调了哪个 api
      const q = new RegExp(`const ${queryName} = useQuery\\(\\{[\\s\\S]{0,400}?\\}\\)`).exec(src)
      if (!q) continue
      const api = /\b(api\w+)\s*\(/.exec(q[0])?.[1]
      if (!api || !paged.has(api)) continue
      if (BOUNDED_PICKERS.has(api)) continue // 按公司规模有界的 picker,反查正当
      const key = `${short.split('/').pop()}:${varName}`
      if (ALLOWLIST[key]) continue
      issues.push({
        file: short,
        varName,
        api,
        reason:
          `${varName} 来自有上限的接口 ${api}` +
          `(${kind === 'map' ? '被建成反查 Map' : '被用于 .find() 反查'})—— 超出上限的实体会查不到。` +
          `改法见本文件顶部三条(优先让后端随行带出该值);` +
          `若确属天生小集合的配置类实体,加进 ALLOWLIST 并写明理由。`,
      })
    }
  }
  return issues
}
