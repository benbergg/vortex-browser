import { describe, it, expect } from "vitest";
import { vtxError, VtxErrorCode } from "@vortex-browser/shared";
import { isStaleNotAttached } from "../src/action/heal";

// 验证 isStaleNotAttached 读的是真实 VtxError 形状：
// vtxError(code, msg, context) → err.extra.context.extras.lastReason
// 而非顶层 err.extras.lastReason（旧错误路径）
describe("isStaleNotAttached — 真实 VtxError 形状", () => {
  it("TIMEOUT + lastReason=NOT_ATTACHED → true", () => {
    const realErr = vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", {
      selector: "#x",
      extras: { lastReason: "NOT_ATTACHED" },
    });
    expect(isStaleNotAttached(realErr)).toBe(true);
  });

  it("TIMEOUT + lastReason=OBSCURED → false", () => {
    const realErr = vtxError(VtxErrorCode.TIMEOUT, "Actionability timeout", {
      selector: "#x",
      extras: { lastReason: "OBSCURED" },
    });
    expect(isStaleNotAttached(realErr)).toBe(false);
  });

  it("非 TIMEOUT/NOT_ATTACHED code → false", () => {
    const realErr = vtxError(VtxErrorCode.ELEMENT_NOT_FOUND, "not found", {
      selector: "#x",
      extras: { lastReason: "NOT_ATTACHED" },
    });
    expect(isStaleNotAttached(realErr)).toBe(false);
  });

  it("undefined → false", () => {
    expect(isStaleNotAttached(undefined)).toBe(false);
  });
});
