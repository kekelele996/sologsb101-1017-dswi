/**
 * 模具台账领域规则：
 * - 挑模：只能挑没报废、次数没用完的模具；挑中时记录编号与当时已用次数；
 * - 开模完成：模具已报废或用尽次数则本道退回未开始并写明原因，已确认的前序工序不变；
 * - 对账：按模具编号汇总开模道次，与台账已用次数不一致则挂起；
 * - 台账保存失败按本侧重试（工序单照旧），重试期间未生效的变更进入待处理队列。
 * 纯函数为主，不直接触碰 Dexie；重试队列持久化在 localStorage。
 */
import type { Mold } from '../types/mold'
import type { Step } from '../types/step'
import { OPEN_STEP_NAME } from '../types/step'

/** 即将用尽阈值：剩余可用次数 ≤ 该值时高亮提醒 */
export const NEAR_EXHAUSTED_LEFT = 2

/* ------------------------------ 模具可用性 ------------------------------ */

/** 模具剩余可用次数（不小于 0） */
export function remainUses(mold: Pick<Mold, 'maxUses' | 'usedCount'>): number {
  return Math.max(0, mold.maxUses - mold.usedCount)
}

export function isMoldScrapped(mold: Pick<Mold, 'scrapped'>): boolean {
  return mold.scrapped
}

export function isMoldExhausted(mold: Pick<Mold, 'maxUses' | 'usedCount'>): boolean {
  return mold.usedCount >= mold.maxUses
}

/** 台账行派生状态（已报废优先于已用尽） */
export function moldStatus(mold: Mold): '可用' | '即将用尽' | '已用尽' | '已报废' {
  if (mold.scrapped) return '已报废'
  if (isMoldExhausted(mold)) return '已用尽'
  if (remainUses(mold) <= NEAR_EXHAUSTED_LEFT) return '即将用尽'
  return '可用'
}

/**
 * 挑模 / 开模完成时的模具可用性校验。
 * 返回 ok=true 才允许占用；否则给出退回原因（已报废优先）。
 */
export function checkMoldUsable(mold: Mold | undefined): { ok: boolean; reason: string } {
  if (mold === undefined) {
    return { ok: false, reason: '绑定的模具在台账上不存在，无法开模' }
  }
  if (mold.scrapped) {
    const suffix = mold.scrapReason.trim() === '' ? '' : `（${mold.scrapReason.trim()}）`
    return { ok: false, reason: `模具「${mold.code}」已报废${suffix}，本道退回未开始` }
  }
  if (isMoldExhausted(mold)) {
    return {
      ok: false,
      reason: `模具「${mold.code}」可用次数已用尽（已用 ${mold.usedCount}/${mold.maxUses} 次），本道退回未开始`,
    }
  }
  return { ok: true, reason: '' }
}

/* ------------------------------ 开模对账 ------------------------------ */

/** 计入对账的开模道次：已完成、绑定了模具且非历史遗留只读 */
export function countOpenPasses(steps: Step[], moldId: string): number {
  return steps.filter(
    (row) => row.name === OPEN_STEP_NAME && row.moldId === moldId && row.state === '已完成' && !row.legacyReadonly,
  ).length
}

export interface MoldReconcile {
  moldId: string
  /** 台账已用次数（含待处理队列中尚未生效的 +1） */
  ledgerUsed: number
  /** 开模道次合计（已完成的开模工序） */
  openPasses: number
  /** 是否挂起：两边对不上 */
  held: boolean
  /** 挂起 / 说明文本 */
  message: string
}

/**
 * 按模具编号对账：开模道次合计跟台账已用次数对不上就挂起。
 * pendingDelta 为台账保存失败、等待本侧重试期间未生效的次数增量。
 */
export function reconcileMold(mold: Mold, steps: Step[], pendingDelta = 0): MoldReconcile {
  const openPasses = countOpenPasses(steps, mold.id)
  const ledgerUsed = mold.usedCount + pendingDelta
  const held = ledgerUsed !== openPasses
  const message = held
    ? `对账挂起：台账已用 ${ledgerUsed} 次，开模道次合计 ${openPasses} 道，两边对不上`
    : `对账一致：台账已用 ${ledgerUsed} 次，开模道次合计 ${openPasses} 道`
  return { moldId: mold.id, ledgerUsed, openPasses, held, message }
}

/* --------------------- 台账保存失败：本侧重试队列 --------------------- */

/** 待处理台账变更：整行写入（新建/编辑/报废）或已用次数 +1（开模完成） */
export type MoldPendingOp =
  | { type: 'put'; row: Mold; queuedAt: string }
  | { type: 'increment'; moldId: string; queuedAt: string }

const PENDING_KEY = 'gbglassblow:moldPendingOps'

/** 读取待处理队列（localStorage 不可用时静默降级为空队列） */
export function loadMoldPendingOps(): MoldPendingOp[] {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is MoldPendingOp =>
        typeof item === 'object' &&
        item !== null &&
        ((item as { type?: unknown }).type === 'put' || (item as { type?: unknown }).type === 'increment'),
    )
  } catch {
    return []
  }
}

function saveMoldPendingOps(ops: MoldPendingOp[]): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(ops))
  } catch {
    /* 隐私模式下降级：队列仅保存在内存 */
  }
}

/**
 * 入队一条待处理变更。
 * - put：同一模具只保留最新整行（后写覆盖先写）；
 * - increment：按模具累加（每次开模完成都是独立的 +1）。
 */
export function enqueueMoldPendingOp(op: MoldPendingOp): MoldPendingOp[] {
  const ops = loadMoldPendingOps()
  if (op.type === 'put') {
    const next = ops.filter((item) => !(item.type === 'put' && item.row.id === op.row.id))
    next.push(op)
    saveMoldPendingOps(next)
    return next
  }
  ops.push(op)
  saveMoldPendingOps(ops)
  return ops
}

/**
 * 整行写入失败时排队：
 * 若队列中已有该模具未生效的 +1，则把增量折叠进整行的 usedCount 并移除这些 +1，
 * 避免重放时先写旧行再加次导致短暂对账挂起。
 */
export function enqueueMoldPut(row: Mold): MoldPendingOp[] {
  const ops = loadMoldPendingOps()
  let folded = 0
  const kept = ops.filter((item) => {
    if (item.type === 'increment' && item.moldId === row.id) {
      folded += 1
      return false
    }
    if (item.type === 'put' && item.row.id === row.id) return false
    return true
  })
  kept.push({
    type: 'put',
    row: { ...row, usedCount: Math.max(row.usedCount, row.usedCount + folded) },
    queuedAt: new Date().toISOString(),
  })
  saveMoldPendingOps(kept)
  return kept
}

export function removeMoldPendingOps(predicate: (op: MoldPendingOp) => boolean): MoldPendingOp[] {
  const next = loadMoldPendingOps().filter((op) => !predicate(op))
  saveMoldPendingOps(next)
  return next
}

/** 清空待处理队列（重置 / 导入存档时调用，避免把旧变更写回新库） */
export function clearMoldPendingOps(): void {
  saveMoldPendingOps([])
}

/** 每个模具尚未生效的 +1 增量合计（对账时计入台账侧） */
export function pendingIncrementByMold(ops: MoldPendingOp[]): Record<string, number> {
  const result: Record<string, number> = {}
  ops.forEach((op) => {
    if (op.type === 'increment') result[op.moldId] = (result[op.moldId] ?? 0) + 1
  })
  return result
}

/* ------------------------------ 故障注入 ------------------------------ */

const FAULT_KEY = 'gbglassblow:moldWriteFault'

/** 故障模式：台账保存时强制抛错，用于演示“保存失败按本侧重试、工序单照旧” */
export type MoldFaultMode = 'off' | 'once' | 'always'

export function loadMoldFaultMode(): MoldFaultMode {
  try {
    const raw = window.localStorage.getItem(FAULT_KEY)
    return raw === 'once' || raw === 'always' ? raw : 'off'
  } catch {
    return 'off'
  }
}

export function saveMoldFaultMode(mode: MoldFaultMode): void {
  try {
    if (mode === 'off') window.localStorage.removeItem(FAULT_KEY)
    else window.localStorage.setItem(FAULT_KEY, mode)
  } catch {
    /* 静默降级 */
  }
}

/** 台账写入前的故障断言；once 模式命中一次后自动复位 */
export function assertMoldWriteAllowed(): void {
  const mode = loadMoldFaultMode()
  if (mode === 'off') return
  if (mode === 'once') saveMoldFaultMode('off')
  throw new Error('模具台账保存失败（故障注入：本侧将按策略重试，工序单照旧）')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

export interface MoldWriteOptions {
  /** 最大尝试次数（含首次） */
  attempts?: number
  /** 基础退避（毫秒），按次数线性退避 */
  baseDelayMs?: number
  onAttempt?: (attempt: number, error: unknown) => void
}

/**
 * 带本侧重试的台账写入包装。
 * 注意：重试只作用于台账侧；调用方负责在彻底失败后把变更放入待处理队列，
 * 工序单（开模道次）不回滚、照旧保留。
 */
export async function runMoldWriteWithRetry<T>(task: () => Promise<T>, options: MoldWriteOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 150, onAttempt } = options
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      onAttempt?.(attempt, error)
      if (attempt < attempts) await sleep(baseDelayMs * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('模具台账保存失败')
}
