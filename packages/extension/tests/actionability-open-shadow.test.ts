// Tier 2（act/extract 穿透 open shadow）：act on an open-shadow-internal element 现在
// 能解析到该元素并继续可操作性检查，而非 #27 的 OPEN_SHADOW_DOM 快速失败。
//
// 演进：#27（PR #29）让 shadow ref act 快速失败（probe 返 OPEN_SHADOW → OPEN_SHADOW_DOM），
// 替代 5s hang。Tier 2 让 probe 经 findInOpenShadow 真正解析到元素 → 可操作。
// 本测试锁定新行为：probe 命中 shadow 元素（不再 OPEN_SHADOW / NOT_ATTACHED）。

import { describe, it, expect, afterEach, vi } from "vitest";
import { VtxErrorCode } from "@bytenew/vortex-shared";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as any).__shadowBtn = undefined;
  (globalThis as any).__shadowHost = undefined;
  (globalThis as any).__outerHost = undefined;
});

describe("actionability open-shadow deep resolution (Tier 2)", () => {
  it("open-shadow-internal 元素经 findInOpenShadow 解析为可操作（rect+efp 给定）", async () => {
    vi.resetModules();
    // 模拟真实浏览器行为：document.elementFromPoint 返回 shadow HOST（composed 树顶重定向），
    // 而非 shadow 内部元素。deepElementFromPoint 需下钻 host.shadowRoot.elementFromPoint
    // 才能拿到真实命中元素（button）。此模拟在修复前会触发 OBSCURED → TIMEOUT。
    const dom = setupActionabilityEnv({
      html: '<div id="host"></div>',
      // document.elementFromPoint 返回 shadow host（真实浏览器 composed 树重定向行为）
      elementFromPoint: () => (globalThis as any).__shadowHost ?? null,
    });
    const host = dom.window.document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    const btn = dom.window.document.createElement("button");
    btn.textContent = "影子按钮";
    sr.appendChild(btn);
    (globalThis as any).__shadowHost = host;
    // jsdom ShadowRoot 无 elementFromPoint；注入模拟：返回 shadow button（下钻一层后命中目标）
    Object.defineProperty(sr, "elementFromPoint", {
      value: () => btn,
      configurable: true,
    });
    // jsdom 无 layout：给 host 和 shadow button 非零 rect，使可见性检查和坐标中点计算正常。
    host.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 40, height: 20, top: 10, left: 10, right: 50, bottom: 30 } as DOMRect);
    btn.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 40, height: 20, top: 10, left: 10, right: 50, bottom: 30 } as DOMRect);

    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    // 解析成功 → waitActionable resolve（无 throw，返回 WaitOk { ok: true, rect }）。
    await expect(
      waitActionable(1, undefined, "button", { timeout: 2000 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("嵌套两层 open shadow 也能解析（递归 walk）", async () => {
    vi.resetModules();
    // 模拟两层嵌套 shadow 的真实重定向：
    //   document.elementFromPoint → outerHost（composed 顶层重定向）
    //   outerHost.shadowRoot.elementFromPoint → innerHost（第二层 host）
    //   innerHost.shadowRoot.elementFromPoint → btn（真实命中元素）
    const dom = setupActionabilityEnv({
      html: '<div id="host"></div>',
      // document.elementFromPoint 返回外层 shadow host（真实浏览器行为）
      elementFromPoint: () => (globalThis as any).__outerHost ?? null,
    });
    const outerHost = dom.window.document.getElementById("host")!;
    const sr1 = outerHost.attachShadow({ mode: "open" });
    const inner = dom.window.document.createElement("div");
    sr1.appendChild(inner);
    const sr2 = inner.attachShadow({ mode: "open" });
    const btn = dom.window.document.createElement("button");
    sr2.appendChild(btn);
    (globalThis as any).__outerHost = outerHost;
    // sr1.elementFromPoint 下钻返回 inner（中间 host）
    Object.defineProperty(sr1, "elementFromPoint", {
      value: () => inner,
      configurable: true,
    });
    // sr2.elementFromPoint 下钻返回 btn（最终命中目标）
    Object.defineProperty(sr2, "elementFromPoint", {
      value: () => btn,
      configurable: true,
    });
    outerHost.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 40, height: 20, top: 10, left: 10, right: 50, bottom: 30 } as DOMRect);
    inner.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 40, height: 20, top: 10, left: 10, right: 50, bottom: 30 } as DOMRect);
    btn.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 40, height: 20, top: 10, left: 10, right: 50, bottom: 30 } as DOMRect);

    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    await expect(
      waitActionable(1, undefined, "button", { timeout: 2000 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("真实缺失元素（无 light 无 shadow）仍 NOT_ATTACHED → TIMEOUT", async () => {
    vi.resetModules();
    const dom = setupActionabilityEnv({ html: "<div id='x'></div>" });
    void dom;
    (globalThis as any).__shadowBtn = null;

    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    let caught: any;
    await waitActionable(1, undefined, "button", { timeout: 150 }).catch((e) => {
      caught = e;
    });
    expect(caught).toBeDefined();
    expect(caught.code).toBe(VtxErrorCode.TIMEOUT);
  });
});
