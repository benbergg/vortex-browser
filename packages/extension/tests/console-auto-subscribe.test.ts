import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionRouter } from "../src/lib/router.js";
import { registerConsoleHandlers } from "../src/handlers/console.js";

/**
 * Lazy-subscribe contract for `console.getLogs` / `console.getErrors`.
 *
 * `vortex_debug_read(source=console)` dispatches to `console.getLogs`
 * without ever passing through `console.subscribe`. Before the
 * `ensureSubscribed` helper was extracted, calling GET_LOGS on a tab
 * that had not been explicitly subscribed returned [] forever — the
 * Runtime domain stayed disabled so the CDP listener never received
 * `Runtime.consoleAPICalled` events to populate the cache.
 *
 * These tests pin the new behavior: GET_LOGS (and GET_ERRORS) call
 * `debuggerMgr.enableDomain(tid, "Runtime")` exactly once for a given
 * tab regardless of which handler tripped it first.
 */
describe("console handler lazy Runtime subscription", () => {
  let router: ActionRouter;
  let enableDomain: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    router = new ActionRouter();
    enableDomain = vi.fn().mockResolvedValue(undefined);

    const debuggerMgr = {
      onEvent: vi.fn(),
      enableDomain,
      attach: vi.fn(),
      sendCommand: vi.fn(),
    } as unknown as Parameters<typeof registerConsoleHandlers>[1];

    const nm = { send: vi.fn() } as unknown as Parameters<
      typeof registerConsoleHandlers
    >[2];

    const dispatcher = { emit: vi.fn() } as unknown as Parameters<
      typeof registerConsoleHandlers
    >[3];

    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([]),
        onRemoved: { addListener: vi.fn() },
      },
    });

    registerConsoleHandlers(router, debuggerMgr, nm, dispatcher);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getLogs on a fresh tab auto-enables Runtime domain", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-getLogs-1",
      tabId: 101,
    });
    expect(enableDomain).toHaveBeenCalledTimes(1);
    expect(enableDomain).toHaveBeenCalledWith(101, "Runtime");
  });

  it("getErrors on a fresh tab also auto-enables Runtime domain", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "console.getErrors",
      args: {},
      requestId: "r-getErrors-1",
      tabId: 102,
    });
    expect(enableDomain).toHaveBeenCalledTimes(1);
    expect(enableDomain).toHaveBeenCalledWith(102, "Runtime");
  });

  it("repeat calls on the same tab subscribe only once", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-1",
      tabId: 103,
    });
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-2",
      tabId: 103,
    });
    await router.dispatch({
      type: "tool_request",
      tool: "console.getErrors",
      args: {},
      requestId: "r-3",
      tabId: 103,
    });
    expect(enableDomain).toHaveBeenCalledTimes(1);
  });

  it("explicit subscribe still works and dedupes with implicit", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "console.subscribe",
      args: {},
      requestId: "r-sub",
      tabId: 104,
    });
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-getLogs",
      tabId: 104,
    });
    expect(enableDomain).toHaveBeenCalledTimes(1);
  });

  it("different tabs subscribe independently", async () => {
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-tab-a",
      tabId: 201,
    });
    await router.dispatch({
      type: "tool_request",
      tool: "console.getLogs",
      args: {},
      requestId: "r-tab-b",
      tabId: 202,
    });
    expect(enableDomain).toHaveBeenCalledTimes(2);
    expect(enableDomain).toHaveBeenNthCalledWith(1, 201, "Runtime");
    expect(enableDomain).toHaveBeenNthCalledWith(2, 202, "Runtime");
  });
});
