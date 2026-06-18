import { describe, it, expect, vi, beforeEach } from "vitest";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";

// mock gate：模拟 waitActionableAutoForce 行为
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

describe("自愈错误语义", () => {
  it("descriptor 歧义 → AMBIGUOUS_DESCRIPTOR 冒泡（不静默错选）", async () => {
    gate.mockRejectedValueOnce(vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }));
    tryHeal.mockRejectedValueOnce({ code: "AMBIGUOUS_DESCRIPTOR" });
    await expect(healAwareGate(1, 0, "#x", { timeout: undefined }, undefined,
      { role: "button", name: "Del" })).rejects.toMatchObject({ code: "AMBIGUOUS_DESCRIPTOR" });
  });

  it("无命中 → STALE_REF 冒泡", async () => {
    gate.mockRejectedValueOnce(vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", { extras: { lastReason: "NOT_ATTACHED" } }));
    tryHeal.mockRejectedValueOnce({ code: "STALE_REF" });
    await expect(healAwareGate(1, 0, "#x", { timeout: undefined }, undefined,
      { name: "Gone" })).rejects.toMatchObject({ code: "STALE_REF" });
  });
});
