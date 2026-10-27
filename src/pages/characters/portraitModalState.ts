import { reactive } from 'vue';

import { requestCompletion, requestViaMainApi, type ChatMsg } from '@/api/client';
import type { PortraitVariant } from '@/autoTag/protocol';
import {
  commitPortrait,
  generatePortraitCandidates,
  type PortraitCandidate,
} from '@/backends/charPortraitVibe';
import { composePortraitPrompt, type CharPortraitSelected } from '@/state/charPortraits';
import { getTagGenChannel } from '@/state/settings';
import { getContext } from '@/st/context';
import type { BackendStatus } from '@/generate';

/**
 * 人设图选图弹窗的**模块级**运行态(仿 floor/tagPlanState.ts / floor/genState.ts)。
 *
 * 为什么不能放在组件里:弹窗说关就关,而一次候选生成是 3 条串行 NAI 请求(每条几十秒)。
 * 把候选、在途任务、AbortController 全塞进组件 ref,用户随手点遮罩关窗就全丢了——
 * 请求还在耗额度、图却再也找不回来。运行态放这里,组件退化成纯展示层:
 * 关窗只是不渲染,任务照跑;重开时按角色名认领回「生成到第几张 / 已出哪几张」。
 *
 * 为什么按角色名分会话:弹窗一次只服务一个角色,但用户可能来回切换角色看进度。
 * 会话键 = 角色名(人设图库的主键)。切换聊天时整存清空(见 ensureBound)。
 *
 * 三个口径值得记住:
 *
 * 1. **串行是纪律,不是巧合**。generatePortraitCandidates 内部逐张出图,共用 genQueue
 *    的 NAI 槽位;本模块把「生成 3 张」拆成 3 次**单变体**调用并挂在同一条 Promise 链上,
 *    同一角色的任何两张图都不会同时在飞(取消 / 重绘 / 批量生成共用这一条链)。
 *    这样每个槽位有自己的 AbortController,「取消这一张」不会误杀另外两张。
 *    代价是没直接用服务层的多变体入口,但服务层本来也只是它的循环封装,提示词、
 *    种子、闸门、串行口径全部原样复用。
 *
 * 2. **未选定不入库**。候选只活在本 store 的内存里;只有「使用这张」会调
 *    commitPortrait 写 charPortraits(编码 vibe + 落盘)。关窗、切页都不会偷偷保存。
 *
 * 3. **提示词改动不销毁已有候选**。手改 extra / AI 重写后,旧候选仍可选中——
 *    它自带出图时的 prompt 与 seed,入库记录与图一致;卡片上给「提示词已改」角标,
 *    提示重绘才会按新提示词出图(与楼层卡片的 stale 口径同思路)。
 */

/** 候选槽位数(与 autoTag 协议、服务层 CANDIDATE_LIMIT 一致)。 */
export const PORTRAIT_SLOT_COUNT = 3;

/**
 * 内置兜底三拍:AI 没给变体(旧聊天 / 协议漏字段 / 手动建档)时也要能点「生成 3 张候选」。
 * 变体只是便利,不是前置条件。三条的 extra 里刻意不含任何固定外貌 tag。
 */
export const DEFAULT_PORTRAIT_VARIANTS: readonly PortraitVariant[] = [
  {
    extra: 'school uniform, standing, full body, simple background',
    nl: 'A full-body portrait of the character standing in a school uniform against a simple background.',
  },
  {
    extra: 'casual clothes, sitting, cafe, smile',
    nl: 'The character sits in a cafe wearing casual clothes and smiles.',
  },
  {
    extra: 'coat, night street, upper body, looking back',
    nl: 'The character looks back over a shoulder on a night street, wearing a coat.',
  },
];

export type PortraitSlotPhase = 'idle' | 'queued' | 'generating' | 'ready' | 'error';

export interface PortraitSlotState {
  /** 0-based 槽位号(展示为「方案 1/2/3」)。 */
  index: number;
  /** 变体 extra(服装/构图/表情/背景 tag),唯一可编辑部分。 */
  extra: string;
  /** 变体自然语言描述,随出图一并发送。 */
  nl: string;
  /** 用户手改过 extra:重开弹窗不再被新变体覆盖。 */
  dirty: boolean;
  /** 是否展开编辑区(展示态,随会话保留)。 */
  editing: boolean;
  phase: PortraitSlotPhase;
  candidate: PortraitCandidate | null;
  /** 本槽位最近一次失败原因;phase='error' 时有值。 */
  error: string;
  /** AI 重写提示词在途。 */
  rewriting: boolean;
  /** AI 重写失败原因(内联展示)。 */
  rewriteError: string;
}

export interface PortraitSessionState {
  name: string;
  /** 打开弹窗当时的外观 tag(选定人设图时作为 anchorTag 落库)。 */
  appearanceTag: string;
  slots: PortraitSlotState[];
  /** 正在「使用这张」的槽位;null = 空闲。 */
  committing: number | null;
}

export interface OpenPortraitSessionInput {
  name: string;
  appearanceTag: string;
  variants: readonly PortraitVariant[];
}

export interface PortraitGate {
  enabled: boolean;
  hint: string;
}

/** 会话表:角色名 → 会话。reactive 保证组件 computed 能跟着变。 */
const sessions = reactive(new Map<string, PortraitSessionState>());
/** AbortController 不进 reactive:不是展示数据。key 与链同构:name\0index。 */
const controllers = new Map<string, AbortController>();
/** 每角色一条串行链:所有槽位任务排队,同角色永不并发出图。 */
const chains = new Map<string, Promise<void>>();

function jobKey(name: string, index: number): string {
  return `${name}\u0000${index}`;
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * 把任意变体列表补齐成恰好 3 条:能用的先用(去空、去多余空白),不够的用内置三拍补位。
 * 纯函数,弹窗初始态与 AI 建档后的刷新共用。
 */
export function seedPortraitVariants(variants: readonly PortraitVariant[]): PortraitVariant[] {
  const out: PortraitVariant[] = [];
  for (const item of variants) {
    const extra = cleanText(item.extra);
    if (!extra) continue;
    out.push({ extra, nl: cleanText(item.nl) });
    if (out.length >= PORTRAIT_SLOT_COUNT) break;
  }
  for (let index = out.length; index < PORTRAIT_SLOT_COUNT; index++) {
    const fallback = DEFAULT_PORTRAIT_VARIANTS[index] ?? DEFAULT_PORTRAIT_VARIANTS[0];
    out.push({ extra: fallback.extra, nl: fallback.nl });
  }
  return out;
}

/** 建一个空会话(无在途任务)。纯函数。 */
export function createPortraitSession(
  name: string,
  appearanceTag: string,
  variants: readonly PortraitVariant[],
): PortraitSessionState {
  const seeded = seedPortraitVariants(variants);
  return {
    name: cleanText(name),
    appearanceTag: appearanceTag.trim(),
    slots: seeded.map((variant, index) => ({
      index,
      extra: variant.extra,
      nl: variant.nl,
      dirty: false,
      // 还没出过图时默认展开编辑区:先让用户看清/改 extra,再点生成
      editing: true,
      phase: 'idle',
      candidate: null,
      error: '',
      rewriting: false,
      rewriteError: '',
    })),
    committing: null,
  };
}

/**
 * 重开弹窗时同步:外观 tag 永远取最新(锚点要按当前档算);
 * 变体只回填「没有候选、没有在途任务、用户没手改过」的槽位——
 * 已出的候选带着自己的 prompt,拿新变体覆盖 extra 只会让图与文字对不上。
 */
export function syncPortraitSession(
  session: PortraitSessionState,
  appearanceTag: string,
  variants: readonly PortraitVariant[],
): void {
  session.appearanceTag = appearanceTag.trim();
  const seeded = seedPortraitVariants(variants);
  session.slots.forEach((slot, index) => {
    if (slot.dirty || slot.candidate || slot.rewriting) return;
    if (slot.phase !== 'idle' && slot.phase !== 'ready') return;
    const next = seeded[index];
    if (!next) return;
    slot.extra = next.extra;
    slot.nl = next.nl;
  });
}

/** 槽位的完整提示词(外观逐字 + extra),与真正发出的请求同源。纯函数。 */
export function slotComposedPrompt(appearanceTag: string, slot: Pick<PortraitSlotState, 'extra' | 'nl'>): string {
  return composePortraitPrompt(appearanceTag, { extra: slot.extra, nl: slot.nl });
}

export function isSlotPromptStale(
  appearanceTag: string,
  slot: Pick<PortraitSlotState, 'extra' | 'nl' | 'candidate'>,
): boolean {
  if (!slot.candidate) return false;
  return slotComposedPrompt(appearanceTag, slot) !== slot.candidate.prompt;
}

/**
 * 后端闸门:人设图参考 v1 只支持 NAI(ComfyUI 的角色 vibe 注入尚未接入)。
 * 纯函数,组件只负责展示。已配齐的 NAI 才真正可点。
 */
export function portraitBackendGate(
  status: Pick<BackendStatus, 'backend' | 'configured' | 'reason'>,
): PortraitGate {
  if (status.backend !== 'nai') {
    return { enabled: false, hint: '人设图参考目前仅支持 NovelAI 渠道' };
  }
  if (!status.configured) {
    return { enabled: false, hint: status.reason || 'NovelAI 渠道尚未配置' };
  }
  return { enabled: true, hint: '' };
}

function normalizeFragment(text: string): string {
  return text.trim().toLowerCase().replace(/[\s_]+/g, ' ');
}

/**
 * 清洗 AI 重写返回的变体 tag:去 Markdown 围栏/引号/「extra:」前缀,只取第一行,
 * 并**丢掉与固定外貌逐字重复的片段**——外貌由插件拼在变体前,模型再抄一遍会让同一套
 * 外貌在提示词里出现两次(两处措辞稍有出入就互相打架)。纯函数。
 */
export function sanitizePortraitExtra(raw: string, appearanceTag: string): string {
  const unfenced = raw.replace(/```[a-zA-Z]*/g, ' ').replace(/```/g, ' ');
  const firstLine = unfenced
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => Boolean(line)) ?? '';
  const body = firstLine.replace(/^(?:extra|tags?|prompt|变体|提示词)\s*[:：]\s*/i, '');
  const appearance = new Set(
    appearanceTag
      .split(',')
      .map(normalizeFragment)
      .filter(Boolean),
  );
  const kept: string[] = [];
  for (const fragment of body.split(',')) {
    const cleaned = fragment
      .trim()
      .replace(/^[-*]\s*/, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    if (!cleaned) continue;
    if (appearance.has(normalizeFragment(cleaned))) continue;
    kept.push(cleaned);
  }
  return kept.join(', ');
}

export interface PortraitRewriteInput {
  appearanceTag: string;
  extra: string;
  nl: string;
}

const REWRITE_SYSTEM = [
  '你在重写一张角色人设图的提示词变体。',
  '固定外貌由插件逐字拼在变体之前，**不得修改、不得重复**：不要输出 sex/hair/eyes/skin/body/fandom 这类外貌 tag。',
  '只重写这一张图的服装、构图、表情、背景 danbooru 短 tag：英文、逗号分隔、单行。',
  '只输出 tag 本身：不要解释、不要引号、不要 Markdown、不要 JSON。',
].join('\n');

/**
 * 「AI 重写」的一次性请求消息(参照楼层重写的口径,压到最小):
 * 把固定的外观约束原样喂给模型,只让它改 extra。纯函数,便于锁文案。
 */
export function buildPortraitRewriteMessages(input: PortraitRewriteInput): ChatMsg[] {
  const appearance = input.appearanceTag.trim() || '(未设置)';
  const extra = input.extra.trim() || '(空)';
  const nl = input.nl.trim();
  return [
    { role: 'system', content: REWRITE_SYSTEM },
    {
      role: 'user',
      content: [
        `固定外貌（插件逐字拼在变体之前，只读，不得重复）：${appearance}`,
        `当前变体 tag：${extra}`,
        nl ? `画面描述：${nl}` : '',
        '请重写这一张人设图的变体 tag：只调整服装、构图、表情、背景，保持外貌约束不变，输出单行英文 danbooru tag。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

function ensureSession(name: string): PortraitSessionState | undefined {
  return sessions.get(cleanText(name));
}

/** 打开/续上某个角色的会话。已存在则同步外观与未动过的变体,在途任务原样保留。 */
export function openPortraitSession(input: OpenPortraitSessionInput): PortraitSessionState {
  ensureBound();
  const name = cleanText(input.name);
  const existing = ensureSession(name);
  if (existing) {
    syncPortraitSession(existing, input.appearanceTag, input.variants);
    return existing;
  }
  sessions.set(name, createPortraitSession(name, input.appearanceTag, input.variants));
  // 回 reactive Map 里那一份(代理),store 与组件才是同一个对象
  const created = sessions.get(name);
  if (!created) throw new Error('人设图会话创建失败');
  return created;
}

/** 组件按角色名取会话(响应式)。 */
export function getPortraitSession(name: string): PortraitSessionState | undefined {
  return ensureSession(name);
}

/** 手改 extra:标记 dirty,重开弹窗不再被库里的变体覆盖。 */
export function setSlotExtra(name: string, index: number, extra: string): void {
  const slot = ensureSession(name)?.slots[index];
  if (!slot) return;
  slot.extra = extra;
  slot.dirty = true;
  slot.rewriteError = '';
}

/** 展开/收起编辑区。 */
export function setSlotEditing(name: string, index: number, editing: boolean): void {
  const slot = ensureSession(name)?.slots[index];
  if (!slot) return;
  slot.editing = editing;
}

async function executeSlot(
  session: PortraitSessionState,
  slot: PortraitSlotState,
  controller: AbortController,
): Promise<void> {
  const key = jobKey(session.name, slot.index);
  try {
    if (controller.signal.aborted) {
      slot.phase = 'idle';
      return;
    }
    const variant: PortraitVariant = { extra: cleanText(slot.extra), nl: cleanText(slot.nl) };
    if (!variant.extra) {
      slot.phase = 'error';
      slot.error = '提示词不能为空';
      return;
    }
    slot.phase = 'generating';
    slot.error = '';
    // 单变体临时条目:复用服务层的提示词组装 / 种子 / 闸门 / 串行口径
    const entry = { name: session.name, variants: [variant], selected: null };
    const candidates = await generatePortraitCandidates(entry, session.appearanceTag, controller.signal);
    const candidate = candidates[0];
    if (!candidate) {
      if (!controller.signal.aborted) {
        slot.phase = 'error';
        slot.error = '没有出图,请重试';
      }
      return;
    }
    // 单变体调用返回的 variantIndex 恒为 0,这里换回真实槽位号
    slot.candidate = { ...candidate, variantIndex: slot.index };
    slot.phase = 'ready';
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      slot.phase = 'idle';
      return;
    }
    slot.phase = 'error';
    slot.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}

/**
 * 生成/重绘单个槽位:挂到该角色的串行链上。同槽位已有在途任务时返回 false(后点不叠加)。
 * 返回 true 只表示已入队,完成与否看 slot.phase。
 */
export function generateSlot(name: string, index: number): boolean {
  const session = ensureSession(name);
  const slot = session?.slots[index];
  if (!session || !slot) return false;
  const key = jobKey(session.name, index);
  if (controllers.has(key)) return false;
  const controller = new AbortController();
  controllers.set(key, controller);
  slot.phase = 'queued';
  slot.error = '';
  const run = () => executeSlot(session, slot, controller);
  const previous = chains.get(session.name) ?? Promise.resolve();
  // 前一个任务无论成败都要接着跑下一个:用 then(run, run) 而不是 finally
  const job = previous.then(run, run);
  chains.set(session.name, job.catch(() => {}));
  return true;
}

/** 「生成 3 张候选」:只补空缺与失败项,已有候选的槽位原样保留(批量不该毁掉满意的那张)。 */
export function generateAll(name: string): void {
  const session = ensureSession(name);
  if (!session) return;
  for (const slot of session.slots) {
    if (slot.candidate) continue;
    generateSlot(session.name, slot.index);
  }
}

/** 取消单个槽位:在途的 abort,排队中的立即停表(链上轮到时直接跳过)。 */
export function cancelSlot(name: string, index: number): void {
  const session = ensureSession(name);
  const slot = session?.slots[index];
  if (!session || !slot) return;
  const controller = controllers.get(jobKey(session.name, index));
  controller?.abort();
  if (slot.phase === 'queued' || slot.phase === 'generating') slot.phase = 'idle';
}

/**
 * 取消单个槽位的「AI 重写」。重写与出图共用同一把每槽位控制器:
 * 同一时刻一个槽位只允许一个任务,简单且不会有两套取消语义互相踩。
 */
export function cancelRewrite(name: string, index: number): void {
  ensureSession(name);
  controllers.get(jobKey(cleanText(name), index))?.abort();
}

/**
 * 「使用这张」:选中即落库(编码 vibe + 缩略图 + setSelected 在服务层完成)。
 *
 * 失败(服务层已 toastr)返回 null 并**保持会话原样**,弹窗由调用方留着让用户重选/重试。
 * 成功则由调用方关闭弹窗并刷新角色页;成功提示放这里——服务层只负责失败提示。
 */
export async function commitSlot(name: string, index: number): Promise<CharPortraitSelected | null> {
  const session = ensureSession(name);
  const slot = session?.slots[index];
  if (!session || !slot || !slot.candidate) return null;
  if (session.committing !== null) return null;
  if (slot.phase === 'queued' || slot.phase === 'generating') return null;
  if (controllers.has(jobKey(session.name, index))) return null;
  session.committing = index;
  try {
    const selected = await commitPortrait({
      name: session.name,
      appearanceTag: session.appearanceTag,
      dataUrl: slot.candidate.dataUrl,
      prompt: slot.candidate.prompt,
      seed: slot.candidate.seed,
    });
    if (selected) toastr.success(`「${session.name}」人设图已更新,后续配图会参考这张图`, '人设图');
    return selected;
  } finally {
    session.committing = null;
  }
}

/**
 * AI 重写某槽位的变体 extra(只改 extra,外貌约束在消息里钉死)。
 * 走与自动 tag 相同的渠道口径:指派渠道优先,未指派跟随主 API。返回是否真的写回了新 tag。
 */
export async function rewriteSlot(name: string, index: number): Promise<boolean> {
  const session = ensureSession(name);
  const slot = session?.slots[index];
  if (!session || !slot || slot.rewriting) return false;
  const key = jobKey(session.name, index);
  if (controllers.has(key)) return false;
  const controller = new AbortController();
  controllers.set(key, controller);
  slot.rewriting = true;
  slot.rewriteError = '';
  try {
    const messages = buildPortraitRewriteMessages({
      appearanceTag: session.appearanceTag,
      extra: slot.extra,
      nl: slot.nl,
    });
    const channel = getTagGenChannel();
    const raw = channel
      ? await requestCompletion(channel, messages, {
          signal: controller.signal,
          source: '人设图提示词重写',
        })
      : await requestViaMainApi(messages, {
          signal: controller.signal,
          source: '人设图提示词重写',
        });
    if (controller.signal.aborted) return false;
    const next = sanitizePortraitExtra(raw, session.appearanceTag);
    if (!next) {
      slot.rewriteError = '模型没有返回可用的 tag,可再试一次';
      return false;
    }
    slot.extra = next;
    slot.dirty = true;
    slot.editing = true;
    return true;
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) return false;
    slot.rewriteError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    if (controllers.get(key) === controller) controllers.delete(key);
    slot.rewriting = false;
  }
}

/** 切聊天/卸载时的全量清理:中止所有在途任务,丢弃全部候选。 */
export function resetPortraitModalState(): void {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  chains.clear();
  sessions.clear();
}

let bound = false;

function ensureBound(): void {
  if (bound) return;
  const context = getContext();
  if (!context?.eventSource || !context.eventTypes?.CHAT_CHANGED) return;
  bound = true;
  // 切聊天后人设图库已换一份,旧候选既不属于新聊天、也不能再被选定(选定会写错库)
  context.eventSource.on(context.eventTypes.CHAT_CHANGED, resetPortraitModalState);
}
