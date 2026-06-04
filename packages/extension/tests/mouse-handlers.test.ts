import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@bytenew/vortex-shared";
import { VtxErrorCode, MouseActions } from "@bytenew/vortex-shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerMouseHandlers } from "../src/handlers/mouse.js";

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

// 类型保护：MouseActions 枚举值稳定
describe("MouseActions constants", () => {
  it("matches expected action strings", () => {
    expect(MouseActions.CLICK).toBe("mouse.click");
    expect(MouseActions.DOUBLE_CLICK).toBe("mouse.doubleClick");
    expect(MouseActions.MOVE).toBe("mouse.move");
  });
});
