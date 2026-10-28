import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 人设图 vibe 登记表与孤儿清扫(state/charPortraitVibeIndex.ts)。
 * vibeStore 只 mock deleteVibeData(真实现走 ST 文件接口/IndexedDB);
 * charPortraits / charPortraitsGlobal 用真实现,引用判定才与生产同路。
 */

const vibeStore = vi.hoisted(() => ({
  deleteVibeData: vi.fn(async (_vibe: { dataPath: string; thumbnailPath: string }) => undefined),
}));

vi.mock('@/backends/vibeStore', () => ({
  deleteVibeData: vibeStore.deleteVibeData,
}));

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  getCurrentChatId: () => string | undefined;
  eventSource: { on: (event: string, handler: (...args: unknown[]) => void) => void };
  eventTypes: Record<string, string>;
}

const REGISTRY_KEY = 'baibai_image_char_portrait_vibe_index';

let ctx: FakeCtx;
let handlers: Record<string, Array<(...args: unknown[]) => void>>;
let chatId: string | undefined;
let portraits: typeof import('@/state/charPortraits');
let globalPortraits: typeof import('@/state/charPortraitsGlobal');
let vibeIndex: typeof import('@/state/charPortraitVibeIndex');

function registryPaths(): Record<string, unknown> {
  const stored = ctx.extensionSettings[REGISTRY_KEY] as { files: Record<string, unknown> } | undefined;
  return stored?.files ?? {};
}

function selected(dataPath: string) {
  return {
    prompt: 'p',
    seed: 1,
    anchorTag: '1girl',
    thumb: 't',
    vibe: { dataPath, thumbnailPath: `${dataPath}.thumb`, modelKeys: ['m'], fingerprint: 'fp' },
  };
}

beforeEach(async () => {
  vi.resetModules();
  vibeStore.deleteVibeData.mockReset();
  vibeStore.deleteVibeData.mockImplementation(async () => undefined);
  chatId = 'chat-a';
  handlers = {};
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
    getCurrentChatId: () => chatId,
    eventSource: {
      on: (event, handler) => {
        (handlers[event] ??= []).push(handler);
      },
    },
    eventTypes: { CHAT_CHANGED: 'chat_changed', CHAT_DELETED: 'chat_deleted' },
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  portraits = await import('@/state/charPortraits');
  globalPortraits = await import('@/state/charPortraitsGlobal');
  vibeIndex = await import('@/state/charPortraitVibeIndex');
  globalPortraits.initGlobalCharPortraits();
  portraits.hydrateCharPortraits();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('registerPortraitVibe', () => {
  it('登记 dataPath 与当前 chatId,落盘 extensionSettings;重复登记幂等', () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: 'vibes/a.thumb' });
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: 'vibes/a.thumb' });

    expect(registryPaths()).toEqual({
      'vibes/a.json': { thumbnailPath: 'vibes/a.thumb', chatId: 'chat-a', at: expect.any(Number) },
    });
    expect(ctx.saveSettingsDebounced).toHaveBeenCalledTimes(1);
  });

  it('chatId 变化时更新登记(同一文件换聊天持有)', () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: '' });
    chatId = 'chat-b';
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: '' });
    expect((registryPaths()['vibes/a.json'] as { chatId: string }).chatId).toBe('chat-b');
  });

  it('空 dataPath 不登记', () => {
    vibeIndex.registerPortraitVibe({ dataPath: '', thumbnailPath: '' });
    expect(registryPaths()).toEqual({});
  });
});

describe('sweepPortraitVibes', () => {
  it('被聊天库引用 → 注销登记但不删文件(生死交还条目清理路径)', async () => {
    portraits.setVariants('阿黛尔', [{ extra: 'standing', nl: '' }]);
    portraits.setSelected('阿黛尔', selected('vibes/used.json'));
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/used.json', thumbnailPath: 'vibes/used.json.thumb' });

    await vibeIndex.sweepPortraitVibes();

    expect(registryPaths()).toEqual({});
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
  });

  it('被全局库引用 → 同样只注销', async () => {
    globalPortraits.setGlobalPortrait({ name: '玩家', variants: [{ extra: 'x', nl: '' }], selected: selected('vibes/g.json') });
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/g.json', thumbnailPath: 't' });

    await vibeIndex.sweepPortraitVibes();

    expect(registryPaths()).toEqual({});
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
  });

  it('本聊天的孤儿(重新选图覆盖泄漏) → 删文件并注销', async () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/orphan.json', thumbnailPath: 'vibes/orphan.json.thumb' });

    await vibeIndex.sweepPortraitVibes();

    expect(vibeStore.deleteVibeData).toHaveBeenCalledWith({
      dataPath: 'vibes/orphan.json',
      thumbnailPath: 'vibes/orphan.json.thumb',
    });
    expect(registryPaths()).toEqual({});
  });

  it('其它聊天的登记 → 无从验证,原样保留', async () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/other.json', thumbnailPath: '' });
    chatId = 'chat-b';
    portraits.hydrateCharPortraits();

    await vibeIndex.sweepPortraitVibes();

    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
    expect(Object.keys(registryPaths())).toEqual(['vibes/other.json']);
  });

  it('没有打开的聊天 → 整体跳过', async () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: '' });
    chatId = undefined;

    await vibeIndex.sweepPortraitVibes();

    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
    expect(Object.keys(registryPaths())).toEqual(['vibes/a.json']);
  });

  it('删文件失败 → 保留登记下次重试,只 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vibeStore.deleteVibeData.mockRejectedValueOnce(new Error('磁盘炸了'));
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: 't' });

    await vibeIndex.sweepPortraitVibes();

    expect(warn).toHaveBeenCalled();
    expect(Object.keys(registryPaths())).toEqual(['vibes/a.json']);
  });
});

describe('sweepDeletedChat', () => {
  it('删聊天 → 该 chatId 下不被全局库引用的文件全删;全局引用的保住', async () => {
    globalPortraits.setGlobalPortrait({
      name: '玩家',
      variants: [{ extra: 'x', nl: '' }],
      selected: selected('vibes/global.json'),
    });
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/global.json', thumbnailPath: '' });
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/chatonly.json', thumbnailPath: 't' });

    await vibeIndex.sweepDeletedChat('chat-a');

    expect(vibeStore.deleteVibeData).toHaveBeenCalledTimes(1);
    expect(vibeStore.deleteVibeData).toHaveBeenCalledWith({ dataPath: 'vibes/chatonly.json', thumbnailPath: 't' });
    expect(Object.keys(registryPaths())).toEqual(['vibes/global.json']);
  });

  it('其它 chatId 的登记不动', async () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/a.json', thumbnailPath: '' });
    await vibeIndex.sweepDeletedChat('chat-z');
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
    expect(Object.keys(registryPaths())).toEqual(['vibes/a.json']);
  });
});

describe('initPortraitVibeSweep', () => {
  it('绑 CHAT_CHANGED 与 CHAT_DELETED,启动即清扫一次', async () => {
    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/orphan.json', thumbnailPath: 't' });
    vibeIndex.initPortraitVibeSweep();
    await vi.waitFor(() => expect(Object.keys(registryPaths())).toEqual([]));
    expect(vibeStore.deleteVibeData).toHaveBeenCalledTimes(1);

    expect(handlers['chat_changed']).toHaveLength(1);
    expect(handlers['chat_deleted']).toHaveLength(1);

    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/again.json', thumbnailPath: '' });
    handlers['chat_changed'][0]();
    await vi.waitFor(() => expect(Object.keys(registryPaths())).toEqual([]));
    expect(vibeStore.deleteVibeData).toHaveBeenCalledTimes(2);

    vibeIndex.registerPortraitVibe({ dataPath: 'vibes/gone.json', thumbnailPath: '' });
    handlers['chat_deleted'][0]('chat-a');
    await vi.waitFor(() => expect(Object.keys(registryPaths())).toEqual([]));
    expect(vibeStore.deleteVibeData).toHaveBeenCalledTimes(3);
  });

  it('旧版 ST 没有 CHAT_DELETED 事件 → 不绑定,CHAT_CHANGED 清扫照常', async () => {
    ctx.eventTypes = { CHAT_CHANGED: 'chat_changed' };
    vi.resetModules();
    portraits = await import('@/state/charPortraits');
    globalPortraits = await import('@/state/charPortraitsGlobal');
    vibeIndex = await import('@/state/charPortraitVibeIndex');
    globalPortraits.initGlobalCharPortraits();

    vibeIndex.initPortraitVibeSweep();
    expect(handlers['chat_changed']).toHaveLength(1);
    expect(handlers['chat_deleted']).toBeUndefined();
  });
});
