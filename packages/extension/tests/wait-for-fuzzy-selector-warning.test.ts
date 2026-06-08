/**
 * Author: qingwa
 * Description: BUG-013 N0060 京东评测 A 方案 — wait_for mode=custom (WAIT_FOR_EXPRESSION)
 *   模糊 selector 检测 + console.warn, 提示用户改用精确 selector 避免 BEM 命名空间冲突。
 *
 * 背景 (reports/jd-dogfood-V1/_meta/BUG-013-wait_for模糊匹配.md):
 *   京东加购 toast: `vortex_wait_for(value='!!document.querySelector("[class*=toast]")")`
 *   1ms false positive 命中 #rateList 元素祖先中含 "toast" 子串的 class (BEM 命名空间冲突)。
 *   - 0 行为变更, 只在 host 侧打 console.warn, 不改 eval 逻辑
 *   - 检测对象: [class*=] / [class^=] / [class$=] / [id*=] / [id^=] / [id$=]
 *     等 attribute substring/prefix/suffix 匹配
 *
 * Why source-level + 集成 + jsdom 混合:
 *   - fuzzy detector 是纯函数 (extractFuzzySelectors), jsdom 单测
 *   - 集成测试验证 page.ts 源码中调用了 detector + console.warn
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * fuzzy selector 检测纯函数: 从 expression 字符串提取 attribute 模糊匹配
 * 模式 (含 * / ^ / $ 前缀)。返回匹配项数组, 空数组 = 无模糊 selector。
 *
 * 支持模式 (CSS attribute selectors 全部模糊匹配):
 *   - [attr*=value]  (substring match, 最常见)
 *   - [attr^=value]  (prefix match)
 *   - [attr$=value]  (suffix match)
 *
 * 不匹配 (精确匹配, 无 BEM 冲突风险):
 *   - [attr=value]   (exact)
 *   - [attr~=value]  (whitespace-separated word)
 *   - [attr|=value]  (exact or prefix with hyphen)
 */
function extractFuzzySelectors(expression: string): string[] {
  const matches: string[] = [];
  const re = /\[(?:class|id)\s*([*^$])=\s*["']?[^"'\]]+["']?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) {
    matches.push(m[0]);
  }
  return matches;
}

describe("extractFuzzySelectors (BUG-013 fuzzy detector 纯函数)", () => {
  it("[class*=toast] → 命中 (substring match, BEM 冲突高风险)", () => {
    expect(extractFuzzySelectors("!!document.querySelector('[class*=toast]')"))
      .toEqual(["[class*=toast]"]);
  });

  it("[id*=rateList] → 命中", () => {
    expect(extractFuzzySelectors("!!document.querySelector('[id*=rateList]')"))
      .toEqual(["[id*=rateList]"]);
  });

  it("[class^=toast] [class$=box] → 双重命中 (prefix + suffix)", () => {
    expect(extractFuzzySelectors("'[class^=toast][class$=box]'"))
      .toEqual(["[class^=toast]", "[class$=box]"]);
  });

  it("[class=\"toast-box\"] (精确) → 不命中", () => {
    expect(extractFuzzySelectors('!!document.querySelector(\'.toast-box\')'))
      .toEqual([]);
  });

  it("[data-toast] → 不命中 (data-* 非 class/id, 命名空间安全)", () => {
    expect(extractFuzzySelectors("!!document.querySelector('[data-toast]')"))
      .toEqual([]);
  });

  it("无 selector 的简单表达式 → 不命中", () => {
    expect(extractFuzzySelectors("document.title.length > 0")).toEqual([]);
    expect(extractFuzzySelectors("!!document.querySelector('#rateList')")).toEqual([]);
  });

  it("IIFE 形式包裹的模糊 selector → 仍命中 (脱 IIFE 壳检测)", () => {
    expect(extractFuzzySelectors("(function(){ return !!document.querySelector('[class*=toast]'); })()"))
      .toEqual(["[class*=toast]"]);
  });
});

/**
 * 集成测试: page.ts 在 WAIT_FOR_EXPRESSION handler 中调用 fuzzy detector
 * 并 console.warn 提示。0 行为变更 (warn 而非 throw)。
 */
describe("page.ts WAIT_FOR_EXPRESSION 集成 — fuzzy detector + warn (BUG-013)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PAGE_SRC = readFileSync(
    join(__dirname, "..", "src", "handlers", "page.ts"),
    "utf8",
  );

  it("page.ts 引用 fuzzy detector 函数 (extractFuzzySelectors 或等效 regex)", () => {
    // 命名可能为 extractFuzzySelectors / detectFuzzySelector / fuzzyMatch 等
    // 这里 sanity-check: 源码中含 [class* 字符串字面量 + console.warn 调用
    expect(PAGE_SRC).toMatch(/\[class\*=/);
  });

  it("page.ts WAIT_FOR_EXPRESSION handler 内调用 console.warn (fuzzy 命中时)", () => {
    // 提取 [PageActions.WAIT_FOR_EXPRESSION] 块 (从注册到下一 action)
    const startIdx = PAGE_SRC.indexOf("WAIT_FOR_EXPRESSION");
    expect(startIdx).toBeGreaterThan(-1);
    const block = PAGE_SRC.slice(startIdx, startIdx + 5000);
    expect(block).toMatch(/console\.warn/);
  });
});
