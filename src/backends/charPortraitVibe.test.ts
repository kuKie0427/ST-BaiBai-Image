import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeVibeImage } from '@/backends/nai';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import { makeJpegThumbnail } from '@/st/imageFile';
import { saveVibeFiles } from '@/backends/vibeStore';
import { setSelected } from '@/state/charPortraits';
import { settings } from '@/state/settings';
import type { GenerateOutput } from '@/generate';
import type { CharPortraitEntry } from '@/state/charPortraits';

vi.mock('@/generate', () => ({
  generateImage: vi.fn(),
  decideSeed: vi.fn(),
  backendStatus: vi.fn(),
}));
// nai 的 vibeModelKey 是纯函数,留原件;encodeVibeImage 是网络请求,换桩
vi.mock('@/backends/nai', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/nai')>()),
  encodeVibeImage: vi.fn(),
}));
// vibeFingerprint 同理留原件(指纹口径另有测试),saveVibeFiles 换桩
vi.mock('@/backends/vibeStore', async importOriginal => ({
  ...(await importOriginal<typeof import('@/backends/vibeStore')>()),
  saveVibeFiles: vi.fn(),
}));
vi.mock('@/floor/genQueue', () => ({ acquireNaiSlot: vi.fn<() => Promise<() => void>>() }));
vi.mock('@/st/imageFile', () => ({ makeJpegThumbnail: vi.fn() }));
// charPortraits 的 composePortraitPrompt(纯)留原件,只换会写库的 setSelected
vi.mock('@/state/charPortraits', async importOriginal => ({
  ...(await importOriginal<typeof import('@/state/charPortraits')>()),
  setSelected: vi.fn(),
}));

import { commitPortrait, generatePortraitCandidates } from '@/backends/charPortraitVibe';

const toastrMock = vi.hoisted(() => ({ warning: vi.fn() }));

function fakeOutput(seed: number): GenerateOutput {
  return {
    result: { url: `data:image/png;base64,IMG${seed}`, filename: 'x.png', format: 'png', revoke: vi.fn() },
    seed,
    size: 'portrait',
    backend: 'nai',
    charactersApplied: true,
    meta: {
      backend: 'nai',
      model: 'nai-diffusion-4-5-full',
      width: 0,
      height: 0,
      positive: '',
      negative: '',
      artist: null,
      vibes: [],
      params: {},
    },
  };
}

function entry(): CharPortraitEntry {
  return {
    name: '小样',
    variants: [
      { extra: 'school uniform, standing', nl: 'a portrait' },
      { extra: 'cafe, sitting', nl: 'in a cafe' },
      { extra: 'night street', nl: 'mood shot' },
    ],
    selected: null,
  };
}

function naiReady(): void {
  settings.nai.endpoints = [{ id: 'nep_official', name: 'NovelAI 官方', url: 'https://image.novelai.net', key: 'k' }];
  settings.nai.activeEndpointId = 'nep_official';
  settings.nai.model = 'nai-diffusion-4-5-full';
}

let release: ReturnType<typeof vi.fn<() => void>>;
let seedSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('toastr', toastrMock);
  vi.mocked(backendStatus).mockReturnValue({
    backend: 'nai',
    configured: true,
    model: 'nai-diffusion-4-5-full',
    supportsCharacters: true,
    reason: '',
  });
  seedSeq = 0;
  vi.mocked(decideSeed).mockImplementation(() => ++seedSeq);
  naiReady();

  release = vi.fn();
  vi.mocked(acquireNaiSlot).mockResolvedValue(release);
  vi.mocked(encodeVibeImage).mockResolvedValue('ENC');
  vi.mocked(makeJpegThumbnail).mockResolvedValue('data:image/jpeg;base64,THUMB');
  vi.mocked(saveVibeFiles).mockResolvedValue({ dataPath: '/f/bbi-vibe-charv.json', thumbnailPath: '/f/thumb.jpg' });
  vi.mocked(setSelected).mockReturnValue(true);
});

describe('generatePortraitCandidates', () => {
  it('逐张串行生成,提示词=外观 tag 逐字+变体 extra,单角色 portrait', async () => {
    let active = 0;
    vi.mocked(generateImage).mockImplementation(async input => {
      // 串行纪律的硬断言:任一时刻只允许一张在飞
      if (++active > 1) throw new Error('候选并发生成了');
      try {
        return fakeOutput(input.seed);
      } finally {
        active--;
      }
    });

    const candidates = await generatePortraitCandidates(entry(), 'silver hair, red eyes');

    expect(candidates).toHaveLength(3);
    expect(candidates.map(c => c.prompt)).toEqual([
      'silver hair, red eyes, school uniform, standing',
      'silver hair, red eyes, cafe, sitting',
      'silver hair, red eyes, night street',
    ]);
    expect(candidates.map(c => c.seed)).toEqual([1, 2, 3]);
    expect(candidates.map(c => c.variantIndex)).toEqual([0, 1, 2]);
    expect(candidates[0]?.dataUrl).toBe('data:image/png;base64,IMG1');

    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(generateImage).mock.calls[0]?.[0]).toEqual({
      prompt: 'silver hair, red eyes, school uniform, standing',
      nl: 'a portrait',
      characters: [{ name: '小样', tag: 'silver hair, red eyes, school uniform, standing', nl: 'a portrait' }],
      size: 'portrait',
      seed: 1,
    });
    expect(vi.mocked(decideSeed)).toHaveBeenCalledWith('nai');
  });

  it('单张失败跳过该槽位,不占位也不连坐', async () => {
    vi.mocked(generateImage)
      .mockResolvedValueOnce(fakeOutput(1))
      .mockRejectedValueOnce(new Error('429 冷却中'))
      .mockResolvedValueOnce(fakeOutput(3));

    const candidates = await generatePortraitCandidates(entry(), 'app');

    expect(candidates.map(c => c.variantIndex)).toEqual([0, 2]);
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(3);
  });

  it('取消(AbortError)整体抛出', async () => {
    vi.mocked(generateImage)
      .mockResolvedValueOnce(fakeOutput(1))
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));

    await expect(generatePortraitCandidates(entry(), 'app')).rejects.toThrow('aborted');
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(2);
  });

  it('signal 已取消时直接抛 AbortError,不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generatePortraitCandidates(entry(), 'app', controller.signal)).rejects.toThrow(
      '人设图候选生成已取消',
    );
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
  });

  it('变体超过 3 条时截断到 3(与库内归一化同一上限)', async () => {
    const many = entry();
    many.variants.push({ extra: 'fourth', nl: '' });
    vi.mocked(generateImage).mockImplementation(async input => fakeOutput(input.seed));

    await generatePortraitCandidates(many, 'app');
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(3);
  });
});

describe('commitPortrait', () => {
  const input = {
    name: '小样',
    appearanceTag: 'silver hair, red eyes',
    dataUrl: 'data:image/png;base64,QUJD',
    prompt: 'silver hair, red eyes, school uniform',
    seed: 42,
  };

  it('编码持闸门且 finally 释放;缩略图/base64/指纹/落盘口径与 NaiPanel 一致', async () => {
    const selected = await commitPortrait(input);

    // base64 剥前缀 + 按当前模型编码
    expect(vi.mocked(encodeVibeImage)).toHaveBeenCalledTimes(1);
    const encodeArgs = vi.mocked(encodeVibeImage).mock.calls[0];
    expect(encodeArgs?.[1]).toBe('QUJD');
    expect(encodeArgs?.[2]).toBe('nai-diffusion-4-5-full');
    // 闸门:取一次,成功路径也必须释放
    expect(vi.mocked(acquireNaiSlot)).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);

    expect(vi.mocked(makeJpegThumbnail)).toHaveBeenCalledWith(input.dataUrl, 96);

    const data = vi.mocked(saveVibeFiles).mock.calls[0]?.[0];
    expect(data).toEqual({
      image: 'QUJD',
      thumbnail: 'data:image/jpeg;base64,THUMB',
      encodings: { 'v4-5full': { encoding: 'ENC', infoExtracted: 1 } },
    });
    expect(vi.mocked(saveVibeFiles).mock.calls[0]?.[1]).toBeNull();
    expect(vi.mocked(saveVibeFiles).mock.calls[0]?.[2]).toMatch(/^charv_小样_/);

    expect(vi.mocked(setSelected)).toHaveBeenCalledWith('小样', {
      prompt: input.prompt,
      seed: 42,
      anchorTag: 'silver hair, red eyes',
      thumb: 'data:image/jpeg;base64,THUMB',
      vibe: {
        dataPath: '/f/bbi-vibe-charv.json',
        thumbnailPath: '/f/thumb.jpg',
        modelKeys: ['v4-5full'],
        // 单编码的指纹 = key:encoding 前 64 字符(vibeFingerprint 口径)
        fingerprint: 'v4-5full:ENC',
      },
    });
    expect(selected).toMatchObject({ prompt: input.prompt, seed: 42 });
    expect(toastrMock.warning).not.toHaveBeenCalled();
  });

  it('编码失败:toastr 提示、返回 null、闸门仍释放、不落库', async () => {
    vi.mocked(encodeVibeImage).mockRejectedValue(new Error('vibe 编码失败 (429)'));

    await expect(commitPortrait(input)).resolves.toBeNull();

    expect(toastrMock.warning).toHaveBeenCalledWith('vibe 编码失败 (429)', '人设图');
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveVibeFiles)).not.toHaveBeenCalled();
    expect(vi.mocked(setSelected)).not.toHaveBeenCalled();
  });

  it('缩略图失败不致命:thumb 存空串,流程照走', async () => {
    vi.mocked(makeJpegThumbnail).mockRejectedValue(new Error('图片加载失败'));

    const selected = await commitPortrait(input);

    expect(selected?.thumb).toBe('');
    expect(vi.mocked(setSelected)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setSelected).mock.calls[0]?.[1].thumb).toBe('');
  });

  it('入库被拒(setSelected false)同样走 toastr + null', async () => {
    vi.mocked(setSelected).mockReturnValue(false);

    await expect(commitPortrait(input)).resolves.toBeNull();
    expect(toastrMock.warning).toHaveBeenCalledTimes(1);
  });
});
