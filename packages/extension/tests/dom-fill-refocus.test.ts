/**
 * Author: qingwa
 * Description: DESIGN-002 (N0063) FILL 后回焦契约。
 *   fill 走原生 value setter 不触发 focus,React 受控组件 click→fill 链路常使
 *   activeElement 停在 BODY(实测 bytenew 搜索框 fill 后 activeElement=BODY),
 *   后续 vortex_press Enter 落不到 input → 搜索+回车整类失效。FILL 成功后须显式
 *   focus 目标,让后续 press 命中。
 *   复刻注入语义:mock pageQuery 用 new Function 剥离模块闭包真执行 inline func。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));
// pageQuery 真执行 inline func(剥离模块闭包),操作下方 JSDOM 全局 document。
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: async (
    _tid: number,
    _frameId: number | undefined,
    fn: (...a: unknown[]) => unknown,
    args: unknown[],
  ) => {
    const stripped = new Function(`return (${String(fn)})`)() as (...a: unknown[]) => unknown;
    return await Promise.resolve(stripped(...args));
  },
  mapPageError: (res: { error?: string }) => {
    throw new Error(res.error ?? "page error");
  },
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.FILL, args, requestId: "r-1" } as NmRequest;
}

describe("FILL 后回焦 (DESIGN-002 N0063)", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(
      `<!DOCTYPE html><html><body><input id="inp" placeholder="搜索" /></body></html>`,
      { pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }

    const inp = dom.window.document.getElementById("inp")!;
    inp.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;

    (win as Record<string, unknown>).__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    (win as Record<string, unknown>).__vortexFillReject = {
      checkRejectPattern: () => ({ rejected: false }),
    };

    // armDialogPolicy / readDialogCapturedAndDisarm 调用 chrome.scripting.executeScript
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    registerDomHandlers(router, debuggerMgr as never);
  });

  it("fill 成功后 activeElement 是被填的 input(让后续 press 命中)", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#inp", value: "复测0611" }));
    expect(resp.error).toBeUndefined();
    // focused 反映真实 activeElement(非硬编码),happy path 应为 true
    expect(resp.result).toMatchObject({ success: true, focused: true });
    const inp = dom.window.document.getElementById("inp");
    expect(dom.window.document.activeElement).toBe(inp);
    expect((inp as HTMLInputElement).value).toBe("复测0611");
  });
});
