// force 选项 — 跳过 actionability 质量门(visible/enabled/editable/obscured),
// 但仍要求元素 attached(对齐 Playwright force 语义 + 让公开 schema options.force 诚实)。
//
// 背景(2026-06-04 借鉴 Stagehand H 族 google_flights force 任务):公开 schema
// 暴露 options.force,但 dom.ts 的 waitActionable 从不读 args.force → force 是 no-op
// (E2E 实测:force fill 全覆盖 input 仍报 OBSCURED/TIMEOUT,value 空)。本次补实现。
//
// 设计:force 在 attached 检查后跳过 visible/enabled/editable/receivesEvents(OBSCURED)
// 门,仍 scrollIntoView + 取 rect 返回;元素不存在仍 NOT_ATTACHED(force 不凭空造元素)。

import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

// 视口内 rect(不触发 scrollIntoView)。
const INVIEW: DOMRect = {
  x: 10, y: 100, width: 50, height: 20,
  top: 100, left: 10, right: 60, bottom: 120, toJSON: () => ({}),
} as DOMRect;

describe("actionability force 跳过质量门 (H 族 force, 2026-06-04)", () => {
  it("非 force:elementFromPoint 命不中目标 → OBSCURED", async () => {
    vi.resetModules();
    const dom: JSDOM = setupActionabilityEnv({
      html: `<button id="t">T</button>`,
      elementFromPoint: () => null, // hit-test 落空 → OBSCURED
    });
    const el = dom.window.document.getElementById("t") as any;
    el.checkVisibility = () => true;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(INVIEW);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const res = await checkActionability(1, undefined, "#t");
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("OBSCURED");
    vi.restoreAllMocks();
  });

  it("force:true → 跳过 OBSCURED 门,返回 ok + rect", async () => {
    vi.resetModules();
    const dom: JSDOM = setupActionabilityEnv({
      html: `<button id="t">T</button>`,
      elementFromPoint: () => null,
    });
    const el = dom.window.document.getElementById("t") as any;
    el.checkVisibility = () => true;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(INVIEW);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const res = await checkActionability(1, undefined, "#t", { force: true });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rect).toEqual({ x: 10, y: 100, w: 50, h: 20 });
    vi.restoreAllMocks();
  });

  it("force:true → 跳过 DISABLED 门(disabled 元素也强制)", async () => {
    vi.resetModules();
    const dom: JSDOM = setupActionabilityEnv({
      html: `<button id="t" disabled>T</button>`,
      elementFromPoint: () => null,
    });
    const el = dom.window.document.getElementById("t") as any;
    el.checkVisibility = () => true;
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue(INVIEW);

    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const normal = await checkActionability(1, undefined, "#t");
    expect(normal.ok).toBe(false);
    expect((normal as { reason: string }).reason).toBe("DISABLED");
    const forced = await checkActionability(1, undefined, "#t", { force: true });
    expect(forced.ok).toBe(true);
    vi.restoreAllMocks();
  });

  it("force 仍要求元素存在:不存在的 selector → NOT_ATTACHED(force 不凭空造元素)", async () => {
    vi.resetModules();
    setupActionabilityEnv({ html: `<button id="t">T</button>`, elementFromPoint: () => null });
    await import("../src/page-side/actionability.js");
    const { checkActionability } = await import("../src/action/actionability.js");
    const res = await checkActionability(1, undefined, "#does-not-exist", { force: true });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("NOT_ATTACHED");
    vi.restoreAllMocks();
  });
});

describe("dom.ts act 路径透传 force (源码结构)", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const SRC = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");
  it("waitActionable 调用透传 args.force", () => {
    expect(SRC).toMatch(/force:\s*args\.force/);
  });
});
