// Regression lock for the content-visibility:auto act-deadlock fix
// (content-visibility 离屏渲染 dogfood 2026-06-01, Finding R2).
//
// 现象:vortex_act(click) 点 content-visibility:auto 处于 skip 态(离屏)的元素 →
// 死锁 TIMEOUT(NOT_VISIBLE)。元素一旦 scrollIntoView un-skip 即完全可交互。
// 根因:actionability isVisible 用 checkVisibility({contentVisibilityAuto:true}),对
// skip 态返 false → NOT_VISIBLE,而 probe 在 visibility 门前不滚动 → 元素永不进视口
// un-skip → 死锁。普通离屏元素 checkVisibility=true(已渲染只是离屏)不受影响。
//
// 修复:probe 在 isAttached 之后、isVisible 之前,用判别式
// (checkVisibility({contentVisibilityAuto:true})===false && {contentVisibilityAuto:false}===true)
// 识别 cv-auto skip,scrollIntoView un-skip,使后续 visible/stable/occlusion 检查作用于
// 已渲染元素。display:none 等真隐藏两变体皆 false,不滚动(保持 NOT_VISIBLE)。
//
// jsdom 不实现 checkVisibility / content-visibility,故 per-element mock checkVisibility +
// scrollIntoView(有状态:scrollIntoView 调用后翻转 un-skip,模拟真实渲染)。

import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

function rect(unskipped: boolean): DOMRect {
  return unskipped
    ? ({ x: 10, y: 10, width: 50, height: 20, top: 10, left: 10, right: 60, bottom: 30, toJSON: () => ({}) } as DOMRect)
    : ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
}

describe("actionability content-visibility:auto un-skip (2026-06-01 dogfood R2)", () => {
  it("scrolls a content-visibility:auto-skipped target into view, then passes", async () => {
    vi.resetModules();

    const html = `<button id="cv" style="position:absolute;top:9000px">CV</button>`;
    let target: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      elementFromPoint: () => target, // un-skip 后 hit-test 命中目标
    });
    target = dom.window.document.getElementById("cv");
    const el = target as any;

    // 有状态 mock:skip 态(未滚动)→ checkVisibility(cvAuto:true)=false / rect 0×0;
    // scrollIntoView 触发 un-skip → 翻转为可见 + 真 rect。
    let unskipped = false;
    el.scrollIntoView = vi.fn(() => {
      unskipped = true;
    });
    el.checkVisibility = (opts: any = {}) => {
      if (opts.contentVisibilityAuto === false) return true; // 忽略 cv-auto skip → 本应可见
      return unskipped; // cvAuto:true(skip 计为不可见)→ 仅 un-skip 后可见
    };
    vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => rect(unskipped));

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#cv");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);

    vi.restoreAllMocks();
  });

  it("does NOT scroll a truly hidden (display:none) element — stays NOT_VISIBLE", async () => {
    vi.resetModules();

    const html = `<button id="hid">Hidden</button>`;
    const dom: JSDOM = setupActionabilityEnv({ html, elementFromPoint: () => null });
    const el = dom.window.document.getElementById("hid") as any;

    el.scrollIntoView = vi.fn();
    el.checkVisibility = () => false; // display:none → 两变体皆 false
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(false));

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#hid");
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("NOT_VISIBLE");

    vi.restoreAllMocks();
  });

  it("does NOT scroll an already-visible element (no content-visibility skip)", async () => {
    vi.resetModules();

    const html = `<button id="vis">Visible</button>`;
    let target: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({ html, elementFromPoint: () => target });
    target = dom.window.document.getElementById("vis");
    const el = target as any;

    el.scrollIntoView = vi.fn();
    el.checkVisibility = () => true; // 已可见 → 判别式不命中
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(rect(true));

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#vis");
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);

    vi.restoreAllMocks();
  });
});
