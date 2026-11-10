// core/org/logic/employee-import.ts
// 组织员工 Excel 批量导入:模板生成、解析校验、仅新增不更新。
// 部门识别以「部门名称」为主,支持二级/三级部门:模板用「一级部门 / 二级部门 / 三级部门」多列,
// 从左到右按层级填(员工归属到最末一级),上级列用来区分同名部门、保证唯一。
// 兼容旧模板的单「部门」列(可填名称或「上级/下级」路径)。
import * as XLSX from 'xlsx'
import type { Ctx, Db } from '../../db/client'
import { scope } from '../../db/soft-delete'
import { departments, employees } from '../model'
import { createEmployee, getDefaultEmployeePassword, hashPassword } from './employee'
import { formatAutoEmpNo, nextAutoEmpNoSerial } from './emp-no'
import { OrgError } from './errors'

// 模板列(部门按层级拆成三列)。标题星号表示必填;无星号为选填。一级部门=最顶层可见部门,依次向下。
export const EMPLOYEE_IMPORT_HEADERS = ['工号', '姓名*', '手机号*', '一级部门*', '二级部门', '三级部门', '岗位', '邮箱'] as const
// 模板第 2 行的示例数据(给用户看标准格式)。原样未改地提交时整行跳过,不会建出一个「张三」。
// 顺序与 EMPLOYEE_IMPORT_HEADERS 一一对应。
const TEMPLATE_SAMPLE_ROW = ['', '张三', '13800000000', '示例公司', '销售部', '', '工程主管', 'zhangsan@example.com'] as const
const SAMPLE_NAME = TEMPLATE_SAMPLE_ROW[1]
const SAMPLE_PHONE = TEMPLATE_SAMPLE_ROW[2]
// 每列的必填口径与填写说明(填写说明页逐列展开,与表头星号同一份口径)
const COLUMN_GUIDE: { header: string; required: '必填' | '选填'; hint: string; example: string }[] = [
  { header: '工号', required: '选填', hint: '租户内唯一;留空时系统按当前最大工号自动生成 No.00001、No.00002 这类递增编号。', example: '(留空自动生成)' },
  { header: '姓名', required: '必填', hint: '员工姓名。为空的行会导入失败。', example: '张三' },
  { header: '手机号', required: '必填', hint: '登录账号;租户内唯一,已存在的手机号会跳过。', example: '13800000000' },
  { header: '一级部门', required: '必填', hint: '最顶层部门名称,必须与系统中已有的部门名称一致。', example: '示例公司' },
  { header: '二级部门', required: '选填', hint: '员工在二级部门时填;只填到员工所在那一级即可。', example: '销售部' },
  { header: '三级部门', required: '选填', hint: '员工在三级部门时填。', example: '' },
  { header: '岗位', required: '选填', hint: '岗位名称,只作展示。', example: '工程主管' },
  { header: '邮箱', required: '选填', hint: '员工邮箱,用于系统通知与邮件往来。', example: 'zhangsan@example.com' },
]
const DEPT_LEVEL_HEADERS = ['一级部门', '二级部门', '三级部门'] as const
const LEGACY_DEPT_HEADER = '部门' // 兼容旧单列模板
const EMPLOYEE_IMPORT_TEMPLATE_MARKER = 'STANDARD_BUILD_EMPLOYEE_IMPORT_TEMPLATE_V1'

export type EmployeeImportRowResult = {
  rowNumber: number
  empNo: string
  name: string
  phone: string
  department: string // 展示用:层级路径(如「研发中心/前端组」)
  position: string
  email: string
  status: 'success' | 'failed'
  reason: string | null
  employeeId: string | null
}

export type EmployeeImportResult = {
  total: number
  success: number
  failed: number
  rows: EmployeeImportRowResult[]
}

type ParsedRow = {
  rowNumber: number
  empNo: string
  name: string
  phone: string
  deptSegments: string[] // 从上到下的部门名称段(已去空),末段=员工所属部门
  deptDisplay: string // deptSegments.join('/'),仅展示
  position: string
  email: string
}

// 一个部门节点带上它从根到自身的「名称路径」(用于同名部门按层级路径消歧)。
type DepartmentNode = { id: string; name: string; status: string; namePath: string[] }

// 旧单列「部门」允许填层级路径,分隔符:半角/全角斜杠、半角/全角大于号。
const DEPT_PATH_SEPARATOR = /\s*[/\\>＞／＼]\s*/

/** 把旧单列「部门」的「上级/下级」拆成从上到下的名称段(去空白、去空段)。 */
function splitDeptPath(input: string): string[] {
  return input.split(DEPT_PATH_SEPARATOR).map((seg) => seg.trim()).filter(Boolean)
}

/**
 * 按部门名称/层级段定位候选部门(不过滤状态,状态与唯一性由调用方判定)。
 * - 单段:按部门名称精确匹配(名称唯一即命中)。
 * - 多段:按「名称路径连续后缀」匹配,即某部门自根到自身的名称链末尾若干段 == 输入段,
 *   例如段 [研发中心, 前端组] 命中名称路径以 …→研发中心→前端组 结尾的部门。
 *   只需从能区分为止的上级填起,不必从最顶层写全。
 */
function resolveDepartment(segments: string[], depts: DepartmentNode[]): DepartmentNode[] {
  if (segments.length === 0) return []
  if (segments.length === 1) return depts.filter((dept) => dept.name === segments[0])
  return depts.filter((dept) => {
    if (dept.namePath.length < segments.length) return false
    const tail = dept.namePath.slice(dept.namePath.length - segments.length)
    return tail.every((name, i) => name === segments[i])
  })
}

const HEADER_ALIASES: Record<string, string[]> = {
  工号: ['工号', '员工工号', '员工编号', '账号编号'],
  姓名: ['姓名', '员工姓名', '名字'],
  手机号: ['手机号', '手机', '联系电话', '电话'],
  一级部门: ['一级部门', '1级部门', '一级部门名称', '顶级部门', '一级'],
  二级部门: ['二级部门', '2级部门', '二级部门名称', '二级'],
  三级部门: ['三级部门', '3级部门', '三级部门名称', '三级'],
  部门: ['部门', '部门名称', '所属部门'],
  岗位: ['岗位', '岗位名称', '职位', '职务'],
  邮箱: ['邮箱', '电子邮箱', '邮件'],
}

function normalizeCell(value: unknown): string {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim()
}

function normalizeHeader(value: unknown): string {
  return normalizeCell(value).replace(/\s+/g, '').replace(/[＊*]/g, '')
}

function findHeaderIndex(headers: unknown[], logicalName: string): number {
  const aliases = new Set((HEADER_ALIASES[logicalName] ?? [logicalName]).map((h) => normalizeHeader(h)))
  return headers.findIndex((header) => aliases.has(normalizeHeader(header)))
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function parseWorkbook(buffer: Buffer): ParsedRow[] {
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  } catch {
    throw new OrgError('INVALID_INPUT', 'Excel 文件无法解析,请使用模板重新填写')
  }
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new OrgError('INVALID_INPUT', 'Excel 文件没有工作表')
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new OrgError('INVALID_INPUT', 'Excel 文件没有工作表')
  const guideSheet = workbook.Sheets['填写说明']
  if (normalizeCell(guideSheet?.A1?.v) !== EMPLOYEE_IMPORT_TEMPLATE_MARKER) {
    throw new OrgError('INVALID_INPUT', '请先下载“员工导入模板”并基于模板填写后再导入')
  }

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: false })
  const headerRow = matrix[0]
  if (!headerRow) throw new OrgError('INVALID_INPUT', 'Excel 文件缺少表头')

  const nameIdx = findHeaderIndex(headerRow, '姓名')
  const phoneIdx = findHeaderIndex(headerRow, '手机号')
  const empNoIdx = findHeaderIndex(headerRow, '工号')
  const positionIdx = findHeaderIndex(headerRow, '岗位')
  const emailIdx = findHeaderIndex(headerRow, '邮箱')
  const levelIdx = DEPT_LEVEL_HEADERS.map((h) => findHeaderIndex(headerRow, h))
  const legacyDeptIdx = findHeaderIndex(headerRow, LEGACY_DEPT_HEADER)
  const hasLevelCols = levelIdx.some((i) => i >= 0)
  const hasDeptCol = hasLevelCols || legacyDeptIdx >= 0

  const missing: string[] = []
  if (nameIdx < 0) missing.push('姓名')
  if (phoneIdx < 0) missing.push('手机号')
  // 邮箱为选填列:不强制存在,缺列时跳过邮箱不报错
  if (!hasDeptCol) missing.push('部门(一级部门/二级部门/三级部门)')
  if (missing.length > 0) throw new OrgError('INVALID_INPUT', `Excel 缺少必填列:${missing.join('、')}`)

  return matrix
    .slice(1)
    .map((row, index) => {
      const deptSegments = hasLevelCols
        ? levelIdx.map((li) => (li >= 0 ? normalizeCell(row[li]) : '')).filter(Boolean)
        : splitDeptPath(normalizeCell(row[legacyDeptIdx]))
      return {
        rowNumber: index + 2,
        empNo: empNoIdx >= 0 ? normalizeCell(row[empNoIdx]) : '',
        name: normalizeCell(row[nameIdx]),
        phone: normalizeCell(row[phoneIdx]),
        deptSegments,
        deptDisplay: deptSegments.join('/'),
        position: positionIdx >= 0 ? normalizeCell(row[positionIdx]) : '',
        email: emailIdx >= 0 ? normalizeCell(row[emailIdx]).toLowerCase() : '',
      }
    })
    .filter((row) => row.empNo || row.name || row.phone || row.deptSegments.length > 0 || row.position || row.email)
    // 模板示例行(姓名+手机号都还是示例值)原样未改 → 跳过,不会建出一个「张三」
    .filter((row) => !(row.name === SAMPLE_NAME && row.phone === SAMPLE_PHONE))
}

function resultBase(row: ParsedRow): Omit<EmployeeImportRowResult, 'status' | 'reason' | 'employeeId'> {
  return { rowNumber: row.rowNumber, empNo: row.empNo, name: row.name, phone: row.phone, department: row.deptDisplay, position: row.position, email: row.email }
}

function fail(row: ParsedRow, reason: string): EmployeeImportRowResult {
  return { ...resultBase(row), status: 'failed', reason, employeeId: null }
}

async function loadDepartments(db: Db, ctx: Ctx): Promise<DepartmentNode[]> {
  const rows = await db
    .select({ id: departments.id, name: departments.name, status: departments.status, path: departments.path })
    .from(departments)
    .where(scope(departments, ctx.tenantId))
  // path 列是 id 链「/rootId/.../selfId/」,映射成名称链即部门的完整名称路径(比递归 parentId 更稳、无环)。
  const nameById = new Map(rows.map((dept) => [dept.id, normalizeCell(dept.name)]))
  return rows.map((dept) => ({
    id: dept.id,
    name: normalizeCell(dept.name),
    status: dept.status,
    namePath: dept.path
      .split('/')
      .filter(Boolean)
      .map((id) => nameById.get(id))
      .filter((name): name is string => Boolean(name)),
  }))
}

async function loadExistingKeys(db: Db, ctx: Ctx): Promise<{ phones: Set<string>; empNos: Set<string> }> {
  const rows = await db
    .select({ phone: employees.phone, empNo: employees.empNo })
    .from(employees)
    .where(scope(employees, ctx.tenantId))
  return {
    phones: new Set(rows.map((row) => row.phone)),
    empNos: new Set(rows.map((row) => row.empNo)),
  }
}

function validateRow(
  row: ParsedRow,
  depts: DepartmentNode[],
  existingPhones: Set<string>,
  existingEmpNos: Set<string>,
  seenPhones: Set<string>,
  seenEmpNos: Set<string>,
  generatedEmpNo: string,
): { ok: true; departmentId: string; empNo: string } | { ok: false; reason: string } {
  if (!row.name) return { ok: false, reason: '姓名不能为空' }
  if (!row.phone) return { ok: false, reason: '手机号不能为空' }
  if (row.deptSegments.length === 0) return { ok: false, reason: '部门不能为空' }
  if (row.phone.length < 5) return { ok: false, reason: '手机号格式不正确' }
  // 邮箱选填:填了才校验格式,留空不拦
  if (row.email && !validateEmail(row.email)) return { ok: false, reason: '邮箱格式不正确' }
  if (seenPhones.has(row.phone)) return { ok: false, reason: '手机号在导入文件中重复' }
  if (existingPhones.has(row.phone)) return { ok: false, reason: '员工已存在(手机号重复)' }
  if (row.empNo && seenEmpNos.has(row.empNo)) return { ok: false, reason: '工号在导入文件中重复' }
  if (row.empNo && existingEmpNos.has(row.empNo)) return { ok: false, reason: '工号已存在' }

  const deptMatches = resolveDepartment(row.deptSegments, depts)
  if (deptMatches.length === 0) return { ok: false, reason: '部门不存在' }
  const activeMatches = deptMatches.filter((dept) => dept.status === 'active')
  if (activeMatches.length === 0) return { ok: false, reason: '部门已停用' }
  if (activeMatches.length > 1) return { ok: false, reason: '部门名称不唯一,请把上级部门列一并填上以区分' }

  const empNo = row.empNo || generatedEmpNo
  if (!row.empNo && existingEmpNos.has(empNo)) return { ok: false, reason: '系统生成工号冲突,请检查已有工号' }
  if (!row.empNo && seenEmpNos.has(empNo)) return { ok: false, reason: '系统生成工号冲突,请检查已有工号' }
  return { ok: true, departmentId: activeMatches[0]!.id, empNo }
}

export function buildEmployeeImportTemplate(): Buffer {
  const workbook = XLSX.utils.book_new()
  // 第 1 行表头(必填列带 *),第 2 行示例数据(原样保留会被自动跳过,可直接覆盖成自己的数据)
  const sheet = XLSX.utils.aoa_to_sheet([[...EMPLOYEE_IMPORT_HEADERS], [...TEMPLATE_SAMPLE_ROW]])
  sheet['!cols'] = [{ wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 28 }]
  const guide = XLSX.utils.aoa_to_sheet([
    [EMPLOYEE_IMPORT_TEMPLATE_MARKER],
    ['字段', '是否必填', '说明', '示例'],
    ...COLUMN_GUIDE.map((col) => [col.header, col.required, col.hint, col.example]),
    [],
    ['使用说明'],
    ['1. 请基于“员工导入模板”第一页填写，不要自己新建表头；标题带 * 的列为必填，未带 * 的列为选填。'],
    ['2. 第 2 行是示例数据，可直接改成你的数据；原样保留时系统会自动跳过，不会导入这条示例。'],
    ['3. 部门按层级从左到右填“一级部门 / 二级部门 / 三级部门”，员工归属到你填写的最末一级部门。'],
    ['4. 只需填到员工所在那一级：一级部门的员工只填“一级部门”；二级填“一级部门+二级部门”；三级三列都填。'],
    ['5. 上级部门列用于区分同名部门、保证唯一；例如两个“前端组”分属不同中心，填上各自上级即可区分。'],
    ['6. 岗位为选填,只作展示,不参与权限。'],
    ['7. 工号为选填；填写时需在租户内唯一，留空时系统会按当前最大工号生成 No.0001、No.0002 这类递增编号，用于员工唯一标识、列表展示和搜索。'],
    ['8. 部门名称需与系统中的名称一致；若同名且同上级仍不唯一，请先在系统中调整部门名称。'],
    ['9. 系统只新增员工，不更新已有员工；手机号重复会跳过。'],
    ['10. 请勿删除或改动模板中的隐藏标记，否则系统会拒绝导入。'],
  ])
  guide['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 76 }, { wch: 26 }]
  XLSX.utils.book_append_sheet(workbook, sheet, '员工导入模板')
  XLSX.utils.book_append_sheet(workbook, guide, '填写说明')
  workbook.Workbook = workbook.Workbook ?? { Sheets: [] }
  workbook.Workbook.Sheets = workbook.Workbook.Sheets ?? []
  workbook.Workbook.Sheets[0] = workbook.Workbook.Sheets[0] ?? {}
  workbook.Workbook.Sheets[1] = { ...(workbook.Workbook.Sheets[1] ?? {}), Hidden: 1 }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

export async function importEmployeesFromWorkbook(db: Db, ctx: Ctx, buffer: Buffer): Promise<EmployeeImportResult> {
  const parsedRows = parseWorkbook(buffer)
  if (parsedRows.length === 0) throw new OrgError('INVALID_INPUT', 'Excel 没有可导入的数据行')
  if (parsedRows.length > 1000) throw new OrgError('INVALID_INPUT', '单次最多导入1000行')

  const depts = await loadDepartments(db, ctx)
  // 导入的员工统一开通登录、用本租户默认密码。默认密码对全批相同 → 只哈希一次,避免逐行 bcrypt(上千行会很慢)。
  const defaultPasswordHash = await hashPassword(await getDefaultEmployeePassword(db, ctx))
  const { phones: existingPhones, empNos: existingEmpNos } = await loadExistingKeys(db, ctx)
  const seenPhones = new Set<string>()
  const seenEmpNos = new Set<string>()
  let nextSerial = nextAutoEmpNoSerial(existingEmpNos)
  const rows: EmployeeImportRowResult[] = []

  for (const row of parsedRows) {
    let generatedEmpNo = ''
    if (!row.empNo) {
      do {
        generatedEmpNo = formatAutoEmpNo(nextSerial++)
      } while (existingEmpNos.has(generatedEmpNo) || seenEmpNos.has(generatedEmpNo))
    }
    const validated = validateRow(row, depts, existingPhones, existingEmpNos, seenPhones, seenEmpNos, generatedEmpNo)
    if (!validated.ok) {
      rows.push(fail(row, validated.reason))
      if (row.phone) seenPhones.add(row.phone)
      if (row.empNo) seenEmpNos.add(row.empNo)
      else if (generatedEmpNo) seenEmpNos.add(generatedEmpNo)
      continue
    }
    try {
      const employee = await createEmployee(db, ctx, {
        name: row.name,
        empNo: validated.empNo,
        phone: row.phone,
        departmentId: validated.departmentId,
        position: row.position,
        email: row.email,
        passwordHash: defaultPasswordHash, // 统一开通登录、用默认密码(已哈希)
      })
      seenPhones.add(row.phone)
      seenEmpNos.add(validated.empNo)
      existingPhones.add(row.phone)
      existingEmpNos.add(validated.empNo)
      rows.push({ ...resultBase(row), status: 'success', reason: null, employeeId: employee.id })
    } catch (e) {
      const reason = (e as { code?: unknown }).code === 'DUPLICATE' ? '员工已存在' : e instanceof Error ? e.message : '导入失败'
      rows.push(fail(row, reason))
    }
  }

  const success = rows.filter((row) => row.status === 'success').length
  return { total: rows.length, success, failed: rows.length - success, rows }
}
