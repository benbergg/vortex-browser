/**
 * Author: 青蛙
 * Description: Regression lock for 缺陷②: 默认 scope=viewport 静默过滤
 *   `left:-9999px` 可交互元素 → agent 失去交互入口。
 *
 * Trigger: v4 评价信息操作深度评测（淘宝）— 15 个细颗粒度评分 label
 *   (描述/服务/物流 × 5星) 用 CSS 离屏技术
 *   `<label class="rate-stars" style="position:absolute; left:-9999px">...</label>`
 *   → 默认 scope=viewport 时 `rect.right < 0` → 静默过滤 → agent
 *   在 observe 输出里看不到这 15 个评分, 只能 fallback CSS selector。
 *
 * 修法（评审建议 #1, 放弃 #3 checkVisibility）: 分 `[on-screen]` /
 * `[off-screen-but-actionable]` 两类输出 — 元素不丢, 加 `offScreenActionable`
 * 标记字段供 agent 区分。判定: `position: absolute|fixed` + `left|right`
 * 巨大值 (CSS a11y-hidden 模式) = visually-hidden actionable, 保留。
 *
 * Why: 这是族级原语问题（observe off-screen 召回）— 不限于淘宝, 任何用
 * CSS 离屏技术做 a11y-hidden 但保留可交互的网站都受影响 (GitHub、
 * MDN、Ant Design demo、Element Plus 文档等)。
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("缺陷②: 默认 scope=viewport 静默过滤 left:-9999px 可交互元素 (2026-06-07 淘宝评测)", () => {
  // ============================================================
  // 现有行为保留测试 — 修复不应破坏既有逻辑
  // ============================================================

  it("现有 inViewport 严格过滤对纯离屏元素仍生效 (非 visually-hidden actionable)", () => {
    // 现有 line 1307-: rect 与 viewport 边界 + mode=='visible' 过滤
    expect(OBSERVE_SRC).toMatch(
      /const inViewport =[\s\S]{0,200}?rect\.top < window\.innerHeight[\s\S]{0,300}?rect\.right > 0;/,
    );
    // 过滤条件现在多行, 用 [\s\S]+? 容忍换行
    expect(OBSERVE_SRC).toMatch(
      /if \([\s\S]+?mode === "visible"[\s\S]+?!inViewport[\s\S]+?continue;/,
    );
  });

  it("现有 checkVisibility 门仍保留 (2026-06-02 dogfood 修 content-visibility:hidden)", () => {
    expect(OBSERVE_SRC).toMatch(
      /htmlEl\.checkVisibility\(\)[\s\S]{0,100}?continue;/,
    );
  });

  // ============================================================
  // 新行为测试 — 修复应新增这些逻辑
  // ============================================================

  it("新行为 1: inViewport 检查后应增加 visually-hidden actionable 判定,豁免 CSS 离屏技术元素", () => {
    // 视觉隐藏可交互判定: position:absolute|fixed + left/right 巨大值
    // (CSS a11y-hidden 模式, GitHub/MDN/Ant Design/淘宝等同用)
    // 判定后应不 continue, 而保留元素 + 标记 offScreenActionable
    // 找 visually-hidden actionable 判定标识符 (在 continue 之前)
    const vhaIdx = OBSERVE_SRC.search(/visuallyHiddenActionable/);
    expect(vhaIdx, "未找到 visuallyHiddenActionable 标识符").toBeGreaterThan(0);
    // 截取前 500 字符, 应包含 position/left/right 判定
    const slice = OBSERVE_SRC.slice(Math.max(0, vhaIdx - 800), vhaIdx + 100);
    expect(slice).toMatch(/position[\s\S]{0,40}?absolute|fixed/);
    expect(slice).toMatch(/left|right/);
    // continue 语句应同时含 visuallyHiddenActionable (豁免条件)
    expect(OBSERVE_SRC).toMatch(
      /!visuallyHiddenActionable[\s\S]{0,30}?continue/,
    );
  });

  it("新行为 2: observe 元素输出应包含 offScreenActionable 字段, 区分 on-screen 与 off-screen-but-actionable", () => {
    // 元素 push 时应带 offScreenActionable 标记
    // 期望出现在 elements.push(...) 调用前/内的某处
    const idx = OBSERVE_SRC.search(/elements\.push\(\{/);
    expect(idx, "未找到 elements.push 位置").toBeGreaterThan(0);
    const slice = OBSERVE_SRC.slice(idx, idx + 800);
    expect(slice).toMatch(/offScreenActionable/);
  });

  it("新行为 3: 纯离屏(非 visually-hidden actionable)元素仍应被过滤,不破坏现有降噪", () => {
    // 现有 continue 逻辑在 visually-hidden actionable 不命中时仍生效
    // 这里测试的是"inViewport=false && !visuallyHidden" 应 continue
    // 由于这是 negative case, 实际我们测: 源码中 inViewport 严格过滤
    // 语句仍在 (现有测试已覆盖)。本测试确认 visually-hidden 豁免逻辑
    // 不会**完全替换**严格过滤 — 而是在它之上增加豁免。
    const hasStrictFilter = OBSERVE_SRC.match(
      /if \([\s\S]+?mode === "visible"[\s\S]+?!inViewport[\s\S]+?continue;/,
    );
    expect(hasStrictFilter, "严格 inViewport 过滤被完全替换, 破坏现有行为").toBeTruthy();
  });

  it("新行为 4: visually-hidden actionable 元素不走遮挡检测 (因为离屏不可能遮挡)", () => {
    // 遮挡检测 (line 1316+) 应只在 inViewport=true 时执行
    // visually-hidden actionable 元素 inViewport=false, 不该被遮挡检测
    // 期望: 遮挡检测逻辑前置 `if (inViewport) { ... }` 守卫仍在
    expect(OBSERVE_SRC).toMatch(/if \(inViewport\) \{[\s\S]{0,800}?deepElementFromPoint/);
  });
});
