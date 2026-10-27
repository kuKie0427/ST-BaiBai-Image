/**
 * 角色人设图的候选生成与选中落库(Task 5 的服务层)。
 *
 * 两条职责,分别对应人设图流程的前后两半:
 *
 * - generatePortraitCandidates:按变体逐条经 generateImage 出候选图。
 *   **串行**是刻意的——generateImage 内部过 NAI 闸门,但一次并排 3 张仍然是
 *   3 条并发请求砸向账号;逐张来才能与「同槽位出图」共用同一条 429 纪律。
 * - commitPortrait:用户选定后,缩略图 + vibe 编码(持闸门)+ 落盘 + setSelected。
 *
 * Momus 复查钉死的三个口径(与 NaiPanel 手动导入 vibe 完全一致):
 *   1. 缩略图走 makeJpegThumbnail(dataUrl, 96),失败回空串;
 *   2. base64 用 dataUrl.split(',')[1] 剥前缀;
 *   3. encodeVibeImage 是一次真实 NAI 请求,必须包在 acquireNaiSlot() 里,
 *      release 放 finally(NaiPanel.vue encodeVibeGated 原样)。
 */

import type { ImageCharacterPrompt } from '@/autoTag/protocol';
import { encodeVibeImage, vibeModelKey } from '@/backends/nai';
import { saveVibeFiles, vibeFingerprint } from '@/backends/vibeStore';
import { acquireNaiSlot } from '@/floor/genQueue';
import { backendStatus, decideSeed, generateImage } from '@/generate';
import {
  composePortraitPrompt,
  setSelected,
  type CharPortraitEntry,
  type CharPortraitSelected,
} from '@/state/charPortraits';
import { effectiveNai, settings, type NaiVibeData } from '@/state/settings';
import { makeJpegThumbnail } from '@/st/imageFile';

/** 一张候选图:足够「重绘 / 再编码」复现,不多带废话。 */
export interface PortraitCandidate {
  /** 图片本体(dataURL)。 */
  dataUrl: string;
  /** 发出的完整提示词(外观 tag 逐字 + 变体 extra)。重绘以它为准。 */
  prompt: string;
  /** 本次实际使用的种子(原样回传自 generateImage)。 */
  seed: number;
  /** 来自第几条变体(0-based),选中后能对应回 entry.variants。 */
  variantIndex: number;
}

export interface CommitPortraitInput {
  /** 角色名(charPortraits 库的键)。 */
  name: string;
  /** 选定当时的外观 tag 快照,原样存为 anchorTag(过期判定的锚点)。 */
  appearanceTag: string;
  /** 选中的候选图 dataURL。 */
  dataUrl: string;
  /** 该候选的完整提示词(随图记录)。 */
  prompt: string;
  /** 该候选的种子(随图记录)。 */
  seed: number;
}

const CANDIDATE_LIMIT = 3;
const THUMB_EDGE = 96;
/** NaiPanel 的 encodeVibeGated 用的是 infoExtracted 默认值 1,同口径。 */
const DEFAULT_INFO_EXTRACTED = 1;

let commitSeq = 0;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 缩略图失败不致命:回空串,由入库/展示方按「无缩略图」处理(NaiPanel makeThumbnail 同款)。 */
async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    return await makeJpegThumbnail(dataUrl, THUMB_EDGE);
  } catch {
    return '';
  }
}

/**
 * 按变体逐张生成候选。**串行**调用 generateImage(闸门/限流共用,见模块头)。
 *
 * 失败槽位的口径:**跳过,不占位**——返回数组只含成功出图的变体,variantIndex
 * 保留原下标,UI 仍能对回变体;取消(AbortError)则整体抛出,已生成的候选一并放弃,
 * 由调用方决定是否保留。不走楼层/gallery 落盘:generateImage 本就只出图不落盘,
 * 这里什么都不补,「未选定不入库」由本函数结构保证。
 */
export async function generatePortraitCandidates(
  entry: CharPortraitEntry,
  appearanceTag: string,
  signal?: AbortSignal,
): Promise<PortraitCandidate[]> {
  const candidates: PortraitCandidate[] = [];
  const variants = entry.variants.slice(0, CANDIDATE_LIMIT);
  const backend = backendStatus().backend;
  for (let index = 0; index < variants.length; index++) {
    if (signal?.aborted) throw new DOMException('人设图候选生成已取消', 'AbortError');
    const variant = variants[index];
    if (!variant) continue;
    const tag = composePortraitPrompt(appearanceTag, variant);
    const characters: ImageCharacterPrompt[] = [{ name: entry.name, tag, nl: variant.nl }];
    try {
      const output = await generateImage(
        {
          prompt: tag,
          nl: variant.nl,
          characters,
          size: 'portrait',
          seed: decideSeed(backend),
        },
        signal,
      );
      candidates.push({
        dataUrl: output.result.url,
        prompt: tag,
        seed: output.seed,
        variantIndex: index,
      });
    } catch (error) {
      // 取消是调用方的决定,整体抛出让它收场;单张失败只是少一张候选。
      if (isAbortError(error) || signal?.aborted) throw error;
    }
  }
  return candidates;
}

/** 取闸门槽位跑一次 vibe 编码(NaiPanel.vue encodeVibeGated 原样拷贝)。 */
async function encodeVibeGated(imageBase64: string): Promise<string> {
  const release = await acquireNaiSlot();
  try {
    return await encodeVibeImage(effectiveNai(), imageBase64, settings.nai.model);
  } finally {
    release();
  }
}

/**
 * 选定即落库:缩略图 → vibe 编码(持闸门)→ saveVibeFiles → setSelected。
 *
 * 失败口径:**toastr 提示后返回 null,不 rethrow**——调用方(选图弹窗)对失败的
 * 反应是「留着弹窗让用户重选/重试」,异常没有第二个消费者,抛出去反而逼每个
 * 调用点都写一层 try/catch。成功返回实际构造的选中项快照(setSelected 内部
 * 还会做一次宽容归一化,字段口径与本函数构造的一致)。
 */
export async function commitPortrait(input: CommitPortraitInput): Promise<CharPortraitSelected | null> {
  const imageBase64 = input.dataUrl.split(',')[1] ?? '';
  const modelKey = vibeModelKey(settings.nai.model);
  try {
    // 缩略图先做:canvas 活不该占着 NAI 并发槽
    const thumb = await makeThumbnail(input.dataUrl);
    const encoding = await encodeVibeGated(imageBase64);
    const data: NaiVibeData = {
      image: imageBase64,
      thumbnail: thumb,
      encodings: { [modelKey]: { encoding, infoExtracted: DEFAULT_INFO_EXTRACTED } },
    };
    const paths = await saveVibeFiles(data, null, `charv_${input.name}_${Date.now()}_${++commitSeq}`);
    const selected: CharPortraitSelected = {
      prompt: input.prompt,
      seed: Math.trunc(input.seed) || 0,
      anchorTag: input.appearanceTag.trim(),
      thumb,
      vibe: {
        dataPath: paths.dataPath,
        thumbnailPath: paths.thumbnailPath,
        modelKeys: [modelKey],
        fingerprint: vibeFingerprint(data.encodings),
      },
    };
    if (!setSelected(input.name, selected)) {
      throw new Error(`「${input.name}」人设图入库失败(名字为空或数据不完整)`);
    }
    return selected;
  } catch (error) {
    toastr.warning(error instanceof Error ? error.message : String(error), '人设图');
    return null;
  }
}
