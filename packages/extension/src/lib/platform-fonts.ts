/**
 * Description: 用 CDP 取「这个元素实际用哪个字体渲染」。
 * CSS.getPlatformFontsForNode 是浏览器对渲染结果的汇报,不是推断——
 * 声明栈里的 webfont 常只覆盖拉丁,中文照样回落系统字体,只有它说得出这件事。
 */

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { DebuggerManager } from "./debugger-manager.js";
import { deepQuerySelectorAllExpr } from "./deep-query-expr.js";
import type { PlatformFontUsage } from "./style-evidence.js";

/** 每项对应探针元素数组的同一下标;该元素单独失败时为 null。 */
export type PlatformFontsResult =
  | { fonts: Array<PlatformFontUsage[] | null> }
  | { reason: string };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function fetchPlatformFonts(
  mgr: DebuggerManager,
  tabId: number,
  selector: string,
  limit: number,
  expectedCount: number,
): Promise<PlatformFontsResult> {
  if (expectedCount === 0) return { fonts: [] };
  try {
    const objectIds = await resolveElementObjectIds(mgr, tabId, selector, limit);
    if (objectIds.length !== expectedCount) {
      // 数量对不上就没法按下标对齐,错位地挂到别的元素上比缺失更糟
      return { reason: `element count mismatch: CDP saw ${objectIds.length}, probe saw ${expectedCount}` };
    }
    return { fonts: await Promise.all(objectIds.map((oid) => fontsOf(mgr, tabId, oid))) };
  } catch (e) {
    return { reason: errText(e) };
  }
}

/** requestNode 之前必须 DOM.getDocument,否则 CSS 域报 Could not find node with given id(真站实测)。 */
async function resolveElementObjectIds(
  mgr: DebuggerManager, tabId: number, selector: string, limit: number,
): Promise<string[]> {
  for (const domain of ["DOM", "CSS", "Runtime"]) await mgr.enableDomain(tabId, domain);
  await mgr.sendCommand(tabId, "DOM.getDocument", { depth: 0 });

  const ev = (await mgr.sendCommand(tabId, "Runtime.evaluate", {
    expression: deepQuerySelectorAllExpr(selector, limit),
    returnByValue: false,
  })) as { result?: { objectId?: string } };
  const arrayId = ev.result?.objectId;
  if (!arrayId) {
    throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR,
      "Runtime.evaluate returned no objectId for the element array", { extras: { selector } });
  }

  const props = (await mgr.sendCommand(tabId, "Runtime.getProperties", {
    objectId: arrayId, ownProperties: true,
  })) as { result?: Array<{ name: string; value?: { objectId?: string } }> };
  return (props.result ?? [])
    .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
    .map((p) => p.value!.objectId!);
}

async function fontsOf(mgr: DebuggerManager, tabId: number, objectId: string): Promise<PlatformFontUsage[] | null> {
  try {
    const rn = (await mgr.sendCommand(tabId, "DOM.requestNode", { objectId })) as { nodeId: number };
    const r = (await mgr.sendCommand(tabId, "CSS.getPlatformFontsForNode", { nodeId: rn.nodeId })) as {
      fonts?: PlatformFontUsage[];
    };
    return r.fonts ?? [];
  } catch {
    return null;
  }
}
