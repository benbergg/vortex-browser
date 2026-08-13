/**
 * Author: qingwa
 * Description: SCROLL 的 descriptor 自愈接线：stale selector 必须重匹配后再滚。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions, vtxError, VtxErrorCode } from "@vortex-browser/shared";
import type { NmRequest } from "@vortex-browser/shared";

const gate = vi.fn();
vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: (...a: unknown[]) => gate(...a),
}));
const tryHeal = vi.fn();
vi.mock("../src/action/heal.js", async (orig) => ({
  ...(await orig<typeof import("../src/action/heal.js")>()),
  tryHealSelector: (...a: unknown[]) => tryHeal(...a),
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

import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { setSnapshot } from "../src/lib/snapshot-store.js";

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.SCROLL, args, requestId: "r-heal" } as NmRequest;
}

// descriptor 只从快照来（observe 记的 role+name），裸 selector 拿不到，故必须走 index
function seedSnapshot(id: string, withName: boolean): void {
  setSnapshot(id, {
    tabId: 1, frameId: 0, capturedAt: Date.now(),
    elements: [{
      index: 7, selector: "#stale", frameId: 0,
      ...(withName ? { role: "list", name: "结果列表" } : {}),
    }],
  });
}

function makeScrollable(el: HTMLElement): void {
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: 0, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 0, configurable: true });
  let top = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v) => { top = v; }, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => 0, set: () => {}, configurable: true });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) => {
    if (o.top !== undefined) top = Math.min(o.top, 1900);
  };
}

describe("SCROLL 的 descriptor 自愈", () => {
  let router: InstanceType<typeof ActionRouter>;

  beforeEach(() => {
    gate.mockReset();
    tryHeal.mockReset();
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
         <div id="fresh" style="height:100px;overflow-y:auto"><div>项</div></div>
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
    makeScrollable(dom.window.document.getElementById("fresh") as HTMLElement);
    dom.window.scrollTo = () => {};
    router = new ActionRouter();
    registerDomHandlers(router, { attach: vi.fn(), sendCommand: vi.fn() } as never);
  });

  it("stale ref 触发 NOT_ATTACHED 后按 descriptor 重匹配，滚的是新元素", async () => {
    seedSnapshot("snap_heal", true);
    // 第一次门失败(元素已 detach)，自愈换选择器后第二次放行 —— 与 click 同一条路径
    gate.mockRejectedValueOnce(
      vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }),
    );
    tryHeal.mockResolvedValueOnce("#fresh");
    gate.mockResolvedValueOnce(undefined);

    const resp = await router.dispatch(
      mkReq({ index: 7, snapshotId: "snap_heal", position: "bottom" }),
    );

    expect(tryHeal).toHaveBeenCalledTimes(1);
    expect(resp.error).toBeUndefined();
    // 滚成功即证明进 page-side 的是自愈后的 #fresh；用 #stale 会 ELEMENT_NOT_FOUND
    expect(resp.result).toMatchObject({ success: true, scrolledSelf: true });
  });

  it("快照没记 name 时不自愈，转成带候选的 NOT_ATTACHED 而非死路 TIMEOUT", async () => {
    seedSnapshot("snap_bare", false);
    gate.mockRejectedValueOnce(
      vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }),
    );
    const resp = await router.dispatch(
      mkReq({ index: 7, snapshotId: "snap_bare", position: "bottom" }),
    );
    expect(tryHeal).not.toHaveBeenCalled();
    expect(resp.error).toMatchObject({ code: "NOT_ATTACHED" });
  });
});
