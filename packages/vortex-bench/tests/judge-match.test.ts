// packages/vortex-bench/tests/judge-match.test.ts
import { describe, it, expect } from "vitest";
import { normalizeLabel, labelsMatch } from "../src/runner/judge-match.js";

describe("normalizeLabel", () => {
  it("trim 首尾空白 + lowercase", () => {
    expect(normalizeLabel("  Save  ")).toBe("save");
  });
  it("折叠内部多空白为单个", () => {
    expect(normalizeLabel("Quick   Start")).toBe("quick start");
  });
  it("中文 label 不受影响(不变大小写,不当英文处理)", () => {
    expect(normalizeLabel(" 保存按钮 ")).toBe("保存按钮");
  });
  it("空字符串 → 空字符串", () => {
    expect(normalizeLabel("   ")).toBe("");
  });
});

describe("labelsMatch", () => {
  it("规范化后相等 → true", () => {
    expect(labelsMatch("  Save ", "save")).toBe(true);
  });
  it("规范化后不等 → false", () => {
    expect(labelsMatch("Save", "Delete")).toBe(false);
  });
  it("中文 label 完全相等 → true(忽略前后空白)", () => {
    expect(labelsMatch("保存", " 保存 ")).toBe(true);
  });
  it("中文 label 不等 → false(label 不做语义/翻译对齐)", () => {
    expect(labelsMatch("保存", "Save")).toBe(false);
  });
  it("空字符串两侧 → true(同为空)", () => {
    expect(labelsMatch("", "  ")).toBe(true);
  });
});
