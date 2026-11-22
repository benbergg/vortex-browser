/**
 * Author: athena
 * Description: vortex_act(scroll) 的 position 词表校准——词表外必须诚实失败,不静默假成功。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

// SCROLL 走 healAwareGate,jsdom 下无真实页面可探,放行即可(同 dom-scroll-scrolled-self.test.ts)。
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
  return { type: "tool_request", tool: DomActions.SCROLL, args, requestId: "r-scroll-pos" } as NmRequest;
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

describe("dom.scroll 的 position 词表", () => {
  let router: ActionRouter;
  let dom: JSDOM;

  beforeEach(() => {
    vi.clearAllMocks();
    dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div id="box" style="height:80px;overflow-y:auto">
           <div id="item">项</div>
         </div>
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

  it("词表外的 position(middle)→ INVALID_PARAMS,不静默假成功", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: "middle" }));
    expect(resp.error?.code).toBe("INVALID_PARAMS");
    expect(resp.error?.message).toContain("Unsupported scroll position: middle");
    expect(resp.error?.message).toContain("top|bottom|left|right");
  });

  it("词表外的 position(绝对像素 26000)→ INVALID_PARAMS", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: "26000" }));
    expect(resp.error?.code).toBe("INVALID_PARAMS");
    expect(resp.result).toBeUndefined();
  });

  it("词表内的 position(bottom)→ 照常滚动", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: "bottom" }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, moved: true, scrollTop: 1120 });
  });

  it("position 大小写/空白归一化后照常生效(TOP)", async () => {
    const resp = await router.dispatch(mkReq({ selector: "#box", position: " TOP " }));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ success: true, scrollTop: 0 });
  });
});
