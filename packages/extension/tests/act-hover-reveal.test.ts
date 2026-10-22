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

  it("NOT_VISIBLE → 调 reveal；揭示成功后门禁通过并回传 revealed 证据", async () => {
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
    expect(r.ok).toBe(true);
    expect((r as any).revealed).toMatchObject({ id: "row" });
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

  it("revealHidden=false → 不触发 reveal（调用方可显式关闭）", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 40, debuggerMgr: fakeDbg, revealHidden: false });
    } catch {
      /* 预期抛错 */
    }
    expect(revealByHover).not.toHaveBeenCalled();
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

  it("揭示只尝试一次：揭示失败后继续按原节奏重试，不反复 hover", async () => {
    checkActionability.mockResolvedValue({ ok: false, reason: "NOT_VISIBLE" });
    revealByHover.mockResolvedValue({ revealed: false, attempts: 2, candidates: 2 });
    try {
      await waitActionable(42, undefined, "#ctl", { timeout: 200, debuggerMgr: fakeDbg });
    } catch {
      /* 预期抛错 */
    }
    expect(revealByHover).toHaveBeenCalledTimes(1);
  });
});
