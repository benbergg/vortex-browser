// packages/vortex-bench/tests/robustness-aggregate.test.ts
import { describe, it, expect } from "vitest";
import { aggregateFixture, CONTRACT_VIOLATION_CODES } from "../src/runner/robustness-aggregate.js";
import type { RefOutcome } from "../src/robustness-types.js";

const o = (over: Partial<RefOutcome>): RefOutcome => ({
  ref: "@x", role: "button", name: "n", kind: "ok", code: null, detail: "", ...over,
});

describe("CONTRACT_VIOLATION_CODES", () => {
  it("含三个契约违反码", () => {
    expect([...CONTRACT_VIOLATION_CODES].sort()).toEqual(
      ["ELEMENT_NOT_FOUND", "NOT_ATTACHED", "STALE_SNAPSHOT"],
    );
  });
});

describe("aggregateFixture", () => {
  it("全 ok → okRate=1, 无 finding, 直方图只 ok", () => {
    const fx = aggregateFixture("fx", "/p", [o({}), o({})]);
    expect(fx.okRate).toBe(1);
    expect(fx.okCount).toBe(2);
    expect(fx.totalRefs).toBe(2);
    expect(fx.findings).toHaveLength(0);
    expect(fx.histogram).toEqual({ ok: 2 });
  });

  it("契约违反码 → R0", () => {
    const fx = aggregateFixture("fx", "/p", [o({ kind: "typed-error", code: "ELEMENT_NOT_FOUND" })]);
    expect(fx.findings).toHaveLength(1);
    expect(fx.findings[0].severity).toBe("R0");
    expect(fx.findings[0].code).toBe("ELEMENT_NOT_FOUND");
    expect(fx.histogram).toEqual({ "typed-error:ELEMENT_NOT_FOUND": 1 });
  });

  it("OBSCURED → R1", () => {
    const fx = aggregateFixture("fx", "/p", [o({ kind: "typed-error", code: "OBSCURED" })]);
    expect(fx.findings[0].severity).toBe("R1");
    expect(fx.findings[0].code).toBe("OBSCURED");
  });

  it("crash → R0(code='crash')", () => {
    const fx = aggregateFixture("fx", "/p", [o({ kind: "crash", detail: "boom" })]);
    expect(fx.findings[0].severity).toBe("R0");
    expect(fx.findings[0].code).toBe("crash");
  });

  it("timeout → R0(code='timeout')", () => {
    const fx = aggregateFixture("fx", "/p", [o({ kind: "timeout" })]);
    expect(fx.findings[0].severity).toBe("R0");
    expect(fx.findings[0].code).toBe("timeout");
  });

  it("okRate 计算 + finding detail 带 role/name", () => {
    const fx = aggregateFixture("fx", "/p", [
      o({}),
      o({ ref: "@y", role: "link", name: "更多", kind: "typed-error", code: "OBSCURED", detail: "covered" }),
    ]);
    expect(fx.okRate).toBe(0.5);
    expect(fx.findings[0].ref).toBe("@y");
    expect(fx.findings[0].detail).toBe('[link] "更多" — covered');
  });

  it("空页(0 ref)→ okRate=1(vacuous), 无 finding", () => {
    const fx = aggregateFixture("fx", "/p", []);
    expect(fx.totalRefs).toBe(0);
    expect(fx.okRate).toBe(1);
    expect(fx.findings).toHaveLength(0);
  });
});
