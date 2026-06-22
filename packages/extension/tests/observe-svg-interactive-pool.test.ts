// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");

// 2026-06-22 APG/recharts dogfood:observe fallbackPool 选择器 `*:not(svg *)` 把所有
// svg 后代整类排除,带交互信号(role/onclick/直绑 listener/可聚焦)的 svg 子元素
// (recharts/d3 可点 rect·circle、流程图形状、地图区域)被整类漏召回——act 侧
// SVG click 崩溃(click-synthetic-inline-scope SVG 用例)的 observe 对偶。
// 此处 source-lock 内联补集查询 + 接线,防回退(scan 在 MAIN world inline,无法常规单测)。
describe("observe SVG 交互元素补集(fallbackPool :not(svg *) 漏召回修复)", () => {
  it("存在 svgInteractivePool 补集查询(仅带信号的 svg 后代)", () => {
    expect(SRC).toContain("const svgInteractivePool = querySelectorAllDeep(");
    // 信号选择器:role / onclick / 直绑 listener 标记 / 可聚焦
    expect(SRC).toContain("svg [role],svg [onclick],svg [data-vtx-listener],svg [tabindex]:not([tabindex='-1'])");
  });

  it("fallback 收集循环把 svgInteractivePool 并入迭代", () => {
    expect(SRC).toContain("for (const el of [...Array.from(fallbackPool), ...Array.from(svgInteractivePool)])");
  });

  it("尺寸门对 SVG(无 offsetWidth)退回 getBoundingClientRect", () => {
    expect(SRC).toContain('if (typeof htmlEl.offsetWidth === "number")');
    expect(SRC).toContain("const __r = el.getBoundingClientRect();");
  });

  it("主 fallbackPool 仍保留 :not(svg *) 排除(补集为加性,不改原噪声治理)", () => {
    expect(SRC).toContain("*:not(svg *):not(script):not(style):not(meta):not(link):not(head):not(head *)");
  });
});
