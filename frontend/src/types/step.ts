/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 开模工序名称常量，供全项目比对 */
export const OPEN_STEP_NAME = '开模' as const

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']

export interface Step {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 工序序号，从 1 开始 */
  seq: number
  /** 工序名称 */
  name: StepName
  /** 工序温度（℃） */
  tempC: number
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 备注 */
  remark: string
  /** 工序状态 */
  state: StepState
  /**
   * 绑定的模具编号（Mold.id）。
   * 仅「开模」工序使用：挑模时必须选未报废、次数未用尽的模具；
   * v2 → v3 升级时按作品当时使用的模具回填，填不上的为历史遗留只读行。
   */
  moldId: string
  /** 挑中模具时台账上的已用次数快照（记录“当时已用次数”） */
  moldUsedAtPick: number
  /**
   * 历史遗留只读标记：旧数据里的开模工序没记模具编号，
   * 升级时按作品当时用的模具回填，填不上的只读。
   */
  legacyReadonly: boolean
  /** 只读 / 退回等原因说明 */
  legacyReason: string
  /** 开模完成时模具已报废或次数用尽，本道退回未开始的原因；可重开后清空 */
  rejectReason: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑吹制工序的表单草稿 */
export interface StepDraft {
  pieceId: string
  seq: number
  name: StepName
  tempC: number
  durationMin: number
  operator: string
  remark: string
  state: StepState
  /** 仅开模工序有效，其余工序保存时归一化为空串 */
  moldId: string
  /** 挑中模具时台账上的已用次数（页面保存前从模具台账快照） */
  moldUsedAtPick?: number
}
