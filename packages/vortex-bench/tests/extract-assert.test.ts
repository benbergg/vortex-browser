// packages/vortex-bench/tests/extract-assert.test.ts
// 缺口 J — extract 容差断言范式（纯函数）。标准锚页面客观事实值。
import { describe, it, expect } from "vitest";
import {
  normalizeString,
  exactMatch,
  jaroWinkler,
  fuzzyMatch,
  numericWithinBand,
  containsAll,
  notContains,
} from "../src/runner/extract-assert.js";

describe("normalizeString", () => {
  it("trim 首尾空白 + lowercase", () => {
    expect(normalizeString("  Coframe  ")).toBe("coframe");
  });
  it("折叠内部多空白为单个", () => {
    expect(normalizeString("Best  Chocolate   Chip")).toBe("best chocolate chip");
  });
  it("中文不受 lowercase 影响", () => {
    expect(normalizeString(" 阻值 ")).toBe("阻值");
  });
  it("空白串 → 空串", () => {
    expect(normalizeString("   ")).toBe("");
  });
});

describe("exactMatch（规范化后精确相等）", () => {
  it("规范化后相等 → true", () => {
    expect(exactMatch("  Coframe ", "coframe")).toBe(true);
  });
  it("内容不同 → false", () => {
    expect(exactMatch("Coframe", "OpusClip")).toBe(false);
  });
});

describe("jaroWinkler（维基标准值校验自实现正确性）", () => {
  it("MARTHA vs MARHTA ≈ 0.961", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961, 2);
  });
  it("DWAYNE vs DUANE ≈ 0.84", () => {
    expect(jaroWinkler("DWAYNE", "DUANE")).toBeCloseTo(0.84, 2);
  });
  it("DIXON vs DICKSONX ≈ 0.813", () => {
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813, 2);
  });
  it("完全相同 → 1.0", () => {
    expect(jaroWinkler("react", "react")).toBe(1);
  });
  it("两个空串 → 1.0", () => {
    expect(jaroWinkler("", "")).toBe(1);
  });
  it("一空一非空 → 0", () => {
    expect(jaroWinkler("react", "")).toBe(0);
  });
  it("毫无公共字符 → 0", () => {
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
});

describe("fuzzyMatch（规范化 + Jaro-Winkler ≥ 阈值）", () => {
  it("格式噪声但高度相似 → true（默认 0.9）", () => {
    // 真站常见：抓到 'Scalable architecture' vs 期望 'scalable architecture'
    expect(fuzzyMatch("Scalable Architecture", "scalable architecture")).toBe(true);
  });
  it("轻微拼写差异 ≥ 阈值 → true", () => {
    expect(fuzzyMatch("MARTHA", "MARHTA", 0.95)).toBe(true);
  });
  it("差异过大 < 阈值 → false", () => {
    expect(fuzzyMatch("Coframe", "OpusClip", 0.9)).toBe(false);
  });
});

describe("numericWithinBand（抽数字 + k/m 后缀 + 千分位 + 容差带）", () => {
  it("k 后缀：'236k' → 236000，落 236000±1000 → true", () => {
    expect(numericWithinBand("236k", 236000, 1000)).toBe(true);
  });
  it("github stars 漂移：'12.3k stars' → 12300，期望 12300±1000 → true", () => {
    expect(numericWithinBand("12.3k stars", 12300, 1000)).toBe(true);
  });
  it("m 后缀：'2.5m' → 2500000", () => {
    expect(numericWithinBand("2.5m", 2500000, 1000)).toBe(true);
  });
  it("千分位：'1,234,567' → 1234567", () => {
    expect(numericWithinBand("1,234,567 results", 1234567, 0)).toBe(true);
  });
  it("货币符号：'$11.99' → 11.99（精确，band=0）", () => {
    expect(numericWithinBand("$11.99", 11.99, 0)).toBe(true);
  });
  it("超出容差带 → false", () => {
    expect(numericWithinBand("236k", 240000, 1000)).toBe(false);
  });
  it("文本无数字 → false（不静默当 0）", () => {
    expect(numericWithinBand("no number here", 0, 1000)).toBe(false);
  });
  it("取第一个数字（多数字时）", () => {
    expect(numericWithinBand("page 2 of 100 items", 2, 0)).toBe(true);
  });
});

describe("containsAll（N 行表完整性：所有期望值都出现）", () => {
  const tableText = "Zone A | Center X | 201\nZone B | Center Y | 202\nZone C | Center Z | 203";
  it("全部期望值都在文本里 → ok:true, missing:[]", () => {
    const r = containsAll(tableText, ["201", "202", "203", "Center X"]);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it("缺失部分 → ok:false 且列出 missing", () => {
    const r = containsAll(tableText, ["201", "999", "Center Q"]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["999", "Center Q"]);
  });
  it("规范化匹配（大小写/空白无关）", () => {
    const r = containsAll("ZONE   A | CENTER x", ["zone a", "center x"]);
    expect(r.ok).toBe(true);
  });
  it("空期望列表 → ok:true（无要求）", () => {
    expect(containsAll(tableText, []).ok).toBe(true);
  });
});

describe("notContains（负向：target 之外的值不应出现）", () => {
  it("禁出现值确实不在 → true", () => {
    expect(notContains("Coframe", "OpusClip")).toBe(true);
  });
  it("禁出现值出现了 → false", () => {
    expect(notContains("Coframe and OpusClip", "OpusClip")).toBe(false);
  });
  it("规范化后判定（大小写无关）", () => {
    expect(notContains("coframe", "COFRAME")).toBe(false);
  });
});
