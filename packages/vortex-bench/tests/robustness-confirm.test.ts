// packages/vortex-bench/tests/robustness-confirm.test.ts
import { describe, it, expect } from "vitest";
import { confirmContractViolations, refIdentity } from "../src/runner/robustness-confirm.js";
import type { RefOutcome } from "../src/robustness-types.js";

const o = (over: Partial<RefOutcome>): RefOutcome => ({
  ref: "@x", role: "button", name: "n", kind: "typed-error", code: "ELEMENT_NOT_FOUND", detail: "", ...over,
});

describe("refIdentity", () => {
  it("role+name 组合", () => {
    expect(refIdentity("button", "保存")).toBe("button 保存");
    expect(refIdentity("link", null)).toBe("link ");
  });
});

describe("confirmContractViolations", () => {
  it("同身份在 S2 仍违反 → 确认", () => {
    const f = o({ ref: "@a", role: "button", name: "保存" });
    const pass2 = new Map<string, RefOutcome[]>([
      ["button 保存", [o({ ref: "@a2", role: "button", name: "保存", code: "ELEMENT_NOT_FOUND" })]],
    ]);
    expect(confirmContractViolations([f], pass2)).toEqual([f]);
  });

  it("同身份在 S2 恢复(ok)→ 抖动丢弃", () => {
    const f = o({ ref: "@a", role: "button", name: "保存" });
    const pass2 = new Map<string, RefOutcome[]>([
      ["button 保存", [o({ ref: "@a2", role: "button", name: "保存", kind: "ok", code: null })]],
    ]);
    expect(confirmContractViolations([f], pass2)).toEqual([]);
  });

  it("同身份在 S2 消失 → 抖动丢弃", () => {
    const f = o({ ref: "@a", role: "button", name: "保存" });
    expect(confirmContractViolations([f], new Map())).toEqual([]);
  });

  it("多同名行:任一仍违反 → 确认", () => {
    const f = o({ ref: "@a", role: "button", name: "更多" });
    const pass2 = new Map<string, RefOutcome[]>([
      ["button 更多", [
        o({ ref: "@b1", role: "button", name: "更多", kind: "ok", code: null }),
        o({ ref: "@b2", role: "button", name: "更多", code: "ELEMENT_NOT_FOUND" }),
      ]],
    ]);
    expect(confirmContractViolations([f], pass2)).toEqual([f]);
  });

  it("多同名行:全恢复 → 抖动丢弃", () => {
    const f = o({ ref: "@a", role: "button", name: "更多" });
    const pass2 = new Map<string, RefOutcome[]>([
      ["button 更多", [
        o({ ref: "@b1", role: "button", name: "更多", kind: "ok", code: null }),
        o({ ref: "@b2", role: "button", name: "更多", kind: "ok", code: null }),
      ]],
    ]);
    expect(confirmContractViolations([f], pass2)).toEqual([]);
  });

  it("pass2 中非契约码(如 OBSCURED)不算违反 → 抖动丢弃", () => {
    const f = o({ ref: "@a", role: "button", name: "保存" });
    const pass2 = new Map<string, RefOutcome[]>([
      ["button 保存", [o({ ref: "@a2", role: "button", name: "保存", kind: "typed-error", code: "OBSCURED" })]],
    ]);
    expect(confirmContractViolations([f], pass2)).toEqual([]);
  });

  it("空 pass1 → 空", () => {
    expect(confirmContractViolations([], new Map())).toEqual([]);
  });
});
