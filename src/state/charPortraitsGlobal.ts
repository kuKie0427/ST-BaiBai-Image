import { getContext } from '@/st/context';
import { reactive } from 'vue';
import { deleteVibeData } from '@/backends/vibeStore';
import {
  charPortraitLib,
  clearSelected,
  findCharPortrait,
  normalizeCharPortraitStore,
  removePortrait,
  setGlobalCharPortraitSource,
  setSelected,
  setVariants as setChatVariants,
  type CharPortraitEntry,
  type CharPortraitVibeRef,
} from '@/state/charPortraits';

/**
 * 全局人设图库 —— 跨所有聊天生效的人设图,与全局角色库(globalCharTags)成对。
 *
 * 档案本身进全局库(extensionSettings[GLOBAL_KEY] → 服务器 settings.json,跨设备同步),
 * 但**只有选中项里的 vibe 引用**跟着走:人设图二进制在 user/files,不随 settings 同步,
 * 换设备后 vibe 加载失败按既有「缺编码」路径跳过,不会炸生成。
 *
 * 依赖方向:本模块 → charPortraits(归一化/CRUD/查找);charPortraits → 本模块只经
 * setGlobalCharPortraitSource 注入的只读 getter,不成模块环(与 charTags ↔ globalCharTags 同构)。
 *
 * 孤儿 vibe 文件风险:删除聊天会连 chatMetadata 一起删,本聊天的人设图条目随
 * chatMetadata 整份消失,但 user/files 里的 vibe 正文与缩略图不跟着删。缓解:
 * charPortraitVibeIndex.ts 在每次选图落盘时把 vibe 文件登记进 extensionSettings,
 * 切聊天/删聊天时清扫无引用的登记项(见该模块注释)。全局条目存在 extensionSettings,不受影响。
 */

const GLOBAL_KEY = 'baibai_image_char_portraits_global';
const GLOBAL_EVENT = 'st-baibai-image:char-portrait-global-changed';
const SCHEMA_VERSION = 1;

interface GlobalCharPortraitStore {
  schemaVersion: number;
  revision: number;
  entries: CharPortraitEntry[];
}

export const globalCharPortraitLib = reactive<{ entries: CharPortraitEntry[] }>({ entries: [] });
export const CHAR_PORTRAIT_GLOBAL_KEY = GLOBAL_KEY;
let fingerprint = '';
let revision = 0;
let listenerBound = false;

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function fingerprintOf(entries: CharPortraitEntry[]): string {
  return JSON.stringify(entries);
}

function normalizeEntries(raw: unknown): CharPortraitEntry[] {
  return normalizeCharPortraitStore({ version: 1, entries: raw });
}

function readStore(raw: unknown): GlobalCharPortraitStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const store = raw as Partial<GlobalCharPortraitStore>;
  if (!Array.isArray(store.entries)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    revision:
      typeof store.revision === 'number' && Number.isFinite(store.revision)
        ? Math.max(0, Math.floor(store.revision))
        : 0,
    entries: normalizeEntries(store.entries),
  };
}

function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  revision += 1;
  const store: GlobalCharPortraitStore = {
    schemaVersion: SCHEMA_VERSION,
    revision,
    entries: JSON.parse(JSON.stringify(globalCharPortraitLib.entries)) as CharPortraitEntry[],
  };
  ctx.extensionSettings[GLOBAL_KEY] = store;
  fingerprint = fingerprintOf(store.entries);
  ctx.saveSettingsDebounced?.();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent(GLOBAL_EVENT, {
        detail: { revision: store.revision, source: 'ST-BaiBai-Image' },
      }),
    );
  }
}

function applyStore(store: GlobalCharPortraitStore): void {
  const next = fingerprintOf(store.entries);
  revision = Math.max(revision, store.revision);
  if (next === fingerprint) return;
  globalCharPortraitLib.entries = store.entries;
  fingerprint = next;
}

function bindListener(): void {
  if (listenerBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  listenerBound = true;
  window.addEventListener(GLOBAL_EVENT, () => {
    const store = readStore(getContext()?.extensionSettings?.[GLOBAL_KEY]);
    if (store) applyStore(store);
  });
}

/** 启动初始化:注入条目来源(供 charPortraits.resolveCharPortrait 查全局)并领养已有数据。 */
export function initGlobalCharPortraits(): void {
  setGlobalCharPortraitSource(() => globalCharPortraitLib.entries);
  const store = readStore(getContext()?.extensionSettings?.[GLOBAL_KEY]);
  if (store) applyStore(store);
  bindListener();
}

export function findGlobalPortrait(name: string): CharPortraitEntry | undefined {
  const clean = cleanName(name);
  if (!clean) return undefined;
  return globalCharPortraitLib.entries.find(entry => entry.name === clean);
}

/** 新增/覆盖全局条目。空条目(无名/无变体且无选中/选中缺 vibe)一律拒绝,不落盘。 */
export function setGlobalPortrait(entry: CharPortraitEntry): boolean {
  const [normalized] = normalizeEntries([entry]);
  if (!normalized) return false;
  const index = globalCharPortraitLib.entries.findIndex(candidate => candidate.name === normalized.name);
  if (index >= 0) globalCharPortraitLib.entries[index] = normalized;
  else globalCharPortraitLib.entries.push(normalized);
  persist();
  return true;
}

export function removeGlobalPortrait(name: string): boolean {
  const clean = cleanName(name);
  if (!clean) return false;
  const index = globalCharPortraitLib.entries.findIndex(entry => entry.name === clean);
  if (index < 0) return false;
  globalCharPortraitLib.entries.splice(index, 1);
  persist();
  return true;
}

/**
 * 把本聊天的人设图整条搬进全局库(变体 + 选中项 + vibe 引用),再删掉本聊天副本。
 * 之后任何聊天(含本聊天)都从全局库解析,与 promoteCharTagToGlobal 的语义一致。
 * 文件不搬也不删:全局条目原样引用同一份 vibe 文件。
 */
export function promotePortraitToGlobal(name: string): boolean {
  const chatEntry = findCharPortrait(name);
  if (!chatEntry) return false;
  const snapshot: CharPortraitEntry = {
    name: chatEntry.name,
    variants: chatEntry.variants.map(variant => ({ ...variant })),
    selected: chatEntry.selected
      ? { ...chatEntry.selected, vibe: { ...chatEntry.selected.vibe, modelKeys: [...chatEntry.selected.vibe.modelKeys] } }
      : null,
  };
  if (!setGlobalPortrait(snapshot)) return false;
  removePortrait(chatEntry.name);
  return true;
}

function isVibeReferenced(dataPath: string): boolean {
  const holders = [...globalCharPortraitLib.entries, ...charPortraitLib.entries];
  return holders.some(entry => entry.selected?.vibe.dataPath === dataPath);
}

export interface CleanupPortraitOptions {
  /** true = 连全局条目一起清(删除全局角色);false/省略 = 只清本聊天条目。 */
  global?: boolean;
}

/**
 * 角色删除时的人设图清理(Task 10 由角色页在 removeCharTag / removeGlobalCharTag 后调用)。
 * 删条目必定成功;vibe 二进制尽力删 —— 但若另一个库条目仍引用同一个 dataPath(提升后同名共存、
 * 或用户手工复制出的两份),保留文件,避免删掉别人正在用的 vibe。
 */
/**
 * 从候选 vibe 里删掉已无人引用的文件。引用 = 全局库或本聊天库任一 selected 指向同一
 * dataPath(提升后同名共存、或用户复制出的两份都算),有人用就保留。
 * 文件删除尽力而为:失败只 warn,不阻塞条目层面的清理结果。
 */
async function deleteUnreferencedVibes(candidates: CharPortraitVibeRef[]): Promise<void> {
  for (const vibe of candidates) {
    if (isVibeReferenced(vibe.dataPath)) continue;
    try {
      await deleteVibeData({ dataPath: vibe.dataPath, thumbnailPath: vibe.thumbnailPath });
    } catch (error) {
      console.warn('[柏宝绘] 人设图已删除,但 vibe 文件清理失败(可能在服务器残留)', error);
    }
  }
}

function collectVibeRefs(entries: Array<CharPortraitEntry | undefined>): CharPortraitVibeRef[] {
  const candidates: CharPortraitVibeRef[] = [];
  for (const entry of entries) {
    if (!entry?.selected) continue;
    if (candidates.some(candidate => candidate.dataPath === entry.selected?.vibe.dataPath)) continue;
    candidates.push(entry.selected.vibe);
  }
  return candidates;
}

export async function cleanupPortrait(name: string, opts: CleanupPortraitOptions = {}): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  const chatEntry = findCharPortrait(clean);
  const globalEntry = opts.global ? findGlobalPortrait(clean) : undefined;
  if (!chatEntry && !globalEntry) return false;

  const candidates = collectVibeRefs([chatEntry, globalEntry]);

  if (opts.global) removeGlobalPortrait(clean);
  removePortrait(clean);

  await deleteUnreferencedVibes(candidates);
  return true;
}

/**
 * 单独删除人设图(角色页选图弹窗「删除人设图」):只清选中项,**变体与条目保留**——
 * 与 cleanupPortrait(随角色删除整条)相对,用户随时能用原变体重出一张。
 * 作用域口径与选图一致:chat 只清本聊天选中项;global 清全局选中项
 * (条目无变体残余时连条目一起删,与空条目不落盘的库规约一致)。
 * vibe 文件按引用计数清理,口径同 cleanupPortrait。
 */
export async function removePortraitSelection(name: string, opts: CleanupPortraitOptions = {}): Promise<boolean> {
  const clean = cleanName(name);
  if (!clean) return false;
  const chatEntry = findCharPortrait(clean);
  const globalEntry = opts.global ? findGlobalPortrait(clean) : undefined;
  if (!chatEntry?.selected && !globalEntry?.selected) return false;

  const candidates = collectVibeRefs([chatEntry, globalEntry]);

  if (globalEntry?.selected) {
    if (globalEntry.variants.length) {
      setGlobalPortrait({
        name: globalEntry.name,
        variants: globalEntry.variants.map(variant => ({ ...variant })),
        selected: null,
      });
    } else {
      removeGlobalPortrait(globalEntry.name);
    }
  }
  if (chatEntry?.selected) clearSelected(clean);

  await deleteUnreferencedVibes(candidates);
  return true;
}

/**
 * 全局库反向出口:把全局条目复制成本聊天副本(之后本聊天可独立改),与 copyGlobalCharTagToChat 对称。
 * 只复制元数据与引用,vibe 文件共享 —— 之后任一库删除时靠 isVibeReferenced 保住文件。
 */
export function copyGlobalPortraitToChat(name: string): boolean {
  const global = findGlobalPortrait(name);
  if (!global) return false;
  if (!global.variants.length && !global.selected) return false;
  if (global.variants.length) setChatVariants(global.name, global.variants.map(variant => ({ ...variant })));
  if (global.selected) {
    const { vibe, ...rest } = global.selected;
    setSelected(global.name, { ...rest, vibe: { ...vibe, modelKeys: [...vibe.modelKeys] } });
  }
  return true;
}
