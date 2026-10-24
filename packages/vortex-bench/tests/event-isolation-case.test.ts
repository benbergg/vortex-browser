/**
 * Author: qingwa
 * Description: 事件隔离用例的时序护栏 + 模拟器建模的 awaitIdle 语义护栏。
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
 * ── 模拟器建模的语义（**已对齐 Task 1 的静默期语义**）────────────────────
 * 照抄 packages/extension/src/handlers/page.ts 的 awaitIdle：
 * - 监听器在 wait_for **调用时**注册，只记录之后到达的 requestWillBeSent；
 * - **静默期**：idle = 「最后一次匹配请求后连续 idleTime 内没有新的匹配请求」。
 *   挂着的请求（pending）**不再阻断 idle**，只作为诊断透出（`pendingRequests`）。
 * - **静默计时器随每个新匹配请求重启** ⇒ 「请求持续不断」的页面永远判不出 idle
 *   （这正是 B3′ 负向验证要的放大器）。
 * - **结束事件（loadingFinished）只清诊断集合，不碰计时器**（Task 1 的修复：
 *   否则结束事件会把静默截止往后推，甚至撞上超时）。
 * - tab 事件过滤（`if (evtTabId !== tid) return;`）在计数与诊断**之前**。
 * - 超时按 MCP 的错误形态返回 `Error [TIMEOUT]: ...`。
 *
 * ⚠️ **模拟器的能力边界**（务必读）：
 * 模拟器只能建模「**字面量 URL** 的 fetch」：`window.fetch("http://…")`。
 * **页面侧的链式 fetch（`window.fetch(u)`，u 是变量）建模不了** —— 模拟器取不到 URL，
 * 于是返回可识别的 `no-fetch(...)` 标记并且**不发出任何请求**。
 * 这意味着：本护栏**只能**覆盖用例当前用的「Node 侧 MCP 循环逐个发字面量 fetch」那一种
 * 持续发请求的形态；**不要**在这里写「页面侧链式 fetch」的用例 —— 模拟器会静默地
 * 少发请求，用例就会**假绿**。真机上那种形态由 bench 实跑（suite B）覆盖。
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
/** 扩展 network idle 的默认 idleTime（与扩展一致：500ms）。 */
const DEFAULT_IDLE_TIME = 500;

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
  /**
   * 让**前台** tab 的 network 日志读取返回一个「标准报错但载荷恰好可解析」的响应：
   * `{ isError: true, content: [{ type: "text", text: "[]" }] }`。
   *
   * 这是 MCP 的真实形态之一：文本里**没有** `Error [`，载荷又能 JSON.parse ⇒
   * 只靠文本判定会把「读取失败」当成「读取成功、日志是空的」。
   */
  fgNetworkReadIsError?: boolean;
  /**
   * 让 wait_for 返回一个「标准报错但载荷恰好是**看起来成功**的对象」的响应：
   * `{ isError: true, content: [{ type: "text", text: '{"idle":true,...}' }] }`。
   *
   * 同一类错误：文本里没有 `Error [`，载荷又能 JSON.parse ⇒ 只看文本的旧判定会
   * 把「idle 报错了」读成「idle 有结果」⇒ 用例假绿。
   */
  idleResultIsError?: boolean;
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

/** 取工具返回的**首个文本块**（载荷块）—— 与 MCP 的真实形态一致。 */
function payloadOf(res: unknown): string {
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (item && typeof item === "object" && "text" in item) {
      return String((item as { text: unknown }).text);
    }
  }
  return "";
}

/** 模拟器**认不出**的脚本形态：页面侧链式 fetch（URL 是变量）。 */
const NO_FETCH_MARK = "no-fetch(模拟器只认字面量 URL 的 fetch(...))";

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
  /** 每次**判出 idle**的结果（护栏用来断言「判没判 idle」而不只是「没抛错」）。 */
  readonly idleResolutions: Array<{
    tabId: number;
    waitedMs: number;
    matchedRequests: number;
    pendingRequests: number;
  }> = [];
  /** 每次 idle **超时**的记录（护栏用来断言「是被持续请求拖到超时」）。 */
  readonly idleTimeouts: Array<{ tabId: number; timeout: number; matched: number; pending: number }> = [];

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
    // 故障注入：前台读取返回「isError=true + 载荷恰好是可解析空数组」的响应。
    if (this.opts.fgNetworkReadIsError && tabId === FG_TAB) {
      return { isError: true, content: [{ type: "text", text: "[]" }] };
    }
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

  /** js.evaluate：识别用例的几段脚本 —— 记 t0 / 发慢请求 / 发探针 / 发持续请求 / 回读。 */
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
      const url = this.literalFetchUrl(code);
      if (!url) return toolText(NO_FETCH_MARK);
      this.emitRequest(tabId, url, Number(new URL(url).searchParams.get("ms") ?? "0"));
      return toolText("issued");
    }

    // 发请求：`window.fetch("<url>")`（探针 / 持续发请求）
    if (code.includes("window.fetch(")) {
      // 后台订阅探针带专属 token，用来跟前台探针区分（两者都是 fetch）；
      // 持续发请求的脚本以 `return "burst"` 自报家门。
      if (code.includes("bg-probe")) this.calls.push("evaluate:bgprobe");
      else if (code.includes('return "burst"')) this.calls.push("evaluate:burst");
      else this.calls.push("evaluate:fgprobe");
      const url = this.literalFetchUrl(code);
      if (!url) return toolText(NO_FETCH_MARK);
      // 探针秒回；持续发请求的「响应时长」在静默期语义下**不影响 idle 判定**
      // （idle 只看「最后一次匹配请求 + idleTime」），这里给个短时长即可。
      this.emitRequest(tabId, url, 5);
      return toolText(code.includes('return "burst"') ? "burst" : "probe");
    }

    // 回读慢请求发起时刻
    if (code.includes("__vortexSlowStart")) {
      this.calls.push("evaluate:read");
      return toolText({ start: state.slowStart ?? null, now: Date.now() });
    }

    return toolText("no-op");
  }

  /**
   * 从脚本里取**字面量** URL 的 fetch。
   *
   * 能力边界：只认 `fetch("…")`。页面侧的链式 fetch（`window.fetch(u)`，u 是变量）
   * 取不到 ⇒ 返回 null ⇒ 调用方返回 NO_FETCH_MARK 且**不发请求**（不假装成功）。
   */
  private literalFetchUrl(code: string): string | null {
    return /fetch\("([^"]+)"\)/.exec(code)?.[1] ?? null;
  }

  /** 造一条请求并通知监听器（durationMs 之后结束）。 */
  emitRequest(tabId: number, url: string, durationMs: number): FakeRequest {
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
    return req;
  }

  /**
   * page.waitForNetworkIdle：**照抄扩展 awaitIdle 的静默期语义**。
   *
   * 与旧版模拟器（"tracked 清空" 语义）的差别：
   * - 计时器在**调用时**就 arm，判定只看「最后一次匹配请求 + idleTime」；
   * - 每个新匹配请求**重启**计时器（⇒ 持续请求 ⇒ 永远判不出 idle）；
   * - 结束事件**只清诊断集合**，不碰计时器；
   * - 结果里带 `pendingRequests`（resolve 那一刻仍未结束的匹配请求数）。
   */
  waitForIdle(args: Record<string, unknown>): Promise<unknown> {
    this.calls.push("wait_for");
    // 不传 tabId 时，hub 把请求路由到 session 当前 tab —— 建完后台 tab 后那就是后台 tab。
    const tabId = this.resolveTab(args, "wait_for");
    const timeout = Number(args.timeout ?? 30000);
    const idleTime = this.opts.idleTime ?? DEFAULT_IDLE_TIME;
    // 故障注入：返回一个「isError=true + 载荷看起来成功」的 idle 结果。
    if (this.opts.idleResultIsError) {
      return Promise.resolve({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ idle: true, waitedMs: 1, matchedRequests: 1, pendingRequests: 0 }),
          },
        ],
      });
    }
    // tracked 只做诊断：requestId → {url, type}，供 pending 明细用。
    const tracked = new Map<number, { url: string; type: string }>();
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
          tracked.set(req.id, { url: req.url, type: "Fetch" });
          matched += 1;
          // ★ 静默计时器随每个新匹配请求重启 —— 少了这一步，「请求持续不断」的页面
          //   会在第一次请求后就判出 idle，负向验证就测不出判别力了。
          checkIdle();
        },
        onFinished: (req: FakeRequest): void => {
          if (!tracked.has(req.id)) return;
          // 结束事件**只更新诊断集合**，绝不碰静默计时器（Task 1 的修复）。
          tracked.delete(req.id);
        },
      };
      const checkIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        idleTimer = setTimeout(() => {
          idleTimer = null;
          cleanup();
          const result = {
            idle: true,
            waitedMs: Date.now() - startTime,
            matchedRequests: matched,
            pendingRequests: tracked.size,
          };
          this.idleResolutions.push({ tabId, ...result });
          resolve(toolText(result));
        }, idleTime);
      };
      const cleanup = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        this.idleListeners = this.idleListeners.filter((l) => l !== listener);
      };
      const timeoutTimer = setTimeout(() => {
        cleanup();
        this.idleTimeouts.push({ tabId, timeout, matched, pending: tracked.size });
        resolve(
          toolError(
            "TIMEOUT",
            `Network not idle after ${timeout}ms (${tracked.size} matching requests pending, ${matched} seen) ` +
              `pending: ${JSON.stringify([...tracked.values()])}`,
          ),
        );
      }, timeout);

      this.idleListeners.push(listener);
      // 立即开始静默计时（调用即「最后一次匹配请求」）。
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

    // 断言具体结果，而不是「没抛错」：前台**判出过** idle，且只认自己 tab 的请求。
    expect(sim.idleResolutions).toHaveLength(1);
    expect(sim.idleResolutions[0].tabId).toBe(FG_TAB);
    // 前台探针被计入；后台的慢请求与持续请求被 tab 过滤 ⇒ 不计入。
    expect(sim.idleResolutions[0].matchedRequests).toBe(1);
    // 没有超时。
    expect(sim.idleTimeouts).toHaveLength(0);
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

  it("删掉 tab 事件过滤（regression）时用例必须失败：前台被持续请求拖到超时", async () => {
    const sim = new ExtensionSim({ tabFilter: false });
    const p = eventIsolation.run(makeCtx(sim));
    const assertion = expect(p).rejects.toThrow(/前台 idle 判定不应报错/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 断言**成因**：前台**一次都没判出 idle**（静默期被后台的持续请求不断推后），
    // 最后是超时 —— 而不是别的什么错。
    expect(sim.idleResolutions).toHaveLength(0);
    expect(sim.idleTimeouts).toHaveLength(1);
    expect(sim.idleTimeouts[0].tabId).toBe(FG_TAB);
    // 后台的持续请求确实被前台数了进去（matched ≫ 1 ⇒ 静默计时器被反复重启）。
    expect(sim.idleTimeouts[0].matched).toBeGreaterThan(1);
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

    // 持续发请求确实发了（模拟器认得「字面量 URL 的 fetch」这一形态）。
    expect(sim.calls.filter((c) => c === "evaluate:burst").length).toBeGreaterThan(5);
  });
});

describe("模拟器建模的 awaitIdle 语义（静默期）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("没有请求时：idleTime 满即判 idle（waitedMs≈idleTime，matched=0，pending=0）", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = sim.waitForIdle({ timeout: 5000, tabId: FG_TAB });
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIME - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);

    const res = JSON.parse(payloadOf(await p)) as {
      idle: boolean;
      waitedMs: number;
      matchedRequests: number;
      pendingRequests: number;
    };
    expect(res.idle).toBe(true);
    expect(res.waitedMs).toBeGreaterThanOrEqual(DEFAULT_IDLE_TIME);
    expect(res.matchedRequests).toBe(0);
    expect(res.pendingRequests).toBe(0);
  });

  it("持续发请求期间**不**判 idle：每个新请求把静默截止往后推", async () => {
    const sim = new ExtensionSim({ tabFilter: false });
    const p = sim.waitForIdle({ timeout: 5000, tabId: FG_TAB });
    let settled = false;
    void p.then(() => {
      settled = true;
    });

    // 每 100ms 发一个**别的 tab** 的请求（间隔 < idleTime 500ms）——
    // 静默计时器被不断重启 ⇒ 前台 2 秒内一次都没判出 idle。
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(100);
      sim.emitRequest(BG_TAB, `${BASE_URL}/slow?ms=1`, 1);
    }
    expect(settled).toBe(false);
    expect(sim.idleResolutions).toHaveLength(0);

    // 停止发请求后：静默期满即 idle。
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIME + 1);
    expect(settled).toBe(true);
    const res = JSON.parse(payloadOf(await p)) as {
      idle: boolean;
      matchedRequests: number;
      pendingRequests: number;
    };
    expect(res.idle).toBe(true);
    // 20 个后台请求全被前台数了进去 ⇒ 静默期被重启过 20 次。
    expect(res.matchedRequests).toBe(20);
  });

  it("请求停止后静默期满即 idle，且 pendingRequests 反映在飞请求（挂着的请求不再阻断 idle）", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = sim.waitForIdle({ timeout: 5000, tabId: FG_TAB });
    // 一个 3000ms 才结束的请求：静默期语义下它**不阻断** idle，只作诊断。
    sim.emitRequest(FG_TAB, `${BASE_URL}/slow?ms=3000`, 3000);

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIME + 1);
    const res = JSON.parse(payloadOf(await p)) as {
      idle: boolean;
      waitedMs: number;
      matchedRequests: number;
      pendingRequests: number;
    };
    expect(res.idle).toBe(true);
    expect(res.waitedMs).toBeLessThan(3000);
    expect(res.matchedRequests).toBe(1);
    // ★ pending 诊断：那个请求还挂着，如实透出（否则 agent 会把静默期误读成「网络空了」）。
    expect(res.pendingRequests).toBe(1);
  });

  it("结束事件**不**重启静默截止（Task 1 的修复）", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = sim.waitForIdle({ timeout: 5000, tabId: FG_TAB });
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    // 100ms 才结束的请求：结束事件不能把静默截止从 500ms 推到 600ms。
    sim.emitRequest(FG_TAB, `${BASE_URL}/slow?ms=100`, 100);

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIME - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);

    const res = JSON.parse(payloadOf(await p)) as { waitedMs: number; pendingRequests: number };
    expect(res.waitedMs).toBeLessThan(600);
    // 结束事件只清诊断集合。
    expect(res.pendingRequests).toBe(0);
  });

  it("tab 过滤：别的 tab 的请求既不计入 matched 也不推迟静默截止", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    const p = sim.waitForIdle({ timeout: 5000, tabId: FG_TAB });
    // 后台的慢请求（6s）：被过滤 ⇒ 不计数、不进诊断集合、不推迟截止。
    sim.emitRequest(BG_TAB, `${BASE_URL}/slow?ms=6000`, 6000);

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIME + 1);
    const res = JSON.parse(payloadOf(await p)) as {
      idle: boolean;
      waitedMs: number;
      matchedRequests: number;
      pendingRequests: number;
    };
    expect(res.idle).toBe(true);
    expect(res.waitedMs).toBeLessThan(1000);
    expect(res.matchedRequests).toBe(0);
    expect(res.pendingRequests).toBe(0);
  });

  it("B1 的读取失败**不得**冒充「无泄漏」：isError=true + 载荷恰是可解析空数组 ⇒ 判读取失败", async () => {
    // 故障注入：前台 tab 的 debug_read 返回 {isError:true, 载荷:"[]"} ——
    // 文本里没有 `Error [`，载荷又能 JSON.parse ⇒ 只看文本/载荷的旧判定会
    // 把它当成「读取成功、日志是空的」⇒ B1 假绿。
    const sim = new ExtensionSim({ tabFilter: true, fgNetworkReadIsError: true });
    const p = eventIsolation.run(makeCtx(sim));
    const assertion = expect(p).rejects.toThrow(/B1 前置不成立/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 前台 idle 本身是好的（失败点只在日志读取这一条路上）。
    expect(sim.idleResolutions.length).toBeGreaterThan(0);
  });

  it("idle 的报错同样不得冒充「有结果」：isError=true + 载荷恰是可解析对象 ⇒ 判失败", async () => {
    // 故障注入：wait_for 返回 {isError:true, 载荷:"{\"idle\":true,...}"} ——
    // 文本里没有 `Error [`，载荷又能 JSON.parse ⇒ 只看文本/载荷的旧判定会
    // 把它当成「idle 判成功了」⇒ 用例假绿。
    const sim = new ExtensionSim({ tabFilter: true, idleResultIsError: true });
    const p = eventIsolation.run(makeCtx(sim));
    const assertion = expect(p).rejects.toThrow(/前台 idle 判定不应报错/);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 关键：一次 idle 都没判成功过（idleResolutions 为空 —— 返回的是报错，不是结果）。
    expect(sim.idleResolutions).toHaveLength(0);
  });

  it("能力边界：页面侧链式 fetch 模拟器建模不了 —— 明确失败，绝不假装成功", async () => {
    const sim = new ExtensionSim({ tabFilter: true });
    // `window.fetch(u)`（u 是变量）：模拟器取不到 URL。
    const res = await sim.call("vortex_evaluate", {
      tabId: BG_TAB,
      code: `(function(){ var u = ${JSON.stringify(`${BASE_URL}/slow?ms=100`)}; window.fetch(u).then(step, step); })()`,
    });
    expect(payloadOf(res)).toContain("no-fetch");
    // 关键：**没有**发出任何请求（少发请求会让用例假绿）。
    expect(sim.requests).toHaveLength(0);
    // 本护栏因此只覆盖「字面量 URL 的 fetch」这一形态；页面侧链式 fetch 由 bench 实跑覆盖。
  });
});
