/**
 * 模具台账状态管理（Pinia）
 * - 模具编号 / 可用次数 / 报废状态台账；
 * - 开模只允许挑未报废、次数未用尽的模具；
 * - 开模完成时模具已报废或用尽 → 该道退回未开始并写明原因，前序工序照旧；
 * - 按模具编号对账：开模道次合计与台账已用次数对不上则挂起；
 * - 台账保存失败按本侧重试，彻底失败的变更进入待处理队列（localStorage），工序单照旧。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Mold, MoldDraft, MoldMaterial, MoldStatus } from '../types/mold'
import type { Step } from '../types/step'
import {
  db,
  getMold,
  incrementMoldUses,
  initDatabase,
  moldReferencedBySteps,
  putMold,
  putStep,
  removeMold,
  ROW_REVISION,
} from '../utils/db'
import {
  assertMoldWriteAllowed,
  checkMoldUsable,
  clearMoldPendingOps,
  countOpenPasses,
  enqueueMoldPendingOp,
  enqueueMoldPut,
  isMoldExhausted,
  loadMoldFaultMode,
  loadMoldPendingOps,
  moldStatus,
  pendingIncrementByMold,
  reconcileMold,
  remainUses,
  removeMoldPendingOps,
  runMoldWriteWithRetry,
  saveMoldFaultMode,
  type MoldFaultMode,
  type MoldPendingOp,
  type MoldReconcile,
} from '../utils/mold'
import { nowIso, uuid } from '../utils/id'

/** 模具筛选条件 */
export interface MoldFilters {
  keyword: string
  status: MoldStatus | 'all'
  material: MoldMaterial | 'all'
}

/** 开模完成动作的结果（供工序页提示） */
export interface OpenCompleteOutcome {
  /** 本道是否被退回未开始 */
  rejected: boolean
  /** 模具编号（缺失时为空） */
  moldCode: string
  /** 提示原因（退回原因或成功文案） */
  message: string
  /** 台账 +1 是否仍在待处理队列（保存失败、本侧重试未生效） */
  ledgerPending: boolean
}

const EMPTY_FILTERS: MoldFilters = { keyword: '', status: 'all', material: 'all' }

let subscribed = false

export const useMoldStore = defineStore('mold', () => {
  const molds = ref<Mold[]>([])
  const steps = ref<Step[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<MoldFilters>({ ...EMPTY_FILTERS })

  /** 台账保存失败、等待本侧重试的变更队列 */
  const pendingOps = ref<MoldPendingOp[]>(loadMoldPendingOps())
  /** 故障注入模式（演示保存失败重试） */
  const faultMode = ref<MoldFaultMode>(loadMoldFaultMode())

  /** 队列中的整行写入（已把同模具的 +1 折叠进行内） */
  const queuedPutMap = computed<Record<string, Mold>>(() => {
    const result: Record<string, Mold> = {}
    pendingOps.value.forEach((op) => {
      if (op.type === 'put') result[op.row.id] = op.row
    })
    return result
  })

  /** 队列中尚未生效的 +1 增量（按模具汇总） */
  const pendingDeltaMap = computed<Record<string, number>>(() =>
    pendingIncrementByMold(pendingOps.value),
  )

  /** 生效中的台账行：待处理整行优先于库内旧行 */
  const effectiveMolds = computed<Mold[]>(() =>
    molds.value.map((row) => queuedPutMap.value[row.id] ?? row),
  )

  function moldById(moldId: string): Mold | undefined {
    return effectiveMolds.value.find((row) => row.id === moldId)
  }

  /** 可挑模具：没报废、次数没用完（待处理的 +1 也占用次数，避免超额开模） */
  const usableMolds = computed<Mold[]>(() =>
    effectiveMolds.value
      .filter((row) => checkMoldUsable(withPendingDelta(row, pendingDeltaMap.value[row.id] ?? 0)).ok)
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
  )

  const statusMap = computed<Record<string, MoldStatus>>(() =>
    Object.fromEntries(effectiveMolds.value.map((row) => [row.id, moldStatus(row)])),
  )

  /** 按模具编号对账：开模道次合计 vs 台账已用次数（含待处理增量） */
  const reconcileMap = computed<Record<string, MoldReconcile>>(() => {
    const result: Record<string, MoldReconcile> = {}
    effectiveMolds.value.forEach((mold) => {
      result[mold.id] = reconcileMold(mold, steps.value, pendingDeltaMap.value[mold.id] ?? 0)
    })
    return result
  })

  const heldMolds = computed<Mold[]>(() =>
    effectiveMolds.value.filter((row) => reconcileMap.value[row.id]?.held),
  )

  const scrappedMolds = computed<Mold[]>(() => effectiveMolds.value.filter((row) => row.scrapped))
  const exhaustedMolds = computed<Mold[]>(() =>
    effectiveMolds.value.filter((row) => !row.scrapped && isMoldExhausted(row)),
  )

  const visibleMolds = computed<Mold[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return effectiveMolds.value
      .filter((mold) => {
        if (filters.material !== 'all' && mold.material !== filters.material) return false
        if (filters.status !== 'all' && statusMap.value[mold.id] !== filters.status) return false
        if (keyword === '') return true
        return (
          mold.code.toLowerCase().includes(keyword) ||
          mold.name.toLowerCase().includes(keyword) ||
          mold.material.toLowerCase().includes(keyword)
        )
      })
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  })

  const stats = computed(() => ({
    total: effectiveMolds.value.length,
    usable: effectiveMolds.value.filter(
      (row) => !row.scrapped && !isMoldExhausted(row) && remainUses(row) > 0,
    ).length,
    scrapped: scrappedMolds.value.length,
    exhausted: exhaustedMolds.value.length,
    held: heldMolds.value.length,
    pending: pendingOps.value.length,
  }))

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [moldRows, stepRows] = await Promise.all([db.molds.toArray(), db.steps.toArray()])
          return { moldRows, stepRows }
        }).subscribe({
          next: ({ moldRows, stepRows }) => {
            molds.value = [...moldRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            steps.value = [...stepRows].sort(
              (a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq,
            )
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取模具台账失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<MoldFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  function refreshPending(): void {
    pendingOps.value = loadMoldPendingOps()
    faultMode.value = loadMoldFaultMode()
  }

  function setFaultMode(mode: MoldFaultMode): void {
    faultMode.value = mode
    saveMoldFaultMode(mode)
  }

  /** 台账写入：本侧重试；彻底失败则排队（工序单照旧） */
  async function writeMoldRow(row: Mold): Promise<boolean> {
    try {
      await runMoldWriteWithRetry(async () => {
        assertMoldWriteAllowed()
        await putMold(row)
      })
      lastMessage.value = `模具「${row.code}」台账已保存`
      return true
    } catch (err) {
      const queued = enqueueMoldPut(row)
      pendingOps.value = queued
      lastMessage.value = `模具「${row.code}」台账保存失败，已按本侧重试仍未生效，变更进入待处理队列；工序单照旧。（${
        err instanceof Error ? err.message : '未知错误'
      }）`
      return false
    }
  }

  async function createMold(draft: MoldDraft): Promise<Mold | null> {
    const code = draft.code.trim() || '未编号模具'
    if (effectiveMolds.value.some((row) => row.code === code)) {
      lastMessage.value = `模具编号「${code}」已存在，台账编号不可重复`
      return null
    }
    const stamp = nowIso()
    const row: Mold = {
      id: uuid('mold'),
      code,
      name: draft.name.trim() || '未命名模具',
      material: draft.material,
      maxUses: Math.max(1, Math.round(draft.maxUses)),
      usedCount: Math.max(0, Math.min(Math.round(draft.usedCount), Math.max(1, Math.round(draft.maxUses)))),
      scrapped: draft.scrapped,
      scrapReason: draft.scrapReason.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await writeMoldRow(row)
    revision.value += 1
    return row
  }

  async function updateMold(moldId: string, draft: MoldDraft): Promise<boolean> {
    const existing = molds.value.find((row) => row.id === moldId)
    if (existing === undefined) return false
    const code = draft.code.trim() || existing.code
    if (effectiveMolds.value.some((row) => row.id !== moldId && row.code === code)) {
      lastMessage.value = `模具编号「${code}」已被其他模具占用`
      return false
    }
    const row: Mold = {
      ...existing,
      code,
      name: draft.name.trim() || existing.name,
      material: draft.material,
      maxUses: Math.max(1, Math.round(draft.maxUses)),
      usedCount: Math.max(0, Math.min(Math.round(draft.usedCount), Math.max(1, Math.round(draft.maxUses)))),
      scrapped: draft.scrapped,
      scrapReason: draft.scrapReason.trim(),
    }
    const ok = await writeMoldRow(row)
    revision.value += 1
    return ok
  }

  /** 报废 / 解除报废（报废原因在报废时必填，由页面校验） */
  async function setScrapped(moldId: string, scrapped: boolean, reason: string): Promise<void> {
    const existing = molds.value.find((row) => row.id === moldId)
    if (existing === undefined) return
    await writeMoldRow({ ...existing, scrapped, scrapReason: scrapped ? reason.trim() : '' })
    revision.value += 1
  }

  async function deleteMold(moldId: string): Promise<boolean> {
    const referenced = await moldReferencedBySteps(moldId)
    if (referenced > 0) {
      lastMessage.value = `该模具已被 ${referenced} 道开模工序引用，不能删除；如需停用请登记报废`
      return false
    }
    try {
      await runMoldWriteWithRetry(async () => {
        assertMoldWriteAllowed()
        await removeMold(moldId)
      })
      pendingOps.value = removeMoldPendingOps(
        (op) => (op.type === 'put' && op.row.id === moldId) || (op.type === 'increment' && op.moldId === moldId),
      )
      revision.value += 1
      lastMessage.value = '模具已从台账删除'
      return true
    } catch (err) {
      lastMessage.value = `模具台账删除失败，已保留待处理：${err instanceof Error ? err.message : '未知错误'}`
      return false
    }
  }

  /** 台账 +1（内部）：失败排队，不影响已保存的工序单 */
  async function applyMoldIncrement(moldId: string): Promise<boolean> {
    try {
      await runMoldWriteWithRetry(async () => {
        assertMoldWriteAllowed()
        const updated = await incrementMoldUses(moldId)
        if (updated === null) throw new Error('模具在台账上不存在')
      })
      return true
    } catch (err) {
      pendingOps.value = enqueueMoldPendingOp({ type: 'increment', moldId, queuedAt: nowIso() })
      lastMessage.value = `模具台账保存失败，已按本侧重试仍未生效，本次开模计数进入待处理队列；工序单照旧。（${
        err instanceof Error ? err.message : '未知错误'
      }）`
      return false
    }
  }

  /**
   * 开模完成：
   * 1) 模具已报废 / 用尽次数 → 本道退回未开始并写明原因，前面确认过的工序照旧，不计数；
   * 2) 校验通过 → 本道置为已完成，台账已用次数 +1（保存失败按本侧重试 / 排队）。
   */
  async function finalizeOpenStep(step: Step): Promise<OpenCompleteOutcome> {
    if (step.moldId === '') {
      return {
        rejected: true,
        moldCode: '',
        message: '该开模工序未绑定模具编号，不能完成；历史遗留行只读或请重新挑模。',
        ledgerPending: false,
      }
    }
    const mold = await getMold(step.moldId)
    const check = checkMoldUsable(mold)
    if (!check.ok || mold === undefined) {
      await putStep({ ...step, state: '未开始', rejectReason: `${check.reason}；前面确认过的工序照旧。` })
      revision.value += 1
      return { rejected: true, moldCode: mold?.code ?? '', message: check.reason, ledgerPending: false }
    }

    // 工序单先落库（已完成），随后单独写台账；台账失败不回滚工序
    await putStep({ ...step, state: '已完成', rejectReason: '' })
    const ledgerOk = await applyMoldIncrement(mold.id)
    revision.value += 1
    return {
      rejected: false,
      moldCode: mold.code,
      message: ledgerOk
        ? `开模完成：模具「${mold.code}」台账已用次数 +1（${mold.usedCount + 1}/${mold.maxUses}）`
        : `开模完成并已记入工序单；模具「${mold.code}」台账保存失败，+1 已进入本侧重试队列`,
      ledgerPending: !ledgerOk,
    }
  }

  /** 手动 / 自动重放待处理队列；返回仍未生效的条数 */
  async function flushPending(): Promise<{ flushed: number; remaining: number }> {
    const queue = loadMoldPendingOps()
    let flushed = 0
    for (const op of queue) {
      const sameOp = (item: MoldPendingOp): boolean => {
        if (item.queuedAt !== op.queuedAt) return false
        if (op.type === 'put') return item.type === 'put' && item.row.id === op.row.id
        return item.type === 'increment' && item.moldId === op.moldId
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await runMoldWriteWithRetry(
          async () => {
            assertMoldWriteAllowed()
            if (op.type === 'put') {
              await putMold(op.row)
            } else {
              const updated = await incrementMoldUses(op.moldId)
              if (updated === null) throw new Error('模具在台账上不存在')
            }
          },
          { attempts: 2, baseDelayMs: 80 },
        )
        pendingOps.value = removeMoldPendingOps(sameOp)
        flushed += 1
      } catch {
        // 故障仍在：剩余变更继续挂起，等待下次重试
      }
    }
    refreshPending()
    if (flushed > 0) lastMessage.value = `待处理台账变更已补写 ${flushed} 条，对账状态已刷新`
    return { flushed, remaining: pendingOps.value.length }
  }

  /** 重置 / 导入存档时清掉旧队列，避免把旧变更写回新库 */
  function dropPending(): void {
    clearMoldPendingOps()
    pendingOps.value = []
  }

  /** 某模具已完成的开模道次（不含历史只读行） */
  function openPassesOf(moldId: string): number {
    return countOpenPasses(steps.value, moldId)
  }  return {
    molds,
    steps,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    pendingOps,
    faultMode,
    effectiveMolds,
    usableMolds,
    heldMolds,
    scrappedMolds,
    exhaustedMolds,
    visibleMolds,
    reconcileMap,
    statusMap,
    pendingDeltaMap,
    stats,
    moldById,
    openPassesOf,
    loadAll,
    setFilters,
    resetFilters,
    refreshPending,
    setFaultMode,
    createMold,
    updateMold,
    setScrapped,
    deleteMold,
    finalizeOpenStep,
    flushPending,
    dropPending,
  }
})

/** 叠加待处理 +1 后的临时模具视图（仅用于挑模次数判断，不落库） */
function withPendingDelta(mold: Mold, delta: number): Mold {
  return delta === 0 ? mold : { ...mold, usedCount: mold.usedCount + delta }
}
