/**
 * Author: qingwa
 * Description: GAP-G(N0062) 合成 click 路径效果信号契约。
 *   - observeEffect:true → result 带 effect(经 window.__vortexClickEffect.begin/end)
 *   - 缺省 → result 不带 effect(零开销契约, 不触碰 __vortexClickEffect)
 *   复刻注入语义:new Function 剥离模块闭包真执行 inline func(同 click-synthetic-inline-scope)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockImplementation((_t: unknown, _f: unknown, sel: string) =>
    Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: sel })),
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

const FIXED_EFFECT = {
  domMutations: 0,
  urlChanged: false,
  focusChanged: false,
  ariaChanged: false,
  observed: true,
  windowMs: 300,
};

describe("合成 click 效果信号(GAP-G observeEffect)", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let beginCalls: Array<[string, number]>;

  beforeEach(() => {
    vi.clearAllMocks();
    beginCalls = [];
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
    (globalThis as Record<string, unknown>).PointerEvent = dom.window.MouseEvent;
    (win as Record<string, unknown>).PointerEvent = dom.window.MouseEvent;

    (win as Record<string, unknown>).__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
      deepElementFromPoint: () => null,
    };
    // 效果采集器 mock:记录 begin 调用 + end 返回固定 effect
    (win as Record<string, unknown>).__vortexClickEffect = {
      version: 1,
      begin: (sel: string, w: number) => {
        beginCalls.push([sel, w]);
        return "tok-1";
      },
      end: async () => FIXED_EFFECT,
    };

    const btn = dom.window.document.getElementById("btn")!;
    btn.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;
    (dom.window.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

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

    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("observeEffect:true → result 带 effect, begin 收到 selector + windowMs", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#btn", observeEffect: true, windowMs: 250 }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, effect: FIXED_EFFECT });
    expect(beginCalls).toEqual([["#btn", 250]]);
  });

  it("缺省 observeEffect → result 不带 effect(零开销, 不触碰 __vortexClickEffect)", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#btn" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true });
    expect((resp.result as Record<string, unknown>).effect).toBeUndefined();
    expect(beginCalls).toEqual([]);
  });

  it("observeEffect:true 但 windowMs 缺省 → begin 收到默认 300", async () => {
    await router.dispatch(mkReq({ selector: "#btn", observeEffect: true }));
    expect(beginCalls).toEqual([["#btn", 300]]);
  });

  // BUG-001 (N0063): 缺省 click(无 windowMs/observeEffect)走合成路径时,executeScript 的
  // args 第 4 位 windowMs=undefined → 真 Chrome structured clone 拒 "Value is unserializable
  // at index 3"(非 trusted 模式 100% 崩;trusted 走 CDP 不经此路径故掩盖)。Node 测 mock 不
  // 校验序列化,故显式断言 args 无 undefined,锁住 structured-clone 安全契约。
  it("BUG-001: 缺省 click 的 executeScript args 无 undefined(structured-clone 安全)", async () => {
    let capturedArgs: unknown[] | undefined;
    (globalThis as unknown as { chrome: { scripting: { executeScript: unknown } } }).chrome.scripting.executeScript =
      async (opts: { func?: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        capturedArgs = opts.args;
        if (typeof opts.func !== "function") return [{}];
        const stripped = new Function(`return (${String(opts.func)})`)() as (...a: unknown[]) => unknown;
        return [{ result: await Promise.resolve(stripped(...(opts.args ?? []))) }];
      };
    const resp = await router.dispatch(mkReq({ selector: "#btn" }));
    expect(resp.error).toBeUndefined();
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.some((a) => a === undefined)).toBe(false);
    // args = [selector, cdpAvailable, observeEffect, windowMs];第 4 位须为 number(默认),非 undefined
    expect(typeof capturedArgs![3]).toBe("number");
  });
});
