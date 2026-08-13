/**
 * Author: qingwa
 * Description: FILL 回读值契约。fill 返回 success:true 却不说明填进去的是什么，
 *   受控组件把值改回去时调用方完全看不见（静默假成功族）。锁住成功返回必须带
 *   el.value 的实读值，而非入参回声。
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
  return { type: "tool_request", tool: DomActions.FILL, args, requestId: "r-fill-value" } as NmRequest;
}

describe("FILL 回读值", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  function setup(bodyHtml: string): void {
    dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`, { pretendToBeVisual: true });
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Event", "InputEvent"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    for (const el of Array.from(dom.window.document.querySelectorAll("input"))) {
      el.getBoundingClientRect = () =>
        ({ x: 10, y: 10, width: 100, height: 20, top: 10, bottom: 30, left: 10, right: 110 }) as DOMRect;
    }
    win.__vortexDomResolve = {
      queryAllDeep: (sel: string) => Array.from(dom.window.document.querySelectorAll(sel)),
      isEnabled: () => true,
    };
    win.__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    router = new ActionRouter();
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    };
    registerDomHandlers(router, debuggerMgr as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setup(`<input id="inp" />`);
  });

  it("成功返回带 value，等于填后实读值", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#inp", value: "hello" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, value: "hello" });
  });

  it("页面把值改回去时，返回的是回滚后的实读值而非入参回声", async () => {
    // 受控组件的最小复刻：input 监听器同步把值改掉。
    // 若实现回声入参，这里会拿到 "typed"；只有真读 el.value 才是 "REVERTED"。
    setup(`<input id="ctl" />`);
    const el = dom.window.document.getElementById("ctl") as HTMLInputElement;
    el.addEventListener("input", () => { el.value = "REVERTED"; });

    const resp = await router.dispatch(mkReq({ selector: "#ctl", value: "typed" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { value: string }).value).toBe("REVERTED");
  });

  it("超长填入值回传时截断到 500 字符", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#inp", value: "a".repeat(900) }));
    const v = (resp.result as { value: string }).value;
    expect(v.length).toBe(501);
    expect(v.endsWith("…")).toBe(true);
  });
});
