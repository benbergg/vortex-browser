/**
 * Author: qingwa
 * Description: mouse.click 在 CDP 被占时无等价降级,只能把提示换成能走通的下一步。
 *
 * act 的合成路径在同一 handler 内可降级,mouse.click 靠真实坐标派发没有等价替代。
 * 通用 attach 提示只说「关 DevTools」,没告诉调用方还有 vortex_act 这条路 —— 当日
 * 日志里模型的选择是 tab_create 弃 tab(2026-08-18)。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode, vtxError } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerMouseHandlers } from "../src/handlers/mouse.js";

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "mouse.click", args, requestId: "r-1", tabId: 42 };
}

function routerWith(attachError: Error) {
  const debuggerMgr = {
    attach: vi.fn().mockRejectedValue(attachError),
    sendCommand: vi.fn().mockResolvedValue(undefined),
  } as never;
  const router = new ActionRouter();
  registerMouseHandlers(router, debuggerMgr);
  return router;
}

const BUSY = vtxError(
  VtxErrorCode.CDP_NOT_ATTACHED,
  "Another debugger is already attached to the tab with id: 42.",
  { tabId: 42 },
  { hint: "Another debugger owns this tab — close DevTools on that tab and retry.", recoverable: true },
);

describe("mouse.click 在 CDP 被占时的提示", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://a/" }]),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
    });
  });

  it("被占用时指出 vortex_act 这条不要求可信事件的替代路", async () => {
    const resp = await routerWith(BUSY).dispatch(mkReq({ x: 10, y: 20 }));
    expect(resp.error?.code).toBe("CDP_NOT_ATTACHED");
    expect(resp.error?.hint).toMatch(/vortex_act/);
    expect(resp.error?.hint).toMatch(/DevTools/i);
    expect(resp.error?.recoverable).toBe(true);
  });

  it("不谎称降级成功:仍然报错,不返回 success", async () => {
    const resp = await routerWith(BUSY).dispatch(mkReq({ x: 10, y: 20 }));
    expect(resp.result).toBeUndefined();
  });

  it("原始 Chrome 报文保留在 message 里", async () => {
    const resp = await routerWith(BUSY).dispatch(mkReq({ x: 10, y: 20 }));
    expect(resp.error?.message).toContain("Another debugger is already attached");
  });

  it("chrome:// 那类 attach 失败不套用本提示 —— 换 vortex_act 也点不了", async () => {
    const denied = vtxError(VtxErrorCode.CDP_NOT_ATTACHED, "Cannot access a chrome:// URL", { tabId: 42 });
    const resp = await routerWith(denied).dispatch(mkReq({ x: 10, y: 20 }));
    expect(resp.error?.hint).not.toMatch(/vortex_act/);
    expect(resp.error?.hint).toMatch(/manifest/i);
  });
});
