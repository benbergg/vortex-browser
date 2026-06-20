import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * observe buildSelector 的 data-testid 选择器转义回归锁(CWE-116 不完整转义,
 * CodeQL security-extended 捕获 + 白盒实机复现,2026-06-20)。
 *
 * 现象:`[${attr}="${testId.replace(/"/g,'\\"')}"]` 只转义引号、不转义反斜杠。page 可控的
 *   data-testid 含 `\` 时 CSS 把 `\x` 当转义符 → 选择器错配(实测 `a\b`:旧选择器匹配 0;
 *   若去转义后的值与他元素 testid 碰撞且唯一,则 buildSelector 返回指向**错误元素**的
 *   selector = silent wrong-target)。同函数 aria-label 路径(observe.ts ~1023)已正确先转
 *   义反斜杠再转义引号,二者不对称(sibling-path asymmetry)。
 *
 * 修复:testid 路径对齐 aria-label,先 `replace(/\\/g,"\\\\")` 再 `replace(/"/g,'\\"')`。
 * buildSelector 内联在 observe page-side executeScript func 中不可 import,故:
 *   ① source-lock 锁住 observe.ts 该行用「反斜杠先于引号」转义;
 *   ② JSDOM 行为验证转义后的选择器能精确命中含反斜杠 testid 的元素。
 */
const OBSERVE_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe data-testid 选择器反斜杠转义(CWE-116)", () => {
  it("source-lock:testid 选择器先转义反斜杠再转义引号", () => {
    // 反斜杠转义(/\\/g → \\\\)必须出现在 testSel 构造中。
    expect(OBSERVE_SRC).toMatch(
      /testSel\s*=\s*`\[\$\{attr\}="\$\{testId\.replace\(\/\\\\\/g,\s*"\\\\\\\\"\)\.replace\(\/"\/g,\s*'\\\\"'\)\}"\]`/,
    );
  });

  it("行为验证:正确转义的选择器精确命中含反斜杠 testid 的元素", () => {
    const dom = new JSDOM("<!DOCTYPE html><body></body>", { url: "https://x/" });
    const doc = dom.window.document;
    const el = doc.createElement("div");
    el.setAttribute("data-testid", "a\\b"); // 真实值 a\b
    doc.body.appendChild(el);
    // 干扰元素:去转义后的值 ab(旧 bug 会错配到它)
    const decoy = doc.createElement("div");
    decoy.setAttribute("data-testid", "ab");
    doc.body.appendChild(decoy);

    const testId = "a\\b";
    const fixedSel = `[data-testid="${testId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    const oldSel = `[data-testid="${testId.replace(/"/g, '\\"')}"]`;

    // 修复版:精确命中真实元素,不含 decoy
    const fixedHits = Array.from(doc.querySelectorAll(fixedSel));
    expect(fixedHits).toHaveLength(1);
    expect(fixedHits[0]).toBe(el);
    expect(fixedHits).not.toContain(decoy);

    // 旧版(漏转义反斜杠):CSS 把 `\b` 当转义符 → 绝不命中真实元素 a\b(两引擎一致),
    // 错配到 0 个或 decoy(ab)——无论哪种都不是真实元素,即 silent wrong/miss target。
    const oldHits = Array.from(doc.querySelectorAll(oldSel));
    expect(oldHits).not.toContain(el);
  });
});
