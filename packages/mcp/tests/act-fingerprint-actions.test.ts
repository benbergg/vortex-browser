import { describe, it, expect } from "vitest";
import { extractSignals } from "../src/lib/fingerprint-apply.js";

describe("extractSignals：从 act 真实返回形状取确定量", () => {
  it("click：取 effect（dom.ts:588 的形状）", () => {
    const r = {
      success: true,
      effect: {
        domMutations: 3, networkRequests: 0, urlChanged: false,
        focusChanged: true, ariaChanged: false, userFeedback: "mutation",
      },
    };
    expect(extractSignals("click", r)).toEqual({ kind: "click", effect: r.effect });
  });

  it("click 未开 observeEffect → undefined", () => {
    expect(extractSignals("click", { success: true })).toBeUndefined();
  });

  it("fill：取 value（dom.ts:1109 的形状）", () => {
    expect(extractSignals("fill", { success: true, focused: true, value: "a@b.com" }))
      .toEqual({ kind: "value", value: "a@b.com" });
  });

  it("type：取 value（dom.ts:816 的形状）", () => {
    expect(extractSignals("type", { success: true, typed: 5, path: "cdp-insertText", value: "hello" }))
      .toEqual({ kind: "value", value: "hello" });
  });

  it("select 多选：value 是数组，序列化后比对", () => {
    expect(extractSignals("select", { success: true, value: ["a", "b"] }))
      .toEqual({ kind: "value", value: '["a","b"]' });
  });

  it("scroll：取位置（dom.ts:1447 的形状）", () => {
    expect(extractSignals("scroll", { success: true, moved: true, scrollTop: 1200, scrollLeft: 0 }))
      .toEqual({ kind: "scroll", scrollAfter: { top: 1200, left: 0 } });
  });

  it("hover：无确定量 → undefined", () => {
    expect(extractSignals("hover", { success: true })).toBeUndefined();
  });
});
