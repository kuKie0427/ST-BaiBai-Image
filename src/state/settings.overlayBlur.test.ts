import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * settings.ui.overlayBlur(窗口背景模糊)的存储口径。
 *
 * normalize 的 ui 段是**逐字段重建**对象:新字段不进白名单就会在每次 hydrate 时
 * 被静默抹回默认值,用户关了模糊、刷新一次又糊回来。故断言必须落在「存进去 →
 * hydrate 出来还在」,而不只是默认值。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function hydrateWithUi(ui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: ui === undefined ? {} : { ui } },
    saveSettingsDebounced: vi.fn(),
  };
  const { hydrateSettings, settings } = await import('@/state/settings');
  await hydrateSettings();
  return settings;
}

describe('settings.ui.overlayBlur', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('缺省为 true:老配置升级后行为不变,窗口照旧模糊', async () => {
    const settings = await hydrateWithUi({ theme: 'st' });
    expect(settings.ui.overlayBlur).toBe(true);
  });

  it('关掉后往返存活:hydrate 出来仍是 false', async () => {
    const settings = await hydrateWithUi({ overlayBlur: false });
    expect(settings.ui.overlayBlur).toBe(false);
  });

  it('开着的值也原样保留', async () => {
    const settings = await hydrateWithUi({ overlayBlur: true });
    expect(settings.ui.overlayBlur).toBe(true);
  });

  it.each([
    ['字符串 "false"', 'false'],
    ['数字 0', 0],
    ['null', null],
  ])('非布尔脏值 %s → 回落默认 true,不抛错', async (_label, stored) => {
    const settings = await hydrateWithUi({ overlayBlur: stored });
    expect(settings.ui.overlayBlur).toBe(true);
  });
});
