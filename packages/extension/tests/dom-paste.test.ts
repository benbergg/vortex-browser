import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DomActions, VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");

describe("dom.paste action 枚举", () => {
  it("DomActions.PASTE 注册为 dom.paste", () => {
    expect(DomActions.PASTE).toBe("dom.paste");
  });
});

describe("dom.paste handler 源码契约", () => {
  it("注册 DomActions.PASTE handler", () => {
    expect(DOM_SRC).toMatch(/\[DomActions\.PASTE\]:\s*async/);
  });
  it("经 healAwareGate 走 actionability 自愈门", () => {
    const block = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?healAwareGate\(/);
    expect(block).not.toBeNull();
  });
  it("MAIN world 注入 + 构造 DataTransfer + 合成 ClipboardEvent('paste')", () => {
    const block = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?world:\s*"MAIN"[\s\S]*?new DataTransfer\(\)[\s\S]*?new ClipboardEvent\("paste"/);
    expect(block).not.toBeNull();
  });
  it("setData text/plain(+可选 text/html)", () => {
    expect(DOM_SRC).toMatch(/setData\("text\/plain"/);
    expect(DOM_SRC).toMatch(/setData\("text\/html"/);
  });
  it("回读护栏:内容未变 → NO_EFFECT", () => {
    const guard = DOM_SRC.match(/\[DomActions\.PASTE\][\s\S]*?changed[\s\S]*?NO_EFFECT/);
    expect(guard).not.toBeNull();
  });
  it("非 contentEditable → 提示改用 vortex_fill", () => {
    expect(DOM_SRC).toMatch(/NOT_CONTENTEDITABLE|vortex_fill/);
  });
  it("result 带 path 标识", () => {
    expect(DOM_SRC).toMatch(/path:\s*"synthetic-clipboard"/);
  });
});

// 运行时行为：mock chrome.scripting 返回受控结果，验证 NO_EFFECT 与成功映射。
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockResolvedValue({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 } }),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "dom.paste", args, requestId: "r-1" } as NmRequest;
}

describe("dom.paste handler 运行时", () => {
  let router: ActionRouter;
  const exec = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
      scripting: { executeScript: exec },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("内容变更 → success(path=synthetic-clipboard)", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: true, before: "", after: "# t", changed: true } }]);
    const res = await router.dispatch(mkReq({ selector: "#ed", text: "# t" }));
    expect(res.result).toMatchObject({ success: true, path: "synthetic-clipboard" });
  });

  it("内容未变 → NO_EFFECT(不假成功)", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: true, before: "# t", after: "# t", changed: false } }]);
    const res = await router.dispatch(mkReq({ selector: "#ed", text: "x" }));
    expect(res.error?.code).toBe(VtxErrorCode.NO_EFFECT);
  });

  it("非 contentEditable → 错误提示改用 fill", async () => {
    exec.mockResolvedValue([{ result: { ok: true, isContentEditable: false } }]);
    const res = await router.dispatch(mkReq({ selector: "#inp", text: "x" }));
    expect(res.error).toBeDefined();
    expect(JSON.stringify(res.error)).toMatch(/fill/i);
  });
});
