// packages/mcp/src/lib/observe-render.ts

import { categoryOf } from "./aria-taxonomy.js";

export interface CompactElement {
  index: number;
  tag: string;
  role: string;
  name: string;
  state?: { checked?: boolean | "mixed"; selected?: boolean; active?: boolean; disabled?: boolean; required?: boolean; expanded?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string; readonly?: boolean; /** aria-level,树形/标题层级(0=outermost)。@since N0002 B001 */ level?: number; /** aria-autocomplete=list/both/none/inline, combobox 自动补全语义。@since R1 B003 */ autocomplete?: "list" | "both" | "none" | "inline"; /** aria-pressed=true, toggle button 标准状态(与 [active] 不同源)。@since R1 B004 */ pressed?: boolean };
  // 值域控件(slider/spinbutton/progressbar/meter 等)的当前值,如 "30" / "30/100"。
  valueNow?: string;
  // 值域控件 min/max。@since N0002 B006 — 即 valuetext=now 场景也输出。
  valueMin?: string;
  valueMax?: string;
  // aria-keyshortcuts 显式键盘快捷键。@since N0002 B010/B016。
  keyshortcuts?: string;
  frameId: number;
  // Issue #21 — visual-grounding. Optional tuple [x, y, w, h] in integer px,
  // frame-local viewport coordinates. Present only when caller passes
  // includeBoxes:true AND the element intersects the frame viewport.
  // Tuple form (not object) saves ~6 tokens/element vs `{x,y,w,h}`.
  bbox?: [number, number, number, number];
  /** 最近的已收集祖先的全局 index；根节点 undefined。@since a11y-tree */
  parentIndex?: number;
  /** react onClick / cursor:pointer 命中 → 渲染 [cursor=pointer]。@since a11y-tree */
  reactClickable?: true;
  /** CDP getEventListeners 确认有 click/mousedown/pointerdown 监听器 → 渲染 [listener]。@since T3 */
  listenerInteractive?: true;
  /** CDP getEventListeners 确认有 drop/dragenter/dragover 监听器 → 渲染 [dropzone]（投放区，vortex_drag endRef 目标）。@since dropzone-discovery */
  dropzoneInteractive?: true;
  /** HTML5 draggable=true 拖拽源 → 渲染 [draggable]（可被拖起，vortex_drag startRef 源）。与 [dropzone] 正交对称。@since draggable-source */
  draggableInteractive?: true;
  /** role=link 的 href，渲染 /url: 属性行。@since a11y-tree */
  href?: string;
  /** AX nameSource：名称来源(label/placeholder/title/heuristic 等)。@since ax-overlay */
  nameSource?: string;
  /** aria-controls / aria-owns 关联。@since B008: 指向已收集元素下标。
   *  @since B009: 加 id 字符串 fallback — 目标非 collectedEls(region/tabpanel)时
   *  用 {id:"ghost"} 暴露, agent 至少看到关联 id。 */
  controls?: Array<{ id?: string; index?: number }>;
  /** aria-owns 指向的全局元素下标列表。@since ax-overlay */
  owns?: number[];
  /** aria-errormessage 关联文本。@since ax-overlay */
  errorMessage?: string;
  /** aria-describedby 关联描述文本。@since ax-overlay */
  description?: string;
  /** 复合控件元数据(combobox/listbox/date-input/file-input/range-input 等)。@since ax-overlay */
  compound?: {
    role: string;
    count?: number;
    options?: string[];
    /** R2 B006: listbox options 被截断时被隐藏的 option 数(原 4 上限提至 6,>6 透明截断) */
    truncated?: number;
    /** date/time 格式串或 file input 当前文件名/None */
    formatHint?: string;
    /** range/number input 最小值约束 */
    min?: string;
    /** range/number input 最大值约束 */
    max?: string;
    /** range/number input 步长约束 */
    step?: string;
  };
  /**
   * 元素是否在当前视口内（由 extension observe.ts 计算）。
   * true=视口内可直接点击，false=需要滚动后才可操作。
   * undefined=旧快照数据（向后兼容，不打 [offscreen]）。
   * @since T4-viewport
   */
  inViewport?: boolean;
  /**
   * 视口外但 CDP 仍可操作的元素（例如粘性 header 下的隐藏元素）。
   * true=屏外可交互，计入"N more below"汇总计数。
   * @since T4-viewport
   */
  offScreenActionable?: boolean;
  /** 盲区降级信号:虚拟列表/canvas/closed-shadow。@since blindspot */
  blindspot?: { kind: "virtual" | "canvas" | "shadow"; total?: number; rendered?: number; confidence?: "low"; readback?: "component" | "screenshot" | "chart"; chartLib?: string };
  /** 模态弹层外的背景元素(filter=all 逃生口)。@since modal-scope */
  behindModal?: boolean;
}

interface CompactFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  offset: { x: number; y: number };
  elementCount: number;
  truncated: boolean;
  scanned: boolean;
  /** 该 frame 扫描时考虑的候选总数(用于截断量化)。@since blindspot */
  candidateCount?: number;
  /** 虚拟列表盲区(容器未被收集为元素时的 frame 级信号)。@since blindspot */
  blindspots?: Array<
    | { kind: "virtual"; total: number; rendered: number; name: string; confidence?: "low" }
    | { kind: "canvas"; name: string; chartLib: string; readback: "chart" }
  >;
  /** 模态作用域信号(aria-modal 弹层裁剪了背景)。@since modal-scope */
  modal?: { name: string; role: string; suppressed: number };
}

export interface CompactObserve {
  snapshotId: string;
  url: string;
  title?: string;
  viewport?: { width: number; height: number; scrollY: number; scrollHeight: number };
  frames?: CompactFrame[];
  elements: CompactElement[];
  /**
   * 传入上一次 observe 返回的 snapshotId，渲染时相比上次新增的元素会打 `*` 前缀，
   * 方便 LLM 快速识别弹层/Toast 等动态新 UI。
   * 不传则行为完全不变（向后兼容）。
   * @since T4-diff
   */
  prevSnapshotId?: string;
}

// =========================================================
// MCP 侧轻量快照缓存（供 prevSnapshotId diff 使用）
// =========================================================

/** 渲染侧快照缓存条目：仅保存元素身份键集合（不存完整元素，省内存）。*/
export interface RenderSnapshotEntry {
  /** 元素身份键：`role::name::frameId`，用于跨快照判定是否新增。 */
  elementKey: string;
  index: number;
}

/** 快照 ID → 身份键集合映射；TTL 5 分钟，容量上限 20 条。 */
const renderSnapshotCache = new Map<string, { keys: Set<string>; identityByIndex: Map<string, string>; ts: number }>();
const RENDER_CACHE_TTL_MS = 5 * 60 * 1000;
const RENDER_CACHE_MAX = 20;

/**
 * 显式存入一个渲染侧快照（测试用）。
 * 生产路径中每次 renderObserve* 结束后自动调用 `autoStoreSnapshot`。
 */
export function storeSnapshot(snapshotId: string, entries: RenderSnapshotEntry[]): void {
  gcRenderCache();
  renderSnapshotCache.set(snapshotId, {
    keys: new Set(entries.map((e) => e.elementKey)),
    // storeSnapshot 仅用于测试，不提供 index 信息，故 identityByIndex 为空。
    identityByIndex: new Map(),
    ts: Date.now(),
  });
}

/** 由 `buildElementKey` 计算元素身份键：role::name::frameId。 */
function buildElementKey(e: CompactElement): string {
  return `${e.role}::${e.name}::${e.frameId}`;
}

/** 渲染完成后把本次快照存入缓存供后续 diff 使用。 */
function autoStoreSnapshot(snapshotId: string, elements: CompactElement[]): void {
  gcRenderCache();
  // 按 `${frameId}:${index}` 建立索引，供 lookupIdentity 按 ref 坐标取回语义身份。
  const identityByIndex = new Map<string, string>();
  for (const e of elements) {
    identityByIndex.set(`${e.frameId}:${e.index}`, buildElementKey(e));
  }
  renderSnapshotCache.set(snapshotId, {
    keys: new Set(elements.map(buildElementKey)),
    identityByIndex,
    ts: Date.now(),
  });
}

/** 取出指定快照的身份键集合；不存在或已过期返回 null。 */
function lookupSnapshot(snapshotId: string): Set<string> | null {
  const entry = renderSnapshotCache.get(snapshotId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RENDER_CACHE_TTL_MS) {
    renderSnapshotCache.delete(snapshotId);
    return null;
  }
  return entry.keys;
}

/**
 * 按 `{frameId, index}` 从快照缓存取回元素语义身份（`role::name::frameId`）。
 * 快照不存在、已过期或 index 未命中均返回 null。
 * 供重放模块将 ref 坐标映射为跨快照稳定的语义 key。
 */
export function lookupIdentity(snapshotId: string, frameId: number, index: number): string | null {
  const entry = renderSnapshotCache.get(snapshotId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RENDER_CACHE_TTL_MS) {
    renderSnapshotCache.delete(snapshotId);
    return null;
  }
  return entry.identityByIndex.get(`${frameId}:${index}`) ?? null;
}

function gcRenderCache(): void {
  const now = Date.now();
  for (const [id, entry] of renderSnapshotCache) {
    if (now - entry.ts > RENDER_CACHE_TTL_MS) renderSnapshotCache.delete(id);
  }
  // 容量超限时淘汰最早的条目
  if (renderSnapshotCache.size > RENDER_CACHE_MAX) {
    const oldest = [...renderSnapshotCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id] of oldest.slice(0, renderSnapshotCache.size - RENDER_CACHE_MAX)) {
      renderSnapshotCache.delete(id);
    }
  }
}

export function refOf(e: CompactElement, snapshotHash: string | null): string {
  const frame = e.frameId === 0 ? "" : `f${e.frameId}`;
  const tail = `${frame}e${e.index}`;
  return snapshotHash !== null ? `@${snapshotHash}:${tail}` : `@${tail}`;
}

function stateFlags(state?: CompactElement["state"]): string {
  if (!state) return "";
  const flags: string[] = [];
  if (state.checked === "mixed") flags.push("checked:mixed");
  else if (state.checked) flags.push("checked");
  if (state.selected) flags.push("selected");
  if (state.active) flags.push("active");
  if (state.disabled) flags.push("disabled");
  if (state.readonly) flags.push("readonly");
  if (state.required) flags.push("required");
  if (state.expanded) flags.push("expanded");
  if (state.current) flags.push("current");
  if (state.invalid) flags.push("invalid");
  // R1 B003: aria-autocomplete=list/both/none/inline, combobox 自动补全语义。
  // 仅 combobox/searchbox 实际使用,其他 role 即使有 aria-autocomplete 也输出(不挑剔)。
  if (state.autocomplete) flags.push(`autocomplete=${state.autocomplete}`);
  // R1 B004: aria-pressed=true 是 toggle button 标准状态(与 [active] 区分)。
  // 仅在 true 时发, false/缺省不发(避免噪声,与 [checked] / [selected] 同模式)。
  if (state.pressed === true) flags.push("pressed");
  // aria-sort:可排序列当前方向。asc/desc 含方向,none=可排未排(标 sortable)。
  if (state.sort === "ascending") flags.push("sort:asc");
  else if (state.sort === "descending") flags.push("sort:desc");
  else if (state.sort === "none") flags.push("sortable");
  // aria-haspopup:点击弹出的弹层类型(menu/listbox/tree/grid/dialog)。冒号语法
  // [haspopup:menu] 让 agent 预判点击后出现弹层(bench parser 自 AC 起容忍冒号)。
  if (state.haspopup) flags.push(`haspopup:${state.haspopup}`);
  // aria-level:树形结构(tree/treeitem)与 heading 的层级数字。!=null 保留 0(outermost 合法值)。
  if (state.level != null) flags.push(`level=${state.level}`);
  return flags.length ? " " + flags.map((f) => `[${f}]`).join(" ") : "";
}

function escapeName(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/"/g, '\\"').slice(0, 80);
}

/**
 * Landmark 锚点:在元素行打 `[landmark:role]` 前缀,让 agent 一眼认出这是地标
 * 容器(region/main/navigation/banner 等),与普通结构容器区分。T5 派发。
 * 极简锚点:不放 compound 段(地标元数据少,语义靠 role+name 表达)。
 */
function landmarkFlag(role: string): string {
  return categoryOf(role) === "landmark" ? ` [landmark:${role}]` : "";
}

/**
 * Live 实时区锚点:`[live]` 前缀让 agent 立刻识别 status/alert/log/timer 是
 * 动态文字区(不需要 click,会自然更新),不会被当成静态 text 误读。T5 派发。
 */
function liveFlag(role: string): string {
  return categoryOf(role) === "live" ? " [live]" : "";
}

/**
 * Compound 段渲染派发(T5 — 按 categoryOf 派发,不再按 compound.role 字面分支):
 * - 输入子类型(date-input/file-input/range-input/number-input,不在 taxonomy):
 *   现有 format/file/min/max/step 路径,widget 特化;
 * - composite(combobox/listbox/menu 等):count + options 样本 + truncated;
 * - structure(toolbar/tabpanel/group/table/row/figure 等):标签 + 可选 count,
 *   不出 options(地标类数据走 element-line anchor,不在此处堆)。
 * - 其他类别(landmark/live/window/range):不在 compound 段渲染(由 element-line
 *   的 [landmark:role] / [live] / 现有 valueNow / modal-scope 各自承担)。
 */
function renderCompoundSeg(c: NonNullable<CompactElement["compound"]>): string {
  const role = c.role;
  // 输入子类型优先于 categoryOf(它们不在 taxonomy,categoryOf 返回 undefined)。
  if (role === "date-input") {
    const extra = c.formatHint ? ` format=${c.formatHint}` : "";
    return ` compound=(${role}${extra})`;
  }
  if (role === "file-input") {
    const extra = c.formatHint ? ` file=${c.formatHint}` : "";
    return ` compound=(${role}${extra})`;
  }
  if (role === "range-input" || role === "number-input") {
    const minSeg = c.min != null ? ` min=${c.min}` : "";
    const maxSeg = c.max != null ? ` max=${c.max}` : "";
    const stepSeg = c.step != null ? ` step=${c.step}` : "";
    return ` compound=(${role}${minSeg}${maxSeg}${stepSeg})`;
  }
  const cat = categoryOf(role);
  if (cat === "composite") {
    const countSeg = c.count != null ? ` count=${c.count}` : "";
    const optSeg = c.options?.length ? ` options=${c.options.join("|")}` : "";
    // R2 B006: options 被截断时追加 "+N more" 提示,Agent 据此知后段未列。
    // 真实 options 数 = 列出的 + truncated。
    const truncSeg = c.truncated ? ` +${c.truncated} more` : "";
    return ` compound=(${role}${countSeg}${optSeg}${truncSeg})`;
  }
  if (cat === "structure") {
    // toolbar 用 "controls"(语义贴近),其他结构容器用 "items"。
    const label = role === "toolbar" ? "controls" : "items";
    const countSeg = c.count != null ? ` ${c.count} ${label}` : "";
    return ` compound=(${role}${countSeg})`;
  }
  // landmark / live / window / range / unknown:不在 compound 段输出。
  return "";
}

/** 盲区行内 tag:挂在 agent 要操作的元素上(承重)。 */
function blindspotTag(b?: CompactElement["blindspot"]): string {
  if (!b) return "";
  if (b.kind === "virtual") {
    const t =
      b.total != null && b.rendered != null
        ? `${b.total}/${b.rendered}`
        : b.total != null
          ? `${b.total}/?`
          : "?";
    return ` [virtual: ${t}]`;
  }
  if (b.kind === "canvas") {
    if (b.readback === "chart") return ` [blindspot=canvas chart=${b.chartLib ?? "?"} readback=evaluate:getOption]`;
    if (b.readback === "component") return " [blindspot=canvas readback=query:component]";
    return " [blindspot=canvas readback=screenshot]"; // screenshot / 旧无 readback 缺省
  }
  return b.confidence === "low" ? " [blindspot=shadow?]" : " [blindspot=shadow]";
}

/**
 * 顶部盲区摘要行:让 agent 一眼知道全页有几处盲区。合并两源:
 * 1) 元素级(canvas/shadow,带 ref)——挂在已收集元素上;
 * 2) frame 级虚拟列表(按 name,容器常未被收集为元素)。
 * 无盲区返回 null。
 */
function blindspotSummary(
  elements: CompactElement[],
  frames: CompactFrame[] | undefined,
  snapshotHash: string | null,
): string | null {
  const parts: string[] = [];
  for (const e of elements) {
    const b = e.blindspot;
    if (!b) continue;
    const ref = refOf(e, snapshotHash);
    if (b.kind === "virtual") parts.push(`${e.role} ${ref} virtual(${b.total ?? "?"}/${b.rendered ?? "?"})`);
    else if (b.kind === "canvas") {
      if (b.readback === "chart") parts.push(`${e.role} ${ref} chart(${b.chartLib ?? "?"}) → read via vortex_evaluate getOption()`);
      else if (b.readback === "component") parts.push(`${e.role} ${ref} canvas → readable via vortex_query mode=component`);
      else parts.push(`${e.role} ${ref} canvas → visual only, use vortex_screenshot`);
    }
    else parts.push(`${e.role} ${ref} shadow${b.confidence === "low" ? "?" : ""}`);
  }
  for (const f of frames ?? []) {
    for (const b of f.blindspots ?? []) {
      const fr = f.frameId !== 0 ? ` (frame ${f.frameId})` : "";
      if (b.kind === "canvas") {
        parts.push(`${b.name} chart(${b.chartLib}) → read via vortex_evaluate getOption()${fr}`);
      } else {
        // confidence:low(A2-fb scrollHeight 估算)用 ~ 前缀标记 total 为近似值。
        const tot = b.confidence === "low" ? `~${b.total}` : `${b.total}`;
        parts.push(`${b.name} virtual(${tot}/${b.rendered})${fr}`);
      }
    }
  }
  return parts.length ? `# blindspots: ${parts.join("; ")}` : null;
}

/** 模态作用域 meta 行:首个带 modal 的 frame → # modal:。对齐 # blindspots: 风格。 */
function modalSummary(frames?: CompactFrame[]): string | null {
  for (const f of frames ?? []) {
    if (f.modal) {
      const nm = f.modal.name ? ` "${f.modal.name}"` : "";
      return `# modal: ${f.modal.role}${nm} (suppressed ${f.modal.suppressed} background elements)`;
    }
  }
  return null;
}

/** 截断量化 meta 行:per truncated frame。追加到 scanNotes。 */
function pushTruncationNotes(frames: CompactFrame[] | undefined, scanNotes: string[]): void {
  for (const f of frames ?? []) {
    if (f.truncated && f.candidateCount != null && f.candidateCount > f.elementCount) {
      scanNotes.push(
        `# truncated: returned ${f.elementCount} of ~${f.candidateCount} candidates${f.frameId !== 0 ? ` (frame ${f.frameId})` : ""}`,
      );
    }
  }
}

export function renderObserveCompact(
  data: CompactObserve,
  snapshotHash: string | null,
  includeBoxes = false,
): string {
  const lines: string[] = [];
  lines.push(`SnapshotId: ${data.snapshotId}`);
  lines.push(`URL: ${data.url}`);
  if (data.title) lines.push(`Title: ${data.title}`);
  if (data.viewport) {
    const vp = data.viewport;
    lines.push(`Viewport: ${vp.width}x${vp.height}, scrollY=${vp.scrollY}/${vp.scrollHeight}`);
  }
  const bsLine = blindspotSummary(data.elements, data.frames, snapshotHash);
  if (bsLine) lines.push(bsLine);
  const modalLine = modalSummary(data.frames);
  if (modalLine) lines.push(modalLine);
  lines.push("");

  // T4-diff: 查找上一快照身份键集合（不存在/过期则 null → 不 diff）。
  const prevKeys = data.prevSnapshotId ? lookupSnapshot(data.prevSnapshotId) : null;

  let offScreenCount = 0;
  for (const el of data.elements) {
    const name = el.name ? ` "${escapeName(el.name)}"` : "";
    // Issue #21 — bbox segment is opt-in AND only present when the
    // handler already attached el.bbox (i.e. element passed the
    // in-viewport / non-zero-area gate in T4). Drop the segment silently
    // when either condition is missing — element line stays intact.
    const bboxSeg =
      includeBoxes && el.bbox !== undefined ? ` bbox=[${el.bbox.join(",")}]` : "";
    // 值域控件当前值:slider/spinbutton/progressbar 等才有(observe 严格限定),
    // 让 agent 知道控件当前设到几。放在 state flag 后、bbox 前。含空格的值
    // (aria-valuetext 如 "3 of 5 stars")加引号,避免破坏按空格分段的解析。
    const valueSeg =
      el.valueNow !== undefined
        ? ` value=${/\s/.test(el.valueNow) ? JSON.stringify(el.valueNow) : el.valueNow}`
        : "";
    // N0002 B006: 独立 valuemin/max 段, 即 valuetext=now 场景也输出。
    const valueMinSeg = el.valueMin !== undefined ? ` [valuemin=${el.valueMin}]` : "";
    const valueMaxSeg = el.valueMax !== undefined ? ` [valuemax=${el.valueMax}]` : "";
    // N0002 B010/B016: 键盘快捷键段。
    const keyshortcutsSeg = el.keyshortcuts ? ` [keyshortcuts=${el.keyshortcuts}]` : "";
    // T4-viewport: 视口外元素追加 [offscreen] 标记，提示 LLM 需要先滚动。
    // inViewport===false（明确屏外）才打标记；undefined（旧快照）保持兼容不打。
    const offscreenSeg = el.inViewport === false ? " [offscreen]" : "";
    if (el.offScreenActionable) offScreenCount++;

    // T5: 按 category 派发的元数据锚点 + compound 段。
    // landmark/live 锚点放在 name 之后(避免破坏既有 `[role] "name"` 子串的测试断言,如
    // `[alert] "操作成功"`),compound 段跟随其后,与 renderObserveTree 对齐。
    const lm = landmarkFlag(el.role);
    const lv = liveFlag(el.role);
    const comp = el.compound ? renderCompoundSeg(el.compound) : "";

    // T4-diff: 新增元素（在上次快照不存在）打 * 前缀。
    const isNew = prevKeys !== null && !prevKeys.has(buildElementKey(el));
    const newPrefix = isNew ? "* " : "";

    lines.push(
      `${newPrefix}${refOf(el, snapshotHash)} [${el.role}]${name}${lm}${lv}${stateFlags(el.state)}${comp}${valueSeg}${valueMinSeg}${valueMaxSeg}${keyshortcutsSeg}${offscreenSeg}${blindspotTag(el.blindspot)}${el.behindModal ? " [behind-modal]" : ""}${bboxSeg}`,
    );
  }

  // T4-viewport: 汇总屏外可交互元素数量提示。
  if (offScreenCount > 0) {
    lines.push(`# ${offScreenCount} more below — scroll to reveal`);
  }

  // Frame 状态提示：1) 未扫的（cross-origin/destroyed）2) 扫描成功但 0 元素的
  // sub-frame。后者之前沉默 → 多 frame 场景下 LLM 看不到子 frame 存在就会
  // 下结论 "frame walker 漏掉了"（见 testc 评价分析 dogfood 误诊）。
  const scanNotes: string[] = [];
  for (const f of data.frames ?? []) {
    if (!f.scanned) {
      scanNotes.push(`# frame ${f.frameId} not scanned (url=${f.url})`);
    } else if (f.elementCount === 0 && f.frameId !== 0) {
      scanNotes.push(`# frame ${f.frameId} scanned, 0 interactive elements (url=${f.url})`);
    }
  }
  // Issue #21 — when includeBoxes=true, emit one '# frame N offset=[x,y]'
  // line per scanned non-main frame. Element bboxes are frame-local; the
  // offset line lets callers compose top-page coords via
  //   (el.bbox.x + frame.offset.x, el.bbox.y + frame.offset.y).
  // Emitted even when elementCount === 0 so callers know the frame exists.
  //
  // Math.round on offset components is the contract boundary: element
  // bboxes are already integer at this point (rounded twice — page-side
  // observe.ts:680-685 and handler observe.ts:917-922), but iframe-offset
  // sources its values raw from getBoundingClientRect (floats on retina
  // / sub-pixel transforms). Rounding here keeps the documented
  // "integer px, frame-local viewport coords" contract honest and lets
  // simple regex parsers like /offset=\[(\d+),(\d+)\]/ work uniformly.
  if (includeBoxes) {
    for (const f of data.frames ?? []) {
      if (f.scanned && f.frameId !== 0) {
        scanNotes.push(
          `# frame ${f.frameId} offset=[${Math.round(f.offset.x)},${Math.round(f.offset.y)}]`,
        );
      }
    }
  }
  if (scanNotes.length > 0) {
    lines.push("");
    lines.push(...scanNotes);
  }

  // T4-diff: 渲染完成后自动存储本次快照，供下次 prevSnapshotId 引用。
  autoStoreSnapshot(data.snapshotId, data.elements);

  return lines.join("\n");
}

export function renderObserveTree(
  data: CompactObserve,
  snapshotHash: string | null,
  includeBoxes = false,
): string {
  const lines: string[] = [];
  lines.push(`SnapshotId: ${data.snapshotId}`);
  lines.push(`URL: ${data.url}`);
  if (data.title) lines.push(`Title: ${data.title}`);
  if (data.viewport) {
    const vp = data.viewport;
    lines.push(`Viewport: ${vp.width}x${vp.height}, scrollY=${vp.scrollY}/${vp.scrollHeight}`);
  }
  const bsLine = blindspotSummary(data.elements, data.frames, snapshotHash);
  if (bsLine) lines.push(bsLine);
  const modalLine = modalSummary(data.frames);
  if (modalLine) lines.push(modalLine);
  lines.push("");

  // T4-diff: 查找上一快照身份键集合。
  const prevKeys = data.prevSnapshotId ? lookupSnapshot(data.prevSnapshotId) : null;

  const els = data.elements;
  const byIndex = new Map<number, CompactElement>();
  for (const e of els) byIndex.set(e.index, e);

  // 按 parentIndex 建子节点表；孤儿（parentIndex 缺失或指向不存在 index）当根。
  // els 已按文档序 → roots 与每个 children 数组的 push 序即文档序，渲染稳定。
  const childrenOf = new Map<number, CompactElement[]>();
  const roots: CompactElement[] = [];
  for (const e of els) {
    const p = e.parentIndex;
    if (p === undefined || p === e.index || !byIndex.has(p)) {
      roots.push(e);
    } else {
      const arr = childrenOf.get(p);
      if (arr) arr.push(e);
      else childrenOf.set(p, [e]);
    }
  }

  let offScreenCount = 0;
  for (const e of els) {
    if (e.offScreenActionable) offScreenCount++;
  }

  const visited = new Set<number>();
  const emit = (e: CompactElement, depth: number): void => {
    if (visited.has(e.index)) return; // 防环兜底：forward parent-reference 形成的环由 visited 截断；
    // self-loop(parentIndex===index) 已在建树阶段提升为根。严格 parentIndex<index 由收集侧保证。
    visited.add(e.index);
    const indent = "  ".repeat(depth);
    const name = e.name ? ` "${escapeName(e.name)}"` : "";
    const ref = ` [ref=${refOf(e, snapshotHash)}]`;
    const cursor = e.reactClickable ? " [cursor=pointer]" : "";
    // CDP getEventListeners 真值信号：[listener] 标记区分「真有 JS 监听器」vs「仅 cursor 启发」。
    const listener = e.listenerInteractive ? " [listener]" : "";
    // 投放区信号：[dropzone] 告知 agent 此元素接受拖放，是 vortex_drag 的 endRef 目标。
    const dropzone = e.dropzoneInteractive ? " [dropzone]" : "";
    // 拖拽源信号：[draggable] 告知 agent 此元素可被拖起，是 vortex_drag 的 startRef 源（与 dropzone 正交）。
    const draggable = e.draggableInteractive ? " [draggable]" : "";
    const valueSeg =
      e.valueNow !== undefined
        ? ` value=${/\s/.test(e.valueNow) ? JSON.stringify(e.valueNow) : e.valueNow}`
        : "";
    // N0002 B006: 独立 min/max 段。值域控件(slider/progressbar/meter)即使 valuetext
    // 命中也输出——valuetext=now 的场景(如 "0") agent 仍要知道范围 0-100。
    // 与 valueNow 拼写区分: value=0 [valuemin=0] [valuemax=100]。
    const valueMinSeg = e.valueMin !== undefined ? ` [valuemin=${e.valueMin}]` : "";
    const valueMaxSeg = e.valueMax !== undefined ? ` [valuemax=${e.valueMax}]` : "";
    // N0002 B010/B016: 显式键盘快捷键渲染(空格分隔多键)。
    // 例: ⌘K 触发搜索按钮 aria-keyshortcuts="Meta+K" → 渲染 [keyshortcuts=Meta+K]。
    // 仅当 keyshortcuts 非空才输出, 与其它 state 标记同段。
    const keyshortcutsSeg = e.keyshortcuts ? ` [keyshortcuts=${e.keyshortcuts}]` : "";
    const bboxSeg =
      includeBoxes && e.bbox !== undefined ? ` bbox=[${e.bbox.join(",")}]` : "";
    const kids = childrenOf.get(e.index) ?? [];
    const hasUrl = e.role === "link" && !!e.href;
    const hasChildren = kids.length > 0 || hasUrl;
    const weak = e.nameSource === "placeholder" || e.nameSource === "title" ? " [weakname]" : "";
    // compound 渲染(T5 — renderCompoundSeg 按 category 派发):
    // - input 子类型(date/file/range/number)→ format/file/min/max/step
    // - composite(combobox/listbox/menu)→ count + options + truncated
    // - structure(toolbar/group/tabpanel 等)→ count + label
    // - landmark/live/window/range → 由 element-line 的 [landmark:role]/[live]/
    //   现有 valueNow/modal-scope 各自承担,此处不输出。
    const comp = e.compound ? renderCompoundSeg(e.compound) : "";
    const lm = landmarkFlag(e.role);
    const lv = liveFlag(e.role);
    const err = e.errorMessage ? ` error=${JSON.stringify(e.errorMessage)}` : "";
    // N0002 B008 + B009: aria-controls / aria-owns 渲染。
    //  - {index:N} → @ref:eN (已收集元素, agent 可直接 click)
    //  - {id:"ghost"} → #ghost (非 collectedEls, agent 可 querySelector)
    //  - 混合: controls=@ref:e0,#tabpanel-1,@ref:e2
    const ctrl = e.controls?.length
      ? ` controls=${e.controls.map((c) => c.index !== undefined ? refOf({ ...e, index: c.index }, snapshotHash) : `#${c.id}`).join(",")}`
      : "";
    const desc = e.description ? ` desc=${JSON.stringify(e.description.slice(0, 60))}` : "";
    // T4-viewport: 视口外元素追加 [offscreen] 标记（inViewport===false 明确屏外才打）。
    const offscreenSeg = e.inViewport === false ? " [offscreen]" : "";
    // T4-diff: 新增元素（上次快照无此身份键）在行首打 * 前缀。
    const isNew = prevKeys !== null && !prevKeys.has(buildElementKey(e));
    const newPrefix = isNew ? "* " : "";
    lines.push(
      `${indent}${newPrefix}- ${e.role}${name}${ref}${lm}${lv}${stateFlags(e.state)}${weak}${cursor}${listener}${dropzone}${draggable}${valueSeg}${valueMinSeg}${valueMaxSeg}${keyshortcutsSeg}${comp}${err}${ctrl}${desc}${offscreenSeg}${blindspotTag(e.blindspot)}${e.behindModal ? " [behind-modal]" : ""}${bboxSeg}${hasChildren ? ":" : ""}`,
    );
    if (hasUrl) lines.push(`${indent}  - /url: ${e.href}`);
    for (const k of kids) emit(k, depth + 1);
  };
  for (const r of roots) emit(r, 0);

  // T4-viewport: 屏外可交互元素汇总提示。
  if (offScreenCount > 0) {
    lines.push(`# ${offScreenCount} more below — scroll to reveal`);
  }

  // frame 提示行：与 renderObserveCompact 完全一致（未扫 / 0 元素子 frame / offset）。
  const scanNotes: string[] = [];
  for (const f of data.frames ?? []) {
    if (!f.scanned) {
      scanNotes.push(`# frame ${f.frameId} not scanned (url=${f.url})`);
    } else if (f.elementCount === 0 && f.frameId !== 0) {
      scanNotes.push(`# frame ${f.frameId} scanned, 0 interactive elements (url=${f.url})`);
    }
  }
  pushTruncationNotes(data.frames, scanNotes);
  if (includeBoxes) {
    for (const f of data.frames ?? []) {
      if (f.scanned && f.frameId !== 0) {
        scanNotes.push(
          `# frame ${f.frameId} offset=[${Math.round(f.offset.x)},${Math.round(f.offset.y)}]`,
        );
      }
    }
  }
  if (scanNotes.length > 0) {
    lines.push("");
    lines.push(...scanNotes);
  }

  // T4-diff: 渲染完成后自动存储本次快照，供下次 prevSnapshotId 引用。
  autoStoreSnapshot(data.snapshotId, data.elements);

  return lines.join("\n");
}
