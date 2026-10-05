/**
 * 作品与工序状态管理（Pinia）
 * 维护作品列表、当前作品与当前作品的工序；工序状态由 db.syncPieceState 联动作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Craft, Piece, PieceDraft, PieceState } from '../types/piece'
import { OPEN_STEP_NAME, type Step, type StepDraft } from '../types/step'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  countAll,
  db,
  initDatabase,
  putPiece,
  putStep,
  removePiece,
  removeStep,
  reorderSteps,
  syncPieceState,
} from '../utils/db'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'
import { nowIso, uuid } from '../utils/id'

/** 作品筛选条件 */
export interface PieceFilters {
  keyword: string
  craft: Craft | 'all'
  state: PieceState | 'all'
}

const EMPTY_FILTERS: PieceFilters = { keyword: '', craft: 'all', state: 'all' }

const CURRENT_PIECE_KEY = 'gbglassblow:currentPieceId'

function readCurrentPieceId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PIECE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentPieceId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PIECE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

let subscribed = false

export const usePieceStore = defineStore('piece', () => {
  const pieces = ref<Piece[]>([])
  const steps = ref<Step[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const currentPieceId = ref<string | null>(readCurrentPieceId())
  const filters = reactive<PieceFilters>({ ...EMPTY_FILTERS })

  const currentPiece = computed<Piece | null>(
    () => pieces.value.find((row) => row.id === currentPieceId.value) ?? null
  )

  const visiblePieces = computed<Piece[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return pieces.value.filter((piece) => {
      if (filters.craft !== 'all' && piece.craft !== filters.craft) return false
      if (filters.state !== 'all' && piece.state !== filters.state) return false
      if (keyword === '') return true
      return (
        piece.name.toLowerCase().includes(keyword) ||
        piece.artist.toLowerCase().includes(keyword) ||
        piece.craft.toLowerCase().includes(keyword)
      )
    })
  })

  function stepsOf(pieceId: string): Step[] {
    return steps.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.seq - b.seq)
  }

  function progressOf(pieceId: string): StepProgress {
    return buildStepProgress(pieceId, steps.value)
  }

  const inProgressCount = computed<number>(
    () => pieces.value.filter((row) => row.state === '设计中' || row.state === '制作中').length
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [pieceRows, stepRows] = await Promise.all([db.pieces.toArray(), db.steps.toArray()])
          return { pieceRows, stepRows }
        }).subscribe({
          next: ({ pieceRows, stepRows }) => {
            const sorted = [...pieceRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            pieces.value = sorted
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentPieceId.value !== null && sorted.some((row) => row.id === currentPieceId.value)
            if (!stillExists) {
              selectPiece(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取作品数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function selectPiece(pieceId: string | null): void {
    currentPieceId.value = pieceId
    writeCurrentPieceId(pieceId)
  }

  function setFilters(patch: Partial<PieceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createPiece(draft: PieceDraft): Promise<Piece> {
    const stamp = nowIso()
    const row: Piece = {
      id: uuid('piece'),
      name: draft.name.trim() || '未命名作品',
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putPiece(row)
    selectPiece(row.id)
    revision.value += 1
    lastMessage.value = `已登记作品「${row.name}」，可继续录入吹制工序`
    return row
  }

  async function updatePiece(pieceId: string, draft: PieceDraft): Promise<void> {
    const existing = pieces.value.find((row) => row.id === pieceId)
    if (existing === undefined) return
    await putPiece({
      ...existing,
      name: draft.name.trim() || existing.name,
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deletePiece(pieceId: string): Promise<void> {
    await removePiece(pieceId)
    if (currentPieceId.value === pieceId) selectPiece(null)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '作品及其工序、退火与检验记录已删除'
  }

  /* ------------------------------ 工序 ------------------------------ */

  async function createStep(draft: StepDraft): Promise<Step> {
    const stamp = nowIso()
    const moldFields = draft.name === OPEN_STEP_NAME ? { moldId: draft.moldId } : { moldId: '' }
    const row: Step = {
      id: uuid('step'),
      pieceId: draft.pieceId,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      ...moldFields,
      // 挑中时记下台账当时已用次数（由页面从模具台账读取后放入 draft.moldUsedAtPick）
      moldUsedAtPick: draft.moldUsedAtPick ?? 0,
      legacyReadonly: false,
      legacyReason: '',
      rejectReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putStep(row)
    revision.value += 1
    return row
  }

  async function updateStep(stepId: string, draft: StepDraft): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    // 历史遗留只读行不可编辑（页面也会隐藏入口，这里再兜底一次）
    if (existing.legacyReadonly) return
    const isOpen = draft.name === OPEN_STEP_NAME
    await putStep({
      ...existing,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      // 非开模工序清掉模具字段；换绑模具时更新“当时已用次数”；保持原绑定时沿用旧快照
      moldId: isOpen ? draft.moldId : '',
      moldUsedAtPick: isOpen
        ? draft.moldId === existing.moldId
          ? existing.moldUsedAtPick
          : draft.moldUsedAtPick ?? 0
        : 0,
      // 改了名称 / 模具后，上一次的退回原因不再适用
      rejectReason: isOpen && draft.moldId === existing.moldId && draft.name === existing.name ? existing.rejectReason : '',
    })
    revision.value += 1
  }

  async function deleteStep(stepId: string): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    // 历史遗留只读行只能查看，不能删除（保留追溯）
    if (existing.legacyReadonly) {
      lastMessage.value = '历史遗留开模工序只读，不能删除'
      return
    }
    await removeStep(stepId)
    revision.value += 1
    lastMessage.value = '工序已删除，作品状态已重新推导'
  }

  /**
   * 统一保存工序（新增 / 编辑）。
   * 若保存后是「已完成」的开模工序，必须经过模具台账最终校验与 +1：
   * - 新建开模直接保存为已完成：先建行再走 finalizeOpenStep（可能退回未开始）；
   * - 编辑时从非完成态改为已完成：同上；
   * - 已完成开模保持已完成（仅改温度/备注）：不重复计数。
   */
  async function saveStepDraft(
    draft: StepDraft,
    editingId: string | null,
  ): Promise<{ rejected: boolean; message: string }> {
    const willCompleteOpen = draft.name === OPEN_STEP_NAME && draft.state === '已完成' && draft.moldId !== ''
    const wasCompletedOpen =
      editingId !== null && steps.value.find((row) => row.id === editingId)?.state === '已完成'

    if (editingId === null) {
      const row = await createStep(draft)
      if (willCompleteOpen && !wasCompletedOpen) {
        const { useMoldStore } = await import('./moldStore')
        const outcome = await useMoldStore().finalizeOpenStep(row)
        revision.value += 1
        return {
          rejected: outcome.rejected,
          message: outcome.rejected
            ? `第 ${row.seq} 道「开模」退回未开始：${outcome.message}`
            : outcome.message,
        }
      }
      return { rejected: false, message: `已新增第 ${draft.seq} 道「${draft.name}」` }
    }

    await updateStep(editingId, draft)
    const updated = steps.value.find((row) => row.id === editingId)
    if (willCompleteOpen && !wasCompletedOpen && updated !== undefined) {
      const { useMoldStore } = await import('./moldStore')
      const outcome = await useMoldStore().finalizeOpenStep(updated)
      revision.value += 1
      return {
        rejected: outcome.rejected,
        message: outcome.rejected
          ? `第 ${updated.seq} 道「开模」退回未开始：${outcome.message}`
          : outcome.message,
      }
    }
    return { rejected: false, message: '工序已更新' }
  }

  /**
   * 推进工序状态：未开始 → 进行中 → 已完成。
   * 「开模」推进到已完成时委托模具台账做最终校验：
   * 模具已报废或用尽次数 → 本道退回未开始并写明原因，前面确认过的工序照旧。
   */
  async function advanceStep(
    stepId: string,
  ): Promise<{ rejected: boolean; message: string }> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return { rejected: true, message: '工序不存在' }
    if (existing.legacyReadonly) {
      return { rejected: true, message: `历史遗留开模工序只读：${existing.legacyReason || '旧数据未记录模具编号'}` }
    }
    const flow: Step['state'][] = ['未开始', '进行中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      return { rejected: true, message: '该工序已处于「已完成」状态' }
    }
    const next = flow[index + 1]

    // 开模完成：由模具台账做最终校验、退回与计数（延迟取模具 store，避免 store 间循环依赖）
    if (existing.name === OPEN_STEP_NAME && next === '已完成') {
      const { useMoldStore } = await import('./moldStore')
      const outcome = await useMoldStore().finalizeOpenStep(existing)
      revision.value += 1
      const piece = pieces.value.find((row) => row.id === existing.pieceId)
      const suffix = piece === undefined ? '' : `（作品：${piece.name}）`
      return {
        rejected: outcome.rejected,
        message: outcome.rejected
          ? `第 ${existing.seq} 道「开模」退回未开始：${outcome.message}${suffix}`
          : `${outcome.message}${suffix}`,
      }
    }

    await putStep({ ...existing, state: next })
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === existing.pieceId)
    return {
      rejected: false,
      message: `第 ${existing.seq} 道「${existing.name}」已推进为「${next}」${
        piece === undefined ? '' : `（作品：${piece.name}）`
      }`,
    }
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveStepBefore(pieceId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === fromId)
    const toIndex = list.findIndex((row) => row.id === toId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已调整工序顺序：「${moved.name}」移动到第 ${toIndex + 1} 道`
  }

  /** 按序号升序重排（拖拽置顶/置底等场景） */
  async function moveStepToIndex(pieceId: string, stepId: string, targetIndex: number): Promise<void> {
    const list = stepsOf(pieceId)
    const fromIndex = list.findIndex((row) => row.id === stepId)
    if (fromIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    const index = Math.max(0, Math.min(list.length, targetIndex))
    list.splice(index, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已把「${moved.name}」调整到第 ${index + 1} 道`
  }

  /** 依工序与退火记录重新推导作品状态 */
  async function resyncPieceState(pieceId: string): Promise<void> {
    const next = await syncPieceState(pieceId)
    revision.value += 1
    if (next !== null) lastMessage.value = `作品状态已重新推导为「${next}」`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    pieces,
    steps,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    currentPieceId,
    currentPiece,
    visiblePieces,
    inProgressCount,
    stepsOf,
    progressOf,
    loadAll,
    selectPiece,
    setFilters,
    resetFilters,
    createPiece,
    updatePiece,
    deletePiece,
    createStep,
    updateStep,
    saveStepDraft,
    deleteStep,
    advanceStep,
    moveStepBefore,
    moveStepToIndex,
    resyncPieceState,
    refreshCounts,
  }
})
