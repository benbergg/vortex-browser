/**
 * iteration 15 真站确诊(DuckDuckGo 结果页):observe 的 iconNameFromClass className
 * 兜底把**无框架前缀的高熵随机类名**当可访问名 —— `<a class="w0GlwvoHJHjX9o0DVIaL">`
 * (无文本/aria-label/title,内含 <img alt="">)被命名为 "w0GlwvoHJHjX9o0DVIaL",
 * button `class="UHLDCRqne5hmHzSLIjwY ..."` 同理。CSS-modules 默认 [hash] / 各家构建
 * 产物属此类:零语义,当名比无名更糟(噪声 + 假名击败 require-name 过滤)。
 *
 * 既有 denylist 只否决 css-/sc- 前缀哈希,裸随机哈希漏网。修复:加「无分隔符 + 大小写
 * 混合 + 含数字 + 长 ≥8」高熵否决。
 *
 * iconNameFromClass 内联于 observe.ts 注入体(不能 import),故:
 *   1. source-lock 守卫修复接线不被回退;
 *   2. 独立谓词测试复刻该启发式,验证真实哈希被否决、语义名保留。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");

// 复刻 observe.ts iconNameFromClass 中的高熵哈希否决谓词(单一真源:同一逻辑)。
// 按 -/_ 切段,任一段长 ≥8 且大小写混合 + 含数字 = 机器生成哈希应否决。
function looksLikeHashClass(cleaned: string): boolean {
  return cleaned
    .split(/[-_]/)
    .some(
      (seg) => seg.length >= 8 && /[a-z]/.test(seg) && /[A-Z]/.test(seg) && /[0-9]/.test(seg),
    );
}

describe("iconNameFromClass 高熵哈希类名否决 · 谓词行为", () => {
  it("否决真站实测的随机哈希类名(含 _ 内嵌哈希段)", () => {
    // DuckDuckGo 结果页实测
    expect(looksLikeHashClass("w0GlwvoHJHjX9o0DVIaL")).toBe(true);
    expect(looksLikeHashClass("UHLDCRqne5hmHzSLIjwY")).toBe(true);
    expect(looksLikeHashClass("cxQwADb9kt3UnKwcXKat")).toBe(true);
    // 含下划线的哈希:段 "YZxymVMEkIDA0nZSt" 仍被识别(第一版无分隔符规则漏网)
    expect(looksLikeHashClass("YZxymVMEkIDA0nZSt_Pm")).toBe(true);
  });

  it("保留语义类名(kebab/snake/纯小写/camelCase 无数字)", () => {
    expect(looksLikeHashClass("close")).toBe(false); // 纯小写
    expect(looksLikeHashClass("closeIcon")).toBe(false); // camelCase 无数字
    expect(looksLikeHashClass("searchButton")).toBe(false);
    expect(looksLikeHashClass("icon-close")).toBe(false); // 有分隔符
    expect(looksLikeHashClass("el_popover")).toBe(false); // 有分隔符
    expect(looksLikeHashClass("navToggle")).toBe(false);
  });

  it("短 token(<8)不否决(避免误伤 Btn2/col3 等)", () => {
    expect(looksLikeHashClass("Btn2")).toBe(false);
    expect(looksLikeHashClass("Col3x")).toBe(false);
  });

  it("短哈希段(每段 <8)不否决,交既有 css-/sc- denylist", () => {
    // css-1a2b3c 段为 ["css","1a2b3c"] 均 <8 → 本谓词不命中(由 css- 前缀 denylist 处理)
    expect(looksLikeHashClass("css-1a2b3c")).toBe(false);
    expect(looksLikeHashClass("a_b1C2")).toBe(false);
  });

  it("纯小写长 token(无大写)不否决(kebab/snake 语义名)", () => {
    expect(looksLikeHashClass("playwright")).toBe(false);
    expect(looksLikeHashClass("automation-testing")).toBe(false);
  });
});

describe("observe.ts 高熵哈希否决接线(source-lock)", () => {
  it("iconNameFromClass className 兜底含按段高熵哈希否决(切 -/_ + 段≥8 + 大小写 + 数字)", () => {
    expect(OBSERVE_SRC).toMatch(/const isHashSeg = cleaned[\s\S]*?\.split\(\/\[-_\]\/\)/);
    expect(OBSERVE_SRC).toMatch(
      /seg\.length\s*>=\s*8\s*&&\s*\/\[a-z\]\/\.test\(seg\)\s*&&\s*\/\[A-Z\]\/\.test\(seg\)\s*&&\s*\/\[0-9\]\/\.test\(seg\)/,
    );
    expect(OBSERVE_SRC).toMatch(/if\s*\(isHashSeg\)\s*continue/);
  });

  it("否决置于 css-/sc- 否决之后、return cleaned 之前(顺序正确)", () => {
    const cssIdx = OBSERVE_SRC.indexOf('/^css-/.test(lower)');
    const hashIdx = OBSERVE_SRC.indexOf("const isHashSeg = cleaned");
    const returnIdx = OBSERVE_SRC.indexOf("return cleaned;");
    expect(cssIdx).toBeGreaterThan(0);
    expect(hashIdx).toBeGreaterThan(cssIdx);
    expect(returnIdx).toBeGreaterThan(hashIdx);
  });
});
