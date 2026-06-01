// Regression lock for the composite-widget OBSCURED false-positive carve-out
// (element-plus.org el-select dogfood 2026-06-01).
//
// 现象:vortex_act(click) 点 Element Plus el-select 报 OBSCURED 超时。el-select
// 的 [role=combobox] 是一个透明 `<input class="el-select__input">`,可见的
// `.el-select__placeholder` 显示层作为兄弟节点叠在其上。actionability 在 input
// 中心 hit-test 命中 placeholder——既非 target 也非其后代——误判 OBSCURED,
// 阻断了经 combobox ref 操作 el-select。
//
// 修复:receivesEvents carve-out——hit 自身非交互(无 role/tabindex/非控件标签)
// 且与 target 同处一个交互 widget 容器(el 的最近交互祖先 contains hit)→ 同
// widget 装饰层,不算 obscured。foreign 模态在 widget 之外,contains 为 false,
// OBSCURED 保持(I6 invariant 不回归)。
//
// jsdom does not implement elementFromPoint — mock required (mirror of I6).

import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

describe("actionability composite-widget cover — el-select OBSCURED carve-out (2026-06-01 element-plus dogfood)", () => {
  it("does NOT report OBSCURED when a non-interactive sibling decoration of the same widget covers the target", async () => {
    vi.resetModules();

    // el-select 结构缩影:wrapper(tabindex=-1,点击宿主)同时包含透明真 input
    // (role=combobox)与显示层 placeholder(无 role/tabindex)。
    const html = `
      <div id="wrap" class="el-select__wrapper" tabindex="-1">
        <div class="el-select__selection">
          <div id="ph" class="el-select__placeholder">Select</div>
          <div class="el-select__selected-item el-select__input-wrapper">
            <input id="combo" role="combobox" tabindex="0" class="el-select__input" />
          </div>
        </div>
      </div>
    `;

    let phRef: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      // 命中显示层兄弟 placeholder,而非透明 input。
      elementFromPoint: (_x: number, _y: number) => phRef,
    });
    phRef = dom.window.document.getElementById("ph");

    const combo = dom.window.document.getElementById("combo")!;
    vi.spyOn(combo, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 10,
      width: 166,
      height: 24,
      right: 176,
      bottom: 34,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#combo");
    expect(res.reason).not.toBe("OBSCURED");
    expect(res.ok).toBe(true);

    vi.restoreAllMocks();
  });

  it("still reports OBSCURED when a foreign overlay (outside the target widget) covers a bare button", async () => {
    // I6 同形:foreign overlay 非交互但在 target widget 之外,carve-out 不应放行。
    vi.resetModules();

    const html = `
      <div id="overlay" style="position:fixed;top:0;left:0;width:200px;height:200px;z-index:999">Overlay</div>
      <button id="btn" style="position:absolute;top:10px;left:10px;width:100px;height:40px">Click</button>
    `;

    let overlayRef: Element | null = null;
    const dom: JSDOM = setupActionabilityEnv({
      html,
      elementFromPoint: (_x: number, _y: number) => overlayRef,
    });
    overlayRef = dom.window.document.getElementById("overlay");

    const btn = dom.window.document.getElementById("btn")!;
    vi.spyOn(btn, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 10,
      width: 100,
      height: 40,
      right: 110,
      bottom: 50,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");

    const res = await checkActionability(1, undefined, "#btn");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("OBSCURED");

    vi.restoreAllMocks();
  });
});
