import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type VNode } from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';

import PortraitModal from './PortraitModal.vue';
import { backendStatus } from '@/generate';

/**
 * 人设图弹窗的组件级测试(基座照抄 gallery/index.test.ts:自定义内存渲染器 + 客户端模板编译)。
 *
 * 只验「组件是否按 store 状态渲染、操作是否按预期接到 store」——串行/取消/清洗等规则
 * 已由 portraitModalState.test.ts 覆盖,这里不重复。
 */
vi.mock('@/components/Icon.vue', () => ({ default: () => null }));
vi.mock('@/components/ModalMask.vue', () => ({
  // 弹窗壳换成恒开的 div,省掉 Teleport/Transition
  default: {
    props: ['open'],
    setup: (_props: unknown, ctx: { slots: { default?: () => VNode[] } }) => () =>
      h('div', { class: 'mask' }, ctx.slots.default ? ctx.slots.default() : []),
  },
}));
vi.mock('@/components/BbiTextarea.vue', () => ({
  default: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup: (props: { modelValue: string }, { emit }: { emit: (event: string, value: string) => void }) => () =>
      h('textarea', {
        class: 'fake-textarea',
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
      }),
  },
}));
vi.mock('@/generate', () => ({ backendStatus: vi.fn() }));
vi.mock('@/backends/charPortraitVibe', () => ({ generatePortraitCandidates: vi.fn(), commitPortrait: vi.fn() }));
vi.mock('@/api/client', () => ({ requestCompletion: vi.fn(), requestViaMainApi: vi.fn() }));
vi.mock('@/state/settings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/state/settings')>()),
  getTagGenChannel: vi.fn(),
}));
vi.mock('@/st/context', () => ({ getContext: () => null }));

import { generatePortraitCandidates } from '@/backends/charPortraitVibe';
import type { PortraitCandidate } from '@/backends/charPortraitVibe';
import { getPortraitSession, generateSlot, resetPortraitModalState, setSlotExtra } from './portraitModalState';

const { descriptor } = parse(readFileSync(new URL('./PortraitModal.vue', import.meta.url), 'utf8'));
const template = compileTemplate({
  source: descriptor.template!.content,
  filename: 'PortraitModal.vue',
  id: 'portrait-modal-test',
  compilerOptions: {
    mode: 'function',
    bindingMetadata: compileScript(descriptor, { id: 'portrait-modal-test' }).bindings,
  },
});
if (template.errors.length) throw new Error(template.errors.join('\n'));
const ClientModal = { ...PortraitModal, render: new Function('Vue', template.code)(Vue) };

interface TestNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: TestNode[];
  parent: TestNode | null;
}

function node(type: string, text = ''): TestNode {
  return { type, text, props: {}, children: [], parent: null };
}

function remove(child: TestNode): void {
  if (!child.parent) return;
  child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}

function insert(child: TestNode, parent: TestNode, anchor?: TestNode | null): void {
  remove(child);
  parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child);
  child.parent = parent;
}

const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type),
  createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (target, text) => {
    target.text = text;
  },
  setElementText: (target, text) => {
    target.text = text;
    target.children = [];
  },
  patchProp: (target, key, _previous, value) => {
    target.props[key] = value;
  },
  parentNode: target => target.parent,
  nextSibling: target => {
    const siblings = target.parent?.children ?? [];
    return siblings[siblings.indexOf(target) + 1] ?? null;
  },
  insert,
  remove,
  insertStaticContent: (content, parent, anchor) => {
    const target = node('#static', content);
    insert(target, parent, anchor);
    return [target, target];
  },
});

function find(root: TestNode, selector: string): TestNode[] {
  const classes = selector.startsWith('.') ? selector.slice(1).split('.') : null;
  const own = String(root.props.class ?? '');
  const matches = classes
    ? classes.every(name => own.split(/\s+/).includes(name))
    : root.type === selector;
  return [...(matches ? [root] : []), ...root.children.flatMap(child => find(child, selector))];
}

function text(target: TestNode): string {
  return target.text + target.children.map(text).join('');
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await nextTick();
}

async function click(target: TestNode): Promise<void> {
  (target.props.onClick as () => void)();
  await nextTick();
}

function candidate(prompt: string, seed: number): PortraitCandidate {
  return { dataUrl: `data:image/png;base64,${seed}`, prompt, seed, variantIndex: 0 };
}

let app: ReturnType<typeof renderer.createApp> | undefined;
let events: { close: number; committed: unknown[] };

async function mount(props: Record<string, unknown> = {}): Promise<TestNode> {
  app?.unmount();
  const root = node('root');
  events = { close: 0, committed: [] };
  app = renderer.createApp(ClientModal, {
    open: true,
    name: '阿黛尔',
    appearanceTag: 'long silver hair, red eyes',
    variants: [],
    selected: null,
    ...props,
    onClose: () => {
      events.close++;
    },
    onCommitted: (value: unknown) => {
      events.committed.push(value);
    },
  });
  app.provide(ssrContextKey, {});
  app.mount(root);
  await flush();
  return root;
}

beforeEach(() => {
  vi.stubGlobal('toastr', { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() });
  vi.mocked(backendStatus).mockReturnValue({
    backend: 'nai',
    configured: true,
    model: 'nai-diffusion-4-5-full',
    supportsCharacters: true,
    reason: '',
  });
  resetPortraitModalState();
  // 候选 prompt 与服务层一致:外观逐字 + 变体 extra(否则会被判「提示词已改」)
  vi.mocked(generatePortraitCandidates).mockImplementation(async (entry, appearanceTag) =>
    [candidate(`${appearanceTag}, ${entry.variants[0].extra}`, 11)],
  );
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.clearAllMocks();
});

describe('PortraitModal', () => {
  it('renders 3 slots with the read-only appearance and composed previews', async () => {
    const root = await mount();
    expect(find(root, '.bbi-pslot')).toHaveLength(3);
    expect(find(root, '.bbi-portrait-appearance')[0]).toBeTruthy();
    expect(text(find(root, '.bbi-portrait-appearance')[0])).toContain('long silver hair, red eyes');
    const previews = find(root, '.bbi-pslot-composed').map(text);
    expect(previews).toHaveLength(3);
    expect(previews.every(preview => preview.startsWith('long silver hair, red eyes, '))).toBe(true);
    // 初始没有候选 → 「使用这张」全部禁用
    const useButtons = find(root, '.bbi-pslot-use');
    expect(useButtons).toHaveLength(3);
    expect(useButtons.every(button => button.props.disabled === true)).toBe(true);
  });

  it('disables generation and explains the NAI-only limitation on other backends', async () => {
    vi.mocked(backendStatus).mockReturnValue({
      backend: 'comfyui',
      configured: true,
      model: 'workflow',
      supportsCharacters: false,
      reason: '',
    });
    const root = await mount();
    expect(find(root, '.bbi-portrait-gate').map(text)).toEqual(['人设图参考目前仅支持 NovelAI 渠道']);
    expect(find(root, '.bbi-btn-primary')[0].props.disabled).toBe(true);
  });

  it('shows the stale pill with the anchor tag of an outdated portrait', async () => {
    const root = await mount({
      selected: {
        prompt: 'old prompt',
        seed: 1,
        anchorTag: 'long blue hair',
        thumb: 'data:image/jpeg;base64,T',
        vibe: { dataPath: 'f', thumbnailPath: '', modelKeys: ['m'], fingerprint: 'fp' },
      },
    });
    const pill = find(root, '.bbi-portrait-pill.is-stale');
    expect(pill.map(node => text(node).trim())).toEqual(['人设图已过期']);
    expect(text(find(root, '.bbi-portrait-anchor')[0])).toContain('long blue hair');
  });

  it('renders finished candidates from the store and marks the ready slot', async () => {
    const root = await mount();
    generateSlot('阿黛尔', 1);
    await flush();
    const session = getPortraitSession('阿黛尔')!;
    await vi.waitFor(() => expect(session.slots[1].candidate).not.toBeNull());
    await flush();

    expect(find(root, '.bbi-pslot-img')).toHaveLength(1);
    expect(find(root, '.bbi-pslot-img')[0].props.src).toBe('data:image/png;base64,11');
    const useButtons = find(root, '.bbi-pslot-use');
    expect(useButtons[1].props.disabled).toBe(false);
    expect(useButtons[0].props.disabled).toBe(true);
  });

  it('editing a slot writes through to the store and updates the preview', async () => {
    const root = await mount();
    const textareas = find(root, '.fake-textarea');
    expect(textareas).toHaveLength(3);
    (textareas[0].props.onInput as (event: { target: { value: string } }) => void)({
      target: { value: 'night street, coat' },
    });
    await nextTick();
    expect(getPortraitSession('阿黛尔')!.slots[0].extra).toBe('night street, coat');
    expect(text(find(root, '.bbi-pslot-composed')[0])).toBe('long silver hair, red eyes, night street, coat');
  });

  it('marks a candidate whose prompt was edited after generation', async () => {
    const root = await mount();
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(getPortraitSession('阿黛尔')!.slots[0].phase).toBe('ready'));
    await flush();
    expect(find(root, '.bbi-pslot-stale')).toHaveLength(0);

    setSlotExtra('阿黛尔', 0, 'something else');
    await flush();
    expect(find(root, '.bbi-pslot-stale').map(node => text(node).trim())).toEqual(['提示词已改']);
  });

  it('「编辑提示词」collapses the editor while keeping the composed preview visible', async () => {
    const root = await mount();
    const toggles = find(root, '.bbi-pslot-link');
    expect(text(toggles[0])).toContain('完成编辑');
    await click(toggles[0]);
    expect(text(find(root, '.bbi-pslot-link')[0])).toContain('编辑提示词');
    expect(find(root, '.fake-textarea')).toHaveLength(2);
    expect(find(root, '.bbi-pslot-composed')).toHaveLength(3);
  });

  it('「取消」only appears while a slot is generating', async () => {
    vi.mocked(generatePortraitCandidates).mockImplementation(() => new Promise(() => {}));
    const root = await mount();
    expect(find(root, '.bbi-pslot-cancel')).toHaveLength(0);
    generateSlot('阿黛尔', 0);
    await flush();
    expect(find(root, '.bbi-pslot-cancel').length).toBeGreaterThan(0);
  });

  it('reopening after a close picks the in-flight job back up from the store', async () => {
    let resolving: ((value: PortraitCandidate[]) => void) | null = null;
    vi.mocked(generatePortraitCandidates).mockImplementation(
      () => new Promise(resolve => {
        resolving = resolve;
      }),
    );
    const first = await mount();
    generateSlot('阿黛尔', 0);
    await flush();
    expect(find(first, '.bbi-pslot-busy')).toHaveLength(1);

    // 关窗:只是不渲染,任务不取消
    const closed = await mount({ open: false });
    expect(find(closed, '.bbi-pslot')).toHaveLength(0);
    expect(getPortraitSession('阿黛尔')!.slots[0].phase).toBe('generating');

    // 重开:认领回进行中状态,任务完成后出图
    const reopened = await mount();
    expect(find(reopened, '.bbi-pslot-busy')).toHaveLength(1);
    resolving!([candidate('silver hair, school uniform', 3)]);
    await vi.waitFor(() => expect(getPortraitSession('阿黛尔')!.slots[0].phase).toBe('ready'));
    await flush();
    expect(find(reopened, '.bbi-pslot-img')).toHaveLength(1);
  });

  it('seeds the default triplet when the archive has no variants', async () => {
    const root = await mount();
    const previews = find(root, '.bbi-pslot-composed').map(text);
    expect(previews[0]).toContain('school uniform, standing, full body, simple background');
    expect(previews[1]).toContain('casual clothes, sitting, cafe, smile');
    expect(previews[2]).toContain('coat, night street, upper body, looking back');
  });

  it('commits the picked candidate and asks the parent to refresh', async () => {
    const { commitPortrait } = await import('@/backends/charPortraitVibe');
    vi.mocked(commitPortrait).mockResolvedValue({
      prompt: 'silver hair, school uniform',
      seed: 3,
      anchorTag: 'long silver hair, red eyes',
      thumb: 'data:image/jpeg;base64,T',
      vibe: { dataPath: 'f', thumbnailPath: '', modelKeys: ['m'], fingerprint: 'fp' },
    });
    const root = await mount();
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(getPortraitSession('阿黛尔')!.slots[0].phase).toBe('ready'));
    await flush();

    await click(find(root, '.bbi-pslot-use')[0]);
    await flush();

    expect(commitPortrait).toHaveBeenCalledTimes(1);
    expect(events.committed).toHaveLength(1);
    expect(events.close).toBe(1);
  });

  it('keeps the modal open when the commit fails', async () => {
    const { commitPortrait } = await import('@/backends/charPortraitVibe');
    vi.mocked(commitPortrait).mockResolvedValue(null);
    const root = await mount();
    generateSlot('阿黛尔', 0);
    await vi.waitFor(() => expect(getPortraitSession('阿黛尔')!.slots[0].phase).toBe('ready'));
    await flush();

    await click(find(root, '.bbi-pslot-use')[0]);
    await flush();

    expect(events.committed).toHaveLength(0);
    expect(events.close).toBe(0);
  });

  it('drops a slot back to idle when the user cancels the redraw', async () => {
    vi.mocked(generatePortraitCandidates).mockImplementation((_entry, _tag, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    );
    const root = await mount();
    generateSlot('阿黛尔', 2);
    await flush();
    await click(find(root, '.bbi-pslot-cancel')[0]);
    await flush();
    expect(getPortraitSession('阿黛尔')!.slots[2].phase).toBe('idle');
    expect(find(root, '.bbi-pslot-busy')).toHaveLength(0);
  });

  it('keeps manually edited extra across a remount with the same archive variants', async () => {
    await mount();
    setSlotExtra('阿黛尔', 0, '我的 outfit');
    const root = await mount({
      variants: [{ extra: 'fresh from ai', nl: '' }],
    });
    expect(text(find(root, '.bbi-pslot-composed')[0])).toBe('long silver hair, red eyes, 我的 outfit');
  });
});
