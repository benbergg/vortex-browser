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

  it("已显式带 target 时不抢 pattern", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7", target: "#explicit" };
    liftQueryRefToTarget("vortex_query", params);
    expect(params.target).toBe("#explicit");
    expect(params.pattern).toBe("@a1b2:e7");
  });

  it("别的工具不受影响", () => {
    const params: Record<string, unknown> = { mode: "style", pattern: "@a1b2:e7" };
    liftQueryRefToTarget("vortex_observe", params);
    expect(params.pattern).toBe("@a1b2:e7");
    expect("target" in params).toBe(false);
  });
});
