// B2 修复锁：waitActionableAutoForce 返回的 selector 必须通过 healAwareGate 传播给调用方。
// 本测试在修复前 FAIL（healAwareGate 当前忽略 waitActionableAutoForce 返回值，直接返回入参 selector）；
// 修复后 PASS（healAwareGate 采用 ok.selector，healed = ok.selector !== selector）。
import { describe, it, expect, vi, beforeEach } from "vitest";

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

describe("healAwareGate selector 传播（B2 修复锁）", () => {
  it("waitActionableAutoForce 返回不同 selector → healed:true，新 selector 透传", async () => {
    // gate 返回自旋期重定位后的新 selector（≠ 入参）
    gate.mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: '[data-vtx-heal="hX"]' });
    const out = await healAwareGate(1, 0, "#old", { timeout: undefined }, undefined, undefined);
    // 修复前：returns { selector: "#old", healed: false }（入参 selector 未被替换）→ 此断言 FAIL
    expect(out).toEqual({ selector: '[data-vtx-heal="hX"]', healed: true });
  });

  it("waitActionableAutoForce 返回相同 selector → healed:false（正常路径不回归）", async () => {
    // gate 返回与入参相同的 selector（无自旋重定位）
    gate.mockResolvedValueOnce({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: "#old" });
    const out = await healAwareGate(1, 0, "#old", { timeout: undefined }, undefined, undefined);
    expect(out).toEqual({ selector: "#old", healed: false });
  });
});
