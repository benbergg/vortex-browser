// packages/vortex-bench/src/scan-types.ts
// 自主发现引擎 #1 MVP — scan 子系统共享类型。与 bench 的 types.ts 解耦。

/** manifest 单条:键 id 对应 fixture HTML 上的 data-vtx-oracle="<id>" */
export interface ManifestEntry {
  id: string;
  /** 该元素该不该被 observe 识别为可交互(true=应出现在 observe 输出) */
  interactive: boolean;
  /** 期望 accessibleName;null=不校验该字段 */
  expectedName: string | null;
  /** 期望 role;null=不校验 */
  expectedRole: string | null;
  /** 对抗模式标签,用于分组统计 */
  pattern: string;
  /** join 方式:geometry(默认,按 bbox)或 name(跨 frame fixture 用) */
  joinBy?: "geometry" | "name";
  /** #2 提议稿的 delta 提示(scan 忽略此字段) */
  _review?: "observe-missed" | "observe-extra" | "agree";
  note?: string;
}

export interface SynthManifest {
  /** fixture 短名,等于文件名去扩展,如 "cursor-pointer-div" */
  fixture: string;
  /** vite 服务路径,如 "/synth/cursor-pointer-div.html" */
  path: string;
  /** observe frames 参数,默认 "main" */
  frames?: "main" | "all-same-origin" | "all-permitted";
  /** #2:捕获来源 URL(真站派生 fixture 记溯源) */
  source?: string;
  /** #2:提议稿未确认标记;scan 跳过 _proposed:true 的 manifest */
  _proposed?: boolean;
  /** 难度档:easy=标准语义 HTML;medium=组件库(最常见真站形态);
   *  hard=iframe/shadow/canvas/虚拟列表。缺省视为 medium。分档门按此聚合。 */
  tier?: "easy" | "medium" | "hard";
  entries: ManifestEntry[];
}

/** evaluate 探针返回的 oracle 元素几何 */
export interface OracleRect {
  id: string;
  /** [x,y,w,h] viewport 坐标(getBoundingClientRect,已 round) */
  rect: [number, number, number, number];
}

export interface ObserveRow {
  ref: string;
  role: string;
  name: string | null;
  flags: string[];
  /** [x,y,w,h] frame-local 视口坐标;无 includeBoxes 或离屏时 null */
  bbox: [number, number, number, number] | null;
  frameId: number;
  /** 缩进深度（0=根）。@since a11y-tree */
  depth?: number;
  /** 父节点 ref（由缩进栈推导）；根为 null。@since a11y-tree */
  parentRef?: string | null;
}

export interface ObserveHeader {
  snapshotId: string;
  url: string;
  title?: string;
  viewport?: { width: number; height: number; scrollY: number; scrollHeight: number };
}

export interface ParsedObserve {
  header: ObserveHeader;
  rows: ObserveRow[];
  /** frameId → [offsetX, offsetY],来自 "# frame N offset=[x,y]" 行 */
  frameOffsets: Record<number, [number, number]>;
}

export type FindingSeverity = "P0" | "P1" | "P2";

export type FindingKind =
  | "recall-miss"
  | "precision-miss"
  | "name-mismatch"
  | "role-mismatch"
  | "inv1-instability"
  | "inv2-unresolvable"
  | "inv3-duplicate"
  | "inv4-bbox";

export interface Finding {
  severity: FindingSeverity;
  kind: FindingKind;
  fixture: string;
  pattern: string;
  detail: string;
  oracleId?: string;
  ref?: string;
}

export interface FixtureScanResult {
  fixture: string;
  pattern: string;
  path: string;
  /** 难度档(来自 manifest.tier,producer 已兜底为 medium);分档召回汇总按此分组 */
  tier?: "easy" | "medium" | "hard";
  recall: { matched: number; expected: number };
  precision: { matchedNoise: number; emitted: number };
  invariants: { inv1: boolean; inv2: boolean; inv3: boolean; inv4: boolean };
  findings: Finding[];
  /** 扫描中途的环境/工具错误(非 finding),如 navigate 失败 */
  error?: string;
}

export interface ScanReport {
  generatedAt: string;
  playgroundUrl: string;
  fixtures: FixtureScanResult[];
  /** 所有 fixture 扁平化 + 排序后的 finding */
  findings: Finding[];
}
