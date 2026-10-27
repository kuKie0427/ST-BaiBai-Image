import { getContext } from '@/st/context';
import { reactive } from 'vue';

import type { CharChange, PortraitVariant } from '@/autoTag/protocol';
import type { CharTagAutoOp } from '@/state/charTags';

/**
 * 角色人设图库(chat 作用域)。
 *
 * - 提示词变体:AI 建档时随附的 3 条 extra(服装/构图/表情/背景),外观 tag 由插件
 *   composePortraitPrompt 逐字拼在前,三条候选的外观部分结构上保证一致。
 * - 选中项:候选出图后选定的那张,连同 anchorTag(选定当时的外观 tag 快照)与
 *   已编码的 NAI vibe 引用;过期与否是派生量(anchorTag 与当前档不符),不回写。
 *
 * 与 charTags 的关系是单向的:本模块可以 import 它的类型/工具,它绝不 import 这里。
 */

export interface CharPortraitVibeRef {
  dataPath: string;
  thumbnailPath: string;
  modelKeys: string[];
  fingerprint: string;
}

export interface CharPortraitSelected {
  prompt: string;
  seed: number;
  anchorTag: string;
  thumb: string;
  vibe: CharPortraitVibeRef;
}

export interface CharPortraitEntry {
  name: string;
  variants: PortraitVariant[];
  selected: null | CharPortraitSelected;
}

export interface CharPortraitSeed {
  name: string;
  variants: PortraitVariant[];
}

interface CharPortraitStore {
  version: 1;
  entries: CharPortraitEntry[];
}

export const CHAR_PORTRAIT_META_KEY = 'baibai_image_char_portraits';
const VARIANT_LIMIT = 3;

export const charPortraitLib = reactive<{ entries: CharPortraitEntry[] }>({ entries: [] });
let baseEntries: CharPortraitEntry[] = [];

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
}

function normalizeVariant(raw: unknown): PortraitVariant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const extra = cleanText(value.extra);
  if (!extra) return null;
  return { extra, nl: cleanText(value.nl) };
}

export function normalizeVariants(raw: unknown): PortraitVariant[] {
  if (!Array.isArray(raw)) return [];
  const out: PortraitVariant[] = [];
  for (const item of raw) {
    if (out.length >= VARIANT_LIMIT) break;
    const variant = normalizeVariant(item);
    if (variant) out.push(variant);
  }
  return out;
}

function normalizeModelKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const key = cleanText(item);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

function normalizeVibeRef(raw: unknown): CharPortraitVibeRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const dataPath = cleanText(value.dataPath);
  // 没有 dataPath 就加载不到 vibe 二进制,选中项等于白存
  if (!dataPath) return null;
  return {
    dataPath,
    thumbnailPath: cleanText(value.thumbnailPath),
    modelKeys: normalizeModelKeys(value.modelKeys),
    fingerprint: cleanText(value.fingerprint),
  };
}

function normalizeSelected(raw: unknown): CharPortraitSelected | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const prompt = cleanText(value.prompt);
  const vibe = normalizeVibeRef(value.vibe);
  if (!prompt || !vibe) return null;
  const seed = typeof value.seed === 'number' && Number.isFinite(value.seed) ? Math.trunc(value.seed) : 0;
  return {
    prompt,
    seed,
    anchorTag: cleanText(value.anchorTag),
    thumb: typeof value.thumb === 'string' ? value.thumb : '',
    vibe,
  };
}

function normalizeEntry(raw: unknown): CharPortraitEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = cleanText(value.name);
  if (!name) return null;
  const variants = normalizeVariants(value.variants);
  const selected = normalizeSelected(value.selected);
  if (!variants.length && !selected) return null;
  return { name, variants, selected };
}

function cloneEntry(entry: CharPortraitEntry): CharPortraitEntry {
  return {
    name: entry.name,
    variants: entry.variants.map(variant => ({ ...variant })),
    selected: entry.selected
      ? { ...entry.selected, vibe: { ...entry.selected.vibe, modelKeys: [...entry.selected.vibe.modelKeys] } }
      : null,
  };
}

export function normalizeCharPortraitStore(raw: unknown): CharPortraitEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = (raw as Partial<CharPortraitStore>).entries;
  if (!Array.isArray(entries)) return [];
  const out: CharPortraitEntry[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const entry = normalizeEntry(item);
    if (entry && !seen.has(entry.name)) {
      seen.add(entry.name);
      out.push(entry);
    }
  }
  return out;
}

function syncLib(): void {
  charPortraitLib.entries = baseEntries.map(cloneEntry);
}

function persist(): void {
  const context = getContext();
  if (!context?.chatMetadata) return;
  context.chatMetadata[CHAR_PORTRAIT_META_KEY] = {
    version: 1,
    entries: baseEntries.map(cloneEntry),
  } satisfies CharPortraitStore;
  context.saveMetadataDebounced?.();
}

/** 空条目(无变体且无选中)没有存在意义,顺手删掉——UI 与全局提升都靠这条保持一致。 */
function commit(entry: CharPortraitEntry): void {
  const index = baseEntries.findIndex(candidate => candidate.name === entry.name);
  if (!entry.variants.length && !entry.selected) {
    if (index >= 0) baseEntries.splice(index, 1);
  } else if (index >= 0) {
    baseEntries[index] = entry;
  } else {
    baseEntries.push(entry);
  }
  persist();
  syncLib();
}

function entryFor(name: string): CharPortraitEntry {
  const cleanName = cleanText(name);
  const found = baseEntries.find(entry => entry.name === cleanName);
  return found ? cloneEntry(found) : { name: cleanName, variants: [], selected: null };
}

export function hydrateCharPortraits(): void {
  baseEntries = normalizeCharPortraitStore(getContext()?.chatMetadata?.[CHAR_PORTRAIT_META_KEY]);
  syncLib();
}

/** 只看本聊天库(不含全局)。要「chat → 全局」的合并查找请用 resolveCharPortrait。 */
export function findCharPortrait(name: string): CharPortraitEntry | undefined {
  const cleanName = cleanText(name);
  if (!cleanName) return undefined;
  return charPortraitLib.entries.find(entry => entry.name === cleanName);
}

/**
 * 全局人设图库的条目来源,由 charPortraitsGlobal.ts 启动时注入。
 * 走注入而不是 import:全局模块要用这里的归一化/CRUD/类型,直接互转会成模块环
 * (与 charTags ↔ globalCharTags 同一套做法)。
 */
let globalCharPortraitSource: () => CharPortraitEntry[] = () => [];

export function setGlobalCharPortraitSource(provider: () => CharPortraitEntry[]): void {
  globalCharPortraitSource = provider;
}

/**
 * 人设图查找的统一入口:**本聊天优先,全局补空缺**(与 charTags 的 mergeCharTagSeed 同语义)。
 * 提升为全局后本聊天条目已被删除,自然落到全局库;本聊天手动建的同名条目则覆盖全局。
 * 注:全局库不会被 AI 写,本聊天条目才是可变的,所以「谁在库里谁说了算」在这里等价于作用域优先级。
 */
export function resolveCharPortrait(name: string): CharPortraitEntry | undefined {
  const cleanName = cleanText(name);
  if (!cleanName) return undefined;
  const chatEntry = charPortraitLib.entries.find(entry => entry.name === cleanName);
  if (chatEntry) return chatEntry;
  return globalCharPortraitSource().find(entry => entry.name === cleanName);
}

/** 覆盖变体但保留已有选中项:重跑建档时 AI 换了提示词,用户已选定的人设图不该跟着掉。 */
export function setVariants(name: string, variants: PortraitVariant[]): boolean {
  const cleanName = cleanText(name);
  if (!cleanName) return false;
  const entry = entryFor(cleanName);
  entry.variants = normalizeVariants(variants);
  commit(entry);
  return true;
}

export function setSelected(name: string, selected: CharPortraitSelected): boolean {
  const cleanName = cleanText(name);
  if (!cleanName) return false;
  const normalized = normalizeSelected(selected);
  if (!normalized) return false;
  const entry = entryFor(cleanName);
  entry.selected = normalized;
  commit(entry);
  return true;
}

export function clearSelected(name: string): boolean {
  const cleanName = cleanText(name);
  if (!cleanName) return false;
  const found = baseEntries.find(entry => entry.name === cleanName);
  if (!found) return false;
  const entry = cloneEntry(found);
  entry.selected = null;
  commit(entry);
  return true;
}

export function removePortrait(name: string): boolean {
  const cleanName = cleanText(name);
  const index = baseEntries.findIndex(entry => entry.name === cleanName);
  if (index < 0) return false;
  baseEntries.splice(index, 1);
  persist();
  syncLib();
  return true;
}

/**
 * 完整提示词 = 外观 tag(逐字) + 变体 extra。外观由调用方传入而非在这里读库:
 * 建档当刻的档就是外观事实,而且这样本模块不依赖 charTags 的运行时状态。
 */
export function composePortraitPrompt(appearanceTag: string, variant: PortraitVariant): string {
  return [appearanceTag.trim(), variant.extra.trim()].filter(Boolean).join(', ');
}

/** 人设图是否过期:锚点(选定当时的档)与当前档不符。没有选中项就谈不上过期。 */
export function isPortraitStale(
  entry: Pick<CharPortraitEntry, 'selected'>,
  currentAppearanceTag: string,
): boolean {
  if (!entry.selected) return false;
  return entry.selected.anchorTag.trim() !== currentAppearanceTag.trim();
}

/**
 * 从「已提交的楼层 ops + 解析出的 changes」里挑出要落库的人设图种子(Task 4 的纯接缝)。
 * 只认 kind==='new':变体是建档时的一次性产物,不随 set 变更重算,也不进楼层 delta。
 */
export function collectPortraitSeeds(
  floorOps: readonly CharTagAutoOp[],
  changes: readonly CharChange[],
): CharPortraitSeed[] {
  const seeds: CharPortraitSeed[] = [];
  const seen = new Set<string>();
  for (const op of floorOps) {
    if (op.kind !== 'new') continue;
    const name = cleanText(op.name);
    if (!name || seen.has(name)) continue;
    const change = changes.find(candidate => candidate.field === 'new' && cleanText(candidate.name) === name);
    const variants = normalizeVariants(change?.portraits);
    if (!variants.length) continue;
    seen.add(name);
    seeds.push({ name, variants });
  }
  return seeds;
}

let bound = false;

export function bindCharPortraitSync(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, hydrateCharPortraits);
  hydrateCharPortraits();
}
