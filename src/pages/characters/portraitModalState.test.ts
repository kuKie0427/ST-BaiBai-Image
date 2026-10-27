import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PortraitCandidate } from '@/backends/charPortraitVibe';

/**
 * 人设图弹窗 store 的纯逻辑测试(本组件没有专门的重型 DOM 测试基座,
 * 运行态与规则全压在这里,组件只做展示)。
 *
 * 覆盖面:
 * - 变体补齐(空档用内置三拍,永远凑够 3 条)
 * - 后端闸门文案(非 NAI / NAI 未配置 / 就绪)
 * - AI 重写返回值的清洗(去围栏/前缀/重复外貌 tag)
 * - 串行纪律:同角色的两次出图不会同时在飞;单槽取消不误杀别的槽
 * - 关窗不取消(store 不随组件卸载),重开时外观/变体同步但不覆盖已有候选
 * - 「使用这张」失败保持原样、成功回调拿到选中项
 */

vi.mock('@/backends/charPortraitVibe', () => ({
  generatePortraitCandidates: vi.fn(),
  commitPortrait: vi.fn(),
}));
vi.mock('@/api/client', () => ({
  requestCompletion: vi.fn(),
  requestViaMainApi: vi.fn(),
}));
vi.mock('@/state/settings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/state/settings')>()),
  getTagGenChannel: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => null }));

import { commitPortrait, generatePortraitCandidates } from '@/backends/charPortraitVibe';
import { requestCompletion, requestViaMainApi } from '@/api/client';
import { getTagGenChannel } from '@/state/settings';

import {
  DEFAULT_PORTRAIT_VARIANTS,
  PORTRAIT_SLOT_COUNT,
  buildPortraitRewriteMessages,
  cancelSlot,
  commitSlot,
  createPortraitSession,
  generateAll,
  generateSlot,
  getPortraitSession,
  openPortraitSession,
  portraitBackendGate,
  resetPortraitModalState,
  rewriteSlot,
  sanitizePortraitExtra,
  seedPortraitVariants,
  setSlotExtra,
  isSlotPromptStale,
  slotComposedPrompt,
  syncPortraitSession,
  type PortraitSessionState,
} from './portraitModalState';

const toastrMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn() }));

function candidate(prompt: string, seed = 1, variantIndex = 0): PortraitCandidate {
  return { dataUrl: `data:image/png;base64,${seed}`, prompt, seed, variantIndex };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('toastr', toastrMock);
  resetPortraitModalState();
  vi.mocked(commitPortrait).mockResolvedValue({
    prompt: 'silver hair, standing',
    seed: 1,
    anchorTag: 'silver hair',
    thumb: 'data:image/jpeg;base64,T',
    vibe: { dataPath: 'f', thumbnailPath: '', modelKeys: ['m'], fingerprint: 'fp' },
  });
});

afterEach(() => {
  resetPortraitModalState();
  vi.unstubAllGlobals();
});

describe('seedPortraitVariants', () => {
  it('空变体用内置三拍补齐,永远凑够 3 条', () => {
    const seeded = seedPortraitVariants([]);
    expect(seeded).toHaveLength(PORTRAIT_SLOT_COUNT);
    expect(seeded.map(v => v.extra)).toEqual(DEFAULT_PORTRAIT_VARIANTS.map(v => v.extra));
  });

  it('已有 1~2 条时按顺序保留,缺位仍补内置', () => {
    const seeded = seedPortraitVariants([
      { extra: '  school uniform,  standing ', nl: ' A girl stands. ' },
      { extra: '   ', nl: '空 extra 丢弃' },
    ]);
    expect(seeded.map(v => v.extra)).toEqual([
      'school uniform, standing',
      DEFAULT_PORTRAIT_VARIANTS[1].extra,
      DEFAULT_PORTRAIT_VARIANTS[2].extra,
    ]);
    expect(seeded[0].nl).toBe('A girl stands.');
  });

  it('超过 3 条截断;空白字符被压平', () => {
    const seeded = seedPortraitVariants(
      [1, 2, 3, 4].map(index => ({ extra: `extra ${index}`, nl: `nl  ${index}` })),
    );
    expect(seeded).toHaveLength(PORTRAIT_SLOT_COUNT);
    expect(seeded[2]).toEqual({ extra: 'extra 3', nl: 'nl 3' });
  });
});

describe('portraitBackendGate', () => {
  it('非 NAI 渠道禁用并给出提示', () => {
    const gate = portraitBackendGate({ backend: 'comfyui', configured: true, reason: '' });
    expect(gate.enabled).toBe(false);
    expect(gate.hint).toBe('人设图参考目前仅支持 NovelAI 渠道');
  });

  it('NAI 未配置时禁用并复用后端原因', () => {
    const gate = portraitBackendGate({ backend: 'nai', configured: false, reason: '当前 NAI 接入点未填写 API Key' });
    expect(gate.enabled).toBe(false);
    expect(gate.hint).toContain('API Key');
  });

  it('NAI 就绪时可用', () => {
    expect(portraitBackendGate({ backend: 'nai', configured: true, reason: '' })).toEqual({ enabled: true, hint: '' });
  });
});

describe('sanitizePortraitExtra', () => {
  const appearance = 'long silver hair, red eyes, 1girl';

  it('剥掉围栏/引号/前缀,只取第一行', () => {
    expect(sanitizePortraitExtra('```\nextra: school uniform, standing\nnoise line\n```', appearance)).toBe(
      'school uniform, standing',
    );
    expect(sanitizePortraitExtra('  "casual clothes, sitting"  ', appearance)).toBe('casual clothes, sitting');
  });

  it('丢掉与固定外貌逐字重复的片段(含下划线/大小写/多空格差异)', () => {
    expect(
      sanitizePortraitExtra('Long_Silver_Hair,  school uniform , red   eyes, standing', appearance),
    ).toBe('school uniform, standing');
  });

  it('空响应回空串', () => {
    expect(sanitizePortraitExtra('   \n ', appearance)).toBe('');
    expect(sanitizePortraitExtra('```', appearance)).toBe('');
  });
});

describe('buildPortraitRewriteMessages', () => {
  it('外观约束原样喂给模型,并要求只输出单行 tag', () => {
    const [system, user] = buildPortraitRewriteMessages({
      appearanceTag: 'long silver hair, red eyes',
      extra: 'school uniform, standing',
      nl: 'A girl stands.',
    });
    expect(system.content).toContain('只重写这一张图的服装、构图、表情、背景');
    expect(user.content).toContain('long silver hair, red eyes');
    expect(user.content).toContain('school uniform, standing');
    expect(user.content).toContain('A girl stands.');
    expect(user.content).toContain('单行');
  });
});

describe('isSlotPromptStale', () => {
  it('没有候选就不算旧;出图后改了 extra 才算旧', () => {
    const session = createPortraitSession('阿黛尔', 'silver hair', []);
    const slot = session.slots[0];
    expect(isSlotPromptStale('silver hair', slot)).toBe(false);
    slot.candidate = candidate(slotComposedPrompt('silver hair', slot), 1);
    expect(isSlotPromptStale('silver hair', slot)).toBe(false);
    slot.extra = 'casual clothes';
    expect(isSlotPromptStale('silver hair', slot)).toBe(true);
    expect(isSlotPromptStale('silver hair, red eyes', slot)).toBe(true);
  });
});

describe('session lifecycle', () => {
  it('打开会话时用变体建 3 个槽位,空变体走内置三拍', () => {
    const session = openPortraitSession({ name: ' 阿黛尔 ', appearanceTag: 'silver hair', variants: [] });
    expect(getPortraitSession('阿黛尔')).toBe(session);
    expect(session.slots).toHaveLength(3);
    expect(session.slots.map(slot => slot.phase)).toEqual(['idle', 'idle', 'idle']);
    expect(session.slots.every(slot => slot.editing)).toBe(true);
  });

  it('重开时同步外观,但已有候选/手改过的槽位不被新变体覆盖', () => {
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'old', variants: [] });
    session.slots[0].candidate = candidate('silver hair, old prompt', 7);
    session.slots[0].phase = 'ready';
    setSlotExtra('阿黛尔', 1, '我的自定义 outfit');

    openPortraitSession({
      name: '阿黛尔',
      appearanceTag: 'new appearance',
      variants: [
        { extra: 'v1', nl: '' },
        { extra: 'v2', nl: '' },
        { extra: 'v3', nl: '' },
      ],
    });

    expect(session.appearanceTag).toBe('new appearance');
    // 有候选 → 保留原 extra(图与文字必须对得上)
    expect(session.slots[0].extra).toBe(DEFAULT_PORTRAIT_VARIANTS[0].extra);
    // 手改过 → 保留用户输入
    expect(session.slots[1].extra).toBe('我的自定义 outfit');
    // 空槽位 → 跟随新变体
    expect(session.slots[2].extra).toBe('v3');
  });

  it('syncPortraitSession 不覆盖在途任务槽位', () => {
    const session = createPortraitSession('阿黛尔', 'a', []);
    session.slots[0].phase = 'generating';
    syncPortraitSession(session, 'b', [{ extra: 'new', nl: '' }]);
    expect(session.slots[0].extra).toBe(DEFAULT_PORTRAIT_VARIANTS[0].extra);
    expect(session.slots[1].extra).toBe(DEFAULT_PORTRAIT_VARIANTS[1].extra);
  });
});

describe('generateSlot', () => {
  it('同一角色的两次出图严格串行(后一张等前一张收尾)', async () => {
    let active = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    vi.mocked(generatePortraitCandidates).mockImplementation(async entry => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => resolvers.push(resolve));
      active--;
      return [candidate(`${entry.name}:${entry.variants[0].extra}`, 1)];
    });

    openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair', variants: [] });
    expect(generateSlot('阿黛尔', 0)).toBe(true);
    expect(generateSlot('阿黛尔', 1)).toBe(true);
    expect(generateSlot('阿黛尔', 2)).toBe(true);

    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.shift()?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers.shift()?.();

    const session = getPortraitSession('阿黛尔')!;
    await vi.waitFor(() => expect(session.slots.every(slot => slot.phase === 'ready')).toBe(true));
    expect(maxActive).toBe(1);
    expect(session.slots.map(slot => slot.candidate?.variantIndex)).toEqual([0, 1, 2]);
  });

  it('单变体调用的 variantIndex=0 会换回真实槽位号,提示词=外观逐字+extra', async () => {
    vi.mocked(generatePortraitCandidates).mockResolvedValue([candidate('p', 5)]);
    openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair, red eyes', variants: [] });
    setSlotExtra('阿黛尔', 1, 'cafe, sitting');

    generateSlot('阿黛尔', 1);
    const session = getPortraitSession('阿黛尔')!;
    await vi.waitFor(() => expect(session.slots[1].phase).toBe('ready'));

    const [entry, appearanceTag] = vi.mocked(generatePortraitCandidates).mock.calls[0];
    expect(entry.variants).toEqual([{ extra: 'cafe, sitting', nl: DEFAULT_PORTRAIT_VARIANTS[1].nl }]);
    expect(appearanceTag).toBe('silver hair, red eyes');
    expect(session.slots[1].candidate?.variantIndex).toBe(1);
    expect(slotComposedPrompt('silver hair, red eyes', session.slots[1])).toBe('silver hair, red eyes, cafe, sitting');
  });

  it('取消单槽只中止它自己,后续排队任务照常跑', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(generatePortraitCandidates).mockImplementation(async (_entry, _tag, signal) => {
      if (signal) signals.push(signal);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return [candidate('p', 1)];
    });

    openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    generateSlot('阿黛尔', 0);
    generateSlot('阿黛尔', 1);

    cancelSlot('阿黛尔', 0);
    const session = getPortraitSession('阿黛尔')!;
    await vi.waitFor(() => expect(session.slots[1].phase).toBe('ready'));
    expect(session.slots[0].candidate).toBeNull();
    expect(session.slots[0].phase).toBe('idle');
  });

  it('空 extra 不发出图请求,直接报可读错误', async () => {
    openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    setSlotExtra('阿黛尔', 0, '   ');
    generateSlot('阿黛尔', 0);
    const session = getPortraitSession('阿黛尔')!;
    await vi.waitFor(() => expect(session.slots[0].phase).toBe('error'));
    expect(session.slots[0].error).toBe('提示词不能为空');
    expect(generatePortraitCandidates).not.toHaveBeenCalled();
  });

  it('generateAll 只补空缺,不覆盖已有候选', () => {
    vi.mocked(generatePortraitCandidates).mockResolvedValue([candidate('p', 1)]);
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    session.slots[0].candidate = candidate('keep me', 3);
    session.slots[0].phase = 'ready';

    generateAll('阿黛尔');
    expect(session.slots[0].phase).toBe('ready');
    expect(session.slots[0].candidate?.prompt).toBe('keep me');
    expect(session.slots[1].phase).toBe('queued');
    expect(session.slots[2].phase).toBe('queued');
  });
});

describe('rewriteSlot', () => {
  it('走指派渠道重写,清洗后写回 extra 并标 dirty', async () => {
    vi.mocked(getTagGenChannel).mockReturnValue({
      id: 'c1',
      name: 'x',
      url: 'https://x',
      key: 'k',
      model: 'm',
      timeoutSec: 180,
      stream: false,
      excludeParams: [],
      reasoningEffort: '',
    } as never);
    vi.mocked(requestCompletion).mockResolvedValue('```\nextra: cafe, sitting, smile\n```');

    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair', variants: [] });
    const ok = await rewriteSlot('阿黛尔', 1);

    expect(ok).toBe(true);
    expect(session.slots[1].extra).toBe('cafe, sitting, smile');
    expect(session.slots[1].dirty).toBe(true);
    expect(session.slots[1].rewriting).toBe(false);
    expect(requestViaMainApi).not.toHaveBeenCalled();
  });

  it('未指派渠道时跟随主 API;失败保留原文并给内联错误', async () => {
    vi.mocked(getTagGenChannel).mockReturnValue(null);
    vi.mocked(requestViaMainApi).mockRejectedValue(new Error('模型超时'));

    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair', variants: [] });
    const before = session.slots[0].extra;
    await expect(rewriteSlot('阿黛尔', 0)).resolves.toBe(false);

    expect(requestViaMainApi).toHaveBeenCalledTimes(1);
    expect(session.slots[0].extra).toBe(before);
    expect(session.slots[0].rewriteError).toBe('模型超时');
    expect(session.slots[0].rewriting).toBe(false);
  });

  it('模型回空 → 不改写,给出提示而非写入空串', async () => {
    vi.mocked(getTagGenChannel).mockReturnValue(null);
    vi.mocked(requestViaMainApi).mockResolvedValue('   ');
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair', variants: [] });
    const before = session.slots[0].extra;

    await expect(rewriteSlot('阿黛尔', 0)).resolves.toBe(false);
    expect(session.slots[0].extra).toBe(before);
    expect(session.slots[0].rewriteError).toContain('没有返回可用的 tag');
  });
});

describe('commitSlot', () => {
  it('成功:调服务层、toastr.success,返回选中项', async () => {
    vi.mocked(generatePortraitCandidates).mockResolvedValue([candidate('silver hair, standing', 9)]);
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'silver hair', variants: [] });
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(session.slots[0].phase).toBe('ready'));
    session.committing = null;

    const selected = await commitSlot('阿黛尔', 0);
    expect(selected?.seed).toBe(1);
    expect(commitPortrait).toHaveBeenCalledWith({
      name: '阿黛尔',
      appearanceTag: 'silver hair',
      dataUrl: 'data:image/png;base64,9',
      prompt: 'silver hair, standing',
      seed: 9,
    });
    expect(toastrMock.success).toHaveBeenCalledTimes(1);
    expect(session.committing).toBeNull();
  });

  it('失败:不 toast 成功,保持会话可供重试', async () => {
    vi.mocked(generatePortraitCandidates).mockResolvedValue([candidate('p', 2)]);
    vi.mocked(commitPortrait).mockResolvedValue(null);
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(session.slots[0].phase).toBe('ready'));

    await expect(commitSlot('阿黛尔', 0)).resolves.toBeNull();
    expect(toastrMock.success).not.toHaveBeenCalled();
    expect(session.slots[0].candidate).not.toBeNull();
  });

  it('没有候选 / 仍在出图时不提交', async () => {
    const session = openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    await expect(commitSlot('阿黛尔', 0)).resolves.toBeNull();
    session.slots[0].phase = 'generating';
    session.slots[0].candidate = candidate('p', 1);
    await expect(commitSlot('阿黛尔', 0)).resolves.toBeNull();
    expect(commitPortrait).not.toHaveBeenCalled();
  });
});

describe('resetPortraitModalState', () => {
  it('清空会话并中止在途任务(切聊天用)', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(generatePortraitCandidates).mockImplementation(
      (_entry, _tag, signal) =>
        new Promise(resolve => {
          if (signal) signals.push(signal);
          // 永不 settle:任务必须一直「在途」,reset 才有东西可中止(settle 后控制器已注销)
          void resolve;
        }),
    );
    openPortraitSession({ name: '阿黛尔', appearanceTag: 'a', variants: [] });
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    resetPortraitModalState();
    expect(signals[0].aborted).toBe(true);
    expect(getPortraitSession('阿黛尔')).toBeUndefined();
  });
});

/** 展示层读的就是这些字段,顺手锁一下会话形状不会被顺手改窄。 */
describe('session shape', () => {
  it('会话字段齐备(组件模板依赖)', () => {
    const session: PortraitSessionState = createPortraitSession('阿黛尔', 'a', []);
    expect(Object.keys(session).sort()).toEqual(['appearanceTag', 'committing', 'name', 'slots']);
    for (const slot of session.slots) {
      expect(Object.keys(slot).sort()).toEqual([
        'candidate',
        'dirty',
        'editing',
        'error',
        'extra',
        'index',
        'nl',
        'phase',
        'rewriteError',
        'rewriting',
      ]);
    }
  });
});
