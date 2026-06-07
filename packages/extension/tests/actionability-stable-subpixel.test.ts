/**
 * Author: 青蛙
 * Description: Regression lock for 缺陷③: 严格 1-RAF === stable 检查
 *   在淘宝子像素 reflow 下永远 NOT_STABLE。
 *
 * Trigger: v4 评价信息操作深度评测（淘宝）— 评价页 click 永远 NOT_STABLE,
 *   唯一出口 options={force:true, timeout:10000} 破坏"无需人工调优"承诺。
 *
 * 根因（spec 决定）: actionability.ts:223-241 注释自承
 *   "No tolerance: any sub-pixel movement counts as not-stable
 *    (spec drops the original '< 1px' tolerance)."
 *
 * L2-spec 决策 (2026-06-07 KB 评审): 选 A — 恢复 0.5px 容差,
 *   与 Playwright actionability 对齐。spec §7.2 同步改写。
 *
 * Why: 子像素 reflow 是现代 SPA 的常态 (淘宝/京东/Ant Design 等), 严格
 * === 误判率极高。0.5px 是浏览器子像素抗锯齿的常规噪声阈值, 不破坏
 * "consecutive 2 RAF samples" 框架 (§1.3 不变)。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

// Mock loadPageSideModule as a no-op so chrome.scripting.executeScript({ files }) is bypassed.
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACT_TS = readFileSync(
  join(__dirname, "..", "src", "page-side", "actionability.ts"),
  "utf8",
);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("缺陷③: stable 检查 0.5px 容差 (L2-spec 决策 A, 2026-06-07 淘宝评测)", () => {
  // ============================================================
  // 现有行为保留测试 — 修复不应破坏既有逻辑
  // ============================================================

  it("现有 isStable 注释引用 L2-spec §7.2 仍保留 (改写后)", () => {
    // 注释应明示 0.5px 容差 + 引用 L2-spec §7.2 新文
    expect(ACT_TS).toMatch(/L2-spec §7\.2/);
  });

  it("现有 I5 测试覆盖的 10px 步进动画仍应 NOT_STABLE (大于容差, 不破坏)", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const dom: JSDOM = setupActionabilityEnv({
      html: '<button id="btn">Click</button>',
    });
    const btn = dom.window.document.getElementById("btn")!;

    Object.defineProperty(dom.window.document, "elementFromPoint", {
      value: (_x: number, _y: number) => btn,
      writable: true,
      configurable: true,
    });

    // 10px 步进 — 远超 0.5px 容差, 应 NOT_STABLE
    let callCount = 0;
    vi.spyOn(btn, "getBoundingClientRect").mockImplementation(() => {
      callCount++;
      return {
        top: callCount * 10,
        left: 0,
        width: 100,
        height: 40,
        right: 100,
        bottom: callCount * 10 + 40,
        x: 0,
        y: callCount * 10,
        toJSON: () => ({}),
      } as DOMRect;
    });

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const [res] = await Promise.all([
      checkActionability(1, undefined, "#btn"),
      vi.runAllTimersAsync(),
    ]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("NOT_STABLE");
  });

  // ============================================================
  // 新行为测试 — 修复应新增这些逻辑
  // ============================================================

  it("新行为 1: 0.3px sub-pixel 漂动 (典型 reflow) 应判稳定 (核心修复)", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const dom: JSDOM = setupActionabilityEnv({
      html: '<button id="btn">Click</button>',
    });
    const btn = dom.window.document.getElementById("btn")!;

    Object.defineProperty(dom.window.document, "elementFromPoint", {
      value: (_x: number, _y: number) => btn,
      writable: true,
      configurable: true,
    });

    // callCount 序列: 1=early visible probe, 2=isStable r1, 3=isStable r2
    // 让 r1 (callCount===2) y=100, r2 (callCount===3) y=100.3 → 0.3px 漂动 ≤ 0.5 容差 → STABLE
    let callCount = 0;
    vi.spyOn(btn, "getBoundingClientRect").mockImplementation(() => {
      callCount++;
      const dy = callCount === 3 ? 0.3 : 0;
      return {
        top: 100 + dy,
        left: 0,
        width: 100,
        height: 40,
        right: 100,
        bottom: 140 + dy,
        x: 0,
        y: 100 + dy,
        toJSON: () => ({}),
      } as DOMRect;
    });

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const [res] = await Promise.all([
      checkActionability(1, undefined, "#btn"),
      vi.runAllTimersAsync(),
    ]);
    // 修复后: 0.3px ≤ 0.5px 容差 → 判稳定 → res.ok = true
    expect(res.ok).toBe(true);
  });

  it("新行为 2: 0.51px 漂动 (> 容差) 应判 NOT_STABLE (边界保护)", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const dom: JSDOM = setupActionabilityEnv({
      html: '<button id="btn">Click</button>',
    });
    const btn = dom.window.document.getElementById("btn")!;

    Object.defineProperty(dom.window.document, "elementFromPoint", {
      value: (_x: number, _y: number) => btn,
      writable: true,
      configurable: true,
    });

    // callCount 序列同上: r1=100, r2=100.51 → 0.51px > 0.5 容差 → NOT_STABLE
    let callCount = 0;
    vi.spyOn(btn, "getBoundingClientRect").mockImplementation(() => {
      callCount++;
      const dy = callCount === 3 ? 0.51 : 0;
      return {
        top: 100 + dy,
        left: 0,
        width: 100,
        height: 40,
        right: 100,
        bottom: 140 + dy,
        x: 0,
        y: 100 + dy,
        toJSON: () => ({}),
      } as DOMRect;
    });

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const [res] = await Promise.all([
      checkActionability(1, undefined, "#btn"),
      vi.runAllTimersAsync(),
    ]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("NOT_STABLE");
  });

  it("新行为 3: 源码应使用 0.5 容差 (invariant)", () => {
    // 期望源码包含 Math.abs(... ) <= 0.5 形式
    const idx = ACT_TS.search(/function isStable/);
    expect(idx, "未找到 isStable 函数").toBeGreaterThan(0);
    const slice = ACT_TS.slice(idx, idx + 800);
    // 应包含 Math.abs (容差比较的标志)
    expect(slice).toMatch(/Math\.abs/);
    // 应包含 0.5 (容差值)
    expect(slice).toMatch(/0\.5/);
    // 不应再有严格 === 比对 (核心修复点)
    expect(slice).not.toMatch(/r1\.x === r2\.x[\s\S]{0,100}?r1\.y === r2\.y/);
  });
});
