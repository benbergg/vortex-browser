// packages/mcp/src/lib/observe-render.ts

export interface CompactElement {
  index: number;
  tag: string;
  role: string;
  name: string;
  state?: { checked?: boolean | "mixed"; selected?: boolean; active?: boolean; disabled?: boolean; required?: boolean; expanded?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none"; haspopup?: string; readonly?: boolean };
  // 值域控件(slider/spinbutton/progressbar/meter 等)的当前值,如 "30" / "30/100"。
  valueNow?: string;
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
  /** role=link 的 href，渲染 /url: 属性行。@since a11y-tree */
  href?: string;
  /** AX nameSource：名称来源(label/placeholder/title/heuristic 等)。@since ax-overlay */
  nameSource?: string;
  /** aria-controls 指向的全局元素下标列表。@since ax-overlay */
  controls?: number[];
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
}

interface CompactFrame {
  frameId: number;
  parentFrameId: number;
  url: string;
  offset: { x: number; y: number };
  elementCount: number;
  truncated: boolean;
  scanned: boolean;
}

interface CompactObserve {
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
const renderSnapshotCache = new Map<string, { keys: Set<string>; ts: number }>();
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
  renderSnapshotCache.set(snapshotId, {
    keys: new Set(elements.map(buildElementKey)),
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
  // aria-sort:可排序列当前方向。asc/desc 含方向,none=可排未排(标 sortable)。
  if (state.sort === "ascending") flags.push("sort:asc");
  else if (state.sort === "descending") flags.push("sort:desc");
  else if (state.sort === "none") flags.push("sortable");
  // aria-haspopup:点击弹出的弹层类型(menu/listbox/tree/grid/dialog)。冒号语法
  // [haspopup:menu] 让 agent 预判点击后出现弹层(bench parser 自 AC 起容忍冒号)。
  if (state.haspopup) flags.push(`haspopup:${state.haspopup}`);
  return flags.length ? " " + flags.map((f) => `[${f}]`).join(" ") : "";
}

function escapeName(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/"/g, '\\"').slice(0, 80);
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
    // T4-viewport: 视口外元素追加 [offscreen] 标记，提示 LLM 需要先滚动。
    // inViewport===false（明确屏外）才打标记；undefined（旧快照）保持兼容不打。
    const offscreenSeg = el.inViewport === false ? " [offscreen]" : "";
    if (el.offScreenActionable) offScreenCount++;

    // T4-diff: 新增元素（在上次快照不存在）打 * 前缀。
    const isNew = prevKeys !== null && !prevKeys.has(buildElementKey(el));
    const newPrefix = isNew ? "* " : "";

    lines.push(
      `${newPrefix}${refOf(el, snapshotHash)} [${el.role}]${name}${stateFlags(el.state)}${valueSeg}${offscreenSeg}${bboxSeg}`,
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
    const valueSeg =
      e.valueNow !== undefined
        ? ` value=${/\s/.test(e.valueNow) ? JSON.stringify(e.valueNow) : e.valueNow}`
        : "";
    const bboxSeg =
      includeBoxes && e.bbox !== undefined ? ` bbox=[${e.bbox.join(",")}]` : "";
    const kids = childrenOf.get(e.index) ?? [];
    const hasUrl = e.role === "link" && !!e.href;
    const hasChildren = kids.length > 0 || hasUrl;
    const weak = e.nameSource === "placeholder" || e.nameSource === "title" ? " [weakname]" : "";
    // compound 渲染:按 compound.role 类型决定渲染哪些元数据字段
    // - combobox/listbox 等:count + options
    // - date-input:format=<formatHint>
    // - file-input:file=<formatHint>
    // - range-input/number-input:min=/max=/step=(有值则渲染)
    let comp = "";
    if (e.compound) {
      const c = e.compound;
      const role = c.role;
      let extra = "";
      if (role === "date-input") {
        // date/time/datetime-local/month/week input 格式串
        if (c.formatHint) extra = ` format=${c.formatHint}`;
      } else if (role === "file-input") {
        // file input 当前文件名或 None
        if (c.formatHint) extra = ` file=${c.formatHint}`;
      } else if (role === "range-input" || role === "number-input") {
        // range/number 约束
        const minSeg = c.min != null ? ` min=${c.min}` : "";
        const maxSeg = c.max != null ? ` max=${c.max}` : "";
        const stepSeg = c.step != null ? ` step=${c.step}` : "";
        extra = `${minSeg}${maxSeg}${stepSeg}`;
      } else {
        // combobox/listbox 等:count + options(原有逻辑)
        const countSeg = c.count != null ? ` count=${c.count}` : "";
        const optSeg = c.options?.length ? ` options=${c.options.join("|")}` : "";
        extra = `${countSeg}${optSeg}`;
      }
      comp = ` compound=(${role}${extra})`;
    }
    const err = e.errorMessage ? ` error=${JSON.stringify(e.errorMessage)}` : "";
    const ctrl = e.controls?.length
      ? ` controls=${e.controls.map((i) => refOf({ ...e, index: i }, snapshotHash)).join(",")}`
      : "";
    const desc = e.description ? ` desc=${JSON.stringify(e.description.slice(0, 60))}` : "";
    // T4-viewport: 视口外元素追加 [offscreen] 标记（inViewport===false 明确屏外才打）。
    const offscreenSeg = e.inViewport === false ? " [offscreen]" : "";
    // T4-diff: 新增元素（上次快照无此身份键）在行首打 * 前缀。
    const isNew = prevKeys !== null && !prevKeys.has(buildElementKey(e));
    const newPrefix = isNew ? "* " : "";
    lines.push(
      `${indent}${newPrefix}- ${e.role}${name}${ref}${stateFlags(e.state)}${weak}${cursor}${listener}${valueSeg}${comp}${err}${ctrl}${desc}${offscreenSeg}${bboxSeg}${hasChildren ? ":" : ""}`,
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
