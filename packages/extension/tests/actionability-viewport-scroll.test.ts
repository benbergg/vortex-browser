// Regression lock for the below-the-fold act-deadlock fix
// (多 agent 审计 2026-06-04, Finding P1-1, LIVE 确认).
//
// 现象:vortex_act(click) 点视口外(折叠线下,如 y=4000)的普通元素 → 死锁
// TIMEOUT(OBSCURED)。元素 checkVisibility 为 true(已渲染只是离屏,非
// content-visibility skip),enabled、editable 全过,但中心点 (cx,cy) 落在视口外
// → deepElementFromPoint 返回 null → receivesEvents 报 elementFromPoint=null →
// OBSCURED,重试到 5s 预算耗尽抛 TIMEOUT,**全程不 scrollIntoView**。实测 y=4000
// 按钮 act click 5088ms TIMEOUT、scrollY 始终 0、未点中。触发面最广(任何长页
// 下方元素)。
//
// 修复:probe 在 visible/enabled/editable 通过后、receivesEvents hit-test 之前,
// 若中心点出视口(cx/cy < 0 或 > innerWidth/innerHeight)则 scrollIntoView
// ({block:center,inline:center}) 把元素带进视口,重算 rect/中心点,使 occlusion
// hit-test 作用于可点中的元素。复用 content-visibility un-skip 的滚动模式。
//
// jsdom 不实现真实滚动,故 per-element mock getBoundingClientRect(有状态:
// scrollIntoView 调用后翻转为视口内 rect)+ scrollIntoView spy。

import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

// 视口外(折叠线下)rect:y=4000,中心 cy=4010 >> innerHeight(768)。
const OFFSCREEN: DOMRect = {
  x: 10, y: 4000, width: 50, height: 20,
  top: 4000, left: 10, right: 60, bottom: 4020, toJSON: () => ({}),
} as DOMRect;
// 滚进视口后:y=100,中心在视口内。
const INVIEW: DOMRect = {
  x: 10, y: 100, width: 50, height: 20,
  top: 100, left: 10, right: 60, bottom: 120, toJSON: () => ({}),
} as DOMRect;

describe("actionability 视口外元素 scrollIntoView 防死锁 (2026-06-04 审计 P1-1)", () => {
  it("把折叠线下(中心出视口)的目标滚进视口后通过", async () => {
    vi.resetModules();

    const html = `<button id="far" style="position:absolute;top:4000px">Far</button>`;
    let target: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      elementFromPoint: () => target, // 滚动后中心点 hit-test 命中目标
    });
    target = dom.window.document.getElementById("far");
    const el = target as any;

    let scrolled = false;
    el.scrollIntoView = vi.fn(() => {
      scrolled = true;
    });
    // 已渲染只是离屏 → checkVisibility 恒 true(非 content-visibility skip)。
    el.checkVisibility = () => true;
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() =>
      scrolled ? INVIEW : OFFSCREEN,
    );

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#far");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);

    vi.restoreAllMocks();
  });

  it("不滚动已在视口内的元素(中心点在视口内)", async () => {
    vi.resetModules();

    const html = `<button id="near">Near</button>`;
    let target: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({ html, elementFromPoint: () => target });
    target = dom.window.document.getElementById("near");
    const el = target as any;

    el.scrollIntoView = vi.fn();
    el.checkVisibility = () => true;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(INVIEW);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#near");
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);

    vi.restoreAllMocks();
  });
});
