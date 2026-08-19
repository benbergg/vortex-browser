import { describe, it, expect } from "vitest";
import { liftQueryRefToTarget } from "../src/lib/query-ref.js";

describe("liftQueryRefToTarget", () => {
  it.each(["style", "geometry", "css", "component"])(
    "mode=%s 且 pattern 以 @ 开头 → 抬成 target 并删掉 pattern",
    (mode) => {
      const params: Record<string, unknown> = { mode, pattern: "@a1b2:e7" };
      liftQueryRefToTarget("vortex_query", params);
      expect(params.target).toBe("@a1b2:e7");
      expect("pattern" in params).toBe(false);
    },
  );

  it.each(["text", "sheet", "flow", "chart", "schema", "tokens"])(
    "mode=%s 不是选择器类 → pattern 原样保留",
    (mode) => {
      const params: Record<string, unknown> = { mode, pattern: "@a1b2:e7" };
      liftQueryRefToTarget("vortex_query", params);
      expect(params.pattern).toBe("@a1b2:e7");
      expect("target" in params).toBe(false);
    },
  );

  it("CSS 选择器形态不动（不以 @ 开头）", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "h1" };
    liftQueryRefToTarget("vortex_query", params);
    expect(params.pattern).toBe("h1");
    expect("target" in params).toBe(false);
  });

  it("target 与 pattern 同时出现 → 抛 INVALID_PARAMS", () => {
    // 「不抢、两者并存」是缺陷行为:server 把 target 译成 selector,extension 却用
    // pattern,调用方拿到的是它没要的那个元素(评审 Task 1 H-2)。
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7", target: "#explicit" };
    expect(() => liftQueryRefToTarget("vortex_query", params)).toThrow(/remove `target`/);
  });

  it("CSS 形态的 pattern 与 target 并存同样拒绝(不是只挡 @ref)", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "h1", target: "#explicit" };
    expect(() => liftQueryRefToTarget("vortex_query", params)).toThrow(/remove `target`/);
  });

  it("只有 target 没有 pattern → 不拦(非 query 语义,交给下游校验)", () => {
    const params: Record<string, unknown> = { mode: "style", target: "#explicit" };
    expect(() => liftQueryRefToTarget("vortex_query", params)).not.toThrow();
  });

  it("别的工具不受影响", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7" };
    liftQueryRefToTarget("vortex_observe", params);
    expect(params.pattern).toBe("@a1b2:e7");
    expect("target" in params).toBe(false);
  });
});
