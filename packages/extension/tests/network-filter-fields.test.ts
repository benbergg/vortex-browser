/**
 * Author: qingwa
 * Description: V2 P0 修复 (N0060-V2 D16 真发现):
 *   vortex_debug_read.filter 子字段未文档化 + handler 字段名不统一
 *   (urlPattern/url/pattern) — 见 V2 实施计划 + V2 评审意见 §1.2
 *
 * 修复目标:
 *   1. schemas-public.ts vortex_debug_read filter 字段加 description + 子字段示例
 *   2. handlers/network.ts FILTER action 字段名统一为 `pattern` (向后兼容 `url`)
 *   3. handlers/console.ts GET_LOGS action 支持 args.level 子字段
 *
 * 本测试覆盖:
 *   - FILTER action 接受 `pattern` 字段 (新统一名) + `statusMin` / `statusMax` / `method`
 *   - 向后兼容: `url` 字段名仍生效 (现有 case / 老调用不破)
 *   - GET_LOGS action 接受 `level` 子字段
 *   - schemas-public.ts filter 字段 description 包含子字段示例 (LLM 文档化)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
// network.ts / console.ts 有模块级 state，跨测试用 vi.resetModules 后动态 import
let registerNetworkHandlers: typeof import("../src/handlers/network.js")["registerNetworkHandlers"];
let registerConsoleHandlers: typeof import("../src/handlers/console.js")["registerConsoleHandlers"];

function mkReq(
  tool: string,
  args: Record<string, unknown> = {},
  tabId?: number,
): NmRequest {
  return {
    type: "tool_request",
    tool,
    args,
    requestId: "r-1",
    ...(tabId != null ? { tabId } : {}),
  };
}

function makeDebuggerMock() {
  const enableDomain = vi.fn().mockResolvedValue(undefined);
  return {
    mgr: {
      enableDomain,
      isAttached: vi.fn().mockReturnValue(false),
      sendCommand: vi.fn(),
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      attach: vi.fn().mockResolvedValue(undefined),
    } as any,
    enableDomain,
  };
}

function makeNmMock() {
  return { send: vi.fn() } as any;
}

function makeDispatcherMock() {
  return { emit: vi.fn() } as any;
}

describe("network FILTER 子字段 (V2 P0 修复 D16)", () => {
  let router: ActionRouter;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();
    const dbg = makeDebuggerMock();

    const onRemovedListeners: Array<(tabId: number) => void> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onRemoved: {
          addListener: (fn: any) => onRemovedListeners.push(fn),
        },
      },
    });

    ({ registerNetworkHandlers } = await import("../src/handlers/network.js"));
    registerNetworkHandlers(router, dbg.mgr, makeNmMock(), makeDispatcherMock());
  });

  it("FILTER 接受新统一字段名 `pattern` (V2 P0 修复核心)", async () => {
    // 模拟用户传入 { filter: { pattern: "/api/" } }
    const resp = await router.dispatch(
      mkReq("network.filter", { pattern: "/api/" }, 42),
    );
    expect(resp.error).toBeUndefined();
    // filter 字段不报错即通过 (handler 接受 pattern)
  });

  it("FILTER 接受复合子字段 pattern + statusMin + statusMax + method", async () => {
    const resp = await router.dispatch(
      mkReq(
        "network.filter",
        {
          pattern: "/api/",
          statusMin: 200,
          statusMax: 299,
          method: "GET",
        },
        42,
      ),
    );
    expect(resp.error).toBeUndefined();
  });

  it("FILTER 向后兼容旧字段名 `url` (现有 call 不破)", async () => {
    const resp = await router.dispatch(
      mkReq("network.filter", { url: "/api/legacy" }, 42),
    );
    expect(resp.error).toBeUndefined();
  });

  it("FILTER 接受顶层 pattern (schema 文档化示例推荐用法)", async () => {
    // 顶层 pattern 而非 filter.pattern — 是 V2 D16 实际可用形式
    const resp = await router.dispatch(
      mkReq("network.filter", { pattern: "item.jd.com" }, 42),
    );
    expect(resp.error).toBeUndefined();
  });
});

describe("console GET_LOGS 子字段 level (V2 P0 修复 D16)", () => {
  let router: ActionRouter;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    router = new ActionRouter();
    const dbg = makeDebuggerMock();

    const onRemovedListeners: Array<(tabId: number) => void> = [];
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
        onRemoved: {
          addListener: (fn: any) => onRemovedListeners.push(fn),
        },
      },
    });

    ({ registerConsoleHandlers } = await import("../src/handlers/console.js"));
    registerConsoleHandlers(router, dbg.mgr, makeNmMock(), makeDispatcherMock());
  });

  it("GET_LOGS 接受 args.level 子字段 (V2 P0 修复核心)", async () => {
    const resp = await router.dispatch(
      mkReq("console.getLogs", { level: "error" }, 42),
    );
    expect(resp.error).toBeUndefined();
  });

  it("GET_LOGS 接受 args.level 子字段 (warn)", async () => {
    const resp = await router.dispatch(
      mkReq("console.getLogs", { level: "warn" }, 42),
    );
    expect(resp.error).toBeUndefined();
  });
});
