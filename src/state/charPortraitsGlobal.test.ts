import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 全局人设图库(state/charPortraitsGlobal.ts)集成测试。
 * 与 globalCharTags.test.ts 同一套假 window.SillyTavern 写法:内存 extensionSettings +
 * chatMetadata,覆盖:落盘/领养、CRUD、提升迁移、chat → global 查找顺序、删除清理。
 * vibeStore 整体 mock(真实现会走 ST 文件上传/IndexedDB,这里只关心是否被调用)。
 */

const vibeStore = vi.hoisted(() => ({
  deleteVibeData: vi.fn(async (_vibe: { dataPath: string; thumbnailPath: string }) => undefined),
}));

vi.mock('@/backends/vibeStore', () => ({
  deleteVibeData: vibeStore.deleteVibeData,
}));

function deletedPaths(): string[] {
  return vibeStore.deleteVibeData.mock.calls.map(([vibe]) => vibe.dataPath);
}

import type { PortraitVariant } from '@/autoTag/protocol';
import type { CharPortraitEntry, CharPortraitSelected } from '@/state/charPortraits';

interface FakeCtx {
  extensionSettings: Record<string, unknown>;
  chatMetadata: Record<string, unknown>;
  saveSettingsDebounced: ReturnType<typeof vi.fn>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
}

const CHAT_KEY = 'baibai_image_char_portraits';
const GLOBAL_KEY = 'baibai_image_char_portraits_global';

let ctx: FakeCtx;
// 每次 resetModules 后动态重进,保证模块级状态(fingerprint/revision/注入的 provider)干净
let portraits: typeof import('@/state/charPortraits');
let globalPortraits: typeof import('@/state/charPortraitsGlobal');

function variant(extra: string, nl = ''): PortraitVariant {
  return { extra, nl };
}

function selected(anchorTag: string, dataPath: string): CharPortraitSelected {
  return {
    prompt: `${anchorTag}, standing`,
    seed: 4242,
    anchorTag,
    thumb: 'data:image/jpeg;base64,AAAA',
    vibe: {
      dataPath,
      thumbnailPath: `${dataPath}.thumb.jpg`,
      modelKeys: ['nai-diffusion-4-5-full'],
      fingerprint: `fp-${dataPath}`,
    },
  };
}

function entry(name: string, extras: string[] = ['standing'], pick: CharPortraitSelected | null = null): CharPortraitEntry {
  return { name, variants: extras.map(extra => variant(extra)), selected: pick };
}

beforeEach(async () => {
  vi.resetModules();
  vibeStore.deleteVibeData.mockClear();
  vibeStore.deleteVibeData.mockImplementation(async () => undefined);
  ctx = {
    extensionSettings: {},
    chatMetadata: {},
    saveSettingsDebounced: vi.fn(),
    saveMetadataDebounced: vi.fn(),
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
  portraits = await import('@/state/charPortraits');
  globalPortraits = await import('@/state/charPortraitsGlobal');
  globalPortraits.initGlobalCharPortraits();
  portraits.hydrateCharPortraits();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('全局人设图库存储', () => {
  it('setGlobalPortrait 落盘 extensionSettings,同名覆盖,revision 递增', () => {
    expect(globalPortraits.setGlobalPortrait(entry('玩家', ['standing']))).toBe(true);
    expect(globalPortraits.setGlobalPortrait(entry('玩家', ['cafe', 'night street']))).toBe(true);

    expect(globalPortraits.globalCharPortraitLib.entries).toHaveLength(1);
    expect(globalPortraits.globalCharPortraitLib.entries[0].variants.map(item => item.extra)).toEqual([
      'cafe',
      'night street',
    ]);

    const stored = ctx.extensionSettings[GLOBAL_KEY] as {
      schemaVersion: number;
      revision: number;
      entries: Array<{ name: string }>;
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.revision).toBe(2);
    expect(stored.entries.map(item => item.name)).toEqual(['玩家']);
    expect(ctx.saveSettingsDebounced).toHaveBeenCalled();
  });

  it('findGlobalPortrait 按名精确查找;removeGlobalPortrait 删除并落盘', () => {
    globalPortraits.setGlobalPortrait(entry('玩家'));
    expect(globalPortraits.findGlobalPortrait('玩家')?.variants).toHaveLength(1);
    expect(globalPortraits.findGlobalPortrait(' 玩家 ')?.name).toBe('玩家');
    expect(globalPortraits.findGlobalPortrait('不存在')).toBeUndefined();
    expect(globalPortraits.findGlobalPortrait('   ')).toBeUndefined();

    expect(globalPortraits.removeGlobalPortrait('玩家')).toBe(true);
    expect(globalPortraits.globalCharPortraitLib.entries).toEqual([]);
    expect(globalPortraits.removeGlobalPortrait('玩家')).toBe(false);
    const stored = ctx.extensionSettings[GLOBAL_KEY] as { entries: unknown[] };
    expect(stored.entries).toEqual([]);
  });

  it('烂数据不抛:空名/无变体无选中/非对象一律拒绝', () => {
    const bad = [
      { name: '', variants: [variant('standing')] },
      { name: '空条目' },
      { name: '坏变体', variants: [{ extra: '  ' }] },
      { name: '缺 vibe', selected: { prompt: 'x', seed: 1 } },
    ] as unknown as CharPortraitEntry[];
    for (const item of bad) expect(globalPortraits.setGlobalPortrait(item)).toBe(false);
    expect(globalPortraits.globalCharPortraitLib.entries).toEqual([]);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });

  it('init 时领养 extensionSettings 里已有的全局库(含 revision 对齐)', async () => {
    ctx.extensionSettings[GLOBAL_KEY] = {
      schemaVersion: 1,
      revision: 7,
      entries: [entry('老玩家', ['standing'], selected('1boy, short black hair', 'vibes/old.vibe.json'))],
    };
    vi.resetModules();
    portraits = await import('@/state/charPortraits');
    globalPortraits = await import('@/state/charPortraitsGlobal');
    globalPortraits.initGlobalCharPortraits();
    portraits.hydrateCharPortraits();

    expect(globalPortraits.globalCharPortraitLib.entries.map(item => item.name)).toEqual(['老玩家']);
    expect(portraits.resolveCharPortrait('老玩家')?.selected?.seed).toBe(4242);
    // revision 只增不减:领养 7 后下一次写入是 8
    globalPortraits.setGlobalPortrait(entry('新角色'));
    expect((ctx.extensionSettings[GLOBAL_KEY] as { revision: number }).revision).toBe(8);
  });
});

describe('copyGlobalPortraitToChat', () => {
  it('把全局条目的变体与选中项复制成聊天副本,全局保留且文件不被删', () => {
    globalPortraits.setGlobalPortrait(
      entry('玩家', ['standalone', 'cafe'], selected('1boy, short black hair', 'vibes/player.vibe.json')),
    );

    expect(globalPortraits.copyGlobalPortraitToChat('玩家')).toBe(true);

    const copy = portraits.findCharPortrait('玩家');
    expect(copy?.variants.map(item => item.extra)).toEqual(['standalone', 'cafe']);
    expect(copy?.selected?.vibe.dataPath).toBe('vibes/player.vibe.json');
    copy!.variants[0].extra = 'mutated';
    expect(globalPortraits.findGlobalPortrait('玩家')?.variants[0].extra).toBe('standalone');
    expect(globalPortraits.globalCharPortraitLib.entries).toHaveLength(1);
    expect(globalPortraits.copyGlobalPortraitToChat('查无此人')).toBe(false);
  });
});

describe('跨标签页广播', () => {
  it('收到广播事件后重新领养 extensionSettings 的全局库', async () => {
    const handlers: Array<() => void> = [];
    (window as unknown as { addEventListener: unknown }).addEventListener = (
      event: string,
      handler: () => void,
    ) => {
      if (event === 'st-baibai-image:char-portrait-global-changed') handlers.push(handler);
    };
    vi.resetModules();
    portraits = await import('@/state/charPortraits');
    globalPortraits = await import('@/state/charPortraitsGlobal');
    globalPortraits.initGlobalCharPortraits();
    expect(handlers).toHaveLength(1);

    ctx.extensionSettings[GLOBAL_KEY] = {
      schemaVersion: 1,
      revision: 9,
      entries: [entry('别处建的', ['standing'])],
    };
    handlers[0]();
    expect(globalPortraits.globalCharPortraitLib.entries.map(item => item.name)).toEqual(['别处建的']);
  });
});

describe('聊天 → 全局查找顺序', () => {
  it('本聊天优先,其次全局,都没有则 undefined', () => {
    globalPortraits.setGlobalPortrait(entry('玩家', ['global-only']));
    globalPortraits.setGlobalPortrait(entry('小雪', ['global-snow']));
    portraits.setVariants('小雪', [variant('chat-snow')]);

    expect(portraits.resolveCharPortrait('玩家')?.variants.map(item => item.extra)).toEqual(['global-only']);
    expect(portraits.resolveCharPortrait('小雪')?.variants.map(item => item.extra)).toEqual(['chat-snow']);
    expect(portraits.resolveCharPortrait('查无此人')).toBeUndefined();
    // 本聊天库仍只含自己的条目,全局库不被污染
    expect(portraits.charPortraitLib.entries.map(item => item.name)).toEqual(['小雪']);
    expect(globalPortraits.globalCharPortraitLib.entries.map(item => item.name)).toEqual(['玩家', '小雪']);
  });
});

describe('提升为全局', () => {
  it('把本聊天条目(含选中项)搬进全局,并从聊天侧删除', () => {
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', selected('1girl, long silver hair', 'vibes/charv_adele.vibe.json'));

    expect(globalPortraits.promotePortraitToGlobal('阿黛尔')).toBe(true);
    expect(globalPortraits.findGlobalPortrait('阿黛尔')?.selected?.vibe.dataPath).toBe(
      'vibes/charv_adele.vibe.json',
    );
    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
    // 提升不是删除:vibe 文件仍然被全局条目引用,不能动
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
  });

  it('聊天侧没有该条目时返回 false,且不写全局库', () => {
    expect(globalPortraits.promotePortraitToGlobal('阿黛尔')).toBe(false);
    expect(globalPortraits.globalCharPortraitLib.entries).toEqual([]);
    expect(ctx.saveSettingsDebounced).not.toHaveBeenCalled();
  });
});

describe('cleanupPortrait', () => {
  it('global=true 时删聊天条目 + 全局条目 + 对应 vibe 文件', async () => {
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', selected('1girl', 'vibes/chat.vibe.json'));
    globalPortraits.setGlobalPortrait(entry('阿黛尔', ['standing'], selected('1girl', 'vibes/global.vibe.json')));

    await expect(globalPortraits.cleanupPortrait('阿黛尔', { global: true })).resolves.toBe(true);

    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
    expect(globalPortraits.findGlobalPortrait('阿黛尔')).toBeUndefined();
    expect(deletedPaths()).toEqual(['vibes/chat.vibe.json', 'vibes/global.vibe.json']);
    expect(vibeStore.deleteVibeData.mock.calls[0][0]).toMatchObject({
      dataPath: 'vibes/chat.vibe.json',
      thumbnailPath: 'vibes/chat.vibe.json.thumb.jpg',
    });
  });

  it('只清聊天侧时保留全局条目;共用同一文件则不删,独占才删', async () => {
    const shared = selected('1girl', 'vibes/shared.vibe.json');
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', shared);
    globalPortraits.setGlobalPortrait(entry('阿黛尔', ['standing'], { ...shared, vibe: { ...shared.vibe } }));

    await globalPortraits.cleanupPortrait('阿黛尔');
    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
    expect(globalPortraits.findGlobalPortrait('阿黛尔')).toBeDefined();
    // 全局条目还指着同一个 dataPath → 不能删
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();

    portraits.setSelected('小雪', selected('1girl', 'vibes/snow.vibe.json'));
    await globalPortraits.cleanupPortrait('小雪');
    expect(portraits.findCharPortrait('小雪')).toBeUndefined();
    expect(deletedPaths()).toEqual(['vibes/snow.vibe.json']);
  });

  it('没有选中项时只清条目,不动文件', async () => {
    portraits.setVariants('铁匠老周', [variant('at the forge')]);
    await expect(globalPortraits.cleanupPortrait('铁匠老周')).resolves.toBe(true);
    expect(portraits.findCharPortrait('铁匠老周')).toBeUndefined();
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
  });

  it('deleteVibeData 失败只 warn,不打断清理', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vibeStore.deleteVibeData.mockRejectedValueOnce(new Error('磁盘炸了'));
    portraits.setSelected('阿黛尔', selected('1girl', 'vibes/chat.vibe.json'));

    await expect(globalPortraits.cleanupPortrait('阿黛尔', { global: true })).resolves.toBe(true);
    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('名字不存在时返回 false,不碰文件', async () => {
    await expect(globalPortraits.cleanupPortrait('查无此人', { global: true })).resolves.toBe(false);
    await expect(globalPortraits.cleanupPortrait('   ')).resolves.toBe(false);
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
  });

  it('聊天的 chatMetadata 被整份删掉时,全局库仍在', async () => {
    globalPortraits.setGlobalPortrait(entry('玩家', ['standing'], selected('1boy', 'vibes/player.vibe.json')));
    // 模拟删掉整个聊天:chatMetadata 换新语境,chat 库随之清空
    ctx.chatMetadata = {};
    portraits.hydrateCharPortraits();
    expect(portraits.charPortraitLib.entries).toEqual([]);
    expect(portraits.resolveCharPortrait('玩家')?.variants.map(item => item.extra)).toEqual(['standing']);
    // 全局 vibe 未被连带删除(仍被引用)
    expect(vibeStore.deleteVibeData).not.toHaveBeenCalled();
    expect((ctx.extensionSettings[GLOBAL_KEY] as { entries: Array<{ name: string }> }).entries).toHaveLength(1);
    // 聊天侧的 key 完全没被写过(只有全局 bank 在 extensionSettings)
    expect(ctx.chatMetadata[CHAT_KEY]).toBeUndefined();
  });
});
