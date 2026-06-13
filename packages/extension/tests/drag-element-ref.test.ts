/**
 * TDD: vortex_drag 元素级 DnD handler 测试。
 *
 * 测试覆盖:
 *   1. action 注册 (MouseActions.DRAG_ELEMENT 已在 router)
 *   2. ref→getBoundingClientRect 中心坐标转换
 *   3. CDP trusted pointer 序列 (hover→press→steps-move→release)
 *   4. steps 默认 10
 *   5. 返回结构 {success, from, to, steps}
 *   6. ref 失效/不可见 → 错误
 *
 * 注：waitActionable 依赖 chrome.scripting.executeScript 做 page-side 探针，
 * 这里通过 vi.mock 把 page-side-loader stub 掉，使 waitActionable
 * 注入调用直接返回 { ok: true, rect: {...} }，聚焦测试 CDP 序列。
 *
 * 关联 memory: vortex_0006_bangniu_dogfood_attribution
 * 教训: 锚点坐标用 getBoundingClientRect 非 transform。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// page-side-loader stub：跳过真实 chrome.scripting.executeScript 注入逻辑
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

import { ActionRouter } from "../src/lib/router.js";
import { registerMouseHandlers } from "../src/handlers/mouse.js";
import { MouseActions, VtxErrorCode } from "@vortex-browser/shared";

// ──── helpers ──────────────────────────────────────────────────────────────

interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId: number;
}

function mkReq(tool: string, args: Record<string, unknown> = {}, tabId = 42): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-drag", tabId };
}

/**
 * 构造一个 chrome.scripting.executeScript mock，按调用顺序返回：
 * - 奇数次调用 → actionability probe (ok=true) 或 bbox 查询
 * - 根据 callIndex 分流:
 *   call 1 = start actionability probe (ok=true, rect)
 *   call 2 = start stable probe (ok=true)
 *   call 3 = end actionability probe (ok=true, rect)
 *   call 4 = end stable probe (ok=true)
 *   call 5 = start getBbox
 *   call 6 = end getBbox
 *
 * 简化版：所有 executeScript 调用都返回 ok:true 且携带 bbox/actionability 数据，
 * handler 只取自己关心的字段。
 */
function buildExecuteScriptMock(
  startBbox: { left: number; top: number; width: number; height: number },
  endBbox: { left: number; top: number; width: number; height: number },
) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    callCount++;
    // actionability probe 需要 ok + rect; stable probe 只需 {ok:true}
    // getBbox 需要 ok + cx/cy
    // 为简化，所有调用返回兼容 struct：handler 只读自己字段
    const isGetBbox = callCount > 4; // actionability 前 4 次 probe
    if (isGetBbox) {
      const bbox = callCount % 2 === 1 ? startBbox : endBbox;
      return Promise.resolve([{
        result: {
          ok: true,
          cx: bbox.left + bbox.width / 2,
          cy: bbox.top + bbox.height / 2,
        },
      }]);
    }
    // actionability probe: 返回 ok:true + 兼容 rect 字段（probe 只读 ok）
    return Promise.resolve([{ result: { ok: true, rect: { x: 0, y: 0, w: 10, h: 10 } } }]);
  });
}

// ──── setup ───────────────────────────────────────────────────────────────

describe("vortex_drag: 元素级 DnD handler", () => {
  let router: ActionRouter;
  let sendCommand: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;

  const startBbox = { left: 100, top: 200, width: 40, height: 20 };  // 中心 (120, 210)
  const endBbox   = { left: 300, top: 400, width: 60, height: 30 };  // 中心 (330, 415)

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    sendCommand = vi.fn().mockResolvedValue({});
    executeScript = buildExecuteScriptMock(startBbox, endBbox);

    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      debugger: {
        attach: vi.fn().mockResolvedValue(undefined),
        sendCommand,
        onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
        onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
      scripting: { executeScript },
    });

    registerMouseHandlers(router, {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand,
      onEvent: vi.fn(),
      offEvent: vi.fn(),
      isAttached: vi.fn().mockReturnValue(false),
      getAttachedTabs: vi.fn().mockReturnValue([]),
      enableDomain: vi.fn().mockResolvedValue(undefined),
      disableDomain: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  afterEach(() => vi.unstubAllGlobals());

  // ── 工具注册 ──────────────────────────────────────────────────────────────

  it("mouse.dragElement action 已在 router 中注册", () => {
    const actions = router.getRegisteredActions();
    expect(actions).toContain(MouseActions.DRAG_ELEMENT);
  });

  // ── ref→中心坐标转换 ──────────────────────────────────────────────────────

  it("两 ref 各取 getBoundingClientRect 中心点，返回 from/to 正确", async () => {
    // start: 中心 (120, 210), end: 中心 (330, 415)
    const r = await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: "[data-start]", endSelector: "[data-end]", steps: 5 }),
    ) as { result?: { success?: boolean; from?: { x: number; y: number }; to?: { x: number; y: number } } };

    expect(r.result?.success).toBe(true);
    expect(r.result?.from).toEqual({ x: 120, y: 210 });
    expect(r.result?.to).toEqual({ x: 330, y: 415 });
  });

  // ── CDP trusted pointer 序列 ──────────────────────────────────────────────

  it("CDP 序列: mouseMoved(hover)→mousePressed(buttons=1)→步进 mouseMoved(buttons=1)→mouseReleased(buttons=0)", async () => {
    const smallStart = { left: 0, top: 0, width: 20, height: 20 };    // 中心 (10, 10)
    const smallEnd   = { left: 100, top: 0, width: 20, height: 20 };  // 中心 (110, 10)
    executeScript = buildExecuteScriptMock(smallStart, smallEnd);
    (chrome.scripting as any).executeScript = executeScript;

    await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: "#a", endSelector: "#b", steps: 3 }),
    );

    // 提取所有 Input.dispatchMouseEvent 调用
    const mouseEvents = sendCommand.mock.calls
      .filter((c: unknown[]) => c[1] === "Input.dispatchMouseEvent")
      .map((c: unknown[]) => c[2] as Record<string, unknown>);

    // 第 1 条: hover 到 start 中心（buttons=0 或省略）
    expect(mouseEvents[0]).toMatchObject({ type: "mouseMoved", x: 10, y: 10 });
    expect((mouseEvents[0].buttons as number | undefined) ?? 0).toBe(0);

    // 第 2 条: mousePressed at start (left, buttons=1)
    expect(mouseEvents[1]).toMatchObject({ type: "mousePressed", x: 10, y: 10, button: "left" });
    expect(mouseEvents[1].buttons).toBe(1);

    // 中间 move 全部带 buttons=1 (drag-move)
    const dragMoves = mouseEvents.slice(2, -1);
    expect(dragMoves.length).toBe(3); // steps=3
    for (const mv of dragMoves) {
      expect(mv).toMatchObject({ type: "mouseMoved", button: "left" });
      expect(mv.buttons).toBe(1);
    }

    // 最后一条: mouseReleased at end (buttons=0)
    const last = mouseEvents[mouseEvents.length - 1];
    expect(last).toMatchObject({ type: "mouseReleased", x: 110, y: 10, button: "left" });
    expect(last.buttons).toBe(0);
  });

  it("steps 默认 10 → 产生 10 条 drag-move mouseMoved (buttons=1)", async () => {
    await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: "#a", endSelector: "#b" }),
    );

    const dragMoves = sendCommand.mock.calls
      .filter((c: unknown[]) => {
        const ev = c[2] as Record<string, unknown>;
        return c[1] === "Input.dispatchMouseEvent" && ev.type === "mouseMoved" && ev.buttons === 1;
      });
    expect(dragMoves.length).toBe(10);
  });

  // ── 返回结构 ─────────────────────────────────────────────────────────────

  it("返回 {success, from, to, steps}", async () => {
    const r = await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: ".a", endSelector: ".b", steps: 7 }),
    ) as { result?: Record<string, unknown> };

    expect(r.result?.success).toBe(true);
    expect(r.result?.from).toEqual({ x: 120, y: 210 });
    expect(r.result?.to).toEqual({ x: 330, y: 415 });
    expect(r.result?.steps).toBe(7);
  });

  // ── ref 失效/不可见 → 错误 ────────────────────────────────────────────────

  it("start element getBoundingClientRect 零尺寸(不可见) → 错误码 NOT_VISIBLE", async () => {
    // getBbox 调用时返回 ok=false + reason=NOT_VISIBLE
    let callCount = 0;
    (chrome.scripting as any).executeScript = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 4) {
        // actionability probe: ok=true (门放行)
        return Promise.resolve([{ result: { ok: true, rect: { x: 0, y: 0, w: 10, h: 10 } } }]);
      }
      // getBbox: 不可见
      return Promise.resolve([{ result: { ok: false, reason: "NOT_VISIBLE" } }]);
    });

    const r = await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: "#gone", endSelector: "#end" }),
    ) as { error?: { code?: string }; result?: unknown };

    expect(r.error).toBeDefined();
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(VtxErrorCode.NOT_VISIBLE);
  });

  it("executeScript 抛出 → 映射为错误（不 resolve success）", async () => {
    (chrome.scripting as any).executeScript = vi.fn().mockRejectedValue(
      new Error("No frame with id: 99"),
    );

    const r = await router.dispatch(
      mkReq(MouseActions.DRAG_ELEMENT, { startSelector: "#gone", endSelector: "#end" }),
    ) as { error?: { code?: string }; result?: unknown };

    expect(r.error).toBeDefined();
    expect(r.result).toBeUndefined();
  });
});
