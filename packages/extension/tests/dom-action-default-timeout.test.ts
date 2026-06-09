/**
 * Author: qingwa
 * Description: 验证 gated 原语 (click/fill/type/select) 不再覆盖 auto-wait 的
 *   timeout 默认值 —— 未传 timeout 时透传 undefined, 由 waitActionable 内部
 *   `options.timeout ?? DEFAULT_TIMEOUT_MS` 单一真源落到 2000ms。
 *
 * 背景 (2026-06-09 京东搜索性能白盒复测):
 *   commit 252c2fb 把 auto-wait.ts 的 DEFAULT_TIMEOUT_MS 从 5000 改 2000,
 *   但 dom.ts 每个 handler 仍硬编码 `?? 5000` → 覆盖了默认值, 2000 成死代码
 *   (实测每次自旋精确 5000ms 非 2000ms)。修复=移除 dom.ts 的 `?? 5000` 覆盖,
 *   让 auto-wait.ts 独占默认值。
 *
 *   旧测试 auto-wait-default-timeout.test.ts 仅 grep 常量字面值,从不验证
 *   handler 真的用了它 —— 正是它在死代码状态下仍"通过"给了假信心。本测试
 *   锁住「handler 不覆盖默认」这条真实契约 (effective 2000 由 auto-wait 保证)。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxErrorCode, DomActions, vtxError } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";
import type { NmRequest } from "@vortex-browser/shared";

const waitActionableMock = vi.fn();
vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: (...args: unknown[]) => waitActionableMock(...args),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: vi.fn().mockResolvedValue({ result: { success: true } }),
  mapPageError: vi.fn(),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

// 用 NOT_ATTACHED 拒绝 (语义错误,不触发自动 force 重试) 隔离出首次 waitActionable
// 的 timeout 入参,无需 mock 各 action 的成功路径。
function rejectNotAttached() {
  waitActionableMock.mockRejectedValue(
    vtxError(VtxErrorCode.NOT_ATTACHED, "Element not attached", { selector: "#t" }),
  );
}

function mkReq(tool: string, args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1" } as NmRequest;
}

describe("gated 原语不覆盖 auto-wait timeout 默认 (修死代码 ?? 5000)", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { result: { success: true } } }]) },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) } as any;
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  // 未传 timeout 时 handler 必须透传 undefined(不覆盖),让 waitActionable 落到
  // DEFAULT_TIMEOUT_MS=2000。断言 5000 不再出现是死代码修复的核心。
  it("click 未传 timeout — 不覆盖默认(透传 undefined, 不是 5000)", async () => {
    rejectNotAttached();
    await router.dispatch(mkReq(DomActions.CLICK, { selector: "#t" }));
    expect(waitActionableMock.mock.calls[0][3].timeout).toBeUndefined();
  });

  it("fill 未传 timeout — 不覆盖默认(透传 undefined, 不是 5000)", async () => {
    rejectNotAttached();
    await router.dispatch(mkReq(DomActions.FILL, { selector: "#t", value: "x" }));
    expect(waitActionableMock.mock.calls[0][3].timeout).toBeUndefined();
  });

  it("type 未传 timeout — 不覆盖默认(透传 undefined, 不是 5000)", async () => {
    rejectNotAttached();
    await router.dispatch(mkReq(DomActions.TYPE, { selector: "#t", text: "x" }));
    expect(waitActionableMock.mock.calls[0][3].timeout).toBeUndefined();
  });

  it("select 未传 timeout — 不覆盖默认(透传 undefined, 不是 5000)", async () => {
    rejectNotAttached();
    await router.dispatch(mkReq(DomActions.SELECT, { selector: "#t", value: "x" }));
    expect(waitActionableMock.mock.calls[0][3].timeout).toBeUndefined();
  });

  it("显式 timeout 仍优先(向后兼容)", async () => {
    rejectNotAttached();
    await router.dispatch(mkReq(DomActions.CLICK, { selector: "#t", timeout: 9000 }));
    expect(waitActionableMock.mock.calls[0][3]).toMatchObject({ timeout: 9000 });
  });
});
