/**
 * 模具台账状态管理（Pinia）
 * 维护模具列表、可用模具、对账结果与挂起状态；台账保存失败时按本侧重试，工序单照旧。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Mold, MoldDraft, MoldReconcile } from '../types/mold'
import {
  ROW_REVISION,
  incrementMoldUsedCount,
  initDatabase,
  isSuspended,
  listMolds,
  putMold,
  reconcileMolds,
  removeMold,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'

let subscribed = false

/** 待重试的台账保存项 */
interface PendingRetry {
  moldId: string
  /** 已重试次数 */
  attempts: number
  /** 最近一次错误信息 */
  lastError: string
}

export const useMoldStore = defineStore('mold', () => {
  const molds = ref<Mold[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const reconciles = ref<MoldReconcile[]>([])
  const suspended = ref(false)
  const pendingRetries = ref<PendingRetry[]>([])

  /** 可用模具：未报废且次数未用完 */
  const availableMolds = computed<Mold[]>(() =>
    molds.value
      .filter((row) => !row.scrapped && row.usedCount < row.totalCount)
      .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
  )

  /** 报废模具 */
  const scrappedMolds = computed<Mold[]>(() => molds.value.filter((row) => row.scrapped))

  /** 次数用尽的模具 */
  const exhaustedMolds = computed<Mold[]>(() =>
    molds.value.filter((row) => !row.scrapped && row.usedCount >= row.totalCount),
  )

  /** 对账不平的模具 */
  const unbalancedReconciles = computed<MoldReconcile[]>(() =>
    reconciles.value.filter((row) => !row.balanced),
  )

  /** 按 id 查模具 */
  function moldById(id: string | null): Mold | undefined {
    if (id === null) return undefined
    return molds.value.find((row) => row.id === id)
  }

  /** 模具是否可用（未报废且次数未用完） */
  function isMoldAvailable(moldId: string | null): boolean {
    if (moldId === null) return false
    const mold = moldById(moldId)
    if (mold === undefined) return false
    return !mold.scrapped && mold.usedCount < mold.totalCount
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const moldRows = await listMolds()
          return { moldRows }
        }).subscribe({
          next: ({ moldRows }) => {
            molds.value = moldRows
            loading.value = false
            ready.value = true
            error.value = ''
            void refreshReconcile()
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取模具数据失败'
            loading.value = false
          },
        })
      }
      await refreshReconcile()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  /** 刷新对账结果与挂起状态 */
  async function refreshReconcile(): Promise<void> {
    try {
      const [rec, susp] = await Promise.all([reconcileMolds(), isSuspended()])
      reconciles.value = rec
      suspended.value = susp
    } catch {
      /* 对账失败时保持旧状态 */
    }
  }

  async function createMold(draft: MoldDraft): Promise<Mold> {
    const stamp = nowIso()
    const row: Mold = {
      id: uuid('mold'),
      code: draft.code.trim() || '未编号模具',
      totalCount: draft.totalCount,
      usedCount: 0,
      scrapped: draft.scrapped,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putMold(row)
    revision.value += 1
    lastMessage.value = `已登记模具「${row.code}」，可用次数 ${row.totalCount} 次`
    return row
  }

  async function updateMold(moldId: string, draft: MoldDraft): Promise<void> {
    const existing = molds.value.find((row) => row.id === moldId)
    if (existing === undefined) return
    await putMold({
      ...existing,
      code: draft.code.trim() || existing.code,
      totalCount: draft.totalCount,
      scrapped: draft.scrapped,
    })
    revision.value += 1
  }

  async function deleteMold(moldId: string): Promise<void> {
    await removeMold(moldId)
    revision.value += 1
    lastMessage.value = '模具已删除'
  }

  /** 报废 / 恢复模具 */
  async function toggleScrap(moldId: string): Promise<void> {
    const existing = molds.value.find((row) => row.id === moldId)
    if (existing === undefined) return
    await putMold({ ...existing, scrapped: !existing.scrapped })
    revision.value += 1
    lastMessage.value = existing.scrapped ? `模具「${existing.code}」已恢复在用` : `模具「${existing.code}」已报废`
  }

  /**
   * 开模完成时递增模具已用次数（台账保存）。
   * 台账保存失败后按本侧重试，工序单照旧。
   * 返回是否成功。
   */
  async function recordMoldUse(moldId: string): Promise<boolean> {
    const ok = await retryIncrement(moldId, 3)
    if (!ok) {
      // 加入待重试队列
      const existing = pendingRetries.value.find((r) => r.moldId === moldId)
      if (existing === undefined) {
        pendingRetries.value.push({ moldId, attempts: 3, lastError: '台账保存失败，等待重试' })
      }
      lastMessage.value = '模具台账保存失败，已加入重试队列（工序单不受影响）'
    } else {
      // 从重试队列移除
      pendingRetries.value = pendingRetries.value.filter((r) => r.moldId !== moldId)
    }
    await refreshReconcile()
    return ok
  }

  /** 带重试的台账递增 */
  async function retryIncrement(moldId: string, maxAttempts: number): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await incrementMoldUsedCount(moldId)
        if (result >= 0) return true
      } catch {
        /* 重试 */
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
      }
    }
    return false
  }

  /** 手动重试所有待重试的台账保存 */
  async function retryAllPending(): Promise<void> {
    const pending = [...pendingRetries.value]
    for (const item of pending) {
      const ok = await retryIncrement(item.moldId, 3)
      if (ok) {
        pendingRetries.value = pendingRetries.value.filter((r) => r.moldId !== item.moldId)
      } else {
        const existing = pendingRetries.value.find((r) => r.moldId === item.moldId)
        if (existing !== undefined) {
          existing.attempts += 3
          existing.lastError = '台账保存失败，等待重试'
        }
      }
    }
    await refreshReconcile()
  }

  return {
    molds,
    loading,
    ready,
    error,
    lastMessage,
    revision,
    reconciles,
    suspended,
    pendingRetries,
    availableMolds,
    scrappedMolds,
    exhaustedMolds,
    unbalancedReconciles,
    moldById,
    isMoldAvailable,
    loadAll,
    refreshReconcile,
    createMold,
    updateMold,
    deleteMold,
    toggleScrap,
    recordMoldUse,
    retryAllPending,
  }
})
