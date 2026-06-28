// L3 Reasoning 层类型定义。spec: vortex重构-L3-spec.md §1

export interface AXNode {
  ref: string;
  role: string;
  name: string;
  description?: string;
  value?: string;
  textHash: string;
  properties: {
    focused?: boolean;
    checked?: boolean | "mixed";
    disabled?: boolean;
    expanded?: boolean;
    selected?: boolean;
    required?: boolean;
    readonly?: boolean;
    level?: number;
    /** aria-autocomplete=list/both/none/inline, combobox 自动补全语义。@since R1 B003 */
    autocomplete?: "list" | "both" | "none" | "inline";
  };
  bounds?: { x: number; y: number; w: number; h: number };
  parentRef?: string;
  childRefs?: string[];
  backendDOMNodeId?: number;
}

export interface AXSnapshot {
  snapshotId: string;
  tabId: number;
  frameId: number;
  capturedAt: number;
  nodes: AXNode[];
}

export interface Descriptor {
  role?: string;
  name?: string;
  text?: string;
  selector?: string;
  near?: { ref: string; relation: "parent" | "sibling" | "child" };
  strict?: false;
}

export interface RefEntry {
  ref: string;
  snapshotId: string;
  descriptor: Descriptor;
  backendDOMNodeId?: number;
  lastValid: number;
}

export interface AXValueSource {
  type: string; // attribute | contents | placeholder | relatedElement | ...
  attribute?: string;
  value?: { value: unknown };
}

// CDP raw shape from Accessibility.getFullAXTree
export interface CDPAXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  role?: { value: string };
  name?: { value: string; sources?: AXValueSource[] };
  description?: { value: string };
  value?: { value: string };
  // properties 值可能携带 relatedNodes(controls/owns/errormessage 等关系)
  properties?: Array<{
    name: string;
    value: { value?: unknown; relatedNodes?: Array<{ backendDOMNodeId?: number; text?: string }> };
  }>;
  ignored?: boolean;
  backendDOMNodeId?: number;
}

// overlay 写回 ScannedElement 的语义增量
export interface AXOverlayInfo {
  role?: string;
  name?: string;
  nameSource?: "aria-label" | "aria-labelledby" | "label" | "contents" | "placeholder" | "title" | "heuristic";
  state?: {
    checked?: boolean | "mixed"; selected?: boolean; disabled?: boolean;
    expanded?: boolean; required?: boolean; readonly?: boolean; invalid?: boolean;
    /** aria-autocomplete=list/both/none, combobox 自动补全语义。@since R1 B003 */
    autocomplete?: "list" | "both" | "none" | "inline";
    /** aria-pressed=true, toggle button 状态(与 [active] 同源不同义)。@since R1 B004 */
    pressed?: boolean;
  };
  valueNow?: string;
  controls?: number[];      // 目标 backendDOMNodeId(后续 remap 到 index)
  owns?: number[];
  errorMessage?: string;
  description?: string;
  compound?: {
    role: string;
    count?: number;
    options?: string[];
    /** R2 B006: options 截断时被隐藏的 option 数(原 4 上限提至 6,>6 透明截断) */
    truncated?: number;
    /** date/time 格式串(如 YYYY-MM-DD)或 file input 当前文件名/None */
    formatHint?: string;
    /** range/number input 的最小值约束 */
    min?: string;
    /** range/number input 的最大值约束 */
    max?: string;
    /** range/number input 的步长约束 */
    step?: string;
  };
}
