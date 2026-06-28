import type { CDPAXNode, AXOverlayInfo, AXValueSource } from "../reasoning/types.js";

// AX role 命中这些时不夺启发式 role(信召回 + 保留更清晰的启发式角色)。
// 除无语义的 generic/none/presentation 外,也含 Chrome AX 内部文本角色 LabelText
// ——可点 <label> 的 AX role 是 LabelText,但对 LLM 远不如启发式的 `label` 清晰
// (bench aria-cursor-nested-no-dup 暴露)。name/state 仍取 AX。
const GENERIC_ROLES = new Set([
  "generic", "none", "presentation", "", "text", "InlineTextBox", "LabelText",
]);

function getProp(n: CDPAXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
}

/**
 * 还原 Chrome Accessibility.getFullAXTree 对 value/valuetext 类 AXValue 的双重编码。
 * Chrome 把这些属性的 UTF-8 字节当 Latin-1 逐字节映射成 JS 字符串返回(name 不受影响),
 * 例:DOM aria-valuetext="弱 – Weak"(U+5F31 U+2013 …)→ CDP 返回 "å¼± â Weak"
 * (字节 0xE5 0xBC 0xB1 0xE2 0x80 0x93 各自当 Latin-1 码位)。2026-06-23 react-aria
 * DatePicker dogfood:spinbutton value "6 – June" 被渲染成 "6 â June"。
 *
 * 还原:把每个码位当单字节取回原 UTF-8 字节序列,再按 UTF-8 严格解码。
 * 安全护栏:① 含真正多字节字符(码位 > 0xFF)说明非 mojibake,原样返回;
 * ② fatal UTF-8 解码失败说明本就是合法 Latin-1 文本(如 "café" 的孤立 0xE9),原样返回。
 * 仅作用于 value 路径——name/description 经 dogfood 实证未被 Chrome 双重编码。
 */
function repairCdpUtf8(s: string): string {
  let hasHigh = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s; // 含真多字节字符 → 非 mojibake,原样返回
    if (c >= 0x80) hasHigh = true;
  }
  if (!hasHigh) return s; // 纯 ASCII → 无双重编码可能
  try {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return s; // 非合法 UTF-8 字节序列 → 真 Latin-1 文本,保留原值
  }
}

function getRelated(n: CDPAXNode, name: string): Array<{ backendDOMNodeId?: number; text?: string }> {
  return n.properties?.find((p) => p.name === name)?.value?.relatedNodes ?? [];
}

function nameSourceOf(sources?: AXValueSource[]): AXOverlayInfo["nameSource"] | undefined {
  const s = sources?.find((x) => x.value?.value != null || x.type === "contents" || x.type === "placeholder" || x.attribute);
  if (!s) return undefined;
  if (s.attribute === "aria-label") return "aria-label";
  if (s.type === "relatedElement" || s.attribute === "aria-labelledby") return "aria-labelledby";
  if (s.type === "placeholder") return "placeholder";
  if (s.attribute === "title") return "title";
  if (s.type === "contents") return "contents";
  if (s.attribute === "label" || s.type === "attribute") return "label";
  return undefined;
}

/**
 * 计算单个已扫元素的 AX 语义覆盖增量。input 是该元素的启发式现值子集。
 * 优先级:① AX role 非 generic → 覆盖 role;② AX role=generic 但启发式判交互 → 留启发式 role;
 * ③ name/state/value AX 命中即覆盖;④ nameSource 标来源。
 */
export function computeAXOverlay(
  el: { backendId: number; role: string; name: string; heuristicInteractive?: boolean },
  node: CDPAXNode,
): AXOverlayInfo {
  const out: AXOverlayInfo = {};
  const axRole = node.role?.value ?? "";
  if (axRole && !GENERIC_ROLES.has(axRole)) out.role = axRole;

  const axName = (node.name?.value ?? "").trim();
  if (axName) {
    out.name = axName;
    out.nameSource = nameSourceOf(node.name?.sources);
  }

  const state: NonNullable<AXOverlayInfo["state"]> = {};
  // CDP checked 是 tristate:value 为字符串 "true"/"false"/"mixed"(亦可能布尔 true)。
  // 旧判据 `checked !== false` 只排除布尔 false,放过字符串 "false" → state.checked="false"
  // (truthy)→ 渲染层误发 [checked]。Radix/Ant/MUI 风格 role=radio/checkbox 未选中项全
  // 中招(2026-06-14 reactflow.dev dogfood B1)。须按 tristate token 精确判定。
  const checked = getProp(node, "checked");
  if (checked === "mixed") state.checked = "mixed";
  else if (checked === true || checked === "true") state.checked = true;
  if (getProp(node, "selected") === true) state.selected = true;
  if (getProp(node, "disabled") === true) state.disabled = true;
  if (getProp(node, "expanded") != null) state.expanded = getProp(node, "expanded") === true;
  if (getProp(node, "required") === true) state.required = true;
  if (getProp(node, "readonly") === true) state.readonly = true;
  if (getProp(node, "invalid") === true || getProp(node, "invalid") === "true") state.invalid = true;
  // R1 B003: aria-autocomplete=list/both/none/inline, combobox 自动补全语义。
  // CDP properties.autocomplete 与 aria-autocomplete 对齐,仅取合法 token。
  const autocomplete = getProp(node, "autocomplete");
  if (
    autocomplete === "list" ||
    autocomplete === "both" ||
    autocomplete === "none" ||
    autocomplete === "inline"
  ) {
    state.autocomplete = autocomplete;
  }
  // R1 B004: aria-pressed 是 toggle button 标准状态,AX 同源,独立标 [pressed]
  // 而非合并到 [active](2026-06-28 a11y 评测 R1 B004)。仅 true 输出,false/缺省不发。
  if (getProp(node, "pressed") === true || getProp(node, "pressed") === "true") {
    state.pressed = true;
  }
  if (Object.keys(state).length > 0) out.state = state;

  const valuetext = getProp(node, "valuetext");
  let rawValue: string | undefined;
  // CDP 双重编码还原:value/valuetext 的非 ASCII 字符须经 repairCdpUtf8(详见上方注释)。
  if (typeof valuetext === "string" && valuetext) rawValue = repairCdpUtf8(valuetext);
  else if (node.value?.value) rawValue = repairCdpUtf8(String(node.value.value));
  // 对齐 page-side getValueInfo 纪律:归一化空白(换行/制表→单空格)+截断 200。
  // AX node.value.value 对 contentEditable/textarea 给「全文」,无截断会撑爆 observe
  // 输出 token(长文档编辑器/Notion/工单)且 \n 破坏单行渲染(2026-06-23 prosemirror dogfood)。
  // slider/range 等短值(如 "50%")不受影响。
  if (rawValue) out.valueNow = rawValue.replace(/\s+/g, " ").trim().slice(0, 200);

  const controls = getRelated(node, "controls").map((r) => r.backendDOMNodeId).filter((x): x is number => x != null);
  if (controls.length) out.controls = controls;
  const owns = getRelated(node, "owns").map((r) => r.backendDOMNodeId).filter((x): x is number => x != null);
  if (owns.length) out.owns = owns;
  const errNodes = getRelated(node, "errormessage");
  if (errNodes.length) {
    const txt = errNodes.map((r) => r.text).filter(Boolean).join(" ").trim();
    if (txt) out.errorMessage = txt;
  }
  if (node.description?.value) out.description = node.description.value;

  return out;
}

/** marker 真源(单测用)。observe.ts 注入体内联同语义副本——改一处须同步。 */
export function STAMP_MARKERS(els: Element[]): void {
  for (let i = 0; i < els.length; i++) els[i].setAttribute("data-vtx-ax", String(i));
}
export function CLEAR_MARKERS(doc: Document): void {
  for (const el of doc.querySelectorAll("[data-vtx-ax]")) el.removeAttribute("data-vtx-ax");
}

interface CDPDomNode {
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[]; // 扁平 [name,value,name,value,...]
  children?: CDPDomNode[];
  shadowRoots?: CDPDomNode[];
  contentDocument?: CDPDomNode;
}

/** 遍历 DOM.getDocument 树取 data-vtx-ax → backendNodeId。穿 shadowRoots,但**不**进
 *  contentDocument(iframe 内容)——v1 仅覆盖主 frame,避免子 frame 同值标记冲突。 */
export function buildIndexToBackend(root: CDPDomNode): Map<number, number> {
  const map = new Map<number, number>();
  const walk = (n: CDPDomNode): void => {
    const attrs = n.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === "data-vtx-ax" && n.backendNodeId !== undefined) {
        map.set(Number(attrs[i + 1]), n.backendNodeId);
      }
    }
    for (const c of n.children ?? []) walk(c);
    for (const s of n.shadowRoots ?? []) walk(s);
    // 不递归 contentDocument:v1 仅主 frame
  };
  walk(root);
  return map;
}

/** applyOverlay 原地改写所需的最小元素形(ScannedElement 的结构子集)。 */
export interface OverlayableElement {
  role: string; name: string;
  state?: Record<string, unknown>;
  valueNow?: string;
  reactClickable?: true;
  nameSource?: string;
  compound?: {
    role: string;
    count?: number;
    options?: string[];
    formatHint?: string;
    min?: string;
    max?: string;
    step?: string;
  };
  controls?: number[]; owns?: number[]; errorMessage?: string; description?: string;
  tag?: string;
  /** tree 展开/折叠 toggle(R25):page-side 已定 role=button/name=expand|collapse,
   *  CDP AX 视 caret 为 presentational(role=img/name="caret-down"),overlay 须跳过覆盖。 */
  treeToggle?: boolean;
}

/**
 * 对主 frame 已扫元素原地应用 AX 覆盖。
 * indexToBackend: data-vtx-ax 下标→backendDOMNodeId; axByBackend: backendId→CDPAXNode;
 * axByNodeId: nodeId→CDPAXNode(compound 子树)。controls/owns 的 backendId 就地 remap 成
 * frame-local 下标(主 frame frameBase=0,即全局 index)。漏命中→nameSource="heuristic",
 * 其余保留启发式,不抛。
 */
export function applyOverlay(
  elements: OverlayableElement[],
  indexToBackend: Map<number, number>,
  axByBackend: Map<number, CDPAXNode>,
  axByNodeId: Map<string, CDPAXNode>,
): void {
  const backendToIndex = new Map<number, number>();
  for (const [idx, bid] of indexToBackend) backendToIndex.set(bid, idx);
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const backendId = indexToBackend.get(i);
    const node = backendId !== undefined ? axByBackend.get(backendId) : undefined;
    if (!node) { el.nameSource = "heuristic"; continue; }
    const ov = computeAXOverlay(
      { backendId: backendId!, role: el.role, name: el.name, heuristicInteractive: el.reactClickable === true },
      node,
    );
    // tree 展开/折叠 toggle:保留 page-side 的 role=button/name=expand|collapse,
    // 不被 CDP AX 的 presentational caret(role=img/name="caret-down")覆盖(R25)。
    if (ov.role && !el.treeToggle) el.role = ov.role;
    if (ov.name && !el.treeToggle) el.name = ov.name;
    el.nameSource = ov.nameSource ?? "heuristic";
    if (ov.state) el.state = { ...(el.state ?? {}), ...ov.state };
    if (ov.valueNow !== undefined) el.valueNow = ov.valueNow;
    if (ov.controls) {
      const idxs = ov.controls.map((b) => backendToIndex.get(b)).filter((x): x is number => x != null);
      if (idxs.length) el.controls = idxs;
    }
    if (ov.owns) {
      const idxs = ov.owns.map((b) => backendToIndex.get(b)).filter((x): x is number => x != null);
      if (idxs.length) el.owns = idxs;
    }
    if (ov.errorMessage) el.errorMessage = ov.errorMessage;
    if (ov.description) el.description = ov.description;
    const compound = extractCompound(node, axByNodeId);
    if (compound) el.compound = compound;
  }
}

const COMPOUND_TRIGGER_ROLES = new Set(["combobox", "listbox", "select", "slider", "spinbutton"]);

/** 复合控件展开:从 AX 子树取 listbox 选项样本 / 范围。byNodeId 是 nodeId→CDPAXNode 全量索引。 */
export function extractCompound(
  node: CDPAXNode,
  byNodeId: Map<string, CDPAXNode>,
): NonNullable<AXOverlayInfo["compound"]> | undefined {
  const role = node.role?.value ?? "";
  // slider/spinbutton 的值域已由 valueNow 覆盖,此处仅展开 option 集合类。
  if (role === "slider" || role === "spinbutton") return undefined;
  if (!COMPOUND_TRIGGER_ROLES.has(role)) return undefined;

  // 找 listbox(自身或子节点)
  let listbox: CDPAXNode | undefined = role === "listbox" ? node : undefined;
  if (!listbox) {
    for (const cid of node.childIds ?? []) {
      const c = byNodeId.get(cid);
      if (c?.role?.value === "listbox") { listbox = c; break; }
    }
  }
  if (!listbox) return undefined;
  const optionIds = listbox.childIds ?? [];
  const options: string[] = [];
  for (const oid of optionIds) {
    const o = byNodeId.get(oid);
    const nm = (o?.name?.value ?? "").trim();
    if (o?.role?.value === "option" && nm) {
      if (options.length < 4) options.push(nm);
    }
  }
  return { role: "listbox", count: optionIds.length, options };
}
