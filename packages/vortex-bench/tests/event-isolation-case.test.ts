/**
 * Author: qingwa
 * Description: 事件隔离用例的时序护栏（最终整体评审 Important 5）。
 *
 * 背景：旧用例的时序是「后台慢请求先发出 → 等 600ms → 才启动前台 idle」，
 * 而扩展的 awaitIdle 在**调用时**新建空 tracked 集合，只记录之后的 requestWillBeSent
 * ⇒ 已经发出去的慢请求进不了集合 ⇒ 即使把扩展里的 tab 事件过滤删掉，用例照样通过
 * （假绿窗口：测的其实不是事件隔离）。
 *
 * 本文件用一个**模拟扩展语义**的假 ctx 驱动这条用例：
 * - `tabFilter: true`（现状：awaitIdle 只跟踪本 tab 的请求）⇒ 用例必须通过；
 * - `tabFilter: false`（模拟"删掉 tab 事件过滤"的 regression）⇒ 用例**必须失败**。
 *
 * 模拟器照抄扩展的真实语义（packages/extension/src/handlers/page.ts 的 awaitIdle）：
 * - 监听器在 wait_for **调用时**注册，只记录之后到达的 requestWillBeSent；
 * - 请求到达时清掉 idle 计时器，请求结束后重新判定；
 * - idleTime 内没有在飞请求才判空闲；超时按 MCP 的错误形态返回 `Error [TIMEOUT]:`。
 *
 * 扩展侧的真实过滤由 packages/extension/tests/page-wait-idle-tab-isolation.test.ts
 * 单独锁住（那边直接驱动真的 page.waitForNetworkIdle）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CaseContext } from "../src/types.js";
import eventIsolation from "../cases/contract/event-isolation.case.js";

const BASE_URL = "http://127.0.0.1:5599";
const FG_TAB = 1;
const BG_TAB = 2;

/** 模拟器内部的一条请求（对齐扩展 NetworkEntry 的关键字段）。 */
interface FakeRequest {
  id: number;
  tabId: number;
  url: string;
  startTime: number;
  endTime?: number;
}

interface SimOptions {
  /** awaitIdle 的 tab 事件过滤（false = 删掉过滤 = 被防的 regression）。 */
  tabFilter: boolean;
  /** awaitIdle 的 idleTime（与扩展一致：500ms）。 */
  idleTime?: number;
}

/** MCP 工具返回的文本形态。 */
function toolText(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** MCP 工具报错的形态（用例靠 `Error [` 形状识别）。 */
function toolError(code: string, message: string): unknown {
  return {
    isError: true,
    content: [{ type: "text", text: `Error [${code}]: ${message}` }],
  };
}

class ExtensionSim {
  readonly tabs = new Map<number, { id: number; url: string; status: string; active: boolean; lastFocused: boolean }>();
  readonly requests: FakeRequest[] = [];
  /** 工具调用顺序（用例的时序断言用）。 */
  readonly calls: string[] = [];
  /**
   * hub 侧的 **session 当前 tab**：不带 tabId 的请求就落到它上面。
   * tab.create 会把它切到新建的 tab（hub 的 updateTabState → claimTab(makeCurrent=true)），
   * 所以建完后台 tab 之后，不带 tabId 的调用其实落在**后台** tab 上。
   * 模拟器必须照抄这个语义：用例里「前台调用」要是没显式带 tabId，
   * 就会落到后台 tab 上，用例随即变红 —— 这正是本护栏要防的假失败。
   */
  sessionCurrentTab: number = FG_TAB;
  /** 每次调用实际落到的 tab（用于护栏：前台调用必须显式带上前台 tab）。 */
  readonly callTabIds: Array<{ name: string; tabId: number }> = [];
  /** 在前台 idle 监听窗口内到达的请求数（含被 tab 过滤掉的 —— 测的是"落在窗口内"）。 */
  requestsDuringIdleWindow = 0;
  /** 每个 tab 的页面状态（用例把慢请求的发起时刻记在页面里）。 */
  readonly pageState = new Map<number, { slowStart?: number }>();

  private nextRequestId = 1;
  private idleListeners: Array<{
    tabId: number;
    onRequest: (req: FakeRequest) => void;
    onFinished: (req: FakeRequest) => void;
  }> = [];

  constructor(private readonly opts: SimOptions) {
    this.tabs.set(FG_TAB, {
      id: FG_TAB,
      url: `${BASE_URL}/`,
      status: "complete",
      active: true,
      lastFocused: true,
    });
  }

  /** 不带 tabId 的调用落到 session 当前 tab（与 hub 的路由口径一致）。 */
  private resolveTab(args: Record<string, unknown>, name: string): number {
    const tabId = args.tabId === undefined ? this.sessionCurrentTab : Number(args.tabId);
    this.callTabIds.push({ name, tabId });
    return tabId;
  }

  /** tab.list */
  listTabs(): unknown {
    this.calls.push("tab_list");
    return toolText([...this.tabs.values()].map((t) => ({ ...t, current: t.id === this.sessionCurrentTab })));
  }

  /** tab.create */
  createTab(args: Record<string, unknown>): unknown {
    this.calls.push("tab_create");
    const id = BG_TAB;
    this.tabs.set(id, {
      id,
      url: String(args.url ?? ""),
      status: "complete",
      active: false,
      lastFocused: false,
    });
    // hub 的语义：tab.create 之后 session 当前 tab 变成新建的 tab
    this.sessionCurrentTab = id;
    return toolText({ id });
  }

  /** tab.close */
  closeTab(args: Record<string, unknown>): unknown {
    this.calls.push("tab_close");
    this.tabs.delete(Number(args.tabId));
    return toolText({ ok: true });
  }

  /** network.getLogs（debug_read source=network）：只回 API 类（XHR/Fetch）。 */
  readNetwork(args: Record<string, unknown>): unknown {
    this.calls.push("debug_read");
    const tabId = this.resolveTab(args, "debug_read");
    const pattern = String(args.pattern ?? "");
    const entries = this.requests
      .filter((r) => r.tabId === tabId && r.url.includes(pattern))
      .map((r) => ({
        url: r.url,
        type: "Fetch",
        // CDP 记的条目 method 非空（扩展侧 Resource Timing 回填的条目 method 为空）——
        // 用例靠这个区分"CDP 域真的开着"与"只有页面自己记得"。
        method: "GET",
        startTime: r.startTime,
        ...(r.endTime === undefined ? {} : { endTime: r.endTime }),
      }));
    return toolText(entries);
  }

  /** js.evaluate：识别用例的几段脚本 —— 记 t0 / 发慢请求 / 发探针 / 回读。 */
  evaluate(args: Record<string, unknown>): unknown {
    const code = String(args.code ?? "");
    const tabId = this.resolveTab(args, "evaluate");
    const state = this.pageState.get(tabId) ?? {};
    this.pageState.set(tabId, state);

    // 记 t0：`return Date.now();`
    if (code.includes("return Date.now()")) {
      this.calls.push("evaluate:t0");
      return toolText(Date.now());
    }

    // 发慢请求：`window.__vortexSlowStart = Date.now(); window.fetch("<url>")`
    if (code.includes("__vortexSlowStart =")) {
      this.calls.push("evaluate:slow");
      state.slowStart = Date.now();
      const url = /fetch\("([^"]+)"\)/.exec(code)?.[1];
      if (!url) return toolText("no-fetch");
      this.issueRequest(tabId, url, Number(new URL(url).searchParams.get("ms") ?? "0"));
      return toolText("issued");
    }

    // 发探针：`window.fetch("<url>")`（前台 tab，秒回）
    if (code.includes("window.fetch(")) {
      // 后台订阅探针带专属 token，用来跟前台探针区分（两者都是 fetch）
      this.calls.push(code.includes("bg-probe") ? "evaluate:bgprobe" : "evaluate:fgprobe");
      const url = /fetch\("([^"]+)"\)/.exec(code)?.[1];
      if (!url) return toolText("no-fetch");
      this.issueRequest(tabId, url, 5);
      return toolText("probe");
    }

    // 回读慢请求发起时刻
    if (code.includes("__vortexSlowStart")) {
      this.calls.push("evaluate:read");
      return toolText({ start: state.slowStart ?? null, now: Date.now() });
    }

    return toolText("no-op");
  }

  /** 造一条请求并通知监听器（durationMs 之后结束）。 */
  private issueRequest(tabId: number, url: string, durationMs: number): void {
    const req: FakeRequest = {
      id: this.nextRequestId++,
      tabId,
      url,
      startTime: Date.now(),
    };
    this.requests.push(req);
    for (const l of this.idleListeners) l.onRequest(req);
    setTimeout(() => {
      req.endTime = Date.now();
      for (const l of this.idleListeners) l.onFinished(req);
    }, durationMs);
  }

  /** page.waitForNetworkIdle：照抄扩展 awaitIdle 的语义。 */
  waitForIdle(args: Record<string, unknown>): Promise<unknown> {
    this.calls.push("wait_for");
    // 不传 tabId 时，hub 把请求路由到 session 当前 tab —— 建完后台 tab 后那就是后台 tab。
    const tabId = this.resolveTab(args, "wait_for");
    const timeout = Number(args.timeout ?? 30000);
    const idleTime = this.opts.idleTime ?? 500;
    const tracked = new Set<number>();
    let matched = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const listener = {
        tabId,
        onRequest: (req: FakeRequest): void => {
          // 计数在过滤**之前**：测的是"慢请求落在了监听窗口内"，
          // 被 tab 过滤掉也算落在窗口内（那正是本用例要防的假绿）。
          this.requestsDuringIdleWindow += 1;
          // 扩展里的关键一行：`if (evtTabId !== tid) return;`
          if (this.opts.tabFilter && req.tabId !== tabId) return;
          tracked.add(req.id);
          matched += 1;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        },
        onFinished: (req: FakeRequest): void => {
          if (!tracked.has(req.id)) return;
          tracked.delete(req.id);
          checkIdle();
        },
      };
      const checkIdle = (): void => {
        if (tracked.size <= 0 && matched >= 0) {
          idleTimer = setTimeout(() => {
            cleanup();
            resolve(
              toolText({ idle: true, waitedMs: Date.now() - startTime, matchedRequests: matched }),
            );
          }, idleTime);
        }
      };
      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        this.idleListeners = this.idleListeners.filter((l) => l !== listener);
      };
      const timeoutTimer = setTimeout(() => {
        cleanup();
        resolve(toolError("TIMEOUT", `Network not idle after ${timeout}ms`));
      }, timeout);

      this.idleListeners.push(listener);
      checkIdle();
    });
  }

  /** 工具分发。 */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "vortex_tab_list":
        return this.listTabs();
      case "vortex_tab_create":
        return this.createTab(args);
      case "vortex_tab_close":
        return this.closeTab(args);
      case "vortex_debug_read":
        return this.readNetwork(args);
      case "vortex_evaluate":
        return this.evaluate(args);
      case "vortex_wait_for":
        return this.waitForIdle(args);
      default:
        throw new Error(`模拟器不支持的工具：${name}`);
    }
  }
}

function makeCtx(sim: ExtensionSim): CaseContext {
  return {
    playgroundUrl: BASE_URL,
    baseUrl: BASE_URL,
    call: (name, args) => sim.call(name, args),
    fallbackEvaluate: async () => {
      throw new Error("本用例不该走 evaluate 兜底");
    },
    recordObserveMiss: () => {},
    assert: (cond, message) => {
      if (!cond) throw new Error(message);
    },
    recordMetric: () => {},
  };
}

describe("事件隔离用例：时序与隔离性", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("按 tab 隔离（现状）时用例通过", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = eventIsolation.run(makeCtx(sim));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBeUndefined();
  });

  it("慢请求确实落在前台 idle 的监听窗口内（时序修正的护栏）", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = eventIsolation.run(makeCtx(sim));
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(sim.requestsDuringIdleWindow).toBeGreaterThan(0);
    // 先开前台 idle 监听，再触发后台慢请求（探针也在窗口内）
    const waitIdx = sim.calls.indexOf("wait_for");
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    // 后台订阅探针必须在前台 idle 监听之前（订阅没开就没有隔离可测）
    expect(sim.calls.indexOf("evaluate:bgprobe")).toBeLessThan(waitIdx);
    // 前台探针与后台慢请求都必须在监听窗口内
    expect(waitIdx).toBeLessThan(sim.calls.indexOf("evaluate:fgprobe"));
    expect(waitIdx).toBeLessThan(sim.calls.indexOf("evaluate:slow"));
  });

  it("删掉 tab 事件过滤（regression）时用例必须失败", async () => {
    const sim = new ExtensionSim({ tabFilter: false });
    const p = eventIsolation.run(makeCtx(sim));
    const assertion = expect(p).rejects.toThrow(/前台 idle 判定不应报错/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it("定向修复轮 ②：前台调用必须显式带上前台 tab（不能靠不带 tabId 的调用）", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = eventIsolation.run(makeCtx(sim));
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBeUndefined();

    // hub 的语义被模拟器照抄了：tab.create 之后 session 当前 tab 变成后台 tab。
    expect(sim.sessionCurrentTab).toBe(BG_TAB);

    // 前台的三个关键调用都必须显式落在前台 tab 上：
    // 前台网络订阅 / 前台 idle 监听 / 前台探针。
    const byName = (name: string): number[] =>
      sim.callTabIds.filter((c) => c.name === name).map((c) => c.tabId);
    expect(byName("wait_for")).toEqual([FG_TAB]);
    expect(byName("evaluate")).toContain(FG_TAB);
    expect(byName("debug_read")).toContain(FG_TAB);
    // 后台的调用仍然落在后台 tab 上
    expect(byName("evaluate")).toContain(BG_TAB);
    expect(byName("debug_read")).toContain(BG_TAB);
  });
});
