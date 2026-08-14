import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode, MouseActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerMouseHandlers } from "../src/handlers/mouse.js";
import { hitProbePageSide, type HitProbe } from "../src/lib/hit-probe.js";

/**
 * 命中探测和 iframe offset 共用 chrome.scripting.executeScript —— 一律返回同一个
 * 对象等于没测（探测拿到 offset 也会被形状守卫吞掉，看不出接没接线）。按注入体
 * 身份分流，让探测的返回值真的来自本测试。
 */
function scriptingMock(probe: HitProbe | Error | null, offset: unknown = null) {
  return {
    executeScript: vi.fn().mockImplementation(async (o: any) => {
      if (o.func === hitProbePageSide) {
        if (probe instanceof Error) throw probe;
        return [{ result: probe }];
      }
      return [{ result: offset }];
    }),
  };
}

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

interface MockDebuggerOpts {
  onSend?: (tabId: number, method: string, params: any) => void;
}

function makeDebuggerMock(opts: MockDebuggerOpts = {}) {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi
      .fn()
      .mockImplementation(async (tabId: number, method: string, params: any) => {
        opts.onSend?.(tabId, method, params);
      }),
  } as any;
}

describe("mouse handlers", () => {
  let router: ActionRouter;
  let sent: Array<{ tabId: number; method: string; params: any }>;
  let debuggerMgr: any;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    sent = [];
    debuggerMgr = makeDebuggerMock({
      onSend: (tabId, method, params) => sent.push({ tabId, method, params }),
    });

    // 默认 chrome stub（无 frame，getIframeOffset 直接返回 {0,0}）
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 42 }]),
      },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
        ]),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: null }]),
      },
    });

    registerMouseHandlers(router, debuggerMgr);
  });

  it("CLICK without frameId uses raw viewport coords", async () => {
    const resp = await router.dispatch(
      mkReq("mouse.click", { x: 100, y: 200 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({
      success: true,
      x: 100,
      y: 200,
      coordSpace: "viewport",
      frameId: null,
      offsetApplied: { x: 0, y: 0 },
    });
    const dispatchedXs = sent.map((e) => e.params.x);
    const dispatchedYs = sent.map((e) => e.params.y);
    expect(dispatchedXs).toEqual([100, 100, 100]);
    expect(dispatchedYs).toEqual([200, 200, 200]);
  });

  it("CLICK with frameId auto-applies iframe offset", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
          { frameId: 65, parentFrameId: 0, url: "https://a/child" },
        ]),
      },
      scripting: {
        executeScript: vi
          .fn()
          .mockResolvedValue([{ result: { x: 60, y: 0 } }]),
      },
    });

    const resp = await router.dispatch(
      mkReq("mouse.click", { x: 341, y: 359, frameId: 65 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({
      success: true,
      x: 401,
      y: 359,
      coordSpace: "frame",
      frameId: 65,
      offsetApplied: { x: 60, y: 0 },
    });
    const dispatchedXs = sent.map((e) => e.params.x);
    expect(dispatchedXs).toEqual([401, 401, 401]);
  });

  it("CLICK with coordSpace=viewport ignores frameId offset", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
          { frameId: 65, parentFrameId: 0, url: "https://a/child" },
        ]),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { x: 60, y: 0 } }]),
      },
    });

    const resp = await router.dispatch(
      mkReq(
        "mouse.click",
        { x: 100, y: 100, frameId: 65, coordSpace: "viewport" },
        42,
      ),
    );
    expect(resp.result).toMatchObject({
      x: 100,
      y: 100,
      coordSpace: "viewport",
      offsetApplied: { x: 0, y: 0 },
    });
  });

  it("CLICK returns INVALID_PARAMS when x/y missing", async () => {
    const resp = await router.dispatch(mkReq("mouse.click", {}, 42));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  it("DOUBLE_CLICK dispatches two press-release pairs at offset coords", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
          { frameId: 65, parentFrameId: 0, url: "https://a/child" },
        ]),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { x: 60, y: 0 } }]),
      },
    });

    const resp = await router.dispatch(
      mkReq("mouse.doubleClick", { x: 10, y: 20, frameId: 65 }, 42),
    );
    expect(resp.error).toBeUndefined();
    // mouseMoved + 2× (mousePressed + mouseReleased) = 5 CDP sends
    expect(sent.length).toBe(5);
    for (const e of sent) {
      expect(e.params.x).toBe(70);
      expect(e.params.y).toBe(20);
    }
    expect(sent.map((e) => e.params.clickCount)).toEqual([
      1,
      1,
      1,
      2,
      2,
    ]);
  });

  it("DRAG 中间 mouseMoved 携带 buttons:1(否则 HTML5 DnD/拖拽库不 engage)", async () => {
    // 现象:CDP dispatchMouseEvent 的 mouseMoved 不带 buttons 掩码,被当 hover
    // 而非 drag-move → dragstart/dragover/drop 永不触发,success:true 却什么也没拖
    // (2026-06-04 多 agent 审计 #3,LIVE 确认 drop/dragstart=0/0)。
    const resp = await router.dispatch(
      mkReq(
        "mouse.drag",
        { fromX: 0, fromY: 0, toX: 100, toY: 0, steps: 4 },
        42,
      ),
    );
    expect(resp.error).toBeUndefined();

    const moves = sent.filter((e) => e.params.type === "mouseMoved");
    const press = sent.find((e) => e.params.type === "mousePressed");
    const release = sent.find((e) => e.params.type === "mouseReleased");

    // 起点 hover move(buttons=0)+ steps 次 drag-move(buttons=1)。
    // 第一条是 press 前的 hover-to-start,其余 move 都在按住状态。
    const dragMoves = moves.slice(1);
    expect(dragMoves.length).toBe(4);
    for (const m of dragMoves) {
      expect(m.params.buttons).toBe(1);
    }
    // press 时左键已按下(buttons=1),release 时已松开(buttons=0)。
    expect(press?.params.buttons).toBe(1);
    expect(release?.params.buttons).toBe(0);
  });

  it("MOVE applies offset and dispatches a single mouseMoved", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
          { frameId: 65, parentFrameId: 0, url: "https://a/child" },
        ]),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: { x: 60, y: 0 } }]),
      },
    });

    const resp = await router.dispatch(
      mkReq("mouse.move", { x: 5, y: 5, frameId: 65 }, 42),
    );
    expect(resp.error).toBeUndefined();
    expect(sent.length).toBe(1);
    expect(sent[0].params).toMatchObject({ type: "mouseMoved", x: 65, y: 5 });
  });

  it("unresolvable iframe offset falls back to zero (still dispatches at raw frame coords)", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
          { frameId: 65, parentFrameId: 0, url: "https://a/child" },
        ]),
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{ result: null }]),
      },
    });

    const resp = await router.dispatch(
      mkReq("mouse.click", { x: 100, y: 100, frameId: 65 }, 42),
    );
    expect(resp.result).toMatchObject({
      x: 100,
      y: 100,
      offsetApplied: { x: 0, y: 0 },
    });
  });
});

// CDP 命中测试是浏览器做的:事件落在该点最上层的元素上。dispatchMouseEvent 不抛错
// 就返回 success:true,于是「点在浮层上」与「点中目标」结果完全一样(2026-08-14 日志:
// 同一坐标被反复重点,页面自查显示 48 个按钮 32 个被插入面板压住)。
describe("mouse.click 命中自证", () => {
  let router: ActionRouter;
  let sent: Array<{ tabId: number; method: string; params: any }>;

  function setup(scripting: unknown) {
    router = new ActionRouter();
    sent = [];
    const debuggerMgr = makeDebuggerMock({
      onSend: (tabId, method, params) => sent.push({ tabId, method, params }),
    });
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://a/" },
        ]),
      },
      scripting,
    });
    registerMouseHandlers(router, debuggerMgr);
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("把实际命中的元素随结果带回，调用方才看得出点在浮层上", async () => {
    setup(scriptingMock({ ok: true, el: "DIV.insert-pane", text: "插入面板" }));
    const resp = await router.dispatch(mkReq("mouse.click", { x: 714, y: 755 }, 42));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({
      success: true,
      hit: { ok: true, el: "DIV.insert-pane", text: "插入面板" },
    });
  });

  it("视口外坐标直接报错，且一个 CDP 事件都不派发", async () => {
    setup(scriptingMock({ ok: false, reason: "OUT_OF_VIEWPORT", viewport: { w: 1920, h: 1080 } }));
    const resp = await router.dispatch(mkReq("mouse.click", { x: 922, y: -3974 }, 42));
    expect(resp.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
    expect(resp.error?.message).toContain("1920x1080");
    expect(resp.error?.hint).toMatch(/scroll/i);
    // 报错却仍旧白点一次是最坏结果:调用方看到错误,页面上却已经发生了点击
    expect(sent).toEqual([]);
  });

  it("视口内没有元素时如实报 NO_ELEMENT，但照常派发", async () => {
    setup(scriptingMock({ ok: false, reason: "NO_ELEMENT" }));
    const resp = await router.dispatch(mkReq("mouse.click", { x: 10, y: 10 }, 42));
    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ hit: { ok: false, reason: "NO_ELEMENT" } });
    expect(sent.length).toBe(3);
  });

  it("探测不可用时优雅降级 —— 自证是增益，不能让它挡住本来能派发的点击", async () => {
    setup(scriptingMock(new Error("Cannot access a chrome:// URL")));
    const resp = await router.dispatch(mkReq("mouse.click", { x: 10, y: 10 }, 42));
    expect(resp.error).toBeUndefined();
    expect(resp.result).not.toHaveProperty("hit");
    expect(sent.length).toBe(3);
  });

  it("doubleClick 走同一条自证路径", async () => {
    setup(scriptingMock({ ok: true, el: "TD.cell" }));
    const resp = await router.dispatch(mkReq("mouse.doubleClick", { x: 10, y: 10 }, 42));
    expect(resp.result).toMatchObject({ hit: { el: "TD.cell" } });
    expect(sent.length).toBe(5);
  });
});

// 类型保护：MouseActions 枚举值稳定
describe("MouseActions constants", () => {
  it("matches expected action strings", () => {
    expect(MouseActions.CLICK).toBe("mouse.click");
    expect(MouseActions.DOUBLE_CLICK).toBe("mouse.doubleClick");
    expect(MouseActions.MOVE).toBe("mouse.move");
  });
});
