/**
 * Author: qingwa
 * Description: debug_read 返回空时挂自陈；非空结果形状原封不动。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerConsoleHandlers } from "../src/handlers/console.js";
import { registerNetworkHandlers } from "../src/handlers/network.js";
import { splitDiagnosis } from "@vortex-browser/shared";

type OnEventCb = (tabId: number, method: string, params: unknown) => void;

describe("console.getLogs 空结果自陈", () => {
  let router: ActionRouter;
  let onEventCb: OnEventCb | undefined;

  async function getLogs(tabId: number, args: Record<string, unknown> = {}) {
    const resp = await router.dispatch({
      type: "tool_request", tool: "console.getLogs", args, requestId: "r", tabId,
    });
    return splitDiagnosis(resp.result);
  }

  function emit(tabId: number, type: string, text: string) {
    onEventCb!(tabId, "Runtime.consoleAPICalled", { type, args: [{ type: "string", value: text }] });
  }

  beforeEach(() => {
    router = new ActionRouter();
    const debuggerMgr = {
      onEvent: vi.fn((cb: OnEventCb) => { onEventCb = cb; }),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn(),
      sendCommand: vi.fn(),
    } as unknown as Parameters<typeof registerConsoleHandlers>[1];
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([]), onRemoved: { addListener: vi.fn() } },
    });
    registerConsoleHandlers(
      router,
      debuggerMgr,
      { send: vi.fn() } as unknown as Parameters<typeof registerConsoleHandlers>[2],
      { emit: vi.fn() } as unknown as Parameters<typeof registerConsoleHandlers>[3],
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("首次读(当场才开始录)明说更早的日志从未被捕获", async () => {
    const { value, diagnosis } = await getLogs(401);
    expect(value).toEqual([]);
    expect(diagnosis).toMatch(/started with this call/i);
  });

  it("已在录但确实没日志 → 说清是真空，别再调 filter", async () => {
    await getLogs(402);
    const { diagnosis } = await getLogs(402);
    expect(diagnosis).toMatch(/empty/i);
    expect(diagnosis).not.toMatch(/started with this call/i);
  });

  it("level 把 3 条滤光 → 报出缓冲条数", async () => {
    await getLogs(403);
    emit(403, "log", "a"); emit(403, "log", "b"); emit(403, "log", "c");
    const { value, diagnosis } = await getLogs(403, { level: "error" });
    expect(value).toEqual([]);
    expect(diagnosis).toContain("3");
    expect(diagnosis).toContain("error");
  });

  it("有结果时不挂自陈，形状与从前一致", async () => {
    await getLogs(404);
    emit(404, "error", "boom");
    const { value, diagnosis } = await getLogs(404);
    expect(diagnosis).toBeNull();
    expect(Array.isArray(value)).toBe(true);
    expect((value as unknown[]).length).toBe(1);
  });
});

describe("network.getLogs 空结果自陈", () => {
  let router: ActionRouter;

  async function getLogs(tabId: number, args: Record<string, unknown> = {}) {
    const resp = await router.dispatch({
      type: "tool_request", tool: "network.getLogs", args, requestId: "r", tabId,
    });
    return splitDiagnosis(resp.result);
  }

  beforeEach(() => {
    router = new ActionRouter();
    const debuggerMgr = {
      onEvent: vi.fn(),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue({}),
    } as unknown as Parameters<typeof registerNetworkHandlers>[1];
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([]), onRemoved: { addListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
      debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    });
    registerNetworkHandlers(
      router,
      debuggerMgr,
      { send: vi.fn() } as unknown as Parameters<typeof registerNetworkHandlers>[2],
      { emit: vi.fn() } as unknown as Parameters<typeof registerNetworkHandlers>[3],
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("首次读且什么都没录到 → 指出捕获刚开始", async () => {
    const { value, diagnosis } = await getLogs(501, { pattern: "/api/" });
    expect(value).toEqual([]);
    expect(diagnosis).toMatch(/started with this call/i);
  });
});
