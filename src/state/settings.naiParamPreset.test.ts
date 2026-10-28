import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NAI 出图参数预设库(settings.nai.paramPresets)的清洗与应用。
 *
 * 与另两个库刻意相反的两条口径,是本文件的主要看点:
 * 1. **允许为空、不播种**——预设是用户自己攒的姿态,没有官方默认
 *    (工作流库恒非空、画师串库也为空,但那边有内置条);
 * 2. **不存 activeParamPresetId**——应用是「一键回填」,写完即断开,
 *    微调即偏离,追踪来源只会制造脏状态。
 *
 * 另有悬空画师串的回落口径:回落空串 = 不使用 + 返回 false 提示,
 * 与 normalizeNai 对 activeArtistId 的处理一致(不静默换别的)。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithNai(nai: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: nai === undefined ? {} : { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('NAI 参数预设 · 清洗', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('缺键/空库 → 空数组,不播种', async () => {
    const settings = await hydrateWithNai(undefined);
    expect(settings.nai.paramPresets).toEqual([]);
  });

  it('完好条目原样保留,含 undesiredContent 空串与 artistId 空串', async () => {
    const settings = await hydrateWithNai({
      paramPresets: [
        {
          id: 'npp_1',
          name: '精细出图',
          model: 'nai-diffusion-4-5-full',
          sampler: 'k_euler_ancestral',
          steps: 32,
          scale: 6,
          cfgRescale: 0.1,
          noiseSchedule: 'native',
          varietyBoost: false,
          undesiredContent: '',
          artistId: '',
        },
      ],
    });
    expect(settings.nai.paramPresets).toHaveLength(1);
    expect(settings.nai.paramPresets[0]).toMatchObject({
      id: 'npp_1',
      name: '精细出图',
      sampler: 'k_euler_ancestral',
      steps: 32,
      varietyBoost: false,
      undesiredContent: '',
      artistId: '',
    });
  });

  it('缺字段逐项回退;数值越界夹取(与渠道级同口径)', async () => {
    const settings = await hydrateWithNai({
      paramPresets: [
        { id: 'npp_1', name: '半条', steps: 999, scale: -5, cfgRescale: 3 },
      ],
    });
    const preset = settings.nai.paramPresets[0];
    expect(preset.steps).toBe(50);
    expect(preset.scale).toBe(0);
    expect(preset.cfgRescale).toBe(1);
    expect(preset.sampler).toBe('k_euler');
    expect(preset.noiseSchedule).toBe('karras');
    expect(preset.varietyBoost).toBe(true);
  });

  it('非对象/无 id 的条目整体丢弃,不连坐好条目', async () => {
    const settings = await hydrateWithNai({
      paramPresets: [null, 'junk', { name: '无 id' }, { id: 'npp_ok', name: '好条' }],
    });
    expect(settings.nai.paramPresets.map(p => p.id)).toEqual(['npp_ok']);
  });

  it('已下线模型回落第一个可用模型(与渠道级口径一致)', async () => {
    const settings = await hydrateWithNai({
      paramPresets: [{ id: 'npp_1', name: '老预设', model: 'nai-diffusion-3' }],
    });
    expect(settings.nai.paramPresets[0].model).toBe('nai-diffusion-5-full');
  });

  it('artistId 悬空原样保留(不在这里清洗,由应用侧回落)', async () => {
    const settings = await hydrateWithNai({
      paramPresets: [{ id: 'npp_1', name: '跨设备', artistId: 'art_gone' }],
    });
    expect(settings.nai.paramPresets[0].artistId).toBe('art_gone');
  });
});

describe('NAI 参数预设 · snapshot 与 apply', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('snapshot 拍下当前渠道级九件套,id 形状 npp_*', async () => {
    const settings = await hydrateWithNai({
      sampler: 'k_dpmpp_2m',
      steps: 23,
      scale: 4,
      undesiredContent: 'lowres',
    });
    settings.nai.artistPresets.push({ id: 'art_x', name: 'X', prompt: 'p', quality: '', negative: '' });
    settings.nai.activeArtistId = 'art_x';

    const { snapshotNaiParamPreset } = await import('@/state/settings');
    const preset = snapshotNaiParamPreset('我的姿态');
    expect(preset.id).toMatch(/^npp_\d+_\d+$/);
    expect(preset).toMatchObject({
      name: '我的姿态',
      sampler: 'k_dpmpp_2m',
      steps: 23,
      scale: 4,
      undesiredContent: 'lowres',
      artistId: 'art_x',
    });
  });

  it('apply 写回九件套;画师串在库时照常切换', async () => {
    const settings = await hydrateWithNai({});
    settings.nai.artistPresets.push({ id: 'art_x', name: 'X', prompt: 'p', quality: '', negative: '' });

    const { applyNaiParamPreset } = await import('@/state/settings');
    const ok = applyNaiParamPreset({
      id: 'npp_1',
      name: '一套',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler_ancestral',
      steps: 40,
      scale: 7,
      cfgRescale: 0.2,
      noiseSchedule: 'exponential',
      varietyBoost: false,
      undesiredContent: 'bad hands',
      artistId: 'art_x',
    });
    expect(ok).toBe(true);
    expect(settings.nai.model).toBe('nai-diffusion-4-5-full');
    expect(settings.nai.sampler).toBe('k_euler_ancestral');
    expect(settings.nai.steps).toBe(40);
    expect(settings.nai.scale).toBe(7);
    expect(settings.nai.cfgRescale).toBe(0.2);
    expect(settings.nai.noiseSchedule).toBe('exponential');
    expect(settings.nai.varietyBoost).toBe(false);
    expect(settings.nai.undesiredContent).toBe('bad hands');
    expect(settings.nai.activeArtistId).toBe('art_x');
  });

  it('画师串悬空 → 回落空串并返回 false;字段本身照常应用', async () => {
    const settings = await hydrateWithNai({});
    const { applyNaiParamPreset } = await import('@/state/settings');
    const ok = applyNaiParamPreset({
      id: 'npp_1',
      name: '一套',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler',
      steps: 28,
      scale: 5.5,
      cfgRescale: 0,
      noiseSchedule: 'karras',
      varietyBoost: true,
      undesiredContent: '',
      artistId: 'art_gone',
    });
    expect(ok).toBe(false);
    expect(settings.nai.activeArtistId).toBe('');
    expect(settings.nai.steps).toBe(28);
  });

  it('artistId 空串 = 不使用,返回 true(不是悬空)', async () => {
    const settings = await hydrateWithNai({});
    settings.nai.artistPresets.push({ id: 'art_x', name: 'X', prompt: 'p', quality: '', negative: '' });
    settings.nai.activeArtistId = 'art_x';

    const { applyNaiParamPreset } = await import('@/state/settings');
    const ok = applyNaiParamPreset({
      id: 'npp_1',
      name: '无画师串',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler',
      steps: 28,
      scale: 5.5,
      cfgRescale: 0,
      noiseSchedule: 'karras',
      varietyBoost: true,
      undesiredContent: '',
      artistId: '',
    });
    expect(ok).toBe(true);
    expect(settings.nai.activeArtistId).toBe('');
  });

  it('apply 不碰接入点/种子/并发(预设边界)', async () => {
    const settings = await hydrateWithNai({});
    settings.nai.seed = 12345;
    settings.nai.concurrency = 3;
    settings.nai.naturalLanguage = false;
    const beforeEndpoint = settings.nai.activeEndpointId;

    const { applyNaiParamPreset } = await import('@/state/settings');
    applyNaiParamPreset({
      id: 'npp_1',
      name: '一套',
      model: 'nai-diffusion-4-5-full',
      sampler: 'k_euler',
      steps: 28,
      scale: 5.5,
      cfgRescale: 0,
      noiseSchedule: 'karras',
      varietyBoost: true,
      undesiredContent: '',
      artistId: '',
    });
    expect(settings.nai.seed).toBe(12345);
    expect(settings.nai.concurrency).toBe(3);
    expect(settings.nai.naturalLanguage).toBe(false);
    expect(settings.nai.activeEndpointId).toBe(beforeEndpoint);
  });
});
