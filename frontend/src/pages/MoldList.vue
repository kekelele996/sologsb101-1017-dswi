<script setup lang="ts">
/**
 * /molds 模具台账
 * 登记模具编号、可用次数与报废状态；按模具编号与开模道次合计对账，对账不平时挂起。
 * 消费模型：Mold、Step；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMoldStore } from '@/stores/moldStore'
import { MOLD_STATE_OPTIONS, type Mold, type MoldDraft } from '@/types/mold'

const moldStore = useMoldStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const keyword = ref('')
const stateFilter = ref<string>('all')
const formRef = ref<FormInstance>()

const form = reactive<MoldDraft>({
  code: '',
  totalCount: 50,
  scrapped: false,
})

const rules: FormRules<MoldDraft> = {
  code: [{ required: true, message: '请填写模具编号', trigger: 'blur' }],
  totalCount: [{ required: true, message: '请填写可用次数', trigger: 'blur' }],
}

const filtered = computed<Mold[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return moldStore.molds.filter((row) => {
    if (stateFilter.value !== 'all') {
      if (stateFilter.value === '在用' && row.scrapped) return false
      if (stateFilter.value === '报废' && !row.scrapped) return false
    }
    if (key === '') return true
    return row.code.toLowerCase().includes(key)
  })
})

const stats = computed(() => ({
  total: moldStore.molds.length,
  inUse: moldStore.molds.filter((r) => !r.scrapped).length,
  scrapped: moldStore.scrappedMolds.length,
  suspended: moldStore.suspended,
}))

onMounted(() => {
  void moldStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, { code: '', totalCount: 50, scrapped: false })
  dialogVisible.value = true
}

function openEdit(row: Mold): void {
  editingId.value = row.id
  Object.assign(form, { code: row.code, totalCount: row.totalCount, scrapped: row.scrapped })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    if (editingId.value === null) {
      await moldStore.createMold({ ...form })
      ElMessage.success('模具已登记')
    } else {
      await moldStore.updateMold(editingId.value, { ...form })
      ElMessage.success('模具已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Mold): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除模具「${row.code}」？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await moldStore.deleteMold(row.id)
  ElMessage.success('模具已删除')
}

async function handleToggleScrap(row: Mold): Promise<void> {
  await moldStore.toggleScrap(row.id)
  ElMessage.success(moldStore.lastMessage)
}

async function handleRetry(): Promise<void> {
  await moldStore.retryAllPending()
  ElMessage.success('已重试台账保存')
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="模具总数" :value="stats.total" suffix="副" tone="primary" icon="Histogram" />
      <StatBadge label="在用模具" :value="stats.inUse" suffix="副" tone="success" icon="DataLine" />
      <StatBadge label="已报废" :value="stats.scrapped" suffix="副" tone="danger" icon="Warning" />
      <StatBadge
        label="系统状态"
        :value="stats.suspended ? '挂起' : '正常'"
        :tone="stats.suspended ? 'danger' : 'success'"
        icon="PieChart"
      />
    </div>

    <el-alert
      v-if="moldStore.suspended"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      title="系统挂起：模具台账与开模道次对账不平"
      description="开模道次合计与台账已用次数不一致，请核对下方对账结果并调整模具台账，平账后自动恢复。"
    />

    <el-alert
      v-if="moldStore.pendingRetries.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${moldStore.pendingRetries.length} 笔台账保存待重试`"
      description="台账保存失败后按本侧重试，工序单不受影响。可点击「重试台账保存」手动重试。"
    >
      <template #default>
        <el-button size="small" type="warning" @click="handleRetry">重试台账保存</el-button>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">模具台账</span>
          <el-space wrap>
            <el-button type="primary" @click="openCreate">
              <el-icon><Plus /></el-icon>
              <span>登记模具</span>
            </el-button>
          </el-space>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[{ key: 'state', label: '状态', options: MOLD_STATE_OPTIONS }]"
        :values="{ state: stateFilter }"
        :result-text="`命中 ${filtered.length} / ${moldStore.molds.length} 副`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="(key: string, value: string) => { if (key === 'state') stateFilter = value }"
        @reset="
          () => {
            keyword = ''
            stateFilter = 'all'
          }
        "
      />

      <EmptyPanel
        v-if="moldStore.ready && moldStore.molds.length === 0"
        title="还没有登记模具"
        description="登记模具编号、可用次数与报废状态；开模工序只能挑选未报废且次数未用完的模具。"
        action-text="登记第一副模具"
        @action="openCreate"
      />

      <el-table v-else v-loading="moldStore.loading" :data="filtered" row-key="id" stripe>
        <el-table-column label="模具编号" min-width="140">
          <template #default="{ row }">
            <b>{{ row.code }}</b>
          </template>
        </el-table-column>
        <el-table-column label="可用次数" width="120">
          <template #default="{ row }">{{ row.totalCount }} 次</template>
        </el-table-column>
        <el-table-column label="台账已用" width="120">
          <template #default="{ row }">
            <span :class="{ 'cell-warn': row.usedCount >= row.totalCount }">{{ row.usedCount }} 次</span>
          </template>
        </el-table-column>
        <el-table-column label="开模道次合计" width="130">
          <template #default="{ row }">
            {{ moldStore.reconciles.find((r) => r.moldId === row.id)?.stepCount ?? 0 }} 道
          </template>
        </el-table-column>
        <el-table-column label="对账" width="100">
          <template #default="{ row }">
            <el-tag
              v-if="moldStore.reconciles.find((r) => r.moldId === row.id)?.balanced"
              size="small"
              type="success"
            >
              平账
            </el-tag>
            <el-tag v-else size="small" type="danger">
              差异 {{ moldStore.reconciles.find((r) => r.moldId === row.id)?.diff ?? 0 }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.scrapped ? 'danger' : 'success'" effect="dark">
              {{ row.scrapped ? '报废' : '在用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link :type="row.scrapped ? 'success' : 'warning'" size="small" @click="handleToggleScrap(row)">
              {{ row.scrapped ? '恢复' : '报废' }}
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '登记模具' : '编辑模具'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="模具编号" prop="code">
          <el-input v-model="form.code" placeholder="如：MOLD-A" />
        </el-form-item>
        <el-form-item label="可用次数" prop="totalCount">
          <el-input-number v-model="form.totalCount" :min="1" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="报废状态">
          <el-switch v-model="form.scrapped" active-text="报废" inactive-text="在用" />
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

.card-header {
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

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
