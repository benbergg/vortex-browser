/**
 * Author: qingwa
 * Description: CLICK CDP-first 路由倒置契约（2026-06-11 转正，spike 报告 reports/spike-cdp/）。
 *
 * 路由矩阵：
 * - 默认           → CDP 真鼠标（cdpClickElement）；仅 CDP 基础设施失败（attach 被占/
 *                    策略禁用等非 VtxError）降级合成
 * - 元素级 VtxError → 直抛不降级（NOT_FOUND/OCCLUDED/DISABLED…——合成重跑只会得到同样结论）
 * - forceSynthetic → 纯合成，不触碰 debugger
 * - useRealMouse   → strict CDP，attach 失败也直抛（用户显式要求真鼠标，静默降级是背叛）
 *
 * 测试方法论（见 click-synthetic-inline-scope.test.ts）：chrome.scripting stub 用
 * new Function 剥离模块闭包后真执行 inline func，效果级断言。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions, VtxError } from "@vortex-browser/shared";
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
vi.mock("../src/lib/iframe-offset.js", () => ({
  getIframeOffset: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" } as NmRequest;
}

describe("CLICK CDP-first 路由倒置", () => {
  let router: ActionRouter;
  let dom: JSDOM;
  let debuggerMgr: { attach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  let executeScriptSpy: ReturnType<typeof vi.fn>;

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

    // new Function 剥离模块闭包后真执行 inline func（与真页面注入语义一致）
    executeScriptSpy = vi.fn(
      async (opts: { func?: (...a: unknown[]) => unknown; args?: unknown[] }) => {
        if (typeof opts.func !== "function") return [{}];
        const stripped = new Function(`return (${String(opts.func)})`)() as (
          ...a: unknown[]
        ) => unknown;
        const result = await Promise.resolve(stripped(...(opts.args ?? [])));
        return [{ result }];
      },
    );
    (globalThis as unknown as { chrome: unknown }).chrome = {
      scripting: { executeScript: executeScriptSpy },
    };

    debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("默认路由走 CDP 真鼠标：Input.dispatchMouseEvent 三连 + mode=realMouse", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#btn" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { mode?: string })?.mode).toBe("realMouse");
    const mouseCalls = debuggerMgr.sendCommand.mock.calls.filter(
      (c) => c[1] === "Input.dispatchMouseEvent",
    );
    expect(mouseCalls.map((c) => (c[2] as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });

  it("CDP attach 失败（基础设施错误）→ 降级合成，页面 listener 真触发", async () => {
    debuggerMgr.attach.mockRejectedValue(new Error("Cannot attach to this target"));
    let clicked = 0;
    dom.window.document.getElementById("btn")!.addEventListener("click", () => {
      clicked++;
    });
    const resp = await router.dispatch(mkReq({ selector: "#btn" }));
    expect(resp.error).toBeUndefined();
    expect(clicked).toBeGreaterThan(0);
  });

  it("元素级 VtxError（ELEMENT_NOT_FOUND）直抛，不做合成降级重跑", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#nope" }));
    expect(resp.error?.code).toBe("ELEMENT_NOT_FOUND");
    // 只有 CDP probe 一次 executeScript；合成降级会带来第二次注入
    expect(executeScriptSpy).toHaveBeenCalledTimes(1);
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
  });

  it("forceSynthetic=true → 纯合成路径，不触碰 debugger", async () => {
    let clicked = 0;
    dom.window.document.getElementById("btn")!.addEventListener("click", () => {
      clicked++;
    });
    const resp = await router.dispatch(mkReq({ selector: "#btn", forceSynthetic: true }));
    expect(resp.error).toBeUndefined();
    expect(clicked).toBeGreaterThan(0);
    expect(debuggerMgr.attach).not.toHaveBeenCalled();
    expect(debuggerMgr.sendCommand).not.toHaveBeenCalled();
  });

  it("useRealMouse=true + attach 失败 → 直抛不降级（显式真鼠标语义）", async () => {
    debuggerMgr.attach.mockRejectedValue(new Error("Another debugger is already attached"));
    let clicked = 0;
    dom.window.document.getElementById("btn")!.addEventListener("click", () => {
      clicked++;
    });
    const resp = await router.dispatch(mkReq({ selector: "#btn", useRealMouse: true }));
    expect(resp.error).toBeDefined();
    expect(clicked).toBe(0);
  });

  it("server 注入 trustedMode=true 与默认同义（CDP-first 含降级），不再单独成路", async () => {
    debuggerMgr.attach.mockRejectedValue(new Error("Cannot attach to this target"));
    let clicked = 0;
    dom.window.document.getElementById("btn")!.addEventListener("click", () => {
      clicked++;
    });
    // 旧语义:trustedMode 直走 cdpClickElement 无降级 → 此处会抛错;
    // 新语义:与默认同路 → attach 失败降级合成。
    const resp = await router.dispatch(mkReq({ selector: "#btn", trustedMode: true }));
    expect(resp.error).toBeUndefined();
    expect(clicked).toBeGreaterThan(0);
  });
});

// VtxError 必须可被 instanceof 判定（降级判据依赖）——防止未来 shared 包改为鸭子类型错误
it("VtxError instanceof 判据可用", () => {
  expect(new VtxError("ELEMENT_NOT_FOUND" as never, "x")).toBeInstanceOf(VtxError);
});
