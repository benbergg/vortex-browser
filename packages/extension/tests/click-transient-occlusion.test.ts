/**
 * Author: qingwa
 * Description: BUG-012 N0060 京东选品评测 V1
 *   vortex click 识别 transient overlay (react-virtuoso 动画层兼容)。
 *   京东家电/服饰评价区使用 react-virtuoso 虚拟列表, 容器与 viewport 间
 *   有"动画覆盖层" (opacity/transform 动画 + aria-hidden 容器),
 *   elementFromPoint(cx, cy) 命中动画覆盖层 → vortex click 误报
 *   ELEMENT_OCCLUDED。评测原本用 vortex_evaluate + scrollIntoView + click
 *   三步手动绕过; 修复后 vortex click 放行 transient 覆盖层。
 *
 *   抽 isTransient 纯函数 (TDD 可在 jsdom 上验证):
 *     - opacity < 0.99 → true (动画中)
 *     - transform 含 matrix → true (translate/scale 动画)
 *     - aria-hidden="true" → true (react-virtuoso 评价项未到视口时标)
 *   三条件任一命中 → transient, click probe 放行。
 *   真遮挡场景 (弹层遮罩) 仍正常报 ELEMENT_OCCLUDED。
 *
 * Why source-level + jsdom: 检测逻辑是 computed style + 属性, 用 jsdom 元素
 *   直接调用 isTransient 验证 4 个判定场景, 不需 chrome extension runtime。
 *   集成测试通过 dom.ts 源码级 contract 验证 isTransient 在 click probe 中
 *   被正确调用 (在 isInteractiveEl 失败后追加 isTransient 放行门)。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isTransient } from "../src/handlers/dom.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOM_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "dom.ts"),
  "utf8",
);

describe("isTransient (BUG-012 N0060 京东评测 react-virtuoso 兼容)", () => {
  beforeEach(() => {
    const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement =
      dom.window.HTMLElement;
    (globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle =
      dom.window.getComputedStyle.bind(dom.window);
  });

  it("opacity < 0.99 → transient (react-virtuoso 评价项淡入动画)", () => {
    const el = document.createElement("div");
    el.style.opacity = "0.5";
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(true);
  });

  it("opacity < 0.99 边界值 0.98 → transient", () => {
    const el = document.createElement("div");
    el.style.opacity = "0.98";
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(true);
  });

  it("transform 含 matrix → transient (react-virtuoso viewport translate3d 滚动)", () => {
    const el = document.createElement("div");
    el.style.transform = "matrix(1, 0, 0, 1, 0, 10)";
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(true);
  });

  it("aria-hidden='true' → transient (react-virtuoso 评价项未到视口时标)", () => {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(true);
  });

  it("普通 div (opacity=1, transform=none, 无 aria-hidden) → 不 transient", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(false);
  });

  it("opacity=1, transform=none, aria-hidden='false' → 不 transient (淘宝遮挡弹层场景)", () => {
    // 真遮挡: opacity=1, transform=none (无动画), aria-hidden="false"
    // (京东物流弹层遮罩 / 淘宝 fixed 遮罩特征) — 必须不被误判为 transient,
    // 否则真遮挡场景不报 ELEMENT_OCCLUDED, 评测无法识别弹层存在
    const el = document.createElement("div");
    el.style.opacity = "1";
    el.style.transform = "none";
    el.setAttribute("aria-hidden", "false");
    document.body.appendChild(el);

    expect(isTransient(el)).toBe(false);
  });
});

describe("click probe 集成: isTransient 在 vortex click 中放行 (BUG-012 N0060)", () => {
  it("dom.ts click probe 调用 isTransient 放行 transient overlay", () => {
    // 点击 occluded 检测逻辑必须新增 isTransient(topEl) 调用 + 放行分支
    expect(DOM_SRC).toMatch(/isTransient/);
  });

  it("dom.ts 已 export isTransient 纯函数 (供其它模块 + 单测复用)", () => {
    expect(DOM_SRC).toMatch(/export\s+function\s+isTransient/);
  });

  it("click probe 中 isTransientInline(topEl) 调用在 isInteractiveEl 函数定义之后 (不破坏淘宝 el-select carve-out)", () => {
    // 验证 click probe 内 isTransientInline(topEl) 调用位置在 isInteractiveEl
    // 函数定义之后 (顺序敏感, 否则会破坏现有 sameWidgetDecoration 路径)。
    // 注:probe 内用的是 isTransient 的**内联副本** isTransientInline——
    // executeScript 注入丢模块作用域,裸引用模块级 isTransient 会
    // ReferenceError(2026-06-10 spike 实测 P0,行为级守护见
    // tests/click-synthetic-inline-scope.test.ts)。
    const interactiveDefIdx = DOM_SRC.indexOf("isInteractiveEl = (x: Element)");
    const transientCallIdx = DOM_SRC.indexOf("isTransientInline(topEl)");
    expect(interactiveDefIdx).toBeGreaterThan(-1);
    expect(transientCallIdx).toBeGreaterThan(-1);
    expect(transientCallIdx).toBeGreaterThan(interactiveDefIdx);
  });
});
