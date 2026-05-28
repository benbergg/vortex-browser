// packages/vortex-bench/tests/judge-consistency.test.ts
import { describe, it, expect } from "vitest";
import { intersectPasses } from "../src/runner/judge-consistency.js";
import type { ClaimedMiss } from "../src/judge-types.js";

const miss = (label: string, bbox: [number, number, number, number] = [0, 0, 10, 10]): ClaimedMiss => ({
  label, bbox, reason: "r",
});

describe("intersectPasses (label-based exact match)", () => {
  it("两轮 label 规范化后相等 → 保留(取 a 侧表述与 bbox)", () => {
    const a = [miss("Save", [10, 10, 40, 40])];
    const b = [miss("  save  ", [12, 12, 38, 38])]; // bbox 不同也无所谓,只比 label
    const result = intersectPasses(a, b);
    expect(result).toEqual(a);
  });
  it("仅一轮出现的 label 丢弃", () => {
    const a = [miss("Save"), miss("Delete")];
    const b = [miss("save")];
    expect(intersectPasses(a, b).map((m) => m.label)).toEqual(["Save"]);
  });
  it("跨模型 bbox 完全错位但 label 一致仍保留(label-based 跨模型 portable)", () => {
    const a = [miss("保存", [10, 10, 40, 40])]; // viewport 像素
    const b = [miss("保存", [0, 770, 600, 1020])]; // 归一化 / 其他坐标系
    expect(intersectPasses(a, b)).toEqual(a);
  });
  it("任一轮为空 → []", () => {
    expect(intersectPasses([miss("x")], [])).toEqual([]);
    expect(intersectPasses([], [miss("x")])).toEqual([]);
  });
  it("同 label 在 a 侧重复 → 都保留(去重职责不在此函数)", () => {
    const a = [miss("Save"), miss("Save")];
    const b = [miss("save")];
    expect(intersectPasses(a, b)).toHaveLength(2);
  });
});
