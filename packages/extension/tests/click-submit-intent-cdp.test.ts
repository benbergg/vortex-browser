import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import { formatDispatchError } from "../../mcp/src/lib/dispatch-error.js";

/**
 * 方案 A:CLICK 对「表单提交意图」元素(button[type=submit] / input[type=submit] /
 * <form> 内无显式 type 的 <button>)直接走 CDP 真鼠标(isTrusted),跳过合成 click。
 *
 * 调研结论(2026-06-05):合成事件 isTrusted 恒 false,React 拦截 submit 的站点
 * (淘宝搜索)会丢弃合成 click;扩展里唯一能发 isTrusted=true 的是 chrome.debugger
 * (CDP)。Playwright/Puppeteer 默认即 CDP trusted,同构扩展 agent(Nanobrowser)
 * 也吃黄条走 puppeteer-over-debugger。vortex 保持合成默认(无黄条覆盖 95%),仅
 * submit-intent 升级 CDP——机制上唯一可行,且跳过合成避免「合成 click 清空输入框」。
 *
 * 页内 func 探测到 submit-intent 且 cdpAvailable 时返回 {deferToCdp:true}(不点击),
 * handler 改走 cdpClickElement;调用失败时返回错误，避免重复点击。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

vi.mock("../../mcp/src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../../mcp/src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn(),
  clickBBox: vi.fn(),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" };
}

describe("CLICK submit-intent → CDP trusted(方案 A · 源码契约)", () => {
  it("页内 func 接收 cdpAvailable 形参", () => {
    // func: (sel: string, cdpAvailable: ...) => ...
    expect(DOM_SRC).toMatch(/cdpAvailable/);
  });
  it("探测 submit-intent:type==='submit' + <form> 内无 type 的 button", () => {
    expect(DOM_SRC).toMatch(/submit/);
    expect(DOM_SRC).toMatch(/closest\(["']form["']\)/);
    expect(DOM_SRC).toMatch(/deferToCdp/);
  });
  it("handler 对 deferToCdp 调 cdpClickElement", () => {
    expect(DOM_SRC).toMatch(/deferToCdp[\s\S]{0,200}cdpClickElement/);
  });
});

describe("CLICK submit-intent → CDP trusted(方案 A · handler 路由)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let cdpClickElement: ReturnType<typeof vi.fn>;
  let debuggerMgr: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = vi.mocked(cdp.cdpClickElement as any);
    debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("submit-intent(deferToCdp)→ 走 cdpClickElement,返回其结果", async () => {
    executeScript.mockResolvedValue([{ result: { result: { deferToCdp: true, element: { tag: "button" } } } }]);
    cdpClickElement.mockResolvedValue({ success: true, element: { tag: "button" }, mode: "realMouse" });
    const resp = await router.dispatch(mkReq({ selector: "button[type=submit]", action: "click", tabId: 42 }));
    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });

  it("非 submit(合成成功)→ 不调 cdpClickElement,返回合成结果", async () => {
    executeScript.mockResolvedValue([{ result: { result: { success: true, element: { tag: "div" } } } }]);
    const resp = await router.dispatch(mkReq({ selector: "div.card", action: "click", tabId: 42 }));
    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ success: true });
  });

  it("CDP 点击已发出但 effect 读取失败时返回错误，不再合成点击", async () => {
    executeScript.mockResolvedValue([{ result: { result: { deferToCdp: true, element: { tag: "button" } } } }]);
    let dispatched = 0;
    cdpClickElement.mockImplementation(async () => {
      dispatched++;
      throw new Error("effect read failed");
    });
    const resp = await router.dispatch(mkReq({ selector: "button[type=submit]", action: "click", observeEffect: true, tabId: 42 }));
    expect(dispatched).toBe(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(resp.result).toBeUndefined();
    expect(resp.error).toMatchObject({ code: "JS_EXECUTION_ERROR", message: "effect read failed" });
    expect(formatDispatchError(resp.error!)).toMatch(/may have.*executed.*check.*page.*do not.*retry/i);
  });

  it("deferToCdp 后 STALE_SNAPSHOT 保留原因并警告，不再合成点击", async () => {
    executeScript.mockResolvedValue([{ result: { result: { deferToCdp: true } } }]);
    cdpClickElement.mockRejectedValue(vtxError(VtxErrorCode.STALE_SNAPSHOT, "snapshot stale"));
    const resp = await router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 }));
    expect(resp.error).toMatchObject({ code: "STALE_SNAPSHOT", message: "snapshot stale" });
    expect(formatDispatchError(resp.error!)).toMatch(/may have.*executed.*check.*page.*do not.*retry/i);
    expect(formatDispatchError(resp.error!)).not.toMatch(/vortex_observe.*retry/i);
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it.each([VtxErrorCode.ELEMENT_DETACHED, VtxErrorCode.ELEMENT_DISABLED])("defer 后 %s 的重试 hint 不得覆盖安全警告，元数据透传至 router 和 MCP", async (code) => {
    executeScript.mockResolvedValue([{ result: { result: { deferToCdp: true } } }]);
    cdpClickElement.mockRejectedValue(vtxError(code, "original failure", { selector: "button", extras: { stage: "effect" } }, { recoverable: false }));
    const { sendRequest } = await import("../../mcp/src/client.js");
    let routed: Awaited<ReturnType<ActionRouter["dispatch"]>> | undefined;
    vi.mocked(sendRequest).mockImplementation(async () => {
      routed = await router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 }));
      return routed as never;
    });
    const { handleCallTool } = await import("../../mcp/src/server.js");
    const result = await handleCallTool({ params: { name: "vortex_act", arguments: { target: "button", action: "click" } } });
    expect(routed?.error).toMatchObject({ code, message: "original failure", recoverable: false, context: { selector: "button", extras: { stage: "effect" } } });
    expect(routed?.error?.hint).toMatch(/may have.*executed.*check.*page.*do not.*retry/i);
    expect(routed?.error?.hint).not.toMatch(/(?:and|then) retry/i);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/original failure[\s\S]*may have.*executed.*check.*page.*do not.*retry/i);
    expect(text).not.toMatch(/(?:and|then) retry/i);
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("普通动作派发前 ELEMENT_DETACHED 保留原有重试 hint", async () => {
    executeScript.mockResolvedValue([{ result: { errorCode: "ELEMENT_DETACHED", error: "element detached" } }]);
    const resp = await router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 }));
    expect(resp.error?.hint).toMatch(/vortex_observe.*retry/i);
    expect(formatDispatchError(resp.error!)).not.toMatch(/may have.*executed/i);
    expect(cdpClickElement).not.toHaveBeenCalled();
  });

  it("合成路径派发前 stale 不带已执行警告", async () => {
    executeScript.mockResolvedValue([{ result: { errorCode: "STALE_SNAPSHOT", error: "snapshot stale" } }]);
    const resp = await router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 }));
    expect(resp.result).toBeUndefined();
    expect(formatDispatchError(resp.error!)).toContain("snapshot stale");
    expect(formatDispatchError(resp.error!)).not.toMatch(/may have.*executed/i);
    expect(cdpClickElement).not.toHaveBeenCalled();
  });

  it("合成路径派发后 stale 的提示经 handler 到 MCP 文本", async () => {
    executeScript.mockResolvedValue([{ result: { errorCode: "STALE_SNAPSHOT", error: "snapshot stale; action may have been executed; check the page state; do not retry directly" } }]);
    const resp = await router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 }));
    expect(resp.result).toBeUndefined();
    expect(formatDispatchError(resp.error!)).toMatch(/snapshot stale.*may have.*executed.*check.*page.*do not.*retry/i);
    expect(cdpClickElement).not.toHaveBeenCalled();
  });

  it("defer 失败经过 MCP 工具入口返回最终错误文本", async () => {
    executeScript.mockResolvedValue([{ result: { result: { deferToCdp: true } } }]);
    cdpClickElement.mockRejectedValue(vtxError(VtxErrorCode.STALE_SNAPSHOT, "snapshot stale"));
    const { sendRequest } = await import("../../mcp/src/client.js");
    vi.mocked(sendRequest).mockImplementation(async () => router.dispatch(mkReq({ selector: "button", action: "click", tabId: 42 })) as never);
    const { handleCallTool } = await import("../../mcp/src/server.js");
    const result = await handleCallTool({ params: { name: "vortex_act", arguments: { target: "button", action: "click" } } });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/snapshot stale[\s\S]*may have.*executed.*check.*page.*do not.*retry/i) });
    expect((result.content[0] as { text: string }).text).not.toMatch(/vortex_observe.*retry/i);
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("输入前已知 CDP 不可用时直接合成点击", async () => {
    router = new ActionRouter();
    registerDomHandlers(router, undefined as never);
    executeScript.mockImplementation(async (injection: { args: unknown[] }) => {
      expect(injection.args[1]).toBe(false);
      return [{ result: { result: { success: true, element: { tag: "button" } } } }];
    });
    const resp = await router.dispatch(mkReq({ selector: "button[type=submit]", action: "click", tabId: 42 }));
    expect(resp.result).toMatchObject({ success: true });
    expect(resp.error).toBeUndefined();
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(cdpClickElement).not.toHaveBeenCalled();
  });

  it("useRealMouse:true 仍直接走 CDP(既有路径不退化)", async () => {
    cdpClickElement.mockResolvedValue({ success: true, mode: "realMouse" });
    const resp = await router.dispatch(mkReq({ selector: "button#s", action: "click", useRealMouse: true, tabId: 42 }));
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });
});
