/**
 * revealByHover 编排层契约测试。
 *
 * 契约:目标被父级 :hover 隐藏时,沿祖先链由近及远地真鼠标 hover,直到目标显现。
 * 关键性质:
 *   - 只在「目标已定位但不可见」时才有副作用(由调用方在 NOT_VISIBLE 时触发)
 *   - 候选与尝试次数有界(不得无限 hover)
 *   - 命中即停,产出可核对的 trigger 证据
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pageQuery = vi.fn();
vi.mock("../src/adapter/native.js", () => ({
  pageQuery: (...a: unknown[]) => pageQuery(...a),
  PageQueryTimeoutError: class PageQueryTimeoutError extends Error {},
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn(async () => undefined),
}));
const getIframeOffset = vi.fn(async () => ({ x: 0, y: 0 }));
vi.mock("../src/lib/iframe-offset.js", () => ({
  getIframeOffset: (...a: unknown[]) => getIframeOffset(...a),
}));

const { revealByHover } = await import("../src/action/reveal.js");

type Candidate = {
  depth: number;
  path: number[];
  tag: string;
  id: string;
  cls: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  inViewport: boolean;
};

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    depth: 1,
    path: [0],
    tag: "div",
    id: "",
    cls: "row",
    text: "",
    x: 100,
    y: 50,
    w: 200,
    h: 40,
    inViewport: true,
    ...over,
  };
}

/** 模拟页面：collectCandidates/measureCandidate/isVisible/scrollIntoView 由测试控制 */
function installPage(opts: {
  candidates: Candidate[];
  visibleAfter: number; // 第几次 isVisible 调用返回 true(-1 = 永远不可见)
  measured?: Array<{ x: number; y: number; w: number; h: number; inViewport: boolean } | null>;
}) {
  const calls = { collect: 0, isVisible: 0, scroll: 0, measure: 0 };
  (globalThis as any).window = {
    __vortexHoverReveal: {
      collectCandidates: () => {
        calls.collect++;
        // 滚动后重新采集：模拟“已滚进视口”（真实页面此时坐标也会变）
        if (calls.scroll > 0) {
          return opts.candidates.map((c) => ({ ...c, inViewport: true }));
        }
        return opts.candidates;
      },
      measureCandidate: () => {
        const m = opts.measured ? opts.measured[calls.measure] : undefined;
        const c = opts.candidates[calls.measure];
        calls.measure++;
        if (m !== undefined) return m;
        // 默认：重测结果与采集时的坐标一致（真实页面两者可能不同）
        if (!c) return null;
        return { x: c.x, y: c.y, w: c.w, h: c.h, inViewport: calls.scroll > 0 ? true : c.inViewport };
      },
      isVisible: () => {
        calls.isVisible++;
        // visibleAfter <= 0 表示「永远不可见」
        return opts.visibleAfter > 0 && calls.isVisible >= opts.visibleAfter;
      },
      scrollIntoView: () => {
        calls.scroll++;
        return true;
      },
      afterPaint: async () => undefined,
    },
  };
  pageQuery.mockImplementation(async (_t: unknown, _f: unknown, fn: (...a: any[]) => unknown, args: unknown[] = []) =>
    fn(...(args as unknown[])),
  );
  return calls;
}

function fakeDebugger() {
  const sent: Array<{ type: string; x: number; y: number }> = [];
  return {
    sent,
    mgr: {
      attach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_t: unknown, _cmd: string, params: any) => {
        sent.push(params);
        return undefined;
      }),
    } as any,
  };
}

describe("revealByHover：hover 祖先以揭示被隐藏的目标", () => {
  beforeEach(() => {
    pageQuery.mockReset();
    getIframeOffset.mockReset();
    getIframeOffset.mockResolvedValue({ x: 0, y: 0 });
  });

  it("第一个候选即可揭示时：只 hover 一次并产出 trigger 证据", async () => {
    installPage({ candidates: [cand({ id: "row" })], visibleAfter: 1 });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.trigger?.id).toBe("row");
    // 真鼠标移动(不是合成事件)——CSS :hover 只认它
    expect(dbg.mgr.sendCommand).toHaveBeenCalledTimes(1);
    const cmd = dbg.mgr.sendCommand.mock.calls[0];
    expect(cmd[1]).toBe("Input.dispatchMouseEvent");
    expect((cmd[2] as any).type).toBe("mouseMoved");
    expect((cmd[2] as any).x).toBe(100);
    expect((cmd[2] as any).y).toBe(50);
  });

  it("前一候选不揭示时继续尝试下一个（由近及远）", async () => {
    installPage({
      candidates: [cand({ id: "a", x: 10, y: 10 }), cand({ id: "b", x: 20, y: 20 })],
      visibleAfter: 2,
    });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.trigger?.id).toBe("b");
    expect(dbg.sent.map((s) => s.x)).toEqual([10, 20]);
  });

  it("全部候选都不揭示时：revealed=false，尝试次数有界", async () => {
    const many = Array.from({ length: 30 }, (_, i) => cand({ id: `c${i}` }));
    installPage({ candidates: many, visibleAfter: -1 });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(false);
    expect(r.attempts).toBeLessThanOrEqual(6);
    expect(dbg.sent.length).toBeLessThanOrEqual(6);
  });

  it("没有候选时：直接返回未揭示，不做任何鼠标移动", async () => {
    installPage({ candidates: [], visibleAfter: 1 });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(false);
    expect(r.attempts).toBe(0);
    expect(dbg.sent).toHaveLength(0);
  });

  it("候选全在视口外时：先滚进视口再 hover", async () => {
    const calls = installPage({
      candidates: [cand({ id: "row", inViewport: false, x: 5000, y: 5000 })],
      visibleAfter: 1,
    });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(calls.scroll).toBeGreaterThan(0);
    expect(r.revealed).toBe(true);
  });

  it("页面侧异常（注入失败/查询抛错）不抛出：返回未揭示", async () => {
    pageQuery.mockRejectedValue(new Error("boom"));
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(false);
    expect(r.attempts).toBe(0);
    expect(r.reason).toBe("error");
  });

  it("deadline 已过：不再派发任何鼠标移动", async () => {
    installPage({ candidates: [cand()], visibleAfter: 1 });
    const dbg = fakeDebugger();

    const r = await revealByHover({
      tabId: 7,
      frameId: undefined,
      selector: "#ctl",
      debuggerMgr: dbg.mgr,
      deadline: Date.now() - 1,
    });

    expect(r.revealed).toBe(false);
    expect(r.reason).toBe("deadline");
    expect(dbg.sent).toHaveLength(0);
  });

  it("非顶层 frame 且偏移不可得（{0,0}）：失败关闭，不派发鼠标移动", async () => {
    installPage({ candidates: [cand()], visibleAfter: 1 });
    getIframeOffset.mockResolvedValue({ x: 0, y: 0 });
    const dbg = fakeDebugger();

    const r = await revealByHover({
      tabId: 7,
      frameId: 3, // 非顶层
      selector: "#ctl",
      debuggerMgr: dbg.mgr,
    });

    expect(r.revealed).toBe(false);
    expect(r.reason).toBe("iframe-offset-unknown");
    expect(dbg.sent).toHaveLength(0);
  });

  it("非顶层 frame 且偏移可靠：正常揭示，坐标加上偏移", async () => {
    installPage({ candidates: [cand({ x: 10, y: 20 })], visibleAfter: 1 });
    getIframeOffset.mockResolvedValue({ x: 100, y: 200 });
    const dbg = fakeDebugger();

    const r = await revealByHover({
      tabId: 7,
      frameId: 3,
      selector: "#ctl",
      debuggerMgr: dbg.mgr,
    });

    expect(r.revealed).toBe(true);
    expect(dbg.sent[0]).toMatchObject({ x: 110, y: 220 });
  });

  it("候选在派发前消失/不可见：跳过该候选（不复用陈旧坐标）", async () => {
    installPage({
      candidates: [cand({ id: "gone" }), cand({ id: "ok" })],
      visibleAfter: 1,
      measured: [null, { x: 30, y: 30, w: 10, h: 10, inViewport: true }],
    });
    const dbg = fakeDebugger();

    const r = await revealByHover({ tabId: 7, frameId: undefined, selector: "#ctl", debuggerMgr: dbg.mgr });

    expect(r.revealed).toBe(true);
    expect(r.trigger?.id).toBe("ok");
    // 第二个候选的坐标来自重测，不是采集时的旧值
    expect(dbg.sent[0]).toMatchObject({ x: 30, y: 30 });
  });
});
