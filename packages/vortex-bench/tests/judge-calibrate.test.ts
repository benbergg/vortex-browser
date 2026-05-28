// packages/vortex-bench/tests/judge-calibrate.test.ts
import { describe, it, expect } from "vitest";
import { ablateRows, computeCalibration } from "../src/runner/judge-calibrate.js";
import type { ObserveRow } from "../src/scan-types.js";
import type { ClaimedMiss } from "../src/judge-types.js";

const row = (ref: string, bbox: ObserveRow["bbox"], frameId = 0, name = ref): ObserveRow => ({
  ref, role: "button", name, flags: [], bbox, frameId,
});
const miss = (label: string, bbox: [number, number, number, number] = [0, 0, 10, 10]): ClaimedMiss => ({
  label, bbox, reason: "r",
});

describe("ablateRows", () => {
  it("抽 bbox 面积最大的前 k 行,kept 去掉它们", () => {
    const rows = [row("@1", [0, 0, 10, 10]), row("@2", [0, 0, 100, 100]), row("@3", [0, 0, 50, 50])];
    const { kept, ablated } = ablateRows(rows, 1);
    expect(ablated.map((r) => r.ref)).toEqual(["@2"]);
    expect(kept.map((r) => r.ref)).toEqual(["@1", "@3"]);
  });
  it("跳过离屏行与非主 frame 行", () => {
    const rows = [row("@1", null), row("@2", [0, 0, 10, 10], 2), row("@3", [0, 0, 20, 20])];
    const { ablated } = ablateRows(rows, 5);
    expect(ablated.map((r) => r.ref)).toEqual(["@3"]); // 只 @3 合格
  });
});

describe("computeCalibration", () => {
  it("查全:抽行 label 被判官重发现计入 ablatedRecovered(case-insensitive + trim)", () => {
    // @2 name "Save",@3 name "Delete";tpMisses 报 "  save  " 命中 @2,未命中 @3
    const ablated = [row("@2", [0, 0, 100, 100], 0, "Save"), row("@3", [200, 0, 50, 50], 0, "Delete")];
    const tpMisses = [miss("  save  ")];
    const stats = computeCalibration([], tpMisses, ablated);
    expect(stats.ablatedCount).toBe(2);
    expect(stats.ablatedRecovered).toBe(1);
  });
  it("查全:bbox 完全错位但 label 一致仍算 recovered(跨模型 portable)", () => {
    // 模拟 Doubao 归一化 bbox(0-1000 量级)与 observe viewport 像素 bbox 错位
    const ablated = [row("@1", [10, 10, 40, 40], 0, "保存")];
    const tpMisses = [miss("保存", [0, 770, 600, 1020])];
    const stats = computeCalibration([], tpMisses, ablated);
    expect(stats.ablatedRecovered).toBe(1);
  });
  it("假阳:原样交集 miss 数计入 fpConfirmed", () => {
    const stats = computeCalibration([miss("x"), miss("y")], [], []);
    expect(stats.fpConfirmed).toBe(2);
  });
  it("无 label 命中 → ablatedRecovered = 0", () => {
    const ablated = [row("@1", [0, 0, 10, 10], 0, "Save")];
    const tpMisses = [miss("Delete")];
    expect(computeCalibration([], tpMisses, ablated).ablatedRecovered).toBe(0);
  });
});
