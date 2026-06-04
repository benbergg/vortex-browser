import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@bytenew/vortex-shared";
import { VtxErrorCode } from "@bytenew/vortex-shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerCaptureHandlers } from "../src/handlers/capture.js";
import { setSnapshot } from "../src/lib/snapshot-store.js";
import { _resetPageSideLoader } from "../src/adapter/page-side-loader.js";

// capture.element 现先 loadPageSideModule("dom-resolve")(经 executeScript({files})注入),
// 再 executeScript({func})取 rect。取 rect 查询调用须按 .func 定位,不能假定为 calls[0]。
function rectCall(): any {
  const calls = (chrome.scripting.executeScript as any).mock.calls;
  return calls.map((c: any[]) => c[0]).find((a: any) => typeof a.func === "function");
}

function mkReq(action: string, args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: action, args, requestId: "r-1", tabId: 42 };
}

// 批次 1 白盒审计修复:
//  - MCP-1(族 J): capture.element 复用 resolveTarget 解析 @ref(index+snapshotId)
//  - CAP-1(族 L): fullPage 高度>8000 截断时回传 truncated/contentHeight/capturedHeight 标志
//  - CAP-2(族 L): 0×0 元素截图报 NOT_VISIBLE 而非 JS_EXECUTION_ERROR
describe("capture 批次1: ref 解析 + fullPage 截断标志 + 零尺寸", () => {
  let router: ActionRouter;
  let debuggerMgr: any;
  let layoutContentHeight: number;

  beforeEach(() => {
    _resetPageSideLoader();
    layoutContentHeight = 3000;
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: {
        // 默认:元素 rect 查询返回正常尺寸;具体测试可覆盖
        executeScript: vi.fn().mockResolvedValue([{ result: { result: { x: 10, y: 20, width: 100, height: 50 } } }]),
      },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([]) },
    });
    debuggerMgr = {
      enableDomain: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn((_tab: number, method: string) => {
        if (method === "Page.captureScreenshot") return Promise.resolve({ data: "BASE64" });
        if (method === "Page.getLayoutMetrics") {
          return Promise.resolve({ cssContentSize: { width: 1000, height: layoutContentHeight } });
        }
        return Promise.resolve({});
      }),
    };
    router = new ActionRouter();
    registerCaptureHandlers(router, debuggerMgr);
  });

  // MCP-1
  it("capture.element 用 @ref(index+snapshotId) 解析 selector(不再报 Missing required param)", async () => {
    setSnapshot("snap_b1", { tabId: 42, capturedAt: Date.now(), elements: [{ index: 5, selector: "#target" }] });
    const resp = await router.dispatch(mkReq("capture.element", { index: 5, snapshotId: "snap_b1" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as any).selector).toBe("#target");
    // 注入函数收到的是反查出的 selector
    const call = rectCall();
    expect(call.args).toEqual(["#target"]);
  });

  it("capture.element 普通 selector 仍正常", async () => {
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#plain" }));
    expect(resp.error).toBeUndefined();
    expect((resp.result as any).selector).toBe("#plain");
  });

  it("capture.element 既无 selector 也无 index → INVALID_PARAMS", async () => {
    const resp = await router.dispatch(mkReq("capture.element", {}));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  // CAP-1
  it("fullPage 内容高度>8000 → 回传 truncated + contentHeight + capturedHeight", async () => {
    layoutContentHeight = 12000;
    const resp = await router.dispatch(mkReq("capture.screenshot", { fullPage: true }));
    expect(resp.error).toBeUndefined();
    const r = resp.result as any;
    expect(r.truncated).toBe(true);
    expect(r.contentHeight).toBe(12000);
    expect(r.capturedHeight).toBe(8000);
  });

  it("fullPage 内容高度<=8000 → 不带 truncated 标志", async () => {
    layoutContentHeight = 3000;
    const resp = await router.dispatch(mkReq("capture.screenshot", { fullPage: true }));
    expect(resp.error).toBeUndefined();
    const r = resp.result as any;
    expect(r.truncated).toBeUndefined();
    expect(r.contentHeight).toBeUndefined();
  });

  // CAP-2
  it("capture.element 截 0×0 元素 → NOT_VISIBLE(非 JS_EXECUTION_ERROR)", async () => {
    chrome.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { result: { x: 0, y: 0, width: 0, height: 0 } } },
    ]);
    const resp = await router.dispatch(mkReq("capture.element", { selector: "#hidden" }));
    expect(resp.error?.code).toBe(VtxErrorCode.NOT_VISIBLE);
  });
});
