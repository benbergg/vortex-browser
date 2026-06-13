// L3: a11y snapshot 采集（CDP Accessibility.getFullAXTree + filter）。
// spec: vortex重构-L3-spec.md §2.1

import { vtxError, VtxErrorCode } from "@vortex-browser/shared";
import type { AXNode, AXSnapshot, CDPAXNode } from "./types.js";
import { sha16 } from "./descriptor.js";

export interface DebuggerLike {
  enableDomain(tabId: number, domain: string): Promise<void>;
  sendCommand(tabId: number, method: string, params?: unknown): Promise<unknown>;
}

export const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "listbox", "menuitem", "tab", "switch", "slider", "spinbutton",
  "option", "searchbox",
]);

export const STRUCTURAL_ROLES = new Set([
  "heading", "banner", "navigation", "main", "contentinfo",
  "complementary", "region", "dialog", "alert", "status",
]);

function getProp(n: CDPAXNode, name: string): unknown {
  const p = n.properties?.find(x => x.name === name);
  return p?.value?.value;
}

export function isInteresting(n: CDPAXNode): boolean {
  if (n.ignored) return false;
  const role = n.role?.value ?? "";
  if (!role || role === "none" || role === "presentation") return false;

  if (INTERACTIVE_ROLES.has(role)) return true;

  // 显式状态属性 → 必收
  if (
    getProp(n, "focused") === true ||
    getProp(n, "checked") != null ||
    getProp(n, "disabled") === true ||
    getProp(n, "selected") === true
  ) {
    return true;
  }

  const name = n.name?.value ?? "";
  if (STRUCTURAL_ROLES.has(role) && name) return true;

  if (n.backendDOMNodeId && name.length > 0) return true;

  return false;
}

function ellipsize(s: string, max = 100): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

async function toAXNode(n: CDPAXNode, index: number): Promise<AXNode> {
  const role = n.role?.value ?? "generic";
  const name = ellipsize((n.name?.value ?? "").trim());
  const value = (n.value?.value as string | undefined) ?? undefined;
  // textHash encodes the (name|role|value) tuple for cross-snapshot node
  // identity (consumed by RefStore stale-relocation). It is NOT a descriptor
  // lookup key — Tier 2 in descriptor.ts uses substring match, not this hash.
  const textHash = await sha16(`${name}|${role}|${value ?? ""}`);

  const properties: AXNode["properties"] = {};
  const focused = getProp(n, "focused");
  if (focused === true) properties.focused = true;
  const checked = getProp(n, "checked");
  if (checked != null) properties.checked = checked as boolean | "mixed";
  const disabled = getProp(n, "disabled");
  if (disabled === true) properties.disabled = true;
  const expanded = getProp(n, "expanded");
  if (expanded === true) properties.expanded = true;
  const selected = getProp(n, "selected");
  if (selected === true) properties.selected = true;
  const required = getProp(n, "required");
  if (required === true) properties.required = true;
  const readonly = getProp(n, "readonly");
  if (readonly === true) properties.readonly = true;
  const level = getProp(n, "level");
  if (typeof level === "number") properties.level = level;

  const node: AXNode = {
    ref: `@e${index}`,
    role,
    name,
    textHash,
    properties,
  };
  if (value !== undefined) node.value = value;
  if (n.description?.value) node.description = n.description.value;
  if (n.backendDOMNodeId !== undefined) node.backendDOMNodeId = n.backendDOMNodeId;
  if (n.parentId) node.parentRef = `__cdp:${n.parentId}`;
  if (n.childIds && n.childIds.length > 0) node.childRefs = n.childIds.map(id => `__cdp:${id}`);
  return node;
}

function ulid(): string {
  // 简化 ULID：时间戳 base36 + 8 char random，单测里够用。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// closed shadow 探测：先 DOM.describeNode 取 shadowRoots；若 host 是 custom element（含 hyphen）
// 且 shadowRoots 为空，再用 Runtime.evaluate 二次验证（el.shadowRoot 也为 null）→ 判定 closed。
// 任意失败均放行（返回 false 不拦截调用方流程，由调用方决定是否 throw CLOSED_SHADOW_DOM）。
export async function detectClosedShadow(
  debuggerMgr: DebuggerLike,
  tabId: number,
  backendNodeId: number,
): Promise<boolean> {
  try {
    const desc = (await debuggerMgr.sendCommand(tabId, "DOM.describeNode", {
      backendNodeId,
    })) as { node?: { nodeName?: string; shadowRoots?: unknown[] } } | undefined;
    const node = desc?.node;
    if (!node) return false;
    const tag = (node.nodeName ?? "").toLowerCase();
    const isCustomElement = tag.includes("-");
    const hasOpenShadow = (node.shadowRoots ?? []).length > 0;
    if (!isCustomElement || hasOpenShadow) return false;

    const evalResult = (await debuggerMgr.sendCommand(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector('${tag}');
        if (!el) return false;
        return el.shadowRoot === null && el.children.length === 0 && el.getBoundingClientRect().height > 0;
      })()`,
      returnByValue: true,
    })) as { result?: { value?: boolean } } | undefined;
    return evalResult?.result?.value === true;
  } catch {
    return false;
  }
}

function isCrossOriginErr(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /cross-origin|same-origin/i.test(msg);
}

export async function captureAXSnapshot(
  debuggerMgr: DebuggerLike,
  tabId: number,
  frameId = 0,
): Promise<AXSnapshot> {
  await debuggerMgr.enableDomain(tabId, "Accessibility");
  await debuggerMgr.enableDomain(tabId, "DOM");

  let raw: { nodes?: CDPAXNode[] };
  try {
    raw = (await debuggerMgr.sendCommand(
      tabId,
      "Accessibility.getFullAXTree",
      frameId === 0 ? undefined : { frameId },
    )) as { nodes?: CDPAXNode[] };
  } catch (err) {
    if (isCrossOriginErr(err)) {
      throw vtxError(
        VtxErrorCode.CROSS_ORIGIN_IFRAME,
        `Cannot access cross-origin iframe (frameId=${frameId})`,
        { extras: { frameId } },
      );
    }
    throw vtxError(
      VtxErrorCode.A11Y_UNAVAILABLE,
      `Accessibility.getFullAXTree failed: ${err instanceof Error ? err.message : String(err)}`,
      { extras: { frameId } },
    );
  }

  const rawNodes = raw?.nodes ?? [];
  const interesting = rawNodes.filter(isInteresting);
  const nodes = await Promise.all(interesting.map((n, i) => toAXNode(n, i)));

  return {
    snapshotId: ulid(),
    tabId,
    frameId,
    capturedAt: Date.now(),
    nodes,
  };
}

/**
 * 采集 frame 的 AX tree,返回两份索引:byBackend(backendDOMNodeId→CDPAXNode,无 backendId
 * 的节点跳过,因无法关联 DOM)和 byNodeId(nodeId→CDPAXNode,供 compound 走子树)。不过滤。
 * 跨域 iframe / A11Y 不可用时抛 vtxError,由调用方回退纯启发式。
 */
export async function captureAXNodeMap(
  debuggerMgr: DebuggerLike,
  tabId: number,
  frameId = 0,
): Promise<{ byBackend: Map<number, CDPAXNode>; byNodeId: Map<string, CDPAXNode> }> {
  await debuggerMgr.enableDomain(tabId, "Accessibility");
  await debuggerMgr.enableDomain(tabId, "DOM");
  let raw: { nodes?: CDPAXNode[] };
  try {
    raw = (await debuggerMgr.sendCommand(
      tabId,
      "Accessibility.getFullAXTree",
      frameId === 0 ? undefined : { frameId },
    )) as { nodes?: CDPAXNode[] };
  } catch (err) {
    if (isCrossOriginErr(err)) {
      throw vtxError(VtxErrorCode.CROSS_ORIGIN_IFRAME,
        `Cannot access cross-origin iframe (frameId=${frameId})`, { extras: { frameId } });
    }
    throw vtxError(VtxErrorCode.A11Y_UNAVAILABLE,
      `Accessibility.getFullAXTree failed: ${err instanceof Error ? err.message : String(err)}`,
      { extras: { frameId } });
  }
  const byBackend = new Map<number, CDPAXNode>();
  const byNodeId = new Map<string, CDPAXNode>();
  for (const n of raw?.nodes ?? []) {
    byNodeId.set(n.nodeId, n);
    if (n.backendDOMNodeId !== undefined) byBackend.set(n.backendDOMNodeId, n);
  }
  return { byBackend, byNodeId };
}
