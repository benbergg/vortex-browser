import type { CDPAXNode, AXOverlayInfo, AXValueSource } from "../reasoning/types.js";

const GENERIC_ROLES = new Set(["generic", "none", "presentation", "", "text", "InlineTextBox"]);

function getProp(n: CDPAXNode, name: string): unknown {
  return n.properties?.find((p) => p.name === name)?.value?.value;
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
  const checked = getProp(node, "checked");
  if (checked != null && checked !== false) state.checked = checked as boolean | "mixed";
  if (getProp(node, "selected") === true) state.selected = true;
  if (getProp(node, "disabled") === true) state.disabled = true;
  if (getProp(node, "expanded") != null) state.expanded = getProp(node, "expanded") === true;
  if (getProp(node, "required") === true) state.required = true;
  if (getProp(node, "readonly") === true) state.readonly = true;
  if (getProp(node, "invalid") === true || getProp(node, "invalid") === "true") state.invalid = true;
  const level = getProp(node, "level");
  if (typeof level === "number") state.level = level;
  if (Object.keys(state).length > 0) out.state = state;

  const valuetext = getProp(node, "valuetext");
  if (typeof valuetext === "string" && valuetext) out.valueNow = valuetext;
  else if (node.value?.value) out.valueNow = String(node.value.value);

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
