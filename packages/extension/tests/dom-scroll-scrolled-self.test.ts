/**
 * Author: qingwa
 * Description: Verify that dom.scroll reports whether it scrolled its target.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

// SCROLL 现在也走 healAwareGate，门在 jsdom 下无真实页面可探，放行即可。
// 门是否真接上由 dom-scroll-heal.test.ts 单独锁，这里只测 scrolledSelf 语义。
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
  return { type: "tool_request", tool: DomActions.SCROLL, args, requestId: "r-scroll" } as NmRequest;
}

function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: 0, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 0, configurable: true });
  let top = 0, left = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v) => { top = v; }, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => left, set: (v) => { left = v; }, configurable: true });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) => {
    if (o.top !== undefined) top = Math.min(o.top, scrollHeight - clientHeight);
    if (o.left !== undefined) left = o.left;
  };
}

describe("dom.scroll 的 scrolledSelf 标记", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div id="box" style="height:80px;overflow-y:auto">
           <div id="item">项</div>
         </div>
         <div id="plain">不可滚</div>
       </body></html>`,
      { pretendToBeVisual: true },
    );
    const win = dom.window as unknown as Record<string, unknown>;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    for (const g of ["HTMLElement", "Element", "Event", "Window"]) {
      (globalThis as Record<string, unknown>)[g] = win[g];
    }
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    makeScrollable(dom.window.document.getElementById("box") as HTMLElement, 1200, 80);
    dom.window.scrollTo = () => {};

    router = new ActionRouter();
    registerDomHandlers(router, { attach: vi.fn(), sendCommand: vi.fn() } as never);
  });

  it("目标自身可滚 → scrolledSelf:true，且滚的是它自己", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, scrolledSelf: true, scrollTop: 1120 });
  });

  it("目标不可滚、上溯到祖先 → scrolledSelf:false（身份与位置已不同源）", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#item", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });

  it("无 selector 的页面级滚动 → scrolledSelf:false", async () => {
    const resp = await router.dispatch(mkReq({ position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });

  it("显式 container → scrolledSelf:false（container 路径本就没有 @ref 身份）", async () => {
    const resp = await router.dispatch(mkReq({ container: "#box", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as { scrolledSelf: boolean }).scrolledSelf).toBe(false);
  });
});
