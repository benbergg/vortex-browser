// packages/vortex-bench/tests/judge-consistency.test.ts
import { describe, it, expect } from "vitest";
import { boxesMatch } from "../src/runner/geometry-join.js";
import { intersectPasses } from "../src/runner/judge-consistency.js";
import type { ClaimedMiss } from "../src/judge-types.js";

const miss = (label: string, bbox: [number, number, number, number]): ClaimedMiss => ({ label, bbox, reason: "r" });

describe("boxesMatch", () => {
  it("中心互落入 → true", () => {
    expect(boxesMatch([0, 0, 100, 100], [10, 10, 80, 80])).toBe(true);
  });
  it("完全不相交 → false", () => {
    expect(boxesMatch([0, 0, 10, 10], [500, 500, 10, 10])).toBe(false);
  });
});

describe("intersectPasses", () => {
  it("两轮位置吻合的 miss 保留(取 a 侧)", () => {
    const a = [miss("搜索", [10, 10, 40, 40])];
    const b = [miss("search btn", [12, 12, 38, 38])];
    expect(intersectPasses(a, b)).toEqual(a);
  });
  it("仅一轮出现的 miss 丢弃", () => {
    const a = [miss("搜索", [10, 10, 40, 40]), miss("孤", [300, 300, 20, 20])];
    const b = [miss("search", [12, 12, 38, 38])];
    expect(intersectPasses(a, b).map((m) => m.label)).toEqual(["搜索"]);
  });
  it("任一轮为空 → []", () => {
    expect(intersectPasses([miss("x", [0, 0, 5, 5])], [])).toEqual([]);
  });
});
