import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CharChange, PortraitVariant } from '@/autoTag/protocol';
import type { CharTagAutoOp } from '@/state/charTags';

/**
 * 人设图状态库(state/charPortraits.ts)测试。
 * 以假 window.SillyTavern.getContext 喂一个内存 chatMetadata(与 globalCharTags.test.ts 同一套写法),
 * 覆盖:落盘/重载生命周期、宽松归一、外观 tag 逐字一致、过期判定、runner 侧的种子收集纯函数。
 */

interface FakeCtx {
  chatMetadata: Record<string, unknown>;
  saveMetadataDebounced: ReturnType<typeof vi.fn>;
  eventSource: { on: (event: string, handler: () => void) => void };
  eventTypes: Record<string, string>;
}

const META_KEY = 'baibai_image_char_portraits';

let ctx: FakeCtx;
// 每次 resetModules 后动态重进,保证模块级状态干净
let portraits: typeof import('@/state/charPortraits');

function variant(extra: string, nl = ''): PortraitVariant {
  return { extra, nl };
}

function selectedSample(anchorTag: string) {
  return {
    prompt: `${anchorTag}, standing, school uniform`,
    seed: 123456,
    anchorTag,
    thumb: 'data:image/jpeg;base64,AAAA',
    vibe: {
      dataPath: 'vibes/charv_adele.vibe.png',
      thumbnailPath: 'vibes/charv_adele.thumb.png',
      modelKeys: ['nai-diffusion-4-5-full'],
      fingerprint: 'fp-1',
    },
  };
}

/** 一条提交后的建档 op(与 runner 落进 floorOps 的形状一致)。 */
function newOp(name: string): CharTagAutoOp {
  return {
    kind: 'new',
    name,
    fields: { fandom: '', sex: '1girl', hair: 'long silver hair', eyes: 'red eyes', skin: '', body: '', extra: '', outfit: '' },
    raw: '',
    nl: '',
    source: 'ai',
    desc: '',
    reason: '',
    at: 1,
  };
}

function setOp(name: string): CharTagAutoOp {
  return { kind: 'set', name, field: 'hair', value: 'short silver hair', reason: '剪发', at: 2 };
}

/** 一条解析后的建档 change(protocol.ts 的 CharChange)。 */
function newChange(name: string, portraits?: PortraitVariant[]): CharChange {
  return {
    name,
    field: 'new',
    value: JSON.stringify({ sex: '1girl', hair: 'long silver hair', eyes: 'red eyes' }),
    reason: '',
    position: 'P1',
    sourceLine: 0,
    portraits,
  };
}

beforeEach(async () => {
  vi.resetModules();
  ctx = {
    chatMetadata: {},
    saveMetadataDebounced: vi.fn(),
    eventSource: { on: vi.fn() },
    eventTypes: { CHAT_CHANGED: 'chat_changed' },
  };
  (globalThis as Record<string, unknown>).window = {
    SillyTavern: { getContext: () => ctx },
  };
  portraits = await import('@/state/charPortraits');
  portraits.hydrateCharPortraits();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  vi.restoreAllMocks();
});

describe('char portraits store normalize', () => {
  it('malformed stores and entries are dropped without throwing', () => {
    expect(portraits.normalizeCharPortraitStore(null)).toEqual([]);
    expect(portraits.normalizeCharPortraitStore('junk')).toEqual([]);
    expect(portraits.normalizeCharPortraitStore({ version: 1 })).toEqual([]);
    expect(portraits.normalizeCharPortraitStore({ version: 1, entries: 'junk' })).toEqual([]);
    const entries = portraits.normalizeCharPortraitStore({
      version: 1,
      entries: [
        null,
        'not-an-object',
        { name: '', variants: [variant('standing')] },
        // 既没有变体也没有选中 → 无意义条目
        { name: '空的' },
        { name: '只有坏变体', variants: [{ extra: '   ' }, { nl: 'no extra' }, 3] },
        { name: '阿黛尔', variants: [variant('standing, school uniform', 'A girl stands.')] },
        // 选中项缺 vibe(注不进图) → 降级为无选中,变体保留
        { name: '铁匠老周', variants: [variant('at the forge')], selected: { prompt: 'x', seed: 1 } },
        // 重名只留第一条
        { name: '阿黛尔', variants: [variant('duplicate')] },
      ],
    });
    expect(entries.map(entry => entry.name)).toEqual(['阿黛尔', '铁匠老周']);
    expect(entries[0].variants).toEqual([variant('standing, school uniform', 'A girl stands.')]);
    expect(entries[0].selected).toBeNull();
    expect(entries[1].selected).toBeNull();
  });

  it('caps variants at 3 and sanitizes selected shapes', () => {
    const entries = portraits.normalizeCharPortraitStore({
      version: 1,
      entries: [
        {
          name: '阿黛尔',
          variants: [variant('a'), variant('b'), variant('c'), variant('d')],
          selected: {
            prompt: '  long silver hair, red eyes, standing  ',
            seed: 42,
            anchorTag: ' long silver hair, red eyes ',
            thumb: 'data:image/jpeg;base64,BBBB',
            vibe: {
              dataPath: ' vibes/a.vibe.png ',
              thumbnailPath: 'vibes/a.thumb.png',
              modelKeys: ['nai-diffusion-4-5-full', 7],
              fingerprint: 'fp-a',
            },
          },
        },
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].variants.map(item => item.extra)).toEqual(['a', 'b', 'c']);
    expect(entries[0].selected).toEqual({
      prompt: 'long silver hair, red eyes, standing',
      seed: 42,
      anchorTag: 'long silver hair, red eyes',
      thumb: 'data:image/jpeg;base64,BBBB',
      vibe: {
        dataPath: 'vibes/a.vibe.png',
        thumbnailPath: 'vibes/a.thumb.png',
        modelKeys: ['nai-diffusion-4-5-full'],
        fingerprint: 'fp-a',
      },
    });
  });

  it('hydrate reads the chat metadata bank', () => {
    ctx.chatMetadata[META_KEY] = {
      version: 1,
      entries: [{ name: '阿黛尔', variants: [variant('standing')] }],
    };
    portraits.hydrateCharPortraits();
    expect(portraits.charPortraitLib.entries.map(entry => entry.name)).toEqual(['阿黛尔']);
    expect(portraits.findCharPortrait('阿黛尔')?.variants).toHaveLength(1);
    expect(portraits.findCharPortrait('不存在')).toBeUndefined();
  });
});

describe('resolveCharPortrait(chat → 全局)', () => {
  it('未注入全局来源时只认本聊天库(默认 provider 为空)', () => {
    portraits.setVariants('阿黛尔', [variant('chat')]);
    expect(portraits.resolveCharPortrait('阿黛尔')?.variants[0].extra).toBe('chat');
    expect(portraits.resolveCharPortrait('只有全局的')).toBeUndefined();
  });

  it('本聊天优先,全局补空缺;findCharPortrait 始终只看聊天库', () => {
    portraits.setGlobalCharPortraitSource(() => [
      { name: '阿黛尔', variants: [variant('global')], selected: null },
      { name: '玩家', variants: [variant('global-player')], selected: null },
    ]);
    portraits.setVariants('阿黛尔', [variant('chat')]);

    expect(portraits.resolveCharPortrait('阿黛尔')?.variants[0].extra).toBe('chat');
    expect(portraits.resolveCharPortrait('玩家')?.variants[0].extra).toBe('global-player');
    expect(portraits.resolveCharPortrait('  玩家  ')?.name).toBe('玩家');
    expect(portraits.resolveCharPortrait('')).toBeUndefined();
    expect(portraits.resolveCharPortrait('   ')).toBeUndefined();
    // 作用域不被污染:本聊天库只含自己的条目
    expect(portraits.charPortraitLib.entries.map(entry => entry.name)).toEqual(['阿黛尔']);
    expect(portraits.findCharPortrait('玩家')).toBeUndefined();
  });
});

describe('composePortraitPrompt', () => {
  it('keeps the appearance part byte-identical across all 3 variants', () => {
    const appearance = '1girl, long silver hair, red eyes, pale skin';
    const variants = [
      variant('standing, school uniform, classroom', 'A girl stands in a classroom.'),
      variant('sitting, cafe, casual clothes', 'A girl sits in a cafe.'),
      variant('close-up, night street, rain', 'A girl on a rainy street at night.'),
    ];
    const prompts = variants.map(item => portraits.composePortraitPrompt(appearance, item));
    expect(prompts).toEqual([
      `${appearance}, standing, school uniform, classroom`,
      `${appearance}, sitting, cafe, casual clothes`,
      `${appearance}, close-up, night street, rain`,
    ]);
    // 逐字一致:三条前缀的长度与内容完全相同(不能靠 trim/大小写「看起来一样」)
    const prefixes = prompts.map(prompt => prompt.slice(0, appearance.length));
    expect(new Set(prefixes)).toEqual(new Set([appearance]));
    for (const prompt of prompts) expect(prompt.startsWith(`${appearance}, `)).toBe(true);
  });

  it('tolerates an empty appearance or empty extra', () => {
    expect(portraits.composePortraitPrompt('', variant('standing'))).toBe('standing');
    expect(portraits.composePortraitPrompt('1girl', variant('   '))).toBe('1girl');
  });
});

describe('isPortraitStale', () => {
  it('no selection → never stale', () => {
    expect(portraits.isPortraitStale({ selected: null }, 'anything')).toBe(false);
  });

  it('anchor tag equal → fresh; differ → stale', () => {
    const anchor = '1girl, long silver hair';
    expect(portraits.isPortraitStale({ selected: selectedSample(anchor) }, anchor)).toBe(false);
    expect(portraits.isPortraitStale({ selected: selectedSample(anchor) }, '1girl, short black hair')).toBe(true);
  });
});

describe('collectPortraitSeeds', () => {
  it('emits a seed for every new op that carries variants', () => {
    const seeds = portraits.collectPortraitSeeds(
      [newOp('阿黛尔')],
      [newChange('阿黛尔', [variant('standing'), variant('cafe'), variant('night street')])],
    );
    expect(seeds).toEqual([
      { name: '阿黛尔', variants: [variant('standing'), variant('cafe'), variant('night street')] },
    ]);
  });

  it('skips new ops whose change has no (usable) variants', () => {
    expect(portraits.collectPortraitSeeds([newOp('阿黛尔')], [newChange('阿黛尔')])).toEqual([]);
    expect(portraits.collectPortraitSeeds([newOp('阿黛尔')], [newChange('阿黛尔', [])])).toEqual([]);
    expect(
      portraits.collectPortraitSeeds([newOp('阿黛尔')], [newChange('阿黛尔', [{ extra: ' ', nl: 'x' }])]),
    ).toEqual([]);
    // change 缺失(例如变更被丢弃)也不炸
    expect(portraits.collectPortraitSeeds([newOp('阿黛尔')], [])).toEqual([]);
  });

  it('ignores non-new ops and name mismatches', () => {
    const seeds = portraits.collectPortraitSeeds(
      [setOp('阿黛尔'), newOp('铁匠老周')],
      [newChange('阿黛尔', [variant('standing')]), newChange('铁匠老周', [variant('at the forge')])],
    );
    expect(seeds).toEqual([{ name: '铁匠老周', variants: [variant('at the forge')] }]);
  });

  it('handles multiple new ops and dedupes by name', () => {
    const seeds = portraits.collectPortraitSeeds(
      [newOp('阿黛尔'), newOp('铁匠老周'), newOp('阿黛尔')],
      [newChange('阿黛尔', [variant('standing')]), newChange('铁匠老周', [variant('at the forge')])],
    );
    expect(seeds.map(seed => seed.name)).toEqual(['阿黛尔', '铁匠老周']);
  });
});

describe('char portraits lifecycle', () => {
  it('setVariants persists and keeps the existing selection', () => {
    const anchor = '1girl, long silver hair, red eyes';
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', selectedSample(anchor));
    portraits.setVariants('阿黛尔', [variant('cafe'), variant('night street')]);

    const entry = portraits.findCharPortrait('阿黛尔');
    expect(entry?.variants.map(item => item.extra)).toEqual(['cafe', 'night street']);
    expect(entry?.selected?.anchorTag).toBe(anchor);

    const stored = ctx.chatMetadata[META_KEY] as { version: number; entries: Array<{ name: string }> };
    expect(stored.version).toBe(1);
    expect(stored.entries.map(item => item.name)).toEqual(['阿黛尔']);
    expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
  });

  it('setSelected creates the entry, clearSelected keeps variants', () => {
    const anchor = '1girl, long silver hair';
    portraits.setSelected('阿黛尔', selectedSample(anchor));
    expect(portraits.findCharPortrait('阿黛尔')?.variants).toEqual([]);
    expect(portraits.isPortraitStale({ selected: portraits.findCharPortrait('阿黛尔')?.selected ?? null }, anchor)).toBe(false);

    portraits.setVariants('阿黛尔', [variant('standing')]);
    expect(portraits.clearSelected('阿黛尔')).toBe(true);
    const entry = portraits.findCharPortrait('阿黛尔');
    expect(entry?.selected).toBeNull();
    expect(entry?.variants).toHaveLength(1);
    // 已经没有选中也没有变体的空条目 → 直接消失
    portraits.setVariants('阿黛尔', []);
    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
  });

  it('removePortrait drops the whole entry', () => {
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', selectedSample('1girl'));
    expect(portraits.removePortrait('阿黛尔')).toBe(true);
    expect(portraits.findCharPortrait('阿黛尔')).toBeUndefined();
    expect(portraits.charPortraitLib.entries).toEqual([]);
    expect(portraits.removePortrait('阿黛尔')).toBe(false);
  });

  it('re-hydrating restores what was persisted', async () => {
    portraits.setVariants('阿黛尔', [variant('standing')]);
    portraits.setSelected('阿黛尔', selectedSample('1girl'));
    vi.resetModules();
    const reloaded = await import('@/state/charPortraits');
    reloaded.hydrateCharPortraits();
    expect(reloaded.findCharPortrait('阿黛尔')?.variants.map(item => item.extra)).toEqual(['standing']);
    expect(reloaded.findCharPortrait('阿黛尔')?.selected?.seed).toBe(123456);
  });

  it('bindCharPortraitSync re-hydrates on CHAT_CHANGED', () => {
    const handlers: Array<() => void> = [];
    ctx.eventSource.on = (_event: string, handler: () => void) => {
      handlers.push(handler);
    };
    portraits.bindCharPortraitSync();
    expect(handlers).toHaveLength(1);
    ctx.chatMetadata[META_KEY] = { version: 1, entries: [{ name: '小雪', variants: [variant('standing')] }] };
    handlers[0]();
    expect(portraits.charPortraitLib.entries.map(entry => entry.name)).toEqual(['小雪']);
  });
});
