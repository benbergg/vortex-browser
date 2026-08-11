// observe 跨 frame 扫描降级(2026-08-11 CC transcript 日志实证)。
//
// 现象:128 次真实 observe 中 5 次卡满 30s 传输超时,报 "no response for
// observe.snapshot after 30000ms" 丑错,入参全是 frames=all-permitted / scope=full。
//
// 根因:page-side 单 frame 内部有时间预算(__timeBudgetHit → truncated),但跨 frame
// 是**串行 for 循环且无预算**,scanOneFrame 的 executeScript 在坏 tab 态永不 settle
// (与 PROBE_TIMEOUT_MS 同族病),一个 frame 卡住即拖死整次 observe。
//
// 注:actionability-probe-timeout.test.ts 的注释断言「observe 走裸 executeScript({func})
// 无门故健康」——本轮日志证伪了该假设。
//
// 契约(乙方案):有货就交货并标明缺口,没货就诚实报错。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers, frameScanTimeout } from "../src/handlers/observe.js";

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId?: number): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1", ...(tabId != null ? { tabId } : {}) };
}

type FrameRow = { frameId: number; parentFrameId: number; url: string };

function mkPage(elementCount: number) {
  return {
    url: "https://x/",
    title: "T",
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 800 },
    elements: Array.from({ length: elementCount }, (_, i) => ({
      index: i,
      tag: "button",
      role: "button",
      name: `el${i}`,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      visible: true,
      inViewport: true,
      attrs: {},
      _sel: `button[data-i="${i}"]`,
    })),
    candidateCount: elementCount,
    truncated: false,
  };
}

/**
 * wedgedFrames 里的 frame 其 scan executeScript 永不 settle(模拟坏 tab 态)。
 * slowFrames 模拟「慢但最终会返回」——live(gamma.app srcdoc iframe)证明这个中间态
 * 才是真实主因,而永不 settle 是极端情形。
 */
function stubChrome(opts: {
  frames: FrameRow[];
  scanResults: Record<number, ReturnType<typeof mkPage> | null>;
  wedgedFrames?: number[];
  slowFrames?: Record<number, number>;
}) {
  const wedged = new Set(opts.wedgedFrames ?? []);
  const slow = opts.slowFrames ?? {};
  const executeScript = vi.fn(({ target, args }: { target: { frameIds?: number[] }; args?: unknown[] }) => {
    const frameId = target.frameIds?.[0] ?? 0;
    const childUrl = args?.[0];
    // getIframeOffset 调用:args[0] 是 URL 字符串,始终正常返回
    if (typeof childUrl === "string" && childUrl.startsWith("http")) {
      return Promise.resolve([{ result: { x: 0, y: 0 } }]);
    }
    if (wedged.has(frameId)) return new Promise(() => {}); // 永不 settle
    if (slow[frameId] != null) {
      return new Promise((resolve) =>
        setTimeout(() => resolve([{ result: opts.scanResults[frameId] ?? null }]), slow[frameId]),
      );
    }
    return Promise.resolve([{ result: opts.scanResults[frameId] ?? null }]);
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { getAllFrames: vi.fn().mockResolvedValue(opts.frames) },
    scripting: { executeScript },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
  });
}

// 阈值来自真实日志(2026-08-11,123 次成功 observe):P90=9.3s、P99=25.6s、MAX=28s,
// 13% 的成功调用超过 8s 且多为**单 frame**。任何固定小上限都会把这些正常调用误判
// 成降级 —— 故单 frame 场景必须能用满剩余预算。
describe("frameScanTimeout 阈值(data-driven,防回退到固定上限)", () => {
  it("单 frame:用满剩余预算,不被下限截断(否则误伤 13% 慢站调用)", () => {
    expect(frameScanTimeout(25_000, 1)).toBe(25_000);
  });

  it("多 frame:按剩余 frame 数均摊,保证后面的 frame 还有机会", () => {
    expect(frameScanTimeout(25_000, 2)).toBe(12_500);
    expect(frameScanTimeout(24_000, 3)).toBe(8_000);
  });

  it("frame 很多时不低于下限(宁可后几个被预算跳过,也不给每个都设过短的界)", () => {
    expect(frameScanTimeout(20_000, 10)).toBe(8_000);
  });

  it("剩余预算低于下限时,以剩余预算为准(绝不超发)", () => {
    expect(frameScanTimeout(3_000, 1)).toBe(3_000);
    expect(frameScanTimeout(3_000, 5)).toBe(3_000);
  });
});

describe("observe 跨 frame 扫描降级", () => {
  let router: ActionRouter;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    registerObserveHandlers(router);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("单个 frame 的 executeScript 永不 settle 时,observe 仍在预算内返回(不挂到 30s 传输超时)", async () => {
    vi.useFakeTimers();
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/wedged" },
        { frameId: 191, parentFrameId: 0, url: "https://x/ok" },
      ],
      scanResults: { 0: mkPage(5), 191: mkPage(7) },
      wedgedFrames: [190],
    });

    let settled = false;
    const p = router
      .dispatch(mkReq("observe.snapshot", { frames: "all-permitted" }, 42))
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.advanceTimersByTimeAsync(29_000);

    expect(settled).toBe(true);
  });

  it("卡死 frame 被标记未扫描,其余 frame 的元素照常返回", async () => {
    vi.useFakeTimers();
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/wedged" },
        { frameId: 191, parentFrameId: 0, url: "https://x/ok" },
      ],
      scanResults: { 0: mkPage(5), 191: mkPage(7) },
      wedgedFrames: [190],
    });

    const p = router.dispatch(mkReq("observe.snapshot", { frames: "all-permitted" }, 42));
    await vi.advanceTimersByTimeAsync(29_000);
    const resp = await p;
    const r = resp.result as {
      elements: unknown[];
      frames: Array<{ frameId: number; scanned: boolean }>;
      meta: { scannedFrames: number; frameCount: number; degraded?: { timedOutFrames: number[] } };
    };

    expect(r.elements.length).toBe(12); // 5 + 7,卡死的 190 贡献 0
    expect(r.frames.find((f) => f.frameId === 190)?.scanned).toBe(false);
    // scannedFrames / frameCount 复用已有 meta 字段,degraded 只承载新增的降级归因
    expect(r.meta.scannedFrames).toBe(2);
    expect(r.meta.frameCount).toBe(3);
    expect(r.meta.degraded).toMatchObject({ timedOutFrames: [190] });
  });

  it("全部 frame 都卡死(零元素)时抛 TIMEOUT,而非返回空的 success", async () => {
    vi.useFakeTimers();
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/wedged" },
      ],
      scanResults: {},
      wedgedFrames: [0, 190],
    });

    const p = router.dispatch(mkReq("observe.snapshot", { frames: "all-permitted" }, 42));
    await vi.advanceTimersByTimeAsync(29_000);
    const resp = await p;

    expect(resp.error?.code).toBe("TIMEOUT");
  });

  // live 复现(2026-08-11 gamma.app):1 个 srcdoc iframe,filter=all + scope=full 下
  // 该 frame 独占几乎全部剩余预算,扫描阶段刚好吃满 → AX overlay / 组装 / marker 清理
  // 全在预算之外,叠加后越过 30s 传输线,调用方仍见 "no response" 丑错。
  //
  // 契约:扫描阶段必须给后续阶段留出余量,整个 handler 有界返回。
  it("慢 frame 吃满扫描预算时,整个 observe 仍显著早于 30s 传输超时返回", async () => {
    vi.useFakeTimers();
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/srcdoc" },
      ],
      scanResults: { 0: mkPage(5), 190: mkPage(3) },
      slowFrames: { 190: 60_000 }, // 该 frame 慢到远超任何单帧配额
    });

    let settled = false;
    const p = router
      .dispatch(mkReq("observe.snapshot", { frames: "all-permitted" }, 42))
      .then((r) => {
        settled = true;
        return r;
      });
    // 传输层默认 30s,而 AX overlay / 组装 / marker 清理都在扫描预算之外(单测里它们
    // 耗时为 0,真实环境是好几秒)。扫描必须在 21s 内收手,才有余量留给后续阶段。
    await vi.advanceTimersByTimeAsync(21_000);

    expect(settled).toBe(true);
  });

  // live 实测(2026-08-11 gamma.app):扩展重载后首次调用,CDP debugger 冷附加使
  // markListenerElements 超过 8s 被界掐断 → 整页 [listener] 标记全部丢失,而输出里
  // 毫无提示。T3 discovery 的召回价值(vanilla/jQuery 裸 div 按钮)静默归零 = 典型
  // silent degradation,必须上报。
  it("listener discovery 超时时上报 degraded,不静默吞掉召回损失", async () => {
    vi.useFakeTimers();
    stubChrome({
      frames: [{ frameId: 0, parentFrameId: -1, url: "https://x/" }],
      scanResults: { 0: mkPage(5) },
    });
    // debuggerMgr 存在但 CDP 永不响应(冷附加卡住)
    const hangingDbg = {
      attach: () => new Promise(() => {}),
      enableDomain: () => new Promise(() => {}),
      sendCommand: () => new Promise(() => {}),
    } as any;
    const r2 = new ActionRouter();
    registerObserveHandlers(r2, hangingDbg);

    const p = r2.dispatch(mkReq("observe.snapshot", {}, 42));
    await vi.advanceTimersByTimeAsync(21_000);
    const resp = await p;
    const r = resp.result as {
      elements: unknown[];
      meta: { degraded?: { listenerDiscovery?: string } };
    };

    expect(r.elements.length).toBe(5); // 扫描本身不受影响
    expect(r.meta.degraded?.listenerDiscovery).toBe("timeout");
  });

  it("无 frame 卡死时行为不变(不引入降级信息)", async () => {
    stubChrome({
      frames: [
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 190, parentFrameId: 0, url: "https://x/ok" },
      ],
      scanResults: { 0: mkPage(5), 190: mkPage(7) },
    });

    const resp = await router.dispatch(mkReq("observe.snapshot", { frames: "all-permitted" }, 42));
    const r = resp.result as { elements: unknown[]; meta: { degraded?: unknown } };

    expect(r.elements.length).toBe(12);
    expect(r.meta.degraded).toBeUndefined();
  });
});
