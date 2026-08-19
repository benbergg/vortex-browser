/**
 * Author: qingwa
 * Description: Shared chrome.debugger fake that rejects unknown CDP commands like a real browser.
 *
 * 为什么要有它:测试里各写各的 mock,`sendCommand` 普遍无条件 resolve —— 于是
 * `Emulation.enable` 这种真机根本不存在的命令在单测里畅通无阻,高 DPR 截图坏了很久
 * 也没人发现。mock 让危险路径变安全,是这类假绿的通用形态。
 *
 * 这里的默认行为对齐真机:白名单外的命令 reject 并带 -32601。要测尚未使用的路径,
 * 用 allow 显式放行 —— 放行是一次有意识的声明,而不是默认。
 */

import { vi } from "vitest";
import { DOMAINS_WITH_ENABLE } from "../../src/lib/cdp-domains.js";

/** 生产代码实际发出的 CDP 命令。新增命令时同步加,漏加会在测试里立刻报错 */
const KNOWN_COMMANDS = new Set([
  "Accessibility.getFullAXTree",
  "CSS.getPlatformFontsForNode",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.pushNodesByBackendIdsToFrontend",
  "DOM.querySelector",
  "DOM.requestNode",
  "DOM.resolveNode",
  "DOM.setAttributeValue",
  "DOMDebugger.getEventListeners",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setFocusEmulationEnabled",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Network.getResponseBody",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Runtime.callFunctionOn",
  "Runtime.evaluate",
  "Runtime.getProperties",
  "Runtime.releaseObject",
]);

function isKnown(method: string, allow: ReadonlySet<string>): boolean {
  if (allow.has(method) || KNOWN_COMMANDS.has(method)) return true;
  // enable/disable 只对确实有这对命令的域成立 —— 正是 Emulation 栽的地方
  const m = /^([A-Za-z]+)\.(enable|disable)$/.exec(method);
  return m ? DOMAINS_WITH_ENABLE.has(m[1]) : false;
}

export interface FakeChromeDebuggerOptions {
  /** 额外放行的命令 */
  allow?: readonly string[];
  /** 指定某条命令的返回值 */
  responses?: Record<string, unknown>;
  /** 指定某条命令抛错 */
  errors?: Record<string, Error>;
  /** attach 失败 */
  attachError?: Error;
}

export function createFakeChromeDebugger(options: FakeChromeDebuggerOptions = {}) {
  const allow = new Set(options.allow ?? []);
  const responses = options.responses ?? {};
  const errors = options.errors ?? {};

  return {
    debugger: {
      attach: options.attachError
        ? vi.fn().mockRejectedValue(options.attachError)
        : vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn((_target: unknown, method: string) => {
        if (errors[method]) return Promise.reject(errors[method]);
        if (!isKnown(method, allow)) {
          return Promise.reject(
            new Error(`{"code":-32601,"message":"'${method}' wasn't found"}`),
          );
        }
        return Promise.resolve(responses[method] ?? {});
      }),
      onEvent: { addListener: vi.fn() },
      onDetach: { addListener: vi.fn() },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
  };
}

/**
 * handler 测试用的 DebuggerManager 替身。与上面同一套命令判据,
 * 避免 handler 层的 fake 又把未知命令放行回去。
 */
export function createFakeDebuggerManager(options: FakeChromeDebuggerOptions = {}) {
  const chrome = createFakeChromeDebugger(options);
  return {
    attach: vi.fn(async (tabId: number) => {
      await chrome.debugger.attach({ tabId }, "1.3");
    }),
    enableDomain: vi.fn(async (tabId: number, domain: string) => {
      await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
    }),
    disableDomain: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn((tabId: number, method: string, params?: unknown) =>
      chrome.debugger.sendCommand({ tabId }, method, params),
    ),
    detach: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    /** 底层 chrome 替身，用于断言真正发出的命令 */
    chrome,
  };
}
