import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

/**
 * ui.overlayBlur 与 settings.ui.overlayBlur 的镜像。
 *
 * 两处 watch 是手写的字段清单:settings → ui 的 hydrate 回灌漏了字段,刷新后开关显示成
 * 默认值;ui → settings 的写回漏了字段,拨了开关却存不住。两边都必须覆盖。
 */

const mocks = vi.hoisted(() => ({
  context: null as Record<string, any> | null,
}));

vi.mock('@/st/context', () => ({
  getContext: () => mocks.context,
}));

async function bootWithUi(ui: Record<string, unknown> | undefined) {
  mocks.context = {
    extensionSettings: { baibai_image: ui === undefined ? {} : { ui } },
    saveSettingsDebounced: vi.fn(),
  };
  // 先建 ui(import 阶段读默认值)再 hydrate,复现真实启动顺序
  const { ui: state } = await import('@/state/ui');
  const settingsMod = await import('@/state/settings');
  await settingsMod.hydrateSettings();
  await nextTick();
  return { state, settings: settingsMod.settings };
}

describe('ui.overlayBlur ↔ settings.ui.overlayBlur', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), error: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
  });

  it('hydrate 回灌:settings 里存着 false → ui 也是 false', async () => {
    const { state } = await bootWithUi({ overlayBlur: false });
    expect(state.overlayBlur).toBe(false);
  });

  it('缺省时 ui 取默认 true', async () => {
    const { state } = await bootWithUi({});
    expect(state.overlayBlur).toBe(true);
  });

  it('拨动 ui → 写回 settings.ui(否则刷新即丢)', async () => {
    const { state, settings } = await bootWithUi({});
    state.overlayBlur = false;
    await nextTick();
    expect(settings.ui.overlayBlur).toBe(false);

    state.overlayBlur = true;
    await nextTick();
    expect(settings.ui.overlayBlur).toBe(true);
  });
});
