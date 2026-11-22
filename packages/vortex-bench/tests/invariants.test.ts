// packages/vortex-bench/tests/invariants.test.ts
import { describe, it, expect } from "vitest";
import { checkStability, classifyProbe, checkDuplicates, checkBboxSanity, iou } from "../src/runner/invariants.js";
import type { ParsedObserve, ObserveRow } from "../src/scan-types.js";

function parsed(rows: ObserveRow[], scrollHeight = 2000): ParsedObserve {
  return { header: { snapshotId: "s", url: "u", viewport: { width: 1280, height: 720, scrollY: 0, scrollHeight } }, rows, frameOffsets: {} };
}
const r = (role: string, name: string | null, bbox: ObserveRow["bbox"]): ObserveRow =>
  ({ ref: "@x", role, name, flags: [], bbox, frameId: 0 });

describe("checkStability (INV-1)", () => {
  it("两次 observe 的锚定元素集合一致 → 无 finding", () => {
    const a = [r("button", "保存", [0, 0, 10, 10])];
    const b = [r("button", "保存", [1, 0, 10, 10])]; // 1px 抖动容忍
    expect(checkStability(a, b, "t", "p")).toHaveLength(0);
  });
  it("第二次少了一个元素 → P1 inv1-instability", () => {
    const a = [r("button", "保存", [0, 0, 10, 10]), r("link", "更多", [0, 50, 10, 10])];
    const b = [r("button", "保存", [0, 0, 10, 10])];
    const f = checkStability(a, b, "t", "p");
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("inv1-instability");
    expect(f[0].severity).toBe("P1");
  });
  it("比较范围只由调用方给定的行决定(环境噪声行不在范围内)", () => {
    const anchored = [r("button", "保存", [0, 0, 10, 10])];
    // 第三方浮球行不在传入范围 → 两次集合一致
    expect(checkStability(anchored, anchored, "t", "p")).toHaveLength(0);
  });
});

describe("classifyProbe (INV-2)", () => {
  it("返回正常文本 → ok", () => {
    expect(classifyProbe({ text: '{"attrs":{}}', threw: false, timedOut: false })).toBe("ok");
  });
  it("typed error 文本 → typed-error", () => {
    expect(classifyProbe({ text: "Error [STALE_SNAPSHOT]: ...", threw: false, timedOut: false })).toBe("typed-error");
  });
  it("promise reject → crash", () => {
    expect(classifyProbe({ text: "", threw: true, timedOut: false })).toBe("crash");
  });
  it("超时 → crash", () => {
    expect(classifyProbe({ text: "", threw: false, timedOut: true })).toBe("crash");
  });
});

describe("checkDuplicates (INV-3)", () => {
  it("同 name+role 且 bbox 高度重叠 → P2 inv3-duplicate", () => {
    const rows = [r("menuitem", "首页", [0, 0, 100, 30]), r("menuitem", "首页", [2, 1, 100, 30])];
    const f = checkDuplicates(rows, "t", "p");
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("inv3-duplicate");
  });
  it("同 name 但 bbox 不重叠 → 无 finding", () => {
    const rows = [r("menuitem", "首页", [0, 0, 100, 30]), r("menuitem", "首页", [0, 500, 100, 30])];
    expect(checkDuplicates(rows, "t", "p")).toHaveLength(0);
  });
});

describe("checkBboxSanity (INV-4)", () => {
  it("正常 bbox → 无 finding", () => {
    expect(checkBboxSanity(parsed([r("button", "x", [10, 10, 50, 20])]), "t", "p")).toHaveLength(0);
  });
  it("宽或高 ≤0 → P2 inv4-bbox", () => {
    const f = checkBboxSanity(parsed([r("button", "x", [10, 10, 0, 20])]), "t", "p");
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("inv4-bbox");
  });
  it("x 负坐标越界 → P2 inv4-bbox", () => {
    expect(checkBboxSanity(parsed([r("button", "x", [-5, 10, 50, 20])]), "t", "p")).toHaveLength(1);
  });
  it("宽度超视口 2 倍 → P2 inv4-bbox", () => {
    expect(checkBboxSanity(parsed([r("button", "x", [0, 10, 3000, 20])]), "t", "p")).toHaveLength(1);
  });
});

describe("iou", () => {
  it("完全重叠 = 1", () => {
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1);
  });
  it("不相交 = 0", () => {
    expect(iou([0, 0, 10, 10], [100, 100, 10, 10])).toBe(0);
  });
});
