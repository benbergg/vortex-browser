// L1 Capability Detector：探测当前环境能力，决定走 native / cdp 路径。
// Wired into production via action/fallback.ts (drag / typed-input adapters).

import type { CapabilityDetector } from "./types.js";
import type { DebuggerManager } from "../lib/debugger-manager.js";

const DRAG_REQUIRES_CDP = true; // drag 操作 untrusted event 不可用，强制 CDP

/**
 * 探测 chrome.debugger 是否可用且能成功 attach。
 *
 * 两种模式：
 * - 传 debuggerMgr（CDP-first 转正后的常规形态）：try-attach **留驻**——成功即保持
 *   attached（经 manager 记账，后续动作复用 session）。probe-detach 会让非 trusted
 *   Chrome 的 infobar 闪现，且 CDP-first 下紧随其后的动作本来就要再 attach。
 * - 不传（legacy）：attach→立即 detach 的纯探测，保持原语义。
 */
async function canUseCDP(tabId: number, debuggerMgr?: DebuggerManager): Promise<boolean> {
  // 1) chrome.debugger 不存在 → false（service worker 环境异常 / 权限缺失）
  if (
    typeof chrome === "undefined" ||
    !chrome.debugger ||
    typeof chrome.debugger.attach !== "function"
  ) {
    return false;
  }

  // 2a) resident 模式：经 manager try-attach 留驻（1 秒 budget，挂起视为不可用——
  //     超时后 attach 若仍成功，session 留在 manager 记账内，下一动作直接复用，无泄漏）
  if (debuggerMgr) {
    if (debuggerMgr.isAttached(tabId)) return true;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("canUseCDP attach timeout")), 1000);
      });
      try {
        await Promise.race([debuggerMgr.attach(tabId), timeout]);
      } finally {
        clearTimeout(timer);
      }
      return true;
    } catch {
      return false;
    }
  }

  // 2b) legacy：尝试 attach + detach（探测性，1 秒 budget）
  // timed-out flag：超时 resolve(false) 后 attach callback 仍可能成功 → 必须 detach 清理，
  // 否则 debugger 残留 attached 状态影响后续其他 CDP 调用（自身 driver / 用户其他 chrome.debugger 用户）。
  let timedOut = false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(false);
    }, 1000);
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        clearTimeout(timer);
        const lastError = chrome.runtime?.lastError;
        if (timedOut) {
          // 已 timeout，attach 仍成功 → 清理；attach 失败则无需 detach。
          if (!lastError) {
            try {
              chrome.debugger.detach({ tabId }, () => {
                // 吃掉 lastError（detach 可能报 "Debugger is not attached"），不再有 resolve。
                void chrome.runtime?.lastError;
              });
            } catch {
              // ignore
            }
          }
          return;
        }
        if (lastError) {
          resolve(false);
          return;
        }
        // 立即 detach，避免泄漏
        chrome.debugger.detach({ tabId }, () => resolve(true));
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/** 判断操作是否要求 trusted event（启发式）。 */
function needsTrustedEvent(
  action: "click" | "fill" | "type" | "drag",
  elementHint?: { tagName?: string },
): boolean {
  if (action === "drag") return DRAG_REQUIRES_CDP;
  // Other actions default to untrusted events; L2 actionability decides per case.
  void elementHint;
  return false;
}

export const capabilityDetector: CapabilityDetector = {
  canUseCDP,
  needsTrustedEvent,
};
