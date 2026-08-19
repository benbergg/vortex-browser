/**
 * Description: 跨层不变量——page.waitForExpression 的 SW 侧兜底须先于 router
 * 的内层预算 fire（锁 Task 6 修复）。
 *
 * router.dispatch 对每次调用都用 innerDeadlineFor(action, callerTimeout) 起一个
 * 独立的 raceTimeout；handler 自己（pageQuery 的 timeout+500ms 兜底）必须比它
 * 先手，否则调用方拿到的是 router 通用的 "exceeded its Xms budget"，而不是
 * handler 给出的语义化 "page-side polling did not report back"。
 *
 * 用真实 router.dispatch + registerPageHandlers 端到端跑，把 fake timer 推进到
 * router 自己的 budgetMs（由 shared 的 innerDeadlineFor 算出，非本文件另写公式），
 * 断言此刻响应已经是 handler 的语义化消息——router 若抢先，消息形态会变，断言
 * 自然转红，不依赖对 page.ts 内部常量的重复假设。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode, innerDeadlineFor, MAX_INNER_TIMEOUT_MS } from "@vortex-browser/shared";
import { ActionRouter } from "../../src/lib/router.js";
import { registerPageHandlers } from "../../src/handlers/page.js";

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

function makeDebuggerMock() {
  return {
    enableDomain: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
    sendCommand: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    isAttached: vi.fn().mockReturnValue(true),
  } as any;
}

describe("内层预算恒先于 router 预算：page.waitForExpression（跨层不变量）", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerPageHandlers(router, makeDebuggerMock());
  });

  // 合法区间代表点：下边界 / 默认(不传) / 15_000 分界附近 / 上边界
  const legalTimeouts: Array<number | undefined> = [1, undefined, 19_500, MAX_INNER_TIMEOUT_MS];

  it("覆盖到代表性 T 值（防空集假绿）", () => {
    expect(legalTimeouts.length).toBe(4);
  });

  it.each(legalTimeouts)("T=%s 时 handler 先于 router fire，消息为语义化 TIMEOUT", async (timeoutArg) => {
    vi.useFakeTimers();
    try {
      // page-side 永不 settle：唯一能结束这次调用的只有 SW 侧计时器或 router 的 race
      executeScript.mockImplementation(() => new Promise(() => {}));
      const args: Record<string, unknown> = { expression: "window.__never === true" };
      if (timeoutArg !== undefined) args.timeout = timeoutArg;

      const budgetMs = innerDeadlineFor("page.waitForExpression", timeoutArg);
      let resp: any;
      const p = router.dispatch(mkReq("page.waitForExpression", args, 42)).then((r) => { resp = r; });

      await vi.advanceTimersByTimeAsync(budgetMs);
      await p;

      expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
      // handler 先手：消息带页面轮询语义；router 抢先只会给 "exceeded its Xms budget"
      expect(String(resp.error?.message), `T=${timeoutArg}: router 抢在 handler 前 fire（budgetMs=${budgetMs}）`)
        .toMatch(/\(page-side polling did not report back\)/);
    } finally {
      vi.useRealTimers();
    }
  });
});
