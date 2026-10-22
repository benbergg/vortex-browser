/**
 * auto-wait ↔ reveal 集成契约。
 *
 * 契约:目标「已定位但不可见」(NOT_VISIBLE)时,门禁自动 hover 祖先把它揭示出来再继续;
 * 揭示失败时报错必须给出可执行指引(而不是「调大 timeout」这种死路)。
 * 反向契约:其它失败原因不得触发 hover(reveal 有真实鼠标副作用,必须是失败路径专用)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { VtxError } from "@vortex-browser/shared";

const checkActionability = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...a: unknown[]) => checkActionability(...a),
}));

const revealByHover = vi.fn();
vi.mock("../src/action/reveal.js", () => ({
  revealByHover: (...a: unknown[]) => revealByHover(...a),
}));

const { waitActionable } = await import("../src/action/auto-wait.js");

const fakeDbg = { attach: vi.fn(), sendCommand: vi.fn() } as any;

describe("auto-wait：NOT_VISIBLE 时自动 hover 揭示", () => {
  beforeEach(() => {
    checkActionability.mockReset();
    revealByHover.mockReset();
  });

  it("NOT_VISIBLE → 调 reveal；揭示成功后门禁**重新校验**并回传 revealed 证据", async () => {
    checkActionability
      .mockResolvedValueOnce({ ok: false, reason: "NOT_VISIBLE" })
      .mockResolvedValueOnce({ ok: true, rect: { x: 1, y: 2, w: 3, h: 4 } });
    revealByHover.mockResolvedValue({
      revealed: true,
      trigger: { tag: "div", id: "row", depth: 2 },
      attempts: 1,
      candidates: 1,
    });

    const r = await waitActionable(42, undefined, "#ctl", { timeout: 1000, debuggerMgr: fakeDbg });

    expect(revealByHover).toHaveBeenCalledTimes(1);
    expect(revealByHover.mock.calls[0][0]).toMatchObject({ tabId: 42, selector: "#ctl" });
    // 揭示后必须重新过一次门（可见 ≠ 可点击：还要查遮挡/稳定/启用/仍连接）
    expect(checkActionability).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    expect((r as any).revealed).toMatchObject({ id: "row" });
  });

  it("剩余预算不足时不再揭示（不越出动作 deadline）", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    revealByHover.mockResolvedValue({ revealed: false, attempts: 1, candidates: 1 });
    // timeout 极小 ⇒ 剩余预算 < REVEAL_MIN_BUDGET_MS
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 120, debuggerMgr: fakeDbg });
    } catch {
      /* 预期抛错 */
    }
    expect(revealByHover).not.toHaveBeenCalled();
  });

  it("NOT_VISIBLE 且揭示失败 → 报错给出可执行指引（提到 hover），不再是「调大 timeout」", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    revealByHover.mockResolvedValue({ revealed: false, attempts: 3, candidates: 3 });

    let err: any = null;
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 60, debuggerMgr: fakeDbg });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VtxError);
    const text = `${err.message}\n${err.hint ?? ""}\n${JSON.stringify(err.extra ?? {})}`;
    expect(text.toLowerCase()).toContain("hover");
  });

  it("其它失败原因（OBSCURED / NOT_ATTACHED / DISABLED）不触发 reveal", async () => {
    for (const reason of ["OBSCURED", "NOT_ATTACHED", "DISABLED"]) {
      checkActionability.mockReset();
      revealByHover.mockReset();
      checkActionability.mockResolvedValue({ ok: false, reason });
      try {
        await waitActionable(42, undefined, "#ctl", { timeout: 40, debuggerMgr: fakeDbg });
      } catch {
        /* 预期抛错 */
      }
      expect(revealByHover, `reason=${reason} 不得触发 hover`).not.toHaveBeenCalled();
    }
  });

  it("无 debuggerMgr → 不触发 reveal（无 CDP 条件不做有副作用的 hover）", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 40 });
    } catch {
      /* 预期抛错 */
    }
    expect(revealByHover).not.toHaveBeenCalled();
  });

  it("揭示失败后在间隔内不再试（避免反复动鼠标）", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    const stamps: number[] = [];
    revealByHover.mockImplementation(async () => {
      stamps.push(Date.now());
      return { revealed: false, attempts: 2, candidates: 2 };
    });
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 900, debuggerMgr: fakeDbg });
    } catch {
      /* 预期抛错 */
    }
    // 轮次有界（≤3）
    expect(revealByHover.mock.calls.length).toBeLessThanOrEqual(3);
    // 相邻两轮间隔 ≥250ms（不给页面 settle 时间就重试没有意义）
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(240);
    }
  });

  it("页面刚 settle 时首次揭示可能落空：允许隔一段时间再试一次", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    revealByHover.mockResolvedValue({ revealed: false, attempts: 2, candidates: 2 });
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 900, debuggerMgr: fakeDbg });
    } catch {
      /* 预期抛错 */
    }
    // 首次落空（页面尚未挂载完/样式未生效）后允许再试，但次数有界
    expect(revealByHover.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(revealByHover.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

/**
 * 接线回归:门禁必须拿到 debuggerMgr，否则揭示永远不发生
 * （此前 call site 漏传，auto-wait 里 `options.debuggerMgr` 为空 → 静默跳过揭示）。
 */
describe("门禁接线：CLICK/TYPE/FILL/SELECT 把 debuggerMgr 传进 actionability 门", () => {
  it("CLICK 的门禁 options 含 debuggerMgr", async () => {
    vi.resetModules();
    vi.doMock("../src/action/auto-wait.js", () => ({
      waitActionable: (...a: unknown[]) => waitActionableSpy(...a),
    }));
    vi.doMock("../src/adapter/page-side-loader.js", () => ({
      loadPageSideModule: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../src/adapter/cdp.js", () => ({
      cdpClickElement: vi.fn().mockResolvedValue({ success: true }),
      clickBBox: vi.fn(),
    }));

    const waitActionableSpy = vi.fn().mockResolvedValue({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 } });
    const { ActionRouter } = await import("../src/lib/router.js");
    const { registerDomHandlers } = await import("../src/handlers/dom.js");
    const { DomActions } = await import("@vortex-browser/shared");

    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { success: true } }]) },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const debuggerMgr = { attach: vi.fn(), sendCommand: vi.fn() } as any;
    const router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);

    await router.dispatch({
      type: "tool_request",
      tool: DomActions.CLICK,
      args: { selector: "button#s", useRealMouse: true, tabId: 42 },
      requestId: "r-1",
    } as any);

    expect(waitActionableSpy).toHaveBeenCalled();
    const opts = waitActionableSpy.mock.calls[0][3] as { debuggerMgr?: unknown };
    expect(opts.debuggerMgr).toBe(debuggerMgr);
  });
});
