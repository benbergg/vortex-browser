/**
 * Description: 用 CDP 取「这个元素实际用哪个字体渲染」。
 * CSS.getPlatformFontsForNode 是浏览器对渲染结果的汇报,不是推断——
 * 声明栈里的 webfont 常只覆盖拉丁,中文照样回落系统字体,只有它说得出这件事。
 */

import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { DebuggerManager } from "./debugger-manager.js";
import { FINGERPRINT_ON_ARRAY_FN, PATH_MAX_SEGMENTS, deepQuerySelectorAllExpr } from "./deep-query-expr.js";
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
  fingerprints: string[],
): Promise<PlatformFontsResult> {
  if (fingerprints.length === 0) return { fonts: [] };
  let arrayId: string | undefined;
  const objectIds: string[] = [];
  try {
    arrayId = await evaluateElementArray(mgr, tabId, selector, limit);
    const seen = (await callOnArray(mgr, tabId, arrayId, FINGERPRINT_ON_ARRAY_FN)) as unknown;
    if (!Array.isArray(seen)) {
      throw vtxError(VtxErrorCode.JS_EXECUTION_ERROR,
        "could not read element fingerprints from the page", { extras: { selector } });
    }
    // 两个元素身份相同就分不出谁是谁,重排照样通过逐项比对 —— 宁可不给
    if (fingerprints.length !== new Set(fingerprints).size) {
      // 分开说:深度截断致同身份和真的结构重复,调用方处置不一样
      const truncated = fingerprints.some((f) => f.split(">").length >= PATH_MAX_SEGMENTS);
      return { reason: truncated
        ? `element identities collided after path truncation at ${PATH_MAX_SEGMENTS} levels; cannot prove alignment`
        : "element identities are not unique; cannot prove alignment" };
    }
    // 数量相同、顺序不同时按下标对齐会把字体挂到别的元素上,只比 count 抓不到
    if (seen.length !== fingerprints.length || seen.some((f, i) => f !== fingerprints[i])) {
      return { reason: `element fingerprint mismatch: CDP saw ${seen.length}, probe saw ${fingerprints.length}` };
    }
    objectIds.push(...(await elementObjectIds(mgr, tabId, arrayId)));
    return { fonts: await Promise.all(objectIds.map((oid) => fontsOf(mgr, tabId, oid))) };
  } catch (e) {
    return { reason: errText(e) };
  } finally {
    await release(mgr, tabId, [...(arrayId ? [arrayId] : []), ...objectIds]);
  }
}

/** requestNode 之前必须 DOM.getDocument,否则 CSS 域报 Could not find node with given id(真站实测)。 */
async function evaluateElementArray(
  mgr: DebuggerManager, tabId: number, selector: string, limit: number,
): Promise<string> {
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
  return arrayId;
}

async function callOnArray(mgr: DebuggerManager, tabId: number, arrayId: string, fn: string): Promise<unknown> {
  const r = (await mgr.sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId: arrayId, functionDeclaration: fn, returnByValue: true,
  })) as { result?: { value?: unknown } };
  return r.result?.value;
}

async function elementObjectIds(mgr: DebuggerManager, tabId: number, arrayId: string): Promise<string[]> {
  const props = (await mgr.sendCommand(tabId, "Runtime.getProperties", {
    objectId: arrayId, ownProperties: true,
  })) as { result?: Array<{ name: string; value?: { objectId?: string } }> };
  // __proto__ 也带 objectId,只看 objectId 会多出一个幽灵元素
  return (props.result ?? [])
    .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
    .map((p) => p.value!.objectId!);
}

/**
 * font 组默认开启,不释放远程对象会一直堆在 renderer 的 object table 里。
 * deadline 只保证调用方不被挂住,**不取消**底层命令(chrome.debugger 没有取消能力),
 * 超时的那条仍在后台 pending。
 */
const RELEASE_DEADLINE_MS = 1000;

async function release(mgr: DebuggerManager, tabId: number, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const all = Promise.all(ids.map((objectId) =>
    Promise.resolve(mgr.sendCommand(tabId, "Runtime.releaseObject", { objectId })).catch(() => undefined),
  ));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((res) => { timer = setTimeout(res, RELEASE_DEADLINE_MS); });
  try {
    await Promise.race([all.then(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
