<script setup lang="ts">
import type { PortraitVariant } from '@/autoTag/protocol';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { backendStatus } from '@/generate';
import { isPortraitStale, type CharPortraitSelected } from '@/state/charPortraits';
import { computed, ref, watch } from 'vue';

import {
  cancelRewrite,
  cancelSlot,
  commitSlot,
  generateAll,
  generateSlot,
  getPortraitSession,
  isSlotPromptStale,
  openPortraitSession,
  portraitBackendGate,
  rewriteSlot,
  setSlotEditing,
  setSlotExtra,
  slotComposedPrompt,
  type PortraitSlotState,
} from './portraitModalState';

/**
 * 角色人设图选图弹窗。
 *
 * 三张候选对应档案里的三条提示词变体(服装/构图/表情/背景),外观 tag 由插件逐字拼在
 * 变体之前——所以卡片里外观是只读的、只有 extra 可编辑。选定一张后由服务层编码成
 * 该角色的 NAI vibe 并落库,此后的故事配图会自动带上它。
 *
 * **本组件是纯展示层**:候选、在途任务、AbortController 全在 portraitModalState.ts 的
 * 模块级 store 里。关窗不取消任务,重开能看到进度——这正是 store 存在的理由。
 *
 * 与楼层 Card.vue 的取舍差异:卡片是「平时不打扰」,浮钮 hover 才出;这里是决策现场,
 * 每张候选下面常驻一排操作(重绘 / AI 重写 / 使用这张),不藏进 ⋯ 菜单——藏起来只会让
 * 用户以为没有这些功能。
 */

const props = withDefaults(
  defineProps<{
    /** 弹窗显隐(ModalMask 内部 v-if,离场动画要容器常驻) */
    open: boolean;
    /** 角色名(人设图库主键) */
    name: string;
    /** 当前外观 tag(只读约束,选定人设图时一并作为 anchorTag 落库) */
    appearanceTag: string;
    /** 档案里 AI 给的提示词变体;为空/不足 3 条时用内置三拍补齐 */
    variants?: PortraitVariant[];
    /** 已选中的人设图(用于展示缩略图与过期判定);null = 尚未设置 */
    selected?: CharPortraitSelected | null;
  }>(),
  { variants: () => [], selected: null },
);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'committed', value: CharPortraitSelected): void;
  (e: 'removed'): void;
}>();

/** 变体内容签名:数组身份每次渲染都会变,比内容才能分清「真更新」与「父级重渲染」。 */
const variantsKey = computed(() => props.variants.map(v => `${v.extra}\u0000${v.nl}`).join('\u0001'));

/** 会话(store 里的那条),未打开或名字为空时没有。 */
const session = computed(() => (props.open && props.name.trim() ? getPortraitSession(props.name) : undefined));
const slots = computed<PortraitSlotState[]>(() => session.value?.slots ?? []);

/**
 * 打开/切换角色时同步会话:外观 tag 取最新(过期判定与落库锚点都看它),
 * 变体只补「没出图、没手改」的空槽位(见 syncPortraitSession)。
 */
watch(
  () => [props.open, props.name, props.appearanceTag, variantsKey.value] as const,
  ([open]) => {
    if (!open || !props.name.trim()) return;
    openPortraitSession({
      name: props.name,
      appearanceTag: props.appearanceTag,
      variants: props.variants,
    });
  },
  { immediate: true },
);

/** 后端闸门:人设图参考 v1 仅支持 NAI(ComfyUI 的角色 vibe 注入尚未接入)。 */
const gate = computed(() => portraitBackendGate(backendStatus()));

/** 过期:选定当时的外观锚点与当前外观档不符(派生量,不写库)。 */
const stale = computed(
  () => !!props.selected && isPortraitStale({ selected: props.selected }, props.appearanceTag),
);

/** 任一出图任务在途(含排队)。批量按钮据此显示整体进度。 */
const busyCount = computed(() => slots.value.filter(s => s.phase === 'queued' || s.phase === 'generating').length);
const readyCount = computed(() => slots.value.filter(s => !!s.candidate).length);
const committing = computed(() => session.value?.committing ?? null);

function composed(slot: PortraitSlotState): string {
  return slotComposedPrompt(session.value?.appearanceTag ?? props.appearanceTag, slot);
}

function promptStale(slot: PortraitSlotState): boolean {
  return isSlotPromptStale(session.value?.appearanceTag ?? props.appearanceTag, slot);
}

function toggleEdit(slot: PortraitSlotState): void {
  if (!session.value) return;
  setSlotEditing(session.value.name, slot.index, !slot.editing);
}

function onExtraInput(slot: PortraitSlotState, value: string): void {
  if (!session.value) return;
  setSlotExtra(session.value.name, slot.index, value);
}

function onGenerateAll(): void {
  if (!gate.value.enabled || !session.value) return;
  generateAll(session.value.name);
}

function onRedraw(slot: PortraitSlotState): void {
  if (!gate.value.enabled || !session.value) return;
  generateSlot(session.value.name, slot.index);
}

function onCancel(slot: PortraitSlotState): void {
  if (!session.value) return;
  cancelSlot(session.value.name, slot.index);
}

function onRewrite(slot: PortraitSlotState): void {
  if (!session.value) return;
  void rewriteSlot(session.value.name, slot.index);
}

function onCancelRewrite(slot: PortraitSlotState): void {
  if (!session.value) return;
  cancelRewrite(session.value.name, slot.index);
}

async function onUse(slot: PortraitSlotState): Promise<void> {
  if (!gate.value.enabled || !session.value) return;
  const selected = await commitSlot(session.value.name, slot.index);
  // 失败(服务层已 toast)保持弹窗原样,让用户重选或重试
  if (!selected) return;
  emit('committed', selected);
  emit('close');
}

function slotBusy(slot: PortraitSlotState): boolean {
  return slot.phase === 'queued' || slot.phase === 'generating';
}

/* 删除人设图:只清选中项(变体保留),文件清理在父页 removePortraitSelection 里做。
 * 不关弹窗——删完回到「未选择」,用户可能想立刻重出一张。 */
const confirmRemoveOpen = ref(false);

function onRemoveConfirmed(): void {
  confirmRemoveOpen.value = false;
  emit('removed');
}

function slotStatus(slot: PortraitSlotState): string {
  if (slot.phase === 'queued') return '排队中…';
  if (slot.phase === 'generating') return '生成中…';
  if (slot.phase === 'error') return slot.error || '生成失败';
  if (slot.candidate) return `种子 ${slot.candidate.seed}`;
  return '未生成';
}
</script>

<template>
  <ModalMask :open="open" @close="emit('close')">
    <div class="bbi-modal bbi-portrait-modal" role="dialog" aria-modal="true" aria-label="角色人设图">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">
          角色人设图
          <span class="bbi-portrait-name">{{ name }}</span>
        </span>
        <button class="bbi-icon-mini" type="button" title="关闭" @click="emit('close')">
          <Icon name="close" />
        </button>
      </header>

      <!-- 当前选中:缩略图 + 锚点外观 + 过期提示 -->
      <section class="bbi-portrait-current">
        <div class="bbi-portrait-current-thumb">
          <img v-if="selected?.thumb" :src="selected.thumb" alt="当前人设图" />
          <span v-else class="bbi-portrait-current-empty">未设置</span>
        </div>
        <div class="bbi-portrait-current-body">
          <div class="bbi-portrait-current-head">
            <span class="bbi-field-label">当前人设图</span>
            <span v-if="stale" class="bbi-portrait-pill is-stale" title="角色的固定外貌已变化,这张图不再代表当前形象">
              人设图已过期
            </span>
            <span v-else-if="selected" class="bbi-portrait-pill is-ok">已生效</span>
            <span v-else class="bbi-portrait-pill">未选择</span>
            <button
              v-if="selected"
              class="bbi-portrait-remove"
              type="button"
              title="删除当前人设图(角色与提示词变体保留)"
              @click="confirmRemoveOpen = true"
            >
              <Icon name="trash" :size="12" /> 删除人设图
            </button>
          </div>
          <p v-if="selected" class="bbi-portrait-anchor">
            <span class="bbi-portrait-anchor-label">锚定外观</span>
            <code>{{ selected.anchorTag || '(空)' }}</code>
          </p>
          <p v-else class="bbi-portrait-hint">
            选一张候选作为该角色的形象参考。选定后会编码成角色 vibe,之后同角色的配图自动带上它。
          </p>
          <p v-if="stale" class="bbi-portrait-hint is-warn">
            外貌已变化,旧图不再代表当前形象。重新生成并选一张即可清除过期标记。
          </p>
        </div>
      </section>

      <!-- 外观约束:只读,所有候选共用 -->
      <div class="bbi-portrait-appearance">
        <span class="bbi-field-label">固定外观(只读)</span>
        <code class="bbi-portrait-appearance-text">{{ appearanceTag || '(该角色还没有外观 tag)' }}</code>
      </div>

      <div class="bbi-portrait-toolbar">
        <button class="bbi-btn bbi-btn-primary" type="button" :disabled="!gate.enabled || busyCount > 0" @click="onGenerateAll">
          <Icon name="palette" />
          <template v-if="busyCount > 0">生成中 {{ readyCount }}/{{ slots.length }}…</template>
          <template v-else>生成 3 张候选</template>
        </button>
        <span v-if="!gate.enabled" class="bbi-portrait-gate">{{ gate.hint }}</span>
        <span v-else class="bbi-portrait-hint is-inline">三张图并排对比,选定一张才会保存。</span>
      </div>

      <!-- 三张候选 -->
      <ul class="bbi-portrait-grid">
        <li v-for="slot in slots" :key="slot.index" class="bbi-pslot" :data-phase="slot.phase">
          <div class="bbi-pslot-stage">
            <img v-if="slot.candidate" class="bbi-pslot-img" :src="slot.candidate.dataUrl" :alt="`方案 ${slot.index + 1}`" />
            <span v-if="!slot.candidate" class="bbi-pslot-placeholder">
              <Icon name="generate" :size="22" />
            </span>
            <span class="bbi-pslot-badge">方案 {{ slot.index + 1 }}</span>
            <span
              v-if="promptStale(slot)"
              class="bbi-pslot-stale"
              title="出图后又改过提示词;这张仍是按旧词画的,重绘才会用新词"
            >
              提示词已改
            </span>

            <div v-if="slotBusy(slot)" class="bbi-pslot-busy">
              <span class="bbi-pslot-spin" aria-hidden="true" />
              <span class="bbi-pslot-busy-text">{{ slot.phase === 'queued' ? '排队中…' : '生成中…' }}</span>
              <button class="bbi-pslot-cancel" type="button" @click="onCancel(slot)">取消</button>
            </div>

            <div v-else-if="slot.rewriting" class="bbi-pslot-busy">
              <span class="bbi-pslot-spin" aria-hidden="true" />
              <span class="bbi-pslot-busy-text">AI 重写提示词…</span>
              <button class="bbi-pslot-cancel" type="button" @click="onCancelRewrite(slot)">取消</button>
            </div>
          </div>

          <div class="bbi-pslot-body">
            <div class="bbi-pslot-body-head">
              <span class="bbi-pslot-status" :data-error="slot.phase === 'error' ? '1' : ''">{{ slotStatus(slot) }}</span>
              <button class="bbi-pslot-link" type="button" @click="toggleEdit(slot)">
                <Icon :name="slot.editing ? 'check' : 'edit'" :size="13" />
                {{ slot.editing ? '完成编辑' : '编辑提示词' }}
              </button>
            </div>

            <p class="bbi-pslot-composed" :title="composed(slot)">{{ composed(slot) || '(空提示词)' }}</p>

            <template v-if="slot.editing">
              <div class="bbi-pslot-anchor">
                <span class="bbi-pslot-anchor-label">外观(只读)</span>
                <code>{{ appearanceTag || '(空)' }}</code>
              </div>
              <BbiTextarea
                :model-value="slot.extra"
                :rows="2"
                :max-rows="5"
                mono
                placeholder="服装、构图、表情、背景 tag"
                @update:model-value="(value: string) => onExtraInput(slot, value)"
              />
              <p v-if="slot.rewriteError" class="bbi-pslot-error">{{ slot.rewriteError }}</p>
            </template>

            <div class="bbi-pslot-actions">
              <button
                class="bbi-btn bbi-btn-sm"
                type="button"
                :disabled="!gate.enabled || slotBusy(slot) || slot.rewriting"
                :title="gate.enabled ? '按当前提示词重新出这张' : gate.hint"
                @click="onRedraw(slot)"
              >
                <Icon name="refresh" :size="13" /> 重绘
              </button>
              <button
                class="bbi-btn bbi-btn-sm"
                type="button"
                :disabled="slotBusy(slot) || slot.rewriting"
                title="让 AI 重写这张图的服装/构图/表情/背景 tag,外观约束不变"
                @click="onRewrite(slot)"
              >
                <Icon name="prompt" :size="13" /> {{ slot.rewriting ? '重写中…' : 'AI 重写' }}
              </button>
              <button
                class="bbi-btn bbi-btn-sm bbi-btn-primary bbi-pslot-use"
                type="button"
                :disabled="!gate.enabled || !slot.candidate || slotBusy(slot) || committing !== null"
                :title="gate.enabled ? '保存这张为该角色的人设图' : gate.hint"
                @click="onUse(slot)"
              >
                {{ committing === slot.index ? '保存中…' : '使用这张' }}
              </button>
            </div>
          </div>
        </li>
      </ul>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="emit('close')">关闭</button>
      </footer>

      <!-- 删除确认:叠在弹窗之上 -->
      <ConfirmDialog
        v-model:open="confirmRemoveOpen"
        title="删除人设图"
        confirm-text="删除"
        tone="danger"
        confirm-icon="trash"
        top-layer
        @confirm="onRemoveConfirmed"
      >
        确定删除「{{ name }}」当前选定的人设图吗？对应的角色 vibe 文件会一并删除，无法恢复。
        提示词变体与角色本身保留，可随时重新生成。
      </ConfirmDialog>
    </div>
  </ModalMask>
</template>

<style scoped>
.bbi-portrait-modal {
  max-width: 900px;
}
.bbi-portrait-name {
  margin-left: 8px;
  color: var(--bbi-ink-soft);
  font-weight: 500;
}

/* —— 当前选中 —— */
.bbi-portrait-current {
  display: flex;
  gap: 12px;
  padding: 10px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
}
.bbi-portrait-current-thumb {
  flex: 0 0 auto;
  width: 64px;
  height: 64px;
  border-radius: var(--bbi-radius-sm);
  overflow: hidden;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bbi-portrait-current-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bbi-portrait-current-empty {
  font-size: 11px;
  color: var(--bbi-ink-muted);
}
.bbi-portrait-current-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbi-portrait-current-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbi-portrait-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
  white-space: nowrap;
}
.bbi-portrait-pill.is-ok {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-portrait-pill.is-stale {
  color: var(--bbi-warning);
  background: var(--bbi-warning-soft);
  border-color: transparent;
}
.bbi-portrait-remove {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 11.5px;
  cursor: pointer;
}
.bbi-portrait-remove:hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
.bbi-portrait-anchor {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  min-width: 0;
}
.bbi-portrait-anchor-label {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--bbi-ink-muted);
}
.bbi-portrait-anchor code {
  font-family: var(--bbi-font-mono);
  font-size: 11.5px;
  color: var(--bbi-ink-soft);
  word-break: break-word;
}
.bbi-portrait-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--bbi-ink-muted);
}
.bbi-portrait-hint.is-warn {
  color: var(--bbi-warning);
}
.bbi-portrait-hint.is-inline {
  font-size: 12px;
}

/* —— 固定外观(只读) —— */
.bbi-portrait-appearance {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 12px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
}
.bbi-portrait-appearance-text {
  font-family: var(--bbi-font-mono);
  font-size: 11.5px;
  color: var(--bbi-ink-soft);
  word-break: break-word;
}

/* —— 工具条 —— */
.bbi-portrait-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.bbi-portrait-gate {
  font-size: 12px;
  color: var(--bbi-warning);
}

/* —— 候选网格:三列等比,卡片竖向排 —— */
.bbi-portrait-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.bbi-pslot {
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  overflow: hidden;
}
.bbi-pslot[data-phase='ready'] {
  border-color: var(--bbi-line-strong);
}

/* 舞台:固定高度 + contain —— 人设图是全身边缘构图,cover 裁掉头脚会让人没法选 */
.bbi-pslot-stage {
  position: relative;
  height: 320px;
  background: var(--bbi-surface-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.bbi-pslot-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.bbi-pslot-placeholder {
  color: var(--bbi-ink-muted);
  opacity: 0.5;
}
.bbi-pslot-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  background: oklch(0 0 0 / 0.55);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 10.5px;
  line-height: 17px;
}
.bbi-pslot-stale {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  background: oklch(0 0 0 / 0.55);
  backdrop-filter: blur(4px);
  color: var(--bbi-warning);
  font-size: 10.5px;
  line-height: 17px;
}
.bbi-pslot-busy {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px;
  background: color-mix(in srgb, var(--bbi-bg) 78%, transparent);
  backdrop-filter: blur(3px);
}
.bbi-pslot-busy-text {
  font-size: 12px;
  color: var(--bbi-ink-soft);
}
.bbi-pslot-spin {
  width: 20px;
  height: 20px;
  border: 2px solid color-mix(in srgb, var(--bbi-accent) 28%, transparent);
  border-top-color: var(--bbi-accent);
  border-radius: 50%;
  animation: bbi-portrait-spin 0.8s linear infinite;
}
@keyframes bbi-portrait-spin {
  to {
    transform: rotate(360deg);
  }
}
.bbi-pslot-cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  padding: 0 12px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  font-size: 11.5px;
  font-family: var(--bbi-font-sans);
  cursor: pointer;
}
.bbi-pslot-cancel:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

/* —— 卡片正文 —— */
.bbi-pslot-body {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}
.bbi-pslot-body-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.bbi-pslot-status {
  font-size: 11px;
  color: var(--bbi-ink-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbi-pslot-status[data-error='1'] {
  color: var(--bbi-danger);
}
.bbi-pslot-link {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: transparent;
  color: var(--bbi-ink-muted);
  font-family: var(--bbi-font-sans);
  font-size: 11.5px;
  cursor: pointer;
}
.bbi-pslot-link:hover {
  color: var(--bbi-accent);
  background: var(--bbi-surface-2);
}
.bbi-pslot-composed {
  margin: 0;
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--bbi-ink-soft);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bbi-pslot-anchor {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px dashed var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
}
.bbi-pslot-anchor-label {
  font-size: 10.5px;
  color: var(--bbi-ink-muted);
}
.bbi-pslot-anchor code {
  font-family: var(--bbi-font-mono);
  font-size: 11px;
  color: var(--bbi-ink-soft);
  word-break: break-word;
}
.bbi-pslot-error {
  margin: 0;
  font-size: 11.5px;
  color: var(--bbi-danger);
}
.bbi-pslot-actions {
  margin-top: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbi-pslot-use {
  margin-left: auto;
}
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}

@media (max-width: 760px) {
  .bbi-portrait-grid {
    grid-template-columns: 1fr;
  }
  .bbi-pslot-stage {
    height: 300px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bbi-pslot-spin {
    animation: none;
  }
}
</style>
