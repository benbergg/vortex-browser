import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerPageHandlers } from "../src/handlers/page.js";

/**
 * VORTEX_FEEDBACK v3.4 BUG-006: vortex_navigate 无效 URL 不预校验
 * 根因:page.ts navigate handler 不预校验 URL scheme,无 ERR 页检测。
 *
 * 修复:
 *   - URL 预校验:只允许 http:// / https:// / file:// (白名单)
 *   - ERR 页检测:navigate 完成后检查 document.title,匹配 ERR 模式抛 NAVIGATION_FAILED
 *
 * 关键守卫:
 *   - 无 scheme 'not-a-valid-url' → INVALID_PARAMS
 *   - javascript: / data: → INVALID_PARAMS
 *   - 有效 URL 正常 navigate
 *   - ERR 页(DNS 失败)→ 抛 NAVIGATION_FAILED
 */

interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId: number;
}

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", tabId };
}

describe("vortex_navigate URL 预校验 (BUG-006)", () => {
  let router: ActionRouter;
  let tabsUpdate: ReturnType<typeof vi.fn>;
  let tabsGet: ReturnType<typeof vi.fn>;
  let scriptingExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    tabsUpdate = vi.fn((id: number, opts: any) => {
      fireImmediately(id);
      return Promise.resolve({ id, status: "loading" });
    });
    tabsGet = vi.fn();
    scriptingExecute = vi.fn();
    // stub webNavigation + tabs.onUpdated: 当 register listener 时立即 fire 完成事件
    // 让 waitForTabLoad 立即 resolve,不 hang 5s test timeout
    const fireImmediately = (tabId: number) => {
      setTimeout(() => listener({ tabId, status: "complete" } as any), 0);
    };
    let listener: (tab: any) => void = () => {};
    const onComplete = {
      addListener: vi.fn((l: (tab: any) => void) => { listener = l; }),
      removeListener: vi.fn(),
    };
    const onDCL = { addListener: vi.fn(), removeListener: vi.fn() };
    vi.stubGlobal("chrome", {
      tabs: {
        update: tabsUpdate,
        get: tabsGet,
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onUpdated: onComplete,
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
        onDOMContentLoaded: onDCL,
        onCompleted: onComplete,
        onErrorOccurred: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: scriptingExecute },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerPageHandlers(router);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("无 scheme 'not-a-valid-url' → INVALID_PARAMS (不调 tabsUpdate)", async () => {
    const out = await router.dispatch(mkReq("page.navigate", { url: "not-a-valid-url" })) as
      { error?: { code: string; message: string } };
    expect(out.error?.code).toBe("INVALID_PARAMS");
    expect(out.error?.message).toMatch(/Invalid URL|http/i);
    expect(tabsUpdate).not.toHaveBeenCalled();
  });

  it("javascript: scheme → INVALID_PARAMS", async () => {
    const out = await router.dispatch(mkReq("page.navigate", { url: "javascript:alert(1)" })) as
      { error?: { code: string; message: string } };
    expect(out.error?.code).toBe("INVALID_PARAMS");
    expect(out.error?.message).toMatch(/scheme not allowed/i);
  });

  it("data: scheme → INVALID_PARAMS", async () => {
    const out = await router.dispatch(mkReq("page.navigate", { url: "data:text/html,x" })) as
      { error?: { code: string; message: string } };
    expect(out.error?.code).toBe("INVALID_PARAMS");
  });

  it("http:// 有效 URL → 正常 navigate (不抛)", async () => {
    tabsGet.mockResolvedValue({ id: 42, status: "complete", url: "http://valid.com/" });
    scriptingExecute.mockResolvedValue([{ result: false }]);  // 不是 ERR 页
    const out = await router.dispatch(mkReq("page.navigate", { url: "http://valid.com", waitForLoad: false })) as
      { error?: { code: string; message: string } };
    expect(out.error).toBeUndefined();
    expect(tabsUpdate).toHaveBeenCalled();
  });

  it("https:// 有效 URL → 正常 navigate", async () => {
    tabsGet.mockResolvedValue({ id: 42, status: "complete", url: "https://valid.com/" });
    scriptingExecute.mockResolvedValue([{ result: false }]);
    const out = await router.dispatch(mkReq("page.navigate", { url: "https://valid.com", waitForLoad: false })) as
      { error?: { code: string; message: string } };
    expect(out.error).toBeUndefined();
  });

  it("file:// 有效 URL → 正常 navigate", async () => {
    tabsGet.mockResolvedValue({ id: 42, status: "complete", url: "file:///tmp/x" });
    scriptingExecute.mockResolvedValue([{ result: false }]);
    const out = await router.dispatch(mkReq("page.navigate", { url: "file:///tmp/x", waitForLoad: false })) as
      { error?: { code: string; message: string } };
    expect(out.error).toBeUndefined();
  });

  it("不抛 error 错误时直接返 url/title/status (waitForLoad:false 跳过 waitForTabLoad)", async () => {
    tabsGet.mockResolvedValue({ id: 42, status: "complete", url: "https://valid.com/" });
    scriptingExecute.mockResolvedValue([{ result: false }]);
    // 走 waitForLoad:false 跳过 waitForTabLoad,直接 tabs.get → return
    const out = await router.dispatch(mkReq("page.navigate", { url: "https://valid.com", waitForLoad: false })) as
      { result?: { url?: string; status?: string } };
    expect(out.result?.url).toBe("https://valid.com/");
    expect(out.result?.status).toBe("complete");
  });
});
