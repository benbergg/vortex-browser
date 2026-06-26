import { describe, it, expect, vi, beforeEach } from "vitest";

const checkMock = vi.fn();
vi.mock("../src/action/actionability.js", () => ({
  checkActionability: (...a: unknown[]) => checkMock(...a),
}));

import { waitActionable } from "../src/action/auto-wait.js";

describe("B2 自旋期 descriptor 重定位", () => {
  beforeEach(() => vi.clearAllMocks());

  it("持续 NOT_ATTACHED 达阈值后调用 reresolve 并切换 selector", async () => {
    // 前若干轮对原 selector 恒 NOT_ATTACHED;reresolve 给出新 selector 后 ok。
    const reresolve = vi.fn().mockResolvedValue("[data-vtx-heal=\"h1\"]");
    let switched = false;
    checkMock.mockImplementation((_t, _f, sel: string) => {
      if (sel.startsWith("[data-vtx-heal")) { switched = true; return Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 } }); }
      return Promise.resolve({ ok: false, reason: "NOT_ATTACHED" });
    });
    const res = await waitActionable(1, undefined, "#stale", { timeout: 3000, reresolve });
    expect(reresolve).toHaveBeenCalledTimes(1);
    expect(switched).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("未传 reresolve 时维持原超时抛错行为", async () => {
    checkMock.mockResolvedValue({ ok: false, reason: "NOT_ATTACHED" });
    await expect(
      waitActionable(1, undefined, "#stale", { timeout: 300 }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    // 无 reresolve 调用发生（本 case 未提供）。
  });
});
