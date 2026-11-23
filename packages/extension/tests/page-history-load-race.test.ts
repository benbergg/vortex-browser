import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 回归锁：back/forward 的 load 等待监听器必须在导航命令**之前**挂上（Round 15）。
 *
 * 现象：`contract/history-back-refused` 偶发红（passRate 0.67），失败形态是
 * `Error [TIMEOUT]: Action page.back exceeded its 30000ms budget`。
 *
 * 根因：handler 先发导航命令、再挂 tab 'complete' 监听器（waitForTabLoad）。历史恢复
 * 常在毫秒级完成（bfcache / 同文档），'complete' 事件在监听器挂上之前就发过了 ⇒
 * 等待器空等满 NAVIGATE_LOAD_TIMEOUT_MS(25s)。实测（探针 6 轮）：history 调用耗时
 * 25536ms / 25651ms 且返回 degraded:true，事后 tab status=complete（页面早已就绪）。
 * 25s + frame-ready 2s 顶穿 MCP 动作 30s 预算 ⇒ 偶发 TIMEOUT。
 *
 * 同一形状的竞态在 navigate 路径已由 NAV-1b 修过（2026-06-04 插桩确诊 55ms↔25047ms
 * 抖动），back/forward 这条路一直没人修。
 *
 * 本测试用「导航命令发出时立刻触发 'complete'」复现该竞态：监听器若已挂上，事件被
 * 接住 ⇒ 返回里没有 degraded；监听器晚挂 ⇒ 事件丢失 ⇒ 干等 25s 才降级返回。
 */

type Handler = (args: Record<string, unknown>, tabId: number) => Promise<unknown>;

const OLD_DOC = { href: "http://x/old", timeOrigin: 1000 };
const NEW_DOC = { href: "http://x/new", timeOrigin: 2000 };

interface SetupOptions {
  /** 历史表；currentIndex 指向当前位置。 */
  currentIndex?: number;
  entries?: Array<{ id: number; url?: string }>;
}

describe("history load 等待的监听器挂载时机（Round 15）", () => {
  beforeEach(() => {
    delete (globalThis as any).chrome;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setup(options: SetupOptions = {}) {
    const { currentIndex = 1, entries = [{ id: 1, url: "http://x/old" }, { id: 2, url: "http://x/new" }] } =
      options;
    const order: string[] = [];
    let completeListener: ((tabId: number, changeInfo: { status: string }) => void) | null = null;
    let navigated = false;

    (globalThis as any).chrome = {
      scripting: {
        executeScript: vi.fn(async () =>
          navigated
            ? [{ result: NEW_DOC, frameId: 2, documentId: "d-new" }]
            : [{ result: OLD_DOC, frameId: 1, documentId: "d-old" }],
        ),
      },
      tabs: {
        onUpdated: {
          addListener: vi.fn((fn: (tabId: number, changeInfo: { status: string }) => void) => {
            order.push("addListener");
            completeListener = fn;
          }),
          removeListener: vi.fn(),
        },
        get: vi.fn(async () => ({ url: "http://x/new", title: "New" })),
      },
    };

    const debuggerMgr = {
      attach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_tid: number, cmd: string) => {
        if (cmd === "Page.getNavigationHistory") return { currentIndex, entries };
        if (cmd === "Page.navigateToHistoryEntry") {
          order.push("navigate");
          navigated = true;
          // 历史恢复已在毫秒级完成：'complete' 事件此刻就发（监听器必须已在场）。
          completeListener?.(7, { status: "complete" });
          return { frameId: 2 };
        }
        return {};
      }),
    };

    vi.resetModules();
    const page = await import("../src/handlers/page.js");
    const handlers: Record<string, Handler> = {};
    const router = {
      registerAll: (map: Record<string, Handler>) => Object.assign(handlers, map),
    } as any;
    page.registerPageHandlers(router, debuggerMgr as any);

    return { handlers, order };
  }

  it("back：监听器在导航命令之前挂上，且毫秒级 'complete' 被接住（不降级）", async () => {
    const { handlers, order } = await setup();
    const t0 = Date.now();
    const res = (await handlers["page.back"]({}, 7)) as { url?: string; degraded?: boolean };

    expect(order.indexOf("addListener")).toBeLessThan(order.indexOf("navigate"));
    // 'complete' 被接住 ⇒ 不是降级返回。
    expect(res.degraded).toBeUndefined();
    expect(res.url).toBe("http://x/new");
    // 没干等 25s。
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("forward：监听器同样在导航命令之前挂上", async () => {
    // currentIndex=0 ⇒ forward 的目标项是 entries[1]（合法）。
    const { handlers, order } = await setup({ currentIndex: 0 });
    const res = (await handlers["page.forward"]({}, 7)) as { degraded?: boolean };
    expect(order.indexOf("addListener")).toBeLessThan(order.indexOf("navigate"));
    expect(res.degraded).toBeUndefined();
  });

  it("导航被拒（索引越界）时抛 NO_EFFECT，且不留下未处理的 reject", async () => {
    const { handlers } = await setup({
      currentIndex: 0,
      entries: [{ id: 1, url: "http://x/old" }],
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(handlers["page.back"]({}, 7)).rejects.toThrow(/oldest entry/i);
      // 等一个 tick，让悬空 promise（若有）有机会触发未处理拒绝。
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
