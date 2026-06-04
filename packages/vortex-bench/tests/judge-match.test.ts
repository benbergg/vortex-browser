// packages/vortex-bench/tests/judge-match.test.ts
import { describe, it, expect } from "vitest";
import { normalizeLabel, labelsMatch, bboxCoversPoint, reconcileByBbox } from "../src/runner/judge-match.js";

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

// bbox 兜底过滤(2026-06-04 京东 live 评测):judge 读截图像素文字 vs observe DOM 名
// 对不上 → 假阳,但 observe 在该位置有 ref。用候选左上角落在 observe bbox 内判定覆盖。
describe("bboxCoversPoint", () => {
  it("点在 [x,y,w,h] 框内 → true", () => {
    expect(bboxCoversPoint([875, 143, 94, 102], 875, 181)).toBe(true);
    expect(bboxCoversPoint([100, 100, 50, 50], 120, 120)).toBe(true);
  });
  it("点在框外(超出 margin)→ false", () => {
    expect(bboxCoversPoint([100, 100, 50, 50], 300, 300)).toBe(false);
  });
  it("点在 margin 容差内 → true(LLM bbox 略偏)", () => {
    expect(bboxCoversPoint([100, 100, 50, 50], 95, 95, 8)).toBe(true); // 95≥100-8
    expect(bboxCoversPoint([100, 100, 50, 50], 90, 90, 8)).toBe(false); // 90<100-8
  });
});

describe("reconcileByBbox — observe 已覆盖的候选丢弃", () => {
  const obsRows = [
    { bbox: [875, 143, 94, 102] as [number, number, number, number] }, // "大促" banner link
    { bbox: null },
  ];
  it("京东案例:judge banner 候选左上角落在 observe '大促' bbox 内 → 丢弃(假阳)", () => {
    const misses = [{ bbox: [875, 181, 950, 230], label: "手机直降" }];
    expect(reconcileByBbox(misses, obsRows)).toEqual([]);
  });
  it("候选远离所有 observe bbox → 保留(真漏)", () => {
    const misses = [{ bbox: [1700, 900, 1750, 940], label: "真漏元素" }];
    expect(reconcileByBbox(misses, obsRows).length).toBe(1);
  });
  it("observe 无任何 bbox(全离屏)→ 不过滤(退化原行为)", () => {
    const misses = [{ bbox: [875, 181, 950, 230], label: "x" }];
    expect(reconcileByBbox(misses, [{ bbox: null }]).length).toBe(1);
  });
});
