import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

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
 * handler 改走 cdpClickElement;CDP 不可用/失败则回退合成(cdpAvailable=false 重跑)。
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

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

  it("deferToCdp 但 CDP 失败 → 回退合成(executeScript 重跑、返回合成结果)", async () => {
    executeScript
      .mockResolvedValueOnce([{ result: { result: { deferToCdp: true, element: { tag: "button" } } } }])
      .mockResolvedValueOnce([{ result: { result: { success: true, element: { tag: "button" } } } }]);
    cdpClickElement.mockRejectedValue(new Error("CDP attach failed"));
    const resp = await router.dispatch(mkReq({ selector: "button[type=submit]", action: "click", tabId: 42 }));
    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(resp.result).toMatchObject({ success: true });
  });

  it("useRealMouse:true 仍直接走 CDP(既有路径不退化)", async () => {
    cdpClickElement.mockResolvedValue({ success: true, mode: "realMouse" });
    const resp = await router.dispatch(mkReq({ selector: "button#s", action: "click", useRealMouse: true, tabId: 42 }));
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });
});
