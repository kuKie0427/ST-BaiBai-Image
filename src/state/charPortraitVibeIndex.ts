import { deleteVibeData } from '@/backends/vibeStore';
import { charPortraitLib, type CharPortraitVibeRef } from '@/state/charPortraits';
import { globalCharPortraitLib } from '@/state/charPortraitsGlobal';
import { getContext } from '@/st/context';

/**
 * 人设图 vibe 文件的登记表与孤儿清扫。
 *
 * 为什么要登记:人设图条目活在 chatMetadata(随聊天删)与 extensionSettings(全局库),
 * 但 vibe 二进制落在 user/files/IndexedDB,条目消失时文件不会自己走。此前的三个泄漏口:
 * 1. 删除聊天 → chatMetadata 整份消失,插件再也不知道那些 dataPath;
 * 2. 重新选图覆盖 → commitPortrait 每次写新文件,旧 selected 的文件无人再指;
 * 3. 条目清理路径之外的任何元数据丢失。
 * 1、3 只有靠**独立的登记表**(extensionSettings,不随聊天删)才能事后对账。
 *
 * 登记口径:commitPortrait 每次落盘新 vibe 时登记,记下 dataPath 与当时的 chatId。
 * 清扫口径(sweepPortraitVibes,CHAT_CHANGED 时跑):
 * - 仍被全局库或本聊天库引用 → 注销登记(之后的生杀大权交还条目清理路径);
 * - chatId 对得上当前聊天且无引用 → 孤儿,删文件并注销;
 * - 属于其它聊天 → 没有它们的 chatMetadata,无从验证,保留。
 * 删聊天(CHAT_DELETED,新版 ST 才有)→ 该 chatId 的登记项只要不被全局库引用就删。
 *
 * 删除文件永远尽力而为:失败保留登记,下次清扫重试。注册表按 dataPath 去重,
 * 两个库共享同一份 vibe(copyGlobalPortraitToChat)时只占一条登记。
 */

const REGISTRY_KEY = 'baibai_image_char_portrait_vibe_index';

interface PortraitVibeRecord {
  thumbnailPath: string;
  chatId: string;
  at: number;
}

interface PortraitVibeRegistry {
  version: 1;
  files: Record<string, PortraitVibeRecord>;
}

function readRegistry(): PortraitVibeRegistry {
  const raw = getContext()?.extensionSettings?.[REGISTRY_KEY];
  const files: Record<string, PortraitVibeRecord> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const source = (raw as Partial<PortraitVibeRegistry>).files;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      for (const [dataPath, record] of Object.entries(source)) {
        if (!dataPath || !record || typeof record !== 'object' || Array.isArray(record)) continue;
        const value = record as Partial<PortraitVibeRecord>;
        if (typeof value.thumbnailPath !== 'string' || typeof value.chatId !== 'string') continue;
        files[dataPath] = {
          thumbnailPath: value.thumbnailPath,
          chatId: value.chatId,
          at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
        };
      }
    }
  }
  return { version: 1, files };
}

function writeRegistry(registry: PortraitVibeRegistry): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[REGISTRY_KEY] = registry;
  ctx.saveSettingsDebounced?.();
}

function currentChatId(): string | undefined {
  const id = getContext()?.getCurrentChatId?.();
  return typeof id === 'string' && id ? id : undefined;
}

function referencedPaths(): Set<string> {
  const paths = new Set<string>();
  for (const entry of [...globalCharPortraitLib.entries, ...charPortraitLib.entries]) {
    if (entry.selected?.vibe.dataPath) paths.add(entry.selected.vibe.dataPath);
  }
  return paths;
}

export function registerPortraitVibe(vibe: Pick<CharPortraitVibeRef, 'dataPath' | 'thumbnailPath'>): void {
  if (!vibe.dataPath) return;
  const chatId = currentChatId() ?? '';
  const registry = readRegistry();
  const existing = registry.files[vibe.dataPath];
  if (existing && existing.thumbnailPath === vibe.thumbnailPath && existing.chatId === chatId) return;
  registry.files[vibe.dataPath] = { thumbnailPath: vibe.thumbnailPath, chatId, at: Date.now() };
  writeRegistry(registry);
}

let sweeping = false;

/**
 * 清扫当前聊天作用域内可判定的孤儿:
 * - 已被任一库引用 → 注销登记(条目清理路径接管该文件的生死);
 * - 登记归属当前聊天且无引用 → 删文件并注销(覆盖泄漏、本聊天内的元数据丢失);
 * - 其它聊天的登记 → 无从验证,原样保留。
 * 没有打开的聊天(getCurrentChatId 拿不到)时整体跳过,避免误判。
 */
export async function sweepPortraitVibes(): Promise<void> {
  if (sweeping) return;
  const chatId = currentChatId();
  if (!chatId) return;
  sweeping = true;
  try {
    const registry = readRegistry();
    const referenced = referencedPaths();
    const doomed: Array<Pick<CharPortraitVibeRef, 'dataPath' | 'thumbnailPath'>> = [];
    let changed = false;
    for (const [dataPath, record] of Object.entries(registry.files)) {
      if (referenced.has(dataPath)) {
        delete registry.files[dataPath];
        changed = true;
        continue;
      }
      if (record.chatId !== chatId) continue;
      doomed.push({ dataPath, thumbnailPath: record.thumbnailPath });
    }
    if (!doomed.length) {
      if (changed) writeRegistry(registry);
      return;
    }
    for (const vibe of doomed) {
      try {
        await deleteVibeData(vibe);
        delete registry.files[vibe.dataPath];
        changed = true;
      } catch (error) {
        console.warn('[柏宝绘] 孤儿 vibe 文件清理失败,保留登记下次重试', error);
      }
    }
    if (changed) writeRegistry(registry);
  } finally {
    sweeping = false;
  }
}

/**
 * 聊天被删:该 chatId 的登记项不再有任何 chatMetadata 可引用,
 * 只需保住全局库仍在用的文件。旧版 ST 没有该事件时不绑定,交给聊天内清扫兜底。
 */
export async function sweepDeletedChat(chatId: string): Promise<void> {
  if (!chatId) return;
  const registry = readRegistry();
  const globalPaths = new Set(
    globalCharPortraitLib.entries.flatMap(entry => (entry.selected?.vibe.dataPath ? [entry.selected.vibe.dataPath] : [])),
  );
  let changed = false;
  for (const [dataPath, record] of Object.entries(registry.files)) {
    if (record.chatId !== chatId || globalPaths.has(dataPath)) continue;
    try {
      await deleteVibeData({ dataPath, thumbnailPath: record.thumbnailPath });
    } catch (error) {
      console.warn('[柏宝绘] 已删聊天的 vibe 文件清理失败,保留登记下次重试', error);
      continue;
    }
    delete registry.files[dataPath];
    changed = true;
  }
  if (changed) writeRegistry(registry);
}

let bound = false;

export function initPortraitVibeSweep(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => void sweepPortraitVibes());
  const chatDeleted = context.eventTypes?.CHAT_DELETED;
  if (typeof chatDeleted === 'string') {
    context.eventSource.on(chatDeleted, (...args: unknown[]) => {
      const deleted = args.find(arg => typeof arg === 'string');
      if (deleted) void sweepDeletedChat(deleted);
    });
  }
  void sweepPortraitVibes();
}
