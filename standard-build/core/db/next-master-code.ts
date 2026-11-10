// core/db/next-master-code.ts
// ★主数据编码「留空自动生成、填了以用户为准」的唯一共享生成器(AM-123)。
// 10 张主数据表复用这一份,不再各写各的(仓里已有 6 个手写单据号生成器,再加 10 个 = 把同一个 bug 复制 10 遍)。
//
// 直接照抄 modules/reimbursement/logic.ts:215 nextDocNo 的成熟形态,逐条守住它注释里踩过的坑:
//  ① 序号 = 「同前缀已有最大序号 + 1」,★禁 count(*)+1 ——
//     软删掉当期中间一张后 count 低于当期已用的最大序号,count+1 正好命中一张仍在的活行 → duplicate key。
//  ② max 只数 is_deleted=false 的活行,与这 10 张表的部分唯一索引(where is_deleted=false)口径一致 ——
//     max 落在活行上就永远撞不上活行。
//  ③ 捕获 23505 唯一冲突并重试(仿 isDocNoConflict + createClaim 的 attempt<8 循环);
//     ★只对「本表 code 唯一索引」这一个约束重试,别把其它 23505 也吞了。
//
// 用户手输的编码走另一条路:先查活行冲突,撞了就抛明确的领域错误(4xx + 人话文案),
// 绝不被重试逻辑悄悄改成别的号 —— 用户填了什么就必须是什么(需求「以用户为准」的应有之义)。
import { sql } from 'drizzle-orm'
import type { Db } from './client'

export type MasterCodeTable =
  | 'inventory_products'
  | 'inventory_warehouses'
  | 'positions'
  | 'leave_types'
  | 'attendance_shifts'
  | 'expense_types'
  | 'cost_centers'
  | 'fin_projects'
  | 'fin_fixed_assets'
  | 'fin_cip'

/** 取号作用域。7 张按 tenant 隔离;finance 四张唯一索引是 (tenant_id, entity_id, code),必须再带 entityId。 */
export type MasterCodeScope = { tenantId: string; entityId?: string }

type Reg = {
  /** 生成前缀(代码常量,★不做租户配置)。 */
  prefix: string
  /** 本表 code 唯一索引名 —— 只对它做 23505 重试。 */
  uniqueIndex: string
  /** 唯一键是否含 entity_id(finance 四张账套隔离)。 */
  entityScoped: boolean
}

// ★前缀注册表(定稿默认值)。leave_types/attendance_shifts/expense_types 的 code 正则只允许 [A-Za-z0-9_],
// 不许连字符 `-`,所以这三张用下划线前缀,生成的编码形如 LEAVE_0001;其余用无分隔前缀,形如 WH0001。
// ★accounts(会计科目)绝不在此表内 —— 科目代码带国标层级语义,发流水号会毁掉科目体系。
const REGISTRY: Record<MasterCodeTable, Reg> = {
  inventory_products: { prefix: 'PRD', uniqueIndex: 'inventory_products_tenant_code_uq', entityScoped: false },
  inventory_warehouses: { prefix: 'WH', uniqueIndex: 'inventory_warehouses_tenant_code_uq', entityScoped: false },
  positions: { prefix: 'POS', uniqueIndex: 'positions_tenant_code_uq', entityScoped: false },
  leave_types: { prefix: 'LEAVE_', uniqueIndex: 'leave_types_tenant_code_uq', entityScoped: false },
  attendance_shifts: { prefix: 'SHIFT_', uniqueIndex: 'attendance_shifts_tenant_code_uq', entityScoped: false },
  expense_types: { prefix: 'EXP_', uniqueIndex: 'expense_types_code_uq', entityScoped: false },
  cost_centers: { prefix: 'CC', uniqueIndex: 'cost_centers_code_uq', entityScoped: true },
  fin_projects: { prefix: 'PRJ', uniqueIndex: 'fin_projects_code_uq', entityScoped: true },
  fin_fixed_assets: { prefix: 'FA', uniqueIndex: 'fin_fixed_assets_code_uq', entityScoped: true },
  fin_cip: { prefix: 'CIP', uniqueIndex: 'fin_cip_code_uq', entityScoped: true },
}

/** 在范围内的 10 张主数据表(测试参数化用)。 */
export const MASTER_CODE_TABLES = Object.keys(REGISTRY) as MasterCodeTable[]

/** 某表的生成前缀。 */
export function masterCodePrefix(table: MasterCodeTable): string {
  return REGISTRY[table].prefix
}

/** accounts 等表是否被误加进注册表的护栏(T7 断言用)。 */
export function isMasterCodeTable(table: string): table is MasterCodeTable {
  return Object.prototype.hasOwnProperty.call(REGISTRY, table)
}

const SEQ_WIDTH = 4

/**
 * 计算某表某作用域下的下一个自动编码 = 前缀 + 补零序号(「同前缀已有最大序号 + 1」,只数活行)。
 * 必须在写事务内调用(与 insert 同一 tx),max 读到 insert 之间不留窗口。
 */
export async function nextMasterCode(db: Db, table: MasterCodeTable, scope: MasterCodeScope): Promise<string> {
  const reg = REGISTRY[table]
  if (reg.entityScoped && !scope.entityId) {
    throw new Error(`nextMasterCode: ${table} 按账套隔离,scope.entityId 不能缺`)
  }
  // 只把「前缀 + 纯数字」视作系统序号:用户手填的自定义码(如 WH-CUSTOM-1)不匹配,天然不参与取号。
  const seqPattern = `^${reg.prefix}[0-9]+$`
  const seqExtract = `^${reg.prefix}([0-9]+)$`
  const entityCond = reg.entityScoped ? sql` and entity_id = ${scope.entityId}` : sql``
  const r = (await db.execute(sql`
    select coalesce(max(substring(code from ${seqExtract})::int), 0) as m
    from ${sql.identifier(table)}
    where tenant_id = ${scope.tenantId} and is_deleted = false and code ~ ${seqPattern}${entityCond}
  `)) as { rows: { m: number }[] }
  const next = (r.rows[0]?.m ?? 0) + 1
  return reg.prefix + String(next).padStart(SEQ_WIDTH, '0')
}

/** 是否本表 code 唯一索引撞号(仅此可重试:换个号重算即可)。别的 23505 原样抛出。 */
export function isMasterCodeConflict(e: unknown, table: MasterCodeTable): boolean {
  const idx = REGISTRY[table].uniqueIndex
  const err = e as {
    code?: string
    constraint?: string
    message?: string
    cause?: { code?: string; constraint?: string; message?: string }
  }
  const code = err?.code ?? err?.cause?.code
  const text = `${err?.constraint ?? ''} ${err?.cause?.constraint ?? ''} ${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  return code === '23505' && text.includes(idx)
}

async function activeCodeExists(db: Db, table: MasterCodeTable, scope: MasterCodeScope, code: string): Promise<boolean> {
  const reg = REGISTRY[table]
  const entityCond = reg.entityScoped ? sql` and entity_id = ${scope.entityId}` : sql``
  const r = (await db.execute(sql`
    select 1 from ${sql.identifier(table)}
    where tenant_id = ${scope.tenantId} and is_deleted = false and code = ${code}${entityCond}
    limit 1
  `)) as { rows: unknown[] }
  return r.rows.length > 0
}

export type MasterCodeResolution = {
  table: MasterCodeTable
  scope: MasterCodeScope
  /** 用户手输的编码(表单/导入);留空(undefined / null / 全空白)= 系统自动生成。 */
  userCode?: string | null
  /** 手输编码的规范化(如 trim().toUpperCase());默认 trim()。 */
  normalize?: (code: string) => string
  /** 手输编码撞活行时抛的领域错误(各模块用自己的错误类,经 core/http/errors 映射到 4xx)。 */
  duplicate: (code: string) => Error
}

/**
 * 主数据写入的统一入口:解析编码(留空→自动生成 / 填了→校验唯一)后调用 insert 落库。
 * insert 收到已定好的 code 与写事务 tx,只管拼自己的列。
 *
 * - 留空:在写事务内取号 + 插入;并发撞号(23505 命中本表 code 唯一索引)→ 换号重试(attempt<8)。
 * - 填了:先查活行,撞了直接抛 duplicate(code)(4xx,★不重试、不改号);并发极端下唯一索引兜底也抛 duplicate。
 */
export async function insertWithMasterCode<T>(
  db: Db,
  res: MasterCodeResolution,
  insert: (tx: Db, code: string) => Promise<T>,
): Promise<T> {
  const normalize = res.normalize ?? ((c) => c.trim())
  const raw = res.userCode == null ? '' : String(res.userCode).trim()

  if (raw !== '') {
    const code = normalize(raw)
    return db.transaction(async (tx) => {
      if (await activeCodeExists(tx as unknown as Db, res.table, res.scope, code)) throw res.duplicate(code)
      try {
        return await insert(tx as unknown as Db, code)
      } catch (e) {
        if (isMasterCodeConflict(e, res.table)) throw res.duplicate(code)
        throw e
      }
    })
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const code = await nextMasterCode(tx as unknown as Db, res.table, res.scope)
        return await insert(tx as unknown as Db, code)
      })
    } catch (e) {
      if (attempt < 8 && isMasterCodeConflict(e, res.table)) continue
      throw e
    }
  }
}
