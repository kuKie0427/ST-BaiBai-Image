<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { NAI_MODELS, settings, type NaiParamPreset } from '@/state/settings';

/**
 * 出图参数预设管理器(NAI 面板「默认参数」区的「管理」按钮唤起)。
 *
 * 分工:面板下拉管「高频切换」,这里管「低频管理」——改名、删除、查看内容、
 * 就地应用。条目只有用户自己存的(没有内置),故无只读分支;预设内容不可编辑
 * ——要改就回面板调参数再存一条,快照类数据原地手改毫无意义还容易改坏。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'apply', preset: NaiParamPreset): void;
}>();

function close() {
  emit('update:open', false);
}

const MODEL_LABELS = new Map(NAI_MODELS.map(m => [m.value, m.label]));

function artistName(id: string): string {
  if (!id) return '不使用';
  const hit = settings.nai.artistPresets.find(a => a.id === id);
  return hit?.name || '已删除的画师串';
}

const deleteOpen = ref(false);
const deleteTarget = ref<NaiParamPreset | null>(null);

function askDelete(preset: NaiParamPreset) {
  deleteTarget.value = preset;
  deleteOpen.value = true;
}

function confirmDelete() {
  deleteOpen.value = false;
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  const list = settings.nai.paramPresets;
  const index = list.findIndex(p => p.id === target.id);
  if (index >= 0) list.splice(index, 1);
  if (renamingId.value === target.id) cancelRename();
}

/* —— 改名:与面板接入点/画师串同款,点「改名」原地换输入框 —— */
const renamingId = ref('');
const renameDraft = ref('');
const renameInput = ref<HTMLInputElement | null>(null);

function startRename(preset: NaiParamPreset) {
  renamingId.value = preset.id;
  renameDraft.value = preset.name;
  requestAnimationFrame(() => renameInput.value?.focus());
}

function cancelRename() {
  renamingId.value = '';
  renameDraft.value = '';
}

/** Enter / 失焦确认;空名保持原名。 */
function commitRename(preset: NaiParamPreset) {
  if (renamingId.value === preset.id) preset.name = renameDraft.value.trim() || preset.name;
  cancelRename();
}

/* —— 应用:同口径的悬空提示由父页(应用方)做,这里只转发 —— */
function applyPreset(preset: NaiParamPreset) {
  emit('apply', preset);
}

const presets = computed(() => settings.nai.paramPresets);

/* 每次打开重置改名草稿;关闭即弃。 */
watch(
  () => props.open,
  open => {
    if (!open) cancelRename();
  },
);
</script>

<template>
  <ModalMask :open="open" @close="close">
    <div class="bbi-modal ppm-modal" role="dialog" aria-modal="true" aria-label="出图参数预设">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">出图参数预设</span>
        <button class="bbi-icon-mini" type="button" title="关闭" aria-label="关闭" @click="close">
          <Icon name="close" />
        </button>
      </header>

      <div class="ppm-scroll">
        <p v-if="!presets.length" class="ppm-empty">
          还没有预设。回到「默认参数」把参数调好,点「存为预设」即可保存当前一套。
        </p>

        <ul v-else class="ppm-list">
          <li v-for="preset in presets" :key="preset.id" class="ppm-item">
            <div class="ppm-main">
              <input
                v-if="renamingId === preset.id"
                ref="renameInput"
                class="bbi-input ppm-name-input"
                type="text"
                v-model="renameDraft"
                placeholder="预设名称"
                spellcheck="false"
                title="Enter 确认,Esc 取消"
                @keydown.enter.prevent="commitRename(preset)"
                @keydown.esc.stop.prevent="cancelRename"
                @blur="commitRename(preset)"
              />
              <span v-else class="ppm-name" :title="preset.name">{{ preset.name || '未命名预设' }}</span>
              <dl class="ppm-fields">
                <div class="ppm-field">
                  <dt>模型</dt>
                  <dd>{{ MODEL_LABELS.get(preset.model) ?? preset.model }}</dd>
                </div>
                <div class="ppm-field">
                  <dt>采样</dt>
                  <dd>{{ preset.sampler }} / {{ preset.noiseSchedule }} · {{ preset.steps }}步</dd>
                </div>
                <div class="ppm-field">
                  <dt>参数</dt>
                  <dd>Scale {{ preset.scale }} · Rescale {{ preset.cfgRescale }} · VB {{ preset.varietyBoost ? '开' : '关' }}</dd>
                </div>
                <div class="ppm-field">
                  <dt>画师串</dt>
                  <dd>{{ artistName(preset.artistId) }}</dd>
                </div>
                <div v-if="preset.undesiredContent" class="ppm-field ppm-field--wide">
                  <dt>负面词</dt>
                  <dd class="ppm-neg" :title="preset.undesiredContent">{{ preset.undesiredContent }}</dd>
                </div>
              </dl>
            </div>
            <div class="ppm-ops">
              <button class="bbi-btn bbi-btn-sm bbi-btn-primary" type="button" title="把这套参数写回渠道级" @click="applyPreset(preset)">
                <Icon name="check" :size="12" /> 应用
              </button>
              <button class="bbi-icon-btn ppm-op" type="button" title="重命名" aria-label="重命名" @click="startRename(preset)">
                <Icon name="edit" :size="14" />
              </button>
              <button
                class="bbi-icon-btn ppm-op ppm-op-remove"
                type="button"
                title="删除"
                aria-label="删除"
                @click="askDelete(preset)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </li>
        </ul>
      </div>

      <footer class="bbi-modal-foot">
        <span class="ppm-foot-hint">应用 = 把这套参数写回渠道级;之后微调不会改动预设本身。</span>
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="close">关闭</button>
      </footer>
    </div>
  </ModalMask>

  <ConfirmDialog
    v-model:open="deleteOpen"
    top-layer
    title="删除参数预设"
    confirm-text="删除"
    confirm-icon="trash"
    tone="danger"
    @confirm="confirmDelete"
  >
    确定删除预设「{{ deleteTarget?.name || '未命名预设' }}」?删除后无法恢复。
  </ConfirmDialog>
</template>

<style scoped>
.ppm-modal {
  max-width: 560px;
  display: flex;
  flex-direction: column;
  max-height: min(80vh, 640px);
}
.ppm-scroll {
  overflow-y: auto;
  min-height: 80px;
}
.ppm-empty {
  margin: 8px 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bbi-ink-muted);
}
.ppm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ppm-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
}
.ppm-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ppm-name {
  font-weight: 600;
  font-size: 13px;
  word-break: break-word;
}
.ppm-name-input {
  height: 28px;
  font-size: 13px;
}
.ppm-fields {
  margin: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 12px;
}
.ppm-field {
  display: flex;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  line-height: 1.6;
}
.ppm-field--wide {
  grid-column: 1 / -1;
}
.ppm-field dt {
  flex: 0 0 auto;
  color: var(--bbi-ink-muted);
}
.ppm-field dd {
  margin: 0;
  color: var(--bbi-ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ppm-neg {
  font-family: var(--bbi-font-mono);
}
.ppm-ops {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}
.ppm-op-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
}
.ppm-foot-hint {
  font-size: 11.5px;
  color: var(--bbi-ink-muted);
}
@media (max-width: 560px) {
  .ppm-fields {
    grid-template-columns: 1fr;
  }
}
</style>
