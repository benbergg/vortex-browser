import { describe, it, expect, vi, beforeEach } from "vitest";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";

// mock gate：第一次（原选择器）抛 stale，第二次（healed）通过。
const gate = vi.fn();
vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: (...a: unknown[]) => gate(...a),
}));
const tryHeal = vi.fn();
vi.mock("../src/action/heal.js", async (orig) => ({
  ...(await orig<typeof import("../src/action/heal.js")>()),
  tryHealSelector: (...a: unknown[]) => tryHeal(...a),
}));

import { healAwareGate } from "../src/handlers/dom.js";

beforeEach(() => { gate.mockReset(); tryHeal.mockReset(); });

describe("healAwareGate", () => {
  it("stale NOT_ATTACHED + descriptor → heal + 重跑 gate，返回 healed selector", async () => {
    gate.mockRejectedValueOnce(vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }))
        .mockResolvedValueOnce(undefined);
    tryHeal.mockResolvedValueOnce(`[data-vtx-heal="h1"]`);
    const out = await healAwareGate(1, 0, "#old", { timeout: undefined }, undefined,
      { role: "button", name: "Submit" });
    expect(out).toEqual({ selector: `[data-vtx-heal="h1"]`, healed: true });
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it("无 descriptor → 不自愈，原样抛", async () => {
    gate.mockRejectedValueOnce(vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }));
    await expect(healAwareGate(1, 0, "#old", { timeout: undefined }, undefined, undefined))
      .rejects.toMatchObject({ code: "TIMEOUT" });
    expect(tryHeal).not.toHaveBeenCalled();
  });

  it("非 stale 错误 → 不自愈，原样抛", async () => {
    gate.mockRejectedValueOnce(vtxError(VtxErrorCode.OBSCURED, "Element obscured"));
    await expect(healAwareGate(1, 0, "#x", { timeout: undefined }, undefined,
      { role: "button", name: "S" })).rejects.toMatchObject({ code: "OBSCURED" });
    expect(tryHeal).not.toHaveBeenCalled();
  });

  it("happy path（gate 直接过）→ 不触发 heal", async () => {
    gate.mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "#ok" });
    const out = await healAwareGate(1, 0, "#ok", { timeout: undefined }, undefined,
      { role: "button", name: "S" });
    expect(out).toEqual({ selector: "#ok", healed: false });
    expect(tryHeal).not.toHaveBeenCalled();
  });
});
