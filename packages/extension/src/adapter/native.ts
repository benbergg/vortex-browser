// L1 Native Adapter：chrome.tabs / scripting / storage 包装。
// 见 ../handlers/dom.ts 内现有调用，PR #1 各 task 逐步迁入本文件。

import {
  ANCESTOR_HIT_HINT,
  NO_HIT_HINT,
  VtxErrorCode,
  ancestorHitMessage,
  noHitMessage,
  vtxError,
} from "@vortex-browser/shared";
import type { NativeAdapter } from "./types.js";
import { buildExecuteTarget } from "../lib/tab-utils.js";

/**
 * pageQuery 的 timeoutMs 触发的超时错误(可与真实 executeScript 错误区分)。
 * 调用方据此只把「探针永不 settle 超时」映射为可重试,真错误(tab 关闭 / 无 frame)
 * 仍透传快速失败(2026-06-03 press-combo flake 调查)。
 */
export class PageQueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `pageQuery executeScript timed out after ${timeoutMs}ms ` +
        `(target tab likely in bad SW/navigation state); retryable`,
    );
    this.name = "PageQueryTimeoutError";
  }
}

// 公共 helper（T1.5a 实现）
export async function pageQuery<T>(
  tabId: number,
  frameId: number | undefined,
  fn: (...args: unknown[]) => T,
  args: unknown[] = [],
  timeoutMs?: number,
): Promise<T> {
  const exec = chrome.scripting
    .executeScript({
      target: buildExecuteTarget(tabId, frameId),
      func: fn,
      args,
      world: "MAIN",
    })
    .then((r) => r[0]?.result as T);
  // 不传 timeoutMs:行为不变(保留既有调用方语义)。
  if (timeoutMs === undefined) return exec;
  // 加界:chrome.scripting.executeScript 在坏 SW/tab 态(SW 回收重启、跨进程导航
  // 中途、renderer 卡顿)会**永不 settle**(既不 resolve 也不 reject)。探针调用经
  // waitActionable 的 while 循环,而预算只在循环**顶部**检查——永不返回的 await 绕过
  // 预算 → dom.* 挂到外层 30s MCP 超时(observe 走裸 executeScript 无门故健康)。
  // 这里把无界 await 转成有界 reject,使调用方(checkActionability)能映射为可重试
  // 失败,让 waitActionable 预算真正生效(2026-06-03 press-combo flake 调查;与
  // page-side-loader.ts 的 INJECT_TIMEOUT_MS 同款机制,泛化到探针执行)。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new PageQueryTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([exec, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * 把 page-side func 返回的 { error?, errorCode?, extras? } 统一映射为 vtxError 抛出。
 * 抽取自 dom.ts 5 处重复模板（CLICK / TYPE / FILL / SELECT / HOVER 末尾的错误码映射）。
 * 调用方仅在 page-side func 返回 error 时调用本 helper（其他情况按原代码 throw）。
 * 返回 never，便于 TS 在调用点 narrow res.error 为非 undefined。
 */
/**
 * page-side 只带回 extras.hitKind / blocker,话术在宿主侧单点成型:注入函数里再写
 * 一遍必然与门分叉(评审 I1 实测三条路径共判据但不共话术)。祖先命中与中心点落空
 * 的修法都与「关掉浮层」相反,故连 hint 一并覆盖。
 */
function hitOwnershipOverride(
  res: { errorCode?: string; extras?: Record<string, unknown> } | undefined,
  selector: string | undefined,
): { message: string; hint: string } | undefined {
  if (res?.errorCode !== VtxErrorCode.ELEMENT_OCCLUDED) return undefined;
  const blocker = res.extras?.blocker;
  if (typeof blocker !== "string") return undefined;
  const target = selector ? `Element ${selector}` : "Element";
  if (blocker === "elementFromPoint=null") {
    return { message: noHitMessage(target), hint: NO_HIT_HINT };
  }
  if (res.extras?.hitKind !== "ancestor") return undefined;
  return { message: ancestorHitMessage(target, blocker), hint: ANCESTOR_HIT_HINT };
}

export function mapPageError(
  res: { error?: string; errorCode?: string; extras?: Record<string, unknown> } | undefined,
  selector: string | undefined,
): never {
  const error = res?.error ?? "Unknown error";
  const code: VtxErrorCode =
    res?.errorCode && res.errorCode in VtxErrorCode
      ? (res.errorCode as VtxErrorCode)
      : error.startsWith("Element not found:") || error.startsWith("Container not found:")
        ? VtxErrorCode.ELEMENT_NOT_FOUND
        : VtxErrorCode.JS_EXECUTION_ERROR;
  // 保持与原 dom.ts 行为：selector 缺失时仅在有 extras 时附 context；都缺则不传 context。
  const hasContext = selector !== undefined || res?.extras !== undefined;
  const override = hitOwnershipOverride(res, selector);
  throw vtxError(
    code,
    override?.message ?? error,
    hasContext ? { selector, extras: res?.extras } : undefined,
    override ? { hint: override.hint } : undefined,
  );
}

// 整个 adapter 的 facade（保留供 future 注入用）
export const nativeAdapter: NativeAdapter = {
  pageQuery,
};
