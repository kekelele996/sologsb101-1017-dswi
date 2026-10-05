/**
 * 模具（Mold）
 * 模具台账记录模具编号、可用次数与报废状态；开模工序只能挑没报废、次数没用完的模具。
 */

/** 模具状态：在用 / 报废 */
export type MoldState = '在用' | '报废'

export const MOLD_STATE_OPTIONS: MoldState[] = ['在用', '报废']

export interface Mold {
  id: string
  /** 模具编号，如 MOLD-A */
  code: string
  /** 可用次数（总寿命） */
  totalCount: number
  /** 台账已用次数（与开模道次合计对账） */
  usedCount: number
  /** 报废状态 */
  scrapped: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑模具的表单草稿 */
export interface MoldDraft {
  code: string
  totalCount: number
  scrapped: boolean
}

/** 模具对账结果 */
export interface MoldReconcile {
  moldId: string
  moldCode: string
  /** 台账已用次数 */
  ledgerUsed: number
  /** 开模道次合计（已完成的开模工序数） */
  stepCount: number
  /** 是否平账 */
  balanced: boolean
  /** 差异（stepCount - ledgerUsed） */
  diff: number
}
