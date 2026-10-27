import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateComfyImage } from '@/backends/comfyui';
import { generateNaiImage } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { charPortraitLib, setGlobalCharPortraitSource } from '@/state/charPortraits';
import { charTagLib, emptyCharFields } from '@/state/charTags';
import { activeNaiEndpoint, newNaiEndpoint, settings, type NaiModel } from '@/state/settings';

vi.mock('@/backends/nai', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/nai')>()),
  generateNaiImage: vi.fn(),
}));
vi.mock('@/backends/comfyui', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/comfyui')>()),
  generateComfyImage: vi.fn(),
}));
vi.mock('@/floor/genQueue', () => ({ acquireNaiSlot: vi.fn() }));

function fakeResult() {
  return { url: 'data:image/png;base64,AAAA', filename: 'x.png', format: 'png', revoke: vi.fn() };
}

/** generateNaiImage 现在返回 { result, usage }（usage 随图落盘）。 */
function fakeNaiOutput() {
  return {
    result: fakeResult(),
    usage: { positive: '', negative: '', width: 0, height: 0, artist: null, vibes: [], params: {} },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acquireNaiSlot).mockResolvedValue(vi.fn());
  vi.mocked(generateNaiImage).mockResolvedValue(fakeNaiOutput());
  vi.mocked(generateComfyImage).mockResolvedValue(fakeResult());
  charTagLib.entries.length = 0;
  charPortraitLib.entries.length = 0;
  settings.nai.charVibeStrength = 0.5;
});

/**
 * 把设置调成「NAI 已配齐」。地址与 key 落在**当前接入点**上——渠道级那两个是存量字段。
 * settings 是模块级单例,用例之间会串,故这里把接入点库整个复位成「只有官方一条」。
 */
function naiReady(model: NaiModel = 'nai-diffusion-4-5-full'): void {
  settings.defaultBackend = 'nai';
  settings.nai.endpoints = [
    { id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'k' },
  ];
  settings.nai.activeEndpointId = 'nep_official';
  settings.nai.model = model;
  settings.nai.seed = 0;
  settings.nai.orientationLock = 'auto';
}

/** 把设置调成「ComfyUI 自定义工作流已配齐」。 */
function comfyReady(): void {
  settings.defaultBackend = 'comfyui';
  settings.comfyui.url = 'http://127.0.0.1:8188';
  const preset = settings.comfyui.workflows[0];
  settings.comfyui.activeWorkflowId = preset.id;
  preset.mode = 'custom';
  preset.workflow = '{"1":{}}';
  preset.orientationLock = 'auto';
}

describe('backendStatus', () => {
  it('reports each missing NAI field by name', () => {
    naiReady();
    expect(backendStatus()).toMatchObject({ configured: true, reason: '' });

    activeNaiEndpoint().key = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '当前 NAI 接入点未填写 API Key',
    });

    activeNaiEndpoint().url = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '当前 NAI 接入点未填写服务地址',
    });
  });

  it('keeps the endpoint name out of reason (it goes to third parties, and users name rows after URLs)', () => {
    // reason 经 getBackendStatus 原样递给第三方,而公开返回值里绝不能出现地址
    naiReady();
    const named = newNaiEndpoint('https://my-secret-proxy.example');
    settings.nai.endpoints.push(named);
    settings.nai.activeEndpointId = named.id;
    expect(backendStatus().reason).not.toContain('my-secret-proxy');
  });

  it('judges readiness by the active endpoint, not the legacy channel-level url/key', () => {
    // 存量字段留着只为回滚,出图一律不看它 —— 否则切到没填 key 的公益站会「看起来能点」
    naiReady();
    settings.nai.url = 'https://image.novelai.net';
    settings.nai.key = 'legacy';

    const blank = newNaiEndpoint('公益站 A');
    settings.nai.endpoints.push(blank);
    settings.nai.activeEndpointId = blank.id;
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '当前 NAI 接入点未填写服务地址',
    });
  });

  it('sends the active endpoint down to the backend (switching outlets keeps every other param)', async () => {
    naiReady();
    settings.nai.steps = 33;
    const alt = newNaiEndpoint('公益站 A');
    alt.url = 'https://a.example';
    alt.key = 'ka';
    settings.nai.endpoints.push(alt);
    settings.nai.activeEndpointId = alt.id;

    await generateImage({ prompt: 'x', seed: 1 }, undefined, {});
    expect(vi.mocked(generateNaiImage).mock.calls[0][0]).toMatchObject({
      url: 'https://a.example',
      key: 'ka',
      steps: 33,
    });
  });

  it('answers supportsCharacters from the model alone, even before the key is filled in', () => {
    naiReady();
    activeNaiEndpoint().key = '';
    // 第三方要在出图**前**就知道该不该传 characters,不能等配好了才知道
    expect(backendStatus().supportsCharacters).toBe(true);
  });

  it('keeps ComfyUI at supportsCharacters=false (the pipeline never reads the field)', () => {
    comfyReady();
    expect(backendStatus()).toMatchObject({ configured: true, supportsCharacters: false });
  });

  it('flags an unconfigured ComfyUI without pretending it can draw', () => {
    comfyReady();
    settings.comfyui.workflows[0].workflow = '  ';
    expect(backendStatus()).toMatchObject({
      configured: false,
      reason: '当前工作流预设未填写工作流 JSON',
    });
  });
});

describe('decideSeed', () => {
  it('prefers an explicit seed over everything else', () => {
    naiReady();
    settings.nai.seed = 999;
    expect(decideSeed('nai', 12345)).toBe(12345);
    expect(decideSeed('nai', 12345.7)).toBe(12345);
  });

  it('uses the NAI panel seed only when it is a positive number', () => {
    naiReady();
    settings.nai.seed = 777;
    expect(decideSeed('nai')).toBe(777);
    settings.nai.seed = 0;
    expect(decideSeed('nai')).not.toBe(0);
  });

  it.each([0, -1, NaN, undefined])('ignores %s as an override and still returns a usable seed', value => {
    naiReady();
    settings.nai.seed = 0;
    const seed = decideSeed('nai', value as number | undefined);
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThan(0);
  });
});

describe('generateImage', () => {
  it('holds a NAI gate slot and always releases it — even when the request throws', async () => {
    naiReady();
    const release = vi.fn();
    vi.mocked(acquireNaiSlot).mockResolvedValue(release);

    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    vi.mocked(generateNaiImage).mockRejectedValueOnce(new Error('429'));
    await expect(generateImage({ prompt: '1girl', seed: 1 })).rejects.toThrow('429');
    // 漏一次 release 就永久少一格并发,漏满就再也发不出请求
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('leaves ComfyUI out of the gate (its queue lives on the server)', async () => {
    comfyReady();
    await generateImage({ prompt: '1girl', seed: 1 });
    expect(vi.mocked(acquireNaiSlot)).not.toHaveBeenCalled();
  });

  it('passes characters through untouched — nai.ts owns the model predicate', async () => {
    naiReady();
    const characters = [{ name: '阿黛尔', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 5, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toEqual({
      prompt: 'x', nl: '', characters, seed: 5, size: 'landscape',
    });
  });

  it('says charactersApplied=false when the model cannot take them', async () => {
    naiReady('nai-diffusion-3');
    const characters = [{ name: 'a', tag: 'b', nl: '' }];
    const applied = await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(applied.charactersApplied).toBe(false);

    naiReady();
    expect((await generateImage({ prompt: 'x', characters, seed: 1 })).charactersApplied).toBe(true);
    // 没传角色时不该报「用上了」
    expect((await generateImage({ prompt: 'x', seed: 1 })).charactersApplied).toBe(false);
  });

  it('refuses to fire a doomed request when the backend is not configured', async () => {
    naiReady();
    activeNaiEndpoint().key = '';
    await expect(generateImage({ prompt: 'x', seed: 1 })).rejects.toThrow('未填写 API Key');
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
  });

  it('clears the retry banner once the image is in hand', async () => {
    naiReady();
    const onRetry = vi.fn();
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onRetry });
    // 落盘还要一会儿,这段时间不该继续显示「稍后重试」
    expect(onRetry).toHaveBeenLastCalledWith(null);
  });

  it('only fires onStart after the slot is in hand (that is the queued→generating moment)', async () => {
    naiReady();
    const order: string[] = [];
    vi.mocked(acquireNaiSlot).mockImplementation(async () => {
      order.push('slot');
      return () => {};
    });
    await generateImage({ prompt: 'x', seed: 1 }, undefined, { onStart: () => order.push('start') });
    expect(order).toEqual(['slot', 'start']);
  });

  it('sends the dynamic negative to ComfyUI (NAI takes its negative from settings)', async () => {
    comfyReady();
    await generateImage({ prompt: 'x', negative: 'bad hands', seed: 9 }, undefined, {});
    expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({
      negative_prompt: 'bad hands',
      seed: 9,
      size: 'portrait',
    });
  });

  it('auto lock keeps the orientation recorded in the tag, and reports it back', async () => {
    naiReady();
    const out = await generateImage({ prompt: 'x', seed: 1, size: 'landscape' });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toMatchObject({ size: 'landscape' });
    expect(out.size).toBe('landscape');
  });

  it('applies the NAI channel lock here — the one path cards and the public API share', async () => {
    naiReady();
    settings.nai.orientationLock = 'landscape';
    try {
      // tag 里记的是竖图(锁定前的老图 / 第三方传的 size),锁定后一律按横出
      const out = await generateImage({ prompt: 'x', seed: 1, size: 'portrait' });
      expect(vi.mocked(generateNaiImage).mock.calls[0][1]).toMatchObject({ size: 'landscape' });
      // 回报实际方向:公开接口落图库时据此记 tag,不能记成请求里的竖图
      expect(out.size).toBe('landscape');
      // 缺省 size 同样被锁覆盖
      await generateImage({ prompt: 'x', seed: 1 });
      expect(vi.mocked(generateNaiImage).mock.calls[1][1]).toMatchObject({ size: 'landscape' });
    } finally {
      settings.nai.orientationLock = 'auto';
    }
  });

  it('takes the ComfyUI lock from the active workflow preset, not from the NAI channel', async () => {
    comfyReady();
    const preset = settings.comfyui.workflows[0];
    preset.orientationLock = 'portrait';
    // 另一个渠道的锁不该串过来
    settings.nai.orientationLock = 'landscape';
    try {
      const out = await generateImage({ prompt: 'x', seed: 1, size: 'landscape' });
      expect(vi.mocked(generateComfyImage).mock.calls[0][1]).toMatchObject({ size: 'portrait' });
      expect(out.size).toBe('portrait');
    } finally {
      preset.orientationLock = 'auto';
      settings.nai.orientationLock = 'auto';
    }
  });

  it('bubbles the NAI usage snapshot (artist/vibes) into output.meta', async () => {
    naiReady();
    vi.mocked(generateNaiImage).mockResolvedValue({
      result: fakeResult(),
      usage: {
        positive: 'artist:wlop, 1girl, masterpiece',
        negative: 'lowres',
        width: 832,
        height: 1216,
        artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
        vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.8, effectiveStrength: 0.8 }],
        params: { sampler: 'k_euler', steps: 28, cfg: 5 },
      },
    });

    const out = await generateImage({ prompt: '1girl', seed: 1 });
    expect(out.meta).toEqual({
      backend: 'nai',
      model: 'nai-diffusion-4-5-full',
      positive: 'artist:wlop, 1girl, masterpiece',
      negative: 'lowres',
      width: 832,
      height: 1216,
      artist: { id: 'art_a', name: '厚涂', prompt: 'artist:wlop' },
      vibes: [{ id: 'v1', name: '参考A', group: '', strength: 0.8, effectiveStrength: 0.8 }],
      params: { sampler: 'k_euler', steps: 28, cfg: 5 },
    });
  });

  it('snapshots the ComfyUI simple-mode recipe (loras/sampler/size) into output.meta', async () => {
    comfyReady();
    const preset = settings.comfyui.workflows[0];
    preset.mode = 'simple';
    preset.portraitSize = '832×1216';
    preset.simple.model = 'pony.safetensors';
    preset.simple.sampler = 'euler_ancestral';
    preset.simple.steps = 30;
    preset.simple.cfg = 7;
    preset.simple.loras = [{ name: 'detail', strength: 0.7 }];

    const out = await generateImage({ prompt: '1girl', negative: 'bad', seed: 1 });
    expect(out.meta).toMatchObject({
      backend: 'comfyui',
      model: preset.name,
      width: 832,
      height: 1216,
      artist: null,
      vibes: [],
      params: {
        mode: 'simple',
        baseModel: 'pony.safetensors',
        loras: 'detail×0.7',
        sampler: 'euler_ancestral',
        steps: 30,
        cfg: 7,
      },
    });
    // 简易模式的固定负面 + 动态负面在 meta 里合成全文
    expect(out.meta.negative).toBe('bad');
    expect(out.meta.positive).toBe('1girl');
  });
});

/**
 * 角色人设 vibe 注入(NAI only,Task 8)。
 *
 * 种子口径:角色档案条目用 raw 外观(fields 全空 → buildEntryTag 取 raw),
 * 人设选中项的 anchorTag 与之相同即为「未过期」。库里只塞响应式 entries,
 * findCharTag/findCharPortrait 都从 charTagLib/charPortraitLib 读,无需 ST 上下文。
 */
function seedCharVibe(name: string, fingerprint = `fp_${name}`, anchorTag = `tag_${name}`): void {
  charTagLib.entries.push({
    name,
    fields: emptyCharFields(),
    raw: `tag_${name}`,
    nl: '',
    source: 'book',
    desc: '',
    history: [],
  });
  charPortraitLib.entries.push({
    name,
    variants: [],
    selected: {
      prompt: 'p',
      seed: 1,
      anchorTag,
      thumb: '',
      vibe: { dataPath: `u_${name}`, thumbnailPath: '', modelKeys: ['v4-5full'], fingerprint },
    },
  });
}

function naiCharacters(names: string[]) {
  return names.map(name => ({ name, tag: '1girl', nl: '' }));
}

describe('generateImage: 角色人设 vibe 注入', () => {
  it('按提示词顺序注入到场角色的完整 NaiVibe,封顶 3 条', async () => {
    naiReady();
    seedCharVibe('甲');
    seedCharVibe('乙');
    seedCharVibe('丙');
    seedCharVibe('丁');
    await generateImage({ prompt: 'x', characters: naiCharacters(['甲', '乙', '丙', '丁']), seed: 1 });
    const values = vi.mocked(generateNaiImage).mock.calls[0][1];
    expect(values.extraVibes?.map(v => v.id)).toEqual(['charv_甲', 'charv_乙', 'charv_丙']);
    expect(values.extraVibes?.[0]).toEqual({
      id: 'charv_甲',
      name: '角色:甲',
      strength: 0.5,
      enabled: true,
      group: '角色',
      dataPath: 'u_甲',
      thumbnailPath: '',
      modelKeys: ['v4-5full'],
      hasImage: true,
      fingerprint: 'fp_甲',
    });
  });

  it('过期(anchorTag 与当前档不符)与缺档案/缺人设的角色被跳过', async () => {
    naiReady();
    seedCharVibe('新鲜的');
    seedCharVibe('过期的', 'fp_过期的', 'tag_老外观');
    charPortraitLib.entries.push({ name: '没人设', variants: [], selected: null });
    // 有档案但 charTags 里查无此名:无法核验过期,同样跳过
    charPortraitLib.entries.push({
      name: '查无档案',
      variants: [],
      selected: {
        prompt: 'p', seed: 1, anchorTag: 'tag_查无档案', thumb: '',
        vibe: { dataPath: 'u_查无档案', thumbnailPath: '', modelKeys: [], fingerprint: 'fp_查无档案' },
      },
    });
    await generateImage({
      prompt: 'x',
      characters: naiCharacters(['新鲜的', '过期的', '没人设', '查无档案']),
      seed: 1,
    });
    const values = vi.mocked(generateNaiImage).mock.calls[0][1];
    expect(values.extraVibes?.map(v => v.id)).toEqual(['charv_新鲜的']);
  });

  it('同指纹去重:同一人设图只叠一次', async () => {
    naiReady();
    seedCharVibe('甲', 'same_fp');
    seedCharVibe('乙', 'same_fp');
    await generateImage({ prompt: 'x', characters: naiCharacters(['甲', '乙']), seed: 1 });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1].extraVibes).toHaveLength(1);
  });

  it('提升为全局的角色照样注入:聊天库查不到时回落全局库', async () => {
    naiReady();
    // 只在 charTags(合并视图)建档 + 只在全局人设库放选中项——提升后聊天副本已删的形态
    charTagLib.entries.push({
      name: '全局角色', fields: emptyCharFields(), raw: 'tag_全局角色',
      nl: '', source: 'book', desc: '', history: [],
    });
    setGlobalCharPortraitSource(() => [{
      name: '全局角色',
      variants: [],
      selected: {
        prompt: 'p', seed: 1, anchorTag: 'tag_全局角色', thumb: '',
        vibe: { dataPath: 'u_全局角色', thumbnailPath: '', modelKeys: ['v4-5full'], fingerprint: 'fp_全局角色' },
      },
    }]);
    await generateImage({ prompt: 'x', characters: naiCharacters(['全局角色']), seed: 1 });
    const values = vi.mocked(generateNaiImage).mock.calls[0][1];
    expect(values.extraVibes?.map(v => v.id)).toEqual(['charv_全局角色']);
  });

  it('强度取自 settings.nai.charVibeStrength', async () => {
    naiReady();
    settings.nai.charVibeStrength = 0.8;
    seedCharVibe('甲');
    await generateImage({ prompt: 'x', characters: naiCharacters(['甲']), seed: 1 });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1].extraVibes?.[0].strength).toBe(0.8);
  });

  it('无人设可选时 values 不带 extraVibes(与既有形状零变化)', async () => {
    naiReady();
    const characters = [{ name: '路人', tag: '1girl', nl: '' }];
    await generateImage({ prompt: 'x', characters, seed: 1 });
    expect(vi.mocked(generateNaiImage).mock.calls[0][1].extraVibes).toBeUndefined();
  });

  it('ComfyUI 链路静默跳过:不查人设、不发 NAI 请求', async () => {
    comfyReady();
    seedCharVibe('甲');
    await generateImage({ prompt: 'x', characters: naiCharacters(['甲']), seed: 1 });
    expect(vi.mocked(generateComfyImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateNaiImage)).not.toHaveBeenCalled();
  });
});
