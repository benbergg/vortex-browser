import type { CDPAXNode, AXOverlayInfo, AXValueSource } from "../reasoning/types.js";

// AX role 命中这些时不夺启发式 role(信召回 + 保留更清晰的启发式角色)。
// 除无语义的 generic/none/presentation 外,也含 Chrome AX 内部文本角色 LabelText
// ——可点 <label> 的 AX role 是 LabelText,但对 LLM 远不如启发式的 `label` 清晰
// (bench aria-cursor-nested-no-dup 暴露)。name/state 仍取 AX。
// 注意:GENERIC_ROLES 是「AX 角色不夺启发式」的策略集合,与 taxonomy 的
// 「召回分类」语义不同(AX 增强策略 ≠ 召回决策),不强行派生以避免语义错配。
// 改此处须同步 aria-taxonomy.test.ts 的等价用例。
export const GENERIC_ROLES = new Set([
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
 * 字体图标字形名(Unicode 私有区字符)不是可用名。
 *
 * Chrome 的 AX name-from-content 取 ::before 字体字形:`<button class="vxe-icon-edit">`
 * 的 AX name 是 U+E61E 字形,而非可读名。AX 命中即覆盖会把 page-side 的
 * iconFontName 补名("edit")洗成字形 —— agent 读到 `button ""` 定位不到控件
 * (bench nameless-control-recall #icon-edit P1,2026-06-19 起长期存在)。
 *
 * 只认「全是私有区字符」的名字;含文本的混合名(aria-label "编辑 \ue61e")仍按 AX 取。
 */
function isGlyphName(name: string): boolean {
  const chars = [...name];
  if (!chars.length) return false;
  return chars.every((c) => {
    const cp = c.codePointAt(0)!;
    return (
      (cp >= 0xe000 && cp <= 0xf8ff) || // BMP 私有区
      (cp >= 0xf0000 && cp <= 0xffffd) || // 增补平面私有区 A
      (cp >= 0x100000 && cp <= 0x10fffd) // 增补平面私有区 B
    );
  });
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
  // 字体图标字形名不覆盖启发式补名(见 isGlyphName 注释);page-side 本就无名时
  // 保留原行为(字形仍照旧输出,不改现状)。
  if (axName && !(isGlyphName(axName) && el.name)) {
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
  frameId?: string;
}

/** Match a scan nonce only inside its owning document, never its child documents. */
export function resolveFrameDocument(root: CDPDomNode, token: string): { frameId: string; document: CDPDomNode } | undefined {
  const matches: Array<{ frameId?: string; document: CDPDomNode }> = [];
  const visitDocument = (document: CDPDomNode, frameId?: string): void => {
    let count = 0;
    const walk = (node: CDPDomNode): void => {
      const attrs = node.attributes ?? [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === "data-vtx-frame-ax" && attrs[i + 1] === token) count++;
      }
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) visitDocument(node.contentDocument, node.frameId);
    };
    walk(document);
    for (let i = 0; i < count; i++) matches.push({ frameId, document });
  };
  visitDocument(root);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match?.frameId ? { frameId: match.frameId, document: match.document } : undefined;
}

/** 遍历 DOM.getDocument 树取 data-vtx-ax → backendNodeId。穿 shadowRoots,但**不**进
 *  contentDocument(iframe 内容)——v1 仅覆盖主 frame,避免子 frame 同值标记冲突。 */
export function buildIndexToBackend(root: CDPDomNode, strict = false, token?: string): Map<number, number> {
  const map = new Map<number, number>();
  const ambiguous = new Set<number>();
  const walk = (n: CDPDomNode): void => {
    const attrs = n.attributes ?? [];
    for (let i = 0; i < attrs.length; i += 2) {
      if (attrs[i] === "data-vtx-ax" && n.backendNodeId !== undefined) {
        const value = attrs[i + 1];
        const rawIndex = token === undefined ? value : value?.startsWith(`${token}:`) ? value.slice(token.length + 1) : undefined;
        if (rawIndex === undefined || (token !== undefined && !/^(0|[1-9]\d*)$/.test(rawIndex))) continue;
        const index = Number(rawIndex);
        if (token !== undefined && !Number.isSafeInteger(index)) continue;
        if (strict && (map.has(index) || ambiguous.has(index))) {
          map.delete(index);
          ambiguous.add(index);
        } else map.set(index, n.backendNodeId);
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
  maskedContent?: boolean;
  role: string; name: string;
  state?: Record<string, unknown>;
  valueNow?: string;
  reactClickable?: true;
  nameSource?: string;
  semanticSource?: "ax" | "dom" | "heuristic";
  compound?: {
    role: string;
    count?: number;
    options?: string[];
    formatHint?: string;
    min?: string;
    max?: string;
    step?: string;
  };
  controls?: Array<{ index?: number; id?: string }>; owns?: Array<{ index?: number; id?: string }>; errorMessage?: string; description?: string;
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
    if (el.maskedContent) {
      const state = computeAXOverlay({ backendId: backendId!, role: el.role, name: el.name }, node).state;
      if (state) {
        el.state = { ...(el.state ?? {}), ...state };
        el.semanticSource = "ax";
      }
      continue;
    }
    const ov = computeAXOverlay(
      { backendId: backendId!, role: el.role, name: el.name, heuristicInteractive: el.reactClickable === true },
      node,
    );
    // tree 展开/折叠 toggle:保留 page-side 的 role=button/name=expand|collapse,
    // 不被 CDP AX 的 presentational caret(role=img/name="caret-down")覆盖(R25)。
    if ((!el.treeToggle && (ov.role || ov.name)) || ov.state || ov.valueNow !== undefined || ov.errorMessage || ov.description) el.semanticSource = "ax";
    if (ov.role && !el.treeToggle) el.role = ov.role;
    if (ov.name && !el.treeToggle) el.name = ov.name;
    el.nameSource = ov.nameSource ?? "heuristic";
    if (ov.state) el.state = { ...(el.state ?? {}), ...ov.state };
    if (ov.valueNow !== undefined) el.valueNow = ov.valueNow;
    if (ov.controls) {
      // R4 B012 修复:AX 路径设的 controls 必须用 B008 形状 [{index:N}],而非纯
      // 数字数组 — 后者被渲染层当 {index:数字,id:undefined} 用,拼出
      // `controls=#undefined`(2026-06-28 a11y 评测 R4)。B008 路径(aria-controls
      // 字符串,3188-3220)设的是 [{id|index}],B009 fallback 是 [{id:"ghost"}]。
      // 形状必须对齐,否则 AX 路径覆盖 page-side 路径后渲染成 `#undefined`。
      // 优先级:AX 路径(更准,CDP 拿的 relatedNodes)优先;若所有 backendId 都
      // 找不到对应 index,保留 page-side 路径设的 controls(它仍可能正确)。
      const ctrlList: Array<{ index: number; id?: undefined }> = [];
      for (const b of ov.controls) {
        const idx = backendToIndex.get(b);
        if (idx != null) ctrlList.push({ index: idx });
      }
      if (ctrlList.length) { el.controls = ctrlList; el.semanticSource = "ax"; }
    }
    if (ov.owns) {
      // 同 controls 形状对齐修复
      const ownList: Array<{ index: number; id?: undefined }> = [];
      for (const b of ov.owns) {
        const idx = backendToIndex.get(b);
        if (idx != null) ownList.push({ index: idx });
      }
      if (ownList.length) { el.owns = ownList; el.semanticSource = "ax"; }
    }
    if (ov.errorMessage) el.errorMessage = ov.errorMessage;
    if (ov.description) el.description = ov.description;
    const compound = extractCompound(node, axByNodeId);
    if (compound) { el.compound = compound; el.semanticSource = "ax"; }
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
  // R2 B006: options 上限从 4 提到 6(2026-06-28 a11y 评测 R2)。原 4 上限 + 真实
  // count=6+ 时 observe 输出"6 个只列 4 个",Agent 看 count 与 options 长度矛盾
  // 误以为后段被丢或已筛选;提到 6 后多数场景(react-aria ListBox 默认 6 个 options)
  // 完整展示。>6 仍截断,但加 truncated:N 透明告诉 agent 还有 N 个未列。
  const OPTIONS_LIMIT = 6;
  const options: string[] = [];
  let totalOptions = 0;
  for (const oid of optionIds) {
    const o = byNodeId.get(oid);
    const nm = (o?.name?.value ?? "").trim();
    if (o?.role?.value === "option" && nm) {
      totalOptions++;
      if (options.length < OPTIONS_LIMIT) options.push(nm);
    }
  }
  // R2 B006: 仅当实际 listbox options 数 > 列出的 options 数时,标 truncated:N。
  // 渲染层据此追加 "+N more" 提示,避免 Agent 误以为 options 是完整列表。
  const out: NonNullable<AXOverlayInfo["compound"]> = {
    role: "listbox",
    count: optionIds.length,
    options,
  };
  if (totalOptions > options.length) {
    out.truncated = totalOptions - options.length;
  }
  return out;
}
