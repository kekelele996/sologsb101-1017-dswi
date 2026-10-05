<script setup lang="ts">
/**
 * /molds 模具台账
 * 模具管理员登记模具编号、可用次数与报废状态；按模具编号与开模道次对账，
 * 对不上先挂起；台账保存失败按本侧重试（工序单照旧），未生效变更进入待处理队列。
 * 消费模型：Mold、Step；复用组件：<StatBadge>、<FilterBar>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMoldStore } from '@/stores/moldStore'
import { usePieceStore } from '@/stores/pieceStore'
import { MOLD_MATERIAL_OPTIONS, MOLD_STATUS_OPTIONS, type Mold, type MoldDraft, type MoldStatus } from '@/types/mold'
import { NEAR_EXHAUSTED_LEFT, remainUses, type MoldFaultMode } from '@/utils/mold'

const moldStore = useMoldStore()
const pieceStore = usePieceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const statusFilter = ref<MoldStatus | 'all'>('all')
const materialFilter = ref<(typeof MOLD_MATERIAL_OPTIONS)[number] | 'all'>('all')
const formRef = ref<FormInstance>()

const form = reactive<MoldDraft>({
  code: '',
  name: '',
  material: '石膏',
  maxUses: 20,
  usedCount: 0,
  scrapped: false,
  scrapReason: '',
})

const rules = computed<FormRules<MoldDraft>>(() => ({
  code: [{ required: true, message: '请填写模具编号', trigger: 'blur' }],
  name: [{ required: true, message: '请填写模具名称 / 用途', trigger: 'blur' }],
  material: [{ required: true, message: '请选择材质', trigger: 'change' }],
  maxUses: [{ required: true, message: '请填写可用次数', trigger: 'blur' }],
  usedCount: [{ required: true, message: '请填写已用次数', trigger: 'blur' }],
  scrapReason: form.scrapped ? [{ required: true, message: '报废时必须填写报废原因', trigger: 'blur' }] : [],
}))

onMounted(() => {
  void moldStore.loadAll()
  void pieceStore.loadAll()
})

const statusTagType = (status: MoldStatus): 'success' | 'warning' | 'info' | 'danger' => {
  if (status === '已报废') return 'danger'
  if (status === '已用尽') return 'info'
  if (status === '即将用尽') return 'warning'
  return 'success'
}

const pieceLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, row.name])),
)

/** 每副模具最近一次开模所在的作品（用于台账行辅助核对） */
const lastOpenPieceOf = (moldId: string): string => {
  const list = moldStore.steps
    .filter((row) => row.name === '开模' && row.moldId === moldId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (list.length === 0) return '—'
  const names = Array.from(new Set(list.map((row) => pieceLabel.value[row.pieceId] ?? '（作品已删除）')))
  return names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : '')
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    code: '',
    name: '',
    material: '石膏',
    maxUses: 20,
    usedCount: 0,
    scrapped: false,
    scrapReason: '',
  })
  dialogVisible.value = true
}

function openEdit(row: Mold): void {
  editingId.value = row.id
  Object.assign(form, {
    code: row.code,
    name: row.name,
    material: row.material,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    scrapped: row.scrapped,
    scrapReason: row.scrapReason,
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (form.usedCount > form.maxUses) {
    ElMessage.warning(`已用次数不能超过可用次数（${form.maxUses}）`)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const duplicate = moldStore.effectiveMolds.some((row) => row.code === form.code.trim())
      if (duplicate) {
        ElMessage.warning(`模具编号「${form.code.trim()}」已存在，台账编号不可重复`)
        return
      }
      const row = await moldStore.createMold({ ...form })
      // 保存失败也不阻断：变更已进入待处理队列（工序单照旧），弹窗照常关闭
      ElMessage[row === null ? 'warning' : 'success'](moldStore.lastMessage)
    } else {
      const ok = await moldStore.updateMold(editingId.value, { ...form })
      ElMessage[ok ? 'success' : 'warning'](moldStore.lastMessage)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Mold): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除模具「${row.code}」？已被开模工序引用的模具不可删除，只能登记报废。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const ok = await moldStore.deleteMold(row.id)
  ElMessage[ok ? 'success' : 'warning'](moldStore.lastMessage)
}

async function handleToggleScrap(row: Mold): Promise<void> {
  if (!row.scrapped) {
    let reason = ''
    try {
      const result = await ElMessageBox.prompt(`登记模具「${row.code}」的报废原因`, '模具报废', {
        confirmButtonText: '确认报废',
        cancelButtonText: '取消',
        inputPlaceholder: '如：模面开裂 / 尺寸超差',
        inputValidator: (value: string) => value.trim() !== '' || '报废原因不能为空',
      })
      reason = result.value
    } catch {
      return
    }
    await moldStore.setScrapped(row.id, true, reason)
    ElMessage.success(moldStore.lastMessage || '模具已登记报废，挑模列表不再出现')
  } else {
    await moldStore.setScrapped(row.id, false, '')
    ElMessage.success(`模具「${row.code}」已解除报废`)
  }
}

async function handleFlush(): Promise<void> {
  const { flushed, remaining } = await moldStore.flushPending()
  if (flushed === 0) ElMessage.warning('待处理变更仍未能写入（故障注入可能仍开启），继续挂起')
  else if (remaining > 0) ElMessage.warning(`已补写 ${flushed} 条，仍有 ${remaining} 条挂起`)
  else ElMessage.success(`待处理变更已全部补写（${flushed} 条），对账状态已刷新`)
}

function handleFaultMode(mode: MoldFaultMode): void {
  moldStore.setFaultMode(mode)
  ElMessage.info(
    mode === 'off'
      ? '故障注入已关闭'
      : mode === 'once'
        ? '下一次模具台账保存将失败，可观察本侧重试 → 排队（工序单照旧）'
        : '故障注入持续开启：所有台账保存都会失败，直到手动关闭',
  )
}

function onFaultChange(value: string | number | boolean | undefined): void {
  handleFaultMode(String(value) as MoldFaultMode)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'status') statusFilter.value = value as MoldStatus | 'all'
  else if (key === 'material') materialFilter.value = value as typeof materialFilter.value
}

function handleResetFilters(): void {
  keyword.value = ''
  statusFilter.value = 'all'
  materialFilter.value = 'all'
}

const filteredRows = computed<Mold[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return moldStore.visibleMolds.filter((row) => {
    if (materialFilter.value !== 'all' && row.material !== materialFilter.value) return false
    if (statusFilter.value !== 'all' && moldStore.statusMap[row.id] !== statusFilter.value) return false
    if (key === '') return true
    return (
      row.code.toLowerCase().includes(key) ||
      row.name.toLowerCase().includes(key) ||
      row.scrapReason.toLowerCase().includes(key)
    )
  })
})

const usedPercent = (row: Mold): number =>
  row.maxUses === 0 ? 0 : Math.min(100, Math.round((row.usedCount / row.maxUses) * 100))
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="模具总数" :value="moldStore.stats.total" suffix="副" tone="primary" icon="Histogram" />
      <StatBadge label="可挑模具" :value="moldStore.stats.usable" suffix="副" tone="success" icon="DataLine" />
      <StatBadge label="即将用尽" :value="moldStore.effectiveMolds.filter((r) => remainUses(r) <= NEAR_EXHAUSTED_LEFT && !r.scrapped && remainUses(r) > 0).length" suffix="副" tone="warning" icon="TrendCharts" />
      <StatBadge label="已用尽" :value="moldStore.stats.exhausted" suffix="副" tone="info" icon="DataLine" />
      <StatBadge label="已报废" :value="moldStore.stats.scrapped" suffix="副" tone="danger" icon="Warning" />
      <StatBadge label="对账挂起" :value="moldStore.stats.held" suffix="副" tone="danger" icon="Warning" />
      <StatBadge label="待处理变更" :value="moldStore.stats.pending" suffix="条" tone="warning" icon="TrendCharts" />
    </div>

    <el-alert
      v-if="moldStore.heldMolds.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${moldStore.heldMolds.length} 副模具对账挂起：开模道次合计与台账已用次数对不上`"
    >
      <template #default>
        <div class="held-list">
          <div v-for="row in moldStore.heldMolds" :key="row.id">
            · {{ row.code }}（{{ row.name }}）：{{ moldStore.reconcileMap[row.id]?.message }}
          </div>
        </div>
      </template>
    </el-alert>

    <el-alert
      v-if="moldStore.pendingOps.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`台账有 ${moldStore.pendingOps.length} 条保存失败的变更待本侧重试（工序单照旧未受影响）`"
    >
      <template #default>
        <el-space wrap>
          <el-button size="small" type="primary" @click="handleFlush">立即重试挂起变更</el-button>
          <span class="cell-sub">
            {{ moldStore.pendingOps.map((op) => (op.type === 'put' ? `整行 ${op.row.code}` : `+1 次 ${op.moldId}`)).join('；') }}
          </span>
        </el-space>
      </template>
    </el-alert>

    <el-card shadow="never" class="fault-card">
      <div class="fault-row">
        <div>
          <b>台账保存故障注入（演示“保存失败按本侧重试”）</b>
          <p class="cell-sub">开启后保存模具台账会强制失败：自动重试 3 次仍失败则变更进入待处理队列，开模工序单照旧。</p>
        </div>
        <el-radio-group :model-value="moldStore.faultMode" size="small" @change="onFaultChange">
          <el-radio-button value="off">关闭</el-radio-button>
          <el-radio-button value="once">失败一次</el-radio-button>
          <el-radio-button value="always">持续失败</el-radio-button>
        </el-radio-group>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">模具台账</span>
          <el-button type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            <span>登记模具</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          { key: 'status', label: '状态', options: MOLD_STATUS_OPTIONS as unknown as string[] },
          { key: 'material', label: '材质', options: MOLD_MATERIAL_OPTIONS as unknown as string[] },
        ]"
        :values="{ status: statusFilter, material: materialFilter }"
        :result-text="`命中 ${filteredRows.length} / ${moldStore.effectiveMolds.length} 副`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="handleResetFilters"
      />

      <EmptyPanel
        v-if="moldStore.effectiveMolds.length === 0 && moldStore.ready"
        title="模具台账还是空的"
        description="登记模具编号、可用次数与报废状态。吹制技师开模时只能挑未报废、次数未用尽的模具，完成开模后台账已用次数自动 +1。"
        action-text="登记第一副模具"
        @action="openCreate"
      />

      <el-table v-else :data="filteredRows" row-key="id" stripe v-loading="moldStore.loading">
        <el-table-column prop="code" label="模具编号" width="110" />
        <el-table-column label="名称 / 用途" min-width="160">
          <template #default="{ row }: { row: Mold }">
            <div class="cell-stack">
              <b>{{ row.name }}</b>
              <span class="cell-sub">最近开模作品：{{ lastOpenPieceOf(row.id) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="material" label="材质" width="80" />
        <el-table-column label="次数（已用 / 可用）" width="200">
          <template #default="{ row }: { row: Mold }">
            <div class="cell-stack">
              <el-progress
                :percentage="usedPercent(row)"
                :status="row.scrapped || row.usedCount >= row.maxUses ? 'exception' : remainUses(row) <= NEAR_EXHAUSTED_LEFT ? 'warning' : ''"
                :stroke-width="10"
              />
              <span class="cell-sub">
                {{ row.usedCount }} / {{ row.maxUses }} · 剩余 {{ remainUses(row) }} 次
                <template v-if="(moldStore.pendingDeltaMap[row.id] ?? 0) > 0">
                  （待补写 +{{ moldStore.pendingDeltaMap[row.id] }}）
                </template>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }: { row: Mold }">
            <el-tag size="small" :type="statusTagType(moldStore.statusMap[row.id])" effect="dark">
              {{ moldStore.statusMap[row.id] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报废原因" min-width="150">
          <template #default="{ row }: { row: Mold }">
            <span v-if="row.scrapReason === ''" class="cell-sub">—</span>
            <span v-else>{{ row.scrapReason }}</span>
          </template>
        </el-table-column>
        <el-table-column label="对账" min-width="220">
          <template #default="{ row }: { row: Mold }">
            <el-tag size="small" :type="moldStore.reconcileMap[row.id]?.held ? 'danger' : 'success'">
              {{ moldStore.reconcileMap[row.id]?.held ? '挂起' : '一致' }}
            </el-tag>
            <span class="cell-sub reconcile-text">
              台账 {{ moldStore.reconcileMap[row.id]?.ledgerUsed ?? row.usedCount }} / 开模
              {{ moldStore.reconcileMap[row.id]?.openPasses ?? 0 }} 道
            </span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }: { row: Mold }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.scrapped ? 'success' : 'warning'" size="small" @click="handleToggleScrap(row)">
              {{ row.scrapped ? '解除报废' : '登记报废' }}
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记模具' : '编辑模具台账'" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="模具编号" prop="code">
              <el-input v-model="form.code" placeholder="如：M-101" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="材质" prop="material">
              <el-select v-model="form.material" style="width: 100%">
                <el-option v-for="item in MOLD_MATERIAL_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="名称 / 用途" prop="name">
          <el-input v-model="form.name" placeholder="如：碗形石膏模" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="可用次数" prop="maxUses">
              <el-input-number v-model="form.maxUses" :min="1" :max="999" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="已用次数" prop="usedCount">
              <el-input-number v-model="form.usedCount" :min="0" :max="form.maxUses" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="报废状态">
          <el-switch v-model="form.scrapped" active-text="已报废" inactive-text="在用" />
        </el-form-item>
        <el-form-item v-if="form.scrapped" label="报废原因" prop="scrapReason">
          <el-input v-model="form.scrapReason" placeholder="如：模面开裂，2026-08 报废" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header,
.fault-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.fault-card {
  margin-bottom: 14px;
  background: #fbfaf6;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.reconcile-text {
  margin-left: 6px;
}

.held-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
