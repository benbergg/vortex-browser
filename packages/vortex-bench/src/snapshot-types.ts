// packages/vortex-bench/src/snapshot-types.ts
// 自主发现引擎 #2 — 快照捕获 / 提议 manifest 类型。

import type { ManifestEntry, SynthManifest } from "./scan-types.js";

/** page-side 提议器对一个候选元素的原始记录(序列化时产出) */
export interface RawCandidate {
  id: string;
  role: string;
  name: string | null;
  pattern: string;
  /** [x,y,w,h] viewport 坐标(getBoundingClientRect,已 round) */
  bbox: [number, number, number, number];
}

/** page-side 脚本 vortex_evaluate 的返回结构 */
export interface SerializeResult {
  /** 自包含静态 HTML(冻结页) */
  html: string;
  candidates: RawCandidate[];
}

/** delta 分类:候选与 observe 是否一致 */
export type ReviewTag = "observe-missed" | "observe-extra" | "agree";

export interface ProposedEntry extends ManifestEntry {
  _review: ReviewTag;
}

export interface ProposedManifest extends Omit<SynthManifest, "entries"> {
  _proposed: true;
  /** 捕获来源 URL */
  source: string;
  /** ISO 时间戳 */
  capturedAt: string;
  entries: ProposedEntry[];
}
