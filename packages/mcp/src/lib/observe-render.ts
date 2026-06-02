// packages/mcp/src/lib/observe-render.ts

export interface CompactElement {
  index: number;
  tag: string;
  role: string;
  name: string;
  state?: { checked?: boolean; selected?: boolean; active?: boolean; disabled?: boolean; required?: boolean; expanded?: boolean; current?: boolean; invalid?: boolean; sort?: "ascending" | "descending" | "none" };
  // 值域控件(slider/spinbutton/progressbar/meter 等)的当前值,如 "30" / "30/100"。
  valueNow?: string;
  frameId: number;
  // Issue #21 — visual-grounding. Optional tuple [x, y, w, h] in integer px,
  // frame-local viewport coordinates. Present only when caller passes
  // includeBoxes:true AND the element intersects the frame viewport.
  // Tuple form (not object) saves ~6 tokens/element vs `{x,y,w,h}`.
  bbox?: [number, number, number, number];
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
}

export function refOf(e: CompactElement, snapshotHash: string | null): string {
  const frame = e.frameId === 0 ? "" : `f${e.frameId}`;
  const tail = `${frame}e${e.index}`;
  return snapshotHash !== null ? `@${snapshotHash}:${tail}` : `@${tail}`;
}

function stateFlags(state?: CompactElement["state"]): string {
  if (!state) return "";
  const flags: string[] = [];
  if (state.checked) flags.push("checked");
  if (state.selected) flags.push("selected");
  if (state.active) flags.push("active");
  if (state.disabled) flags.push("disabled");
  if (state.required) flags.push("required");
  if (state.expanded) flags.push("expanded");
  if (state.current) flags.push("current");
  if (state.invalid) flags.push("invalid");
  // aria-sort:可排序列当前方向。asc/desc 含方向,none=可排未排(标 sortable)。
  if (state.sort === "ascending") flags.push("sort:asc");
  else if (state.sort === "descending") flags.push("sort:desc");
  else if (state.sort === "none") flags.push("sortable");
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
    lines.push(
      `${refOf(el, snapshotHash)} [${el.role}]${name}${stateFlags(el.state)}${valueSeg}${bboxSeg}`,
    );
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
  return lines.join("\n");
}
