import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * nai.charVibeStrength(角色人设 vibe 强度)的设置口径。
 *
 * 最大看点是 normalizeNai 往返:normalizeNai 是**逐字段重建**对象,新字段忘了挂进
 * 白名单的话,每次 hydrate 都会把它静默抹回默认值——用户调的强度永远存不住。
 * 故这里的断言必须落在「存进去 → hydrate 出来还在」,而不只是默认值/夹取。
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

describe('nai.charVibeStrength', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('缺省 0.5(与产品决策的默认强度一致)', async () => {
    const settings = await hydrateWithNai({});
    expect(settings.nai.charVibeStrength).toBe(0.5);
  });

  it.each([
    ['高于上限', 2, 1],
    ['低于下限', -0.3, 0],
    ['合法值原样保留', 0.65, 0.65],
  ])('%s:%s → %s', async (_label, stored, expected) => {
    const settings = await hydrateWithNai({ charVibeStrength: stored });
    expect(settings.nai.charVibeStrength).toBe(expected);
  });

  it('非数字回落默认而不是被 Number() 成 0(vibeStore.clampVibeStrength 同口径)', async () => {
    const settings = await hydrateWithNai({ charVibeStrength: null });
    expect(settings.nai.charVibeStrength).toBe(0.5);
  });

  it('normalizeNai 往返存活:hydrate 出来的值就是存进去的值(Momus 修复)', async () => {
    const settings = await hydrateWithNai({ charVibeStrength: 0.8 });
    expect(settings.nai.charVibeStrength).toBe(0.8);
  });
});
