/**
 * Author: qingwa
 * Description: 回归锁(P0,spike 阶段3 发现) — 合成 click inline func 的注入作用域完整性。
 *
 * 根因:`5d8dbf4`(BUG-012)在 executeScript inline func 内引用了模块级导出
 *   `isTransient`(dom.ts:44)。chrome.scripting.executeScript({func}) 注入时
 *   丢模块闭包 → 页面里 ReferenceError "isTransient is not defined" → 非 trusted
 *   Chrome 上**每一次合成 click 100% 抛 JS_EXECUTION_ERROR**。
 *
 * 为何三层防线全漏(见 vortex_page_side_func_inline_gotcha / vortex_test_pageside_pure_fn):
 *   ① 开发机 Chrome 带 --silent-debugger-extension-api → trustedMode=CDP 路径,合成分支不跑
 *   ② 既有单测对 click inline func 是 source-grep(不执行)
 *   ③ bench 历史也在 trusted 环境跑
 *
 * 处方:本测试用 `new Function("return (" + String(func) + ")")()` 剥离模块闭包后
 *   **真执行** inline func——任何裸引用模块级 helper 都会在此爆 ReferenceError。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" } as NmRequest;
}

describe("合成 click inline func 注入作用域(P0 isTransient 回归锁)", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(
      `<!DOCTYPE html><html><body><button id="btn">OK</button></body></html>`,
      { pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "MouseEvent", "Event", "getComputedStyle"]) {
      (globalThis as Record<string, unknown>)[g] =
        g === "getComputedStyle"
          ? (dom.window.getComputedStyle as (el: Element) => CSSStyleDeclaration).bind(dom.window)
          : win[g];
    }
    // jsdom 无 PointerEvent;MAIN world 注入环境有,shim 之
    (globalThis as Record<string, unknown>).PointerEvent = dom.window.MouseEvent;
    (win as Record<string, unknown>).PointerEvent = dom.window.MouseEvent;

    (win as Record<string, unknown>).__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
      deepElementFromPoint: () => null,
    };
    const btn = dom.window.document.getElementById("btn")!;
    btn.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;
    (dom.window.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

    // 复刻注入语义:new Function 剥离模块闭包后真执行 func。
    // 裸引用模块级 helper(如 isTransient)在此必爆 ReferenceError——与真页面一致。
    (globalThis as unknown as { chrome: unknown }).chrome = {
      scripting: {
        executeScript: async (opts: { func?: (...a: unknown[]) => unknown; args?: unknown[] }) => {
          if (typeof opts.func !== "function") return [{}];
          const stripped = new Function(`return (${String(opts.func)})`)() as (
            ...a: unknown[]
          ) => unknown;
          const result = await Promise.resolve(stripped(...(opts.args ?? [])));
          return [{ result }];
        },
      },
    };

    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("合成 click(forceSynthetic)在剥离模块作用域后仍成功——无 'X is not defined'", async () => {
    const resp = await router.dispatch(
      mkReq({ selector: "#btn", trustedMode: true, forceSynthetic: true }),
    );
    expect(resp.error?.message ?? "").not.toMatch(/is not defined/);
    expect(resp.error).toBeUndefined();
  });

  it("合成 click 真触发页面 listener(效果级断言,防静默 no-op)", async () => {
    let clicked = 0;
    dom.window.document.getElementById("btn")!.addEventListener("click", () => {
      clicked++;
    });
    await router.dispatch(mkReq({ selector: "#btn", forceSynthetic: true }));
    expect(clicked).toBeGreaterThan(0);
  });
});
