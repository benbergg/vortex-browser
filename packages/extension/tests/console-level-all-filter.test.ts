import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerConsoleHandlers } from "../src/handlers/console.js";

/**
 * console.getLogs 的 level='all' 哨兵不被识别(白盒+DAST,2026-06-20)。
 *
 * 缺陷(silent-false-negative,文档化输入契约违反):
 *   GET_LOGS 做 `logs.filter(l => l.level === level)`。公开工具
 *   vortex_debug_read(source=console) 的 filter 在 dispatch.ts:214 文档化为
 *   `console:{level:'error'|'warn'|'all'}`,且 dispatch 把 filter 原样
 *   Object.assign 进 params(level='all' 直达 handler)。但没有 entry 的 level
 *   是字面 'all' → 请求「全部级别」反而返回 []。
 *
 *   DAST 实机复现(example.com 发 log/warn/error/info):
 *     无 filter → 4 条;filter={level:'all'} → [](应为 4);
 *     filter={level:'error'} → 1(正常)。
 *
 * 修复:GET_LOGS 把 'all' 视作「无级别过滤」(level && level !== 'all'),
 *   同时覆盖 vortex_console 与 vortex_debug_read 两条 funnel 到 console.getLogs
 *   的路径。
 */
type OnEventCb = (tabId: number, method: string, params: unknown) => void;

interface ConsoleArgs {
  level?: string;
}

describe("console.getLogs level='all' 哨兵 = 无级别过滤", () => {
  let router: ActionRouter;
  let onEventCb: OnEventCb | undefined;

  function emit(tabId: number, type: string, text: string) {
    onEventCb!(tabId, "Runtime.consoleAPICalled", {
      type,
      args: [{ type: "string", value: text }],
    });
  }

  async function getLogs(tabId: number, args: ConsoleArgs = {}) {
    const resp = await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args,
      requestId: "r",
      tabId,
    });
    return resp.result as Array<{ level: string; text: string }>;
  }

  beforeEach(() => {
    router = new ActionRouter();
    const debuggerMgr = {
      onEvent: vi.fn((cb: OnEventCb) => {
        onEventCb = cb;
      }),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn(),
      sendCommand: vi.fn(),
    } as unknown as Parameters<typeof registerConsoleHandlers>[1];
    const nm = { send: vi.fn() } as unknown as Parameters<typeof registerConsoleHandlers>[2];
    const dispatcher = { emit: vi.fn() } as unknown as Parameters<typeof registerConsoleHandlers>[3];
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([]), onRemoved: { addListener: vi.fn() } },
    });
    registerConsoleHandlers(router, debuggerMgr, nm, dispatcher);
  });

  afterEach(() => vi.unstubAllGlobals());

  // 先 getLogs 触发 ensureSubscribed(subscribedTabs.has 才让 onEvent 入缓存),
  // 再灌入 4 条不同级别日志。
  async function seed(tabId: number) {
    await getLogs(tabId); // auto-subscribe
    emit(tabId, "log", "CANARY_LOG");
    emit(tabId, "warning", "CANARY_WARN"); // CDP 'warning' → 归一 'warn'
    emit(tabId, "error", "CANARY_ERROR");
    emit(tabId, "info", "CANARY_INFO");
  }

  it("无 level → 返回全部 4 条", async () => {
    await seed(301);
    const logs = await getLogs(301);
    expect(logs).toHaveLength(4);
  });

  it("level='all' → 返回全部 4 条(修复核心,此前返回 0)", async () => {
    await seed(302);
    const logs = await getLogs(302, { level: "all" });
    expect(logs).toHaveLength(4);
    expect(logs.map((l) => l.level).sort()).toEqual(["error", "info", "log", "warn"]);
  });

  it("level='error' → 仅 1 条(具体级别过滤不受影响)", async () => {
    await seed(303);
    const logs = await getLogs(303, { level: "error" });
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("error");
  });

  it("level='warn' → 仅 1 条(CDP 'warning' 归一后可命中)", async () => {
    await seed(304);
    const logs = await getLogs(304, { level: "warn" });
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe("CANARY_WARN");
  });
});
