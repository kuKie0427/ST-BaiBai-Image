import { CHAR_VIBE_CAP } from '@/backends/nai';
import { clampVibeStrength } from '@/backends/vibeStore';
import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { resolveCharPortrait, isPortraitStale } from '@/state/charPortraits';
import { buildEntryTag, findCharTag } from '@/state/charTags';
import type { NaiVibe } from '@/state/settings';

/**
 * 把出场角色映射成可叠加的角色人设 vibe(NAI 专用,ComfyUI 静默跳过)。
 *
 * 逐个判定:有选中人设(本聊天库优先,没有再查全局库——提升为全局的角色
 * 在提升后聊天副本已删,只活在全局库里)→ 档案还在且未过期(anchorTag 与当前档的 buildEntryTag
 * 一致)→ 指纹未重复 → 未超 CHAR_VIBE_CAP。任何一环不满足就跳过该角色,
 * 不降级、不报错——人设 vibe 是锦上添花,不该挡住正图。
 * 只组装元数据(完整 NaiVibe,含 loadVibeData 必需的 dataPath);
 * 正文加载统一在 generateNaiImage 里做,这里不预读。
 */
export function resolveCharVibes(
  characters: readonly ImageCharacterPrompt[],
  strength: number,
): NaiVibe[] {
  const picked: NaiVibe[] = [];
  const seenFingerprints = new Set<string>();
  for (const character of characters) {
    if (picked.length >= CHAR_VIBE_CAP) break;
    const portrait = resolveCharPortrait(character.name);
    const vibe = portrait?.selected?.vibe;
    if (!portrait?.selected || !vibe) continue;
    const tagEntry = findCharTag(portrait.name);
    if (!tagEntry) continue;
    if (isPortraitStale(portrait, buildEntryTag(tagEntry))) continue;
    if (seenFingerprints.has(vibe.fingerprint)) continue;
    seenFingerprints.add(vibe.fingerprint);
    picked.push({
      id: `charv_${portrait.name}`,
      name: `角色:${portrait.name}`,
      strength: clampVibeStrength(strength),
      enabled: true,
      group: '角色',
      dataPath: vibe.dataPath,
      thumbnailPath: vibe.thumbnailPath,
      modelKeys: vibe.modelKeys,
      hasImage: true,
      fingerprint: vibe.fingerprint,
    });
  }
  return picked;
}
