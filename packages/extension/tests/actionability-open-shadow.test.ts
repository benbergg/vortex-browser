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
});

describe("actionability open-shadow deep resolution (Tier 2)", () => {
  it("open-shadow-internal 元素经 findInOpenShadow 解析为可操作（rect+efp 给定）", async () => {
    vi.resetModules();
    const dom = setupActionabilityEnv({
      html: '<div id="host"></div>',
      // efp 返回 shadow button，模拟「目标接收事件」（非遮挡）
      elementFromPoint: () => (globalThis as any).__shadowBtn ?? null,
    });
    const host = dom.window.document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    const btn = dom.window.document.createElement("button");
    btn.textContent = "影子按钮";
    sr.appendChild(btn);
    (globalThis as any).__shadowBtn = btn;
    // jsdom 无 layout：给 shadow button 一个非零 rect，使可见性检查通过。
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
    const dom = setupActionabilityEnv({
      html: '<div id="host"></div>',
      elementFromPoint: () => (globalThis as any).__shadowBtn ?? null,
    });
    const sr1 = dom.window.document.getElementById("host")!.attachShadow({ mode: "open" });
    const inner = dom.window.document.createElement("div");
    sr1.appendChild(inner);
    const sr2 = inner.attachShadow({ mode: "open" });
    const btn = dom.window.document.createElement("button");
    sr2.appendChild(btn);
    (globalThis as any).__shadowBtn = btn;
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
