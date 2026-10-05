/**
 * 模具（Mold）
 * 模具管理员在模具台账上登记模具编号、可用次数与报废状态；
 * 吹制技师开模时只能挑未报废、次数未用尽的模具。
 */

/** 模具材质 */
export type MoldMaterial = '石膏' | '石墨' | '木' | '钢'

export const MOLD_MATERIAL_OPTIONS: MoldMaterial[] = ['石膏', '石墨', '木', '钢']

/** 台账行派生状态（已报废优先于已用尽） */
export type MoldStatus = '可用' | '即将用尽' | '已用尽' | '已报废'

export const MOLD_STATUS_OPTIONS: MoldStatus[] = ['可用', '即将用尽', '已用尽', '已报废']

export interface Mold {
  id: string
  /** 模具编号（业务编号，如 M-101） */
  code: string
  /** 模具名称 / 用途，如 碗形石膏模 */
  name: string
  /** 材质 */
  material: MoldMaterial
  /** 可用次数（寿命上限） */
  maxUses: number
  /** 已用次数（台账侧计数，与开模道次对账） */
  usedCount: number
  /** 报废状态 */
  scrapped: boolean
  /** 报废原因 */
  scrapReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑模具的表单草稿 */
export interface MoldDraft {
  code: string
  name: string
  material: MoldMaterial
  maxUses: number
  usedCount: number
  scrapped: boolean
  scrapReason: string
}
