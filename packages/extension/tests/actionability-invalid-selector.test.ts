/**
 * Author: qingwa
 * Description: 非法 CSS selector 必须报 INVALID_SELECTOR 并立即失败，
 *   不得伪装成可重试的 NOT_ATTACHED。
 *
 * 背景 (2026-07-29 iPaaS 实战): probe 把 document.querySelector 的 SyntaxError
 *   catch 成 el=null → 返回 NOT_ATTACHED（RETRY_INTERVAL_MS=0 立即重试）→ 在
 *   timeout 预算内空转数百次 probe，最后抛 TIMEOUT，hint 说 "Element detached
 *   from DOM. Call vortex_observe to re-locate"。调用方据此判断是时序问题，
 *   加大 timeout / wait_for idle 全部无效，真因（选择器语法不受支持）永不可见。
 *
 *   实测同页同刻：`tbody tr:nth-child(1) td:nth-child(2)` 成功，
 *   `text=搜索`（Playwright 语法）报 NOT_ATTACHED。
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import { setupActionabilityEnv } from "./helpers/actionability-test-setup.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: async () => {},
  _resetPageSideLoader: () => {},
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * querySelector 真会抛 SyntaxError 的 target（Playwright engine 语法）。
 *
 * 注意不含 `保存配置` 这类纯文本：它是**合法**的 CSS 类型选择器（Unicode 标签名），
 * querySelector 不抛错、只是匹配不到 → NOT_ATTACHED 在本层是正确分类。
 * 那类"语法合法但显然是自然语言"的 target 由 MCP 层 ref-parser 拦截
 * （见 packages/mcp/tests/ref-parser-unsupported-syntax.test.ts）。
 */
const INVALID_SELECTORS = [
  "text=搜索",
  'tr:has-text("VOC-聚水潭") >> text=定时拉取',
  "button >> nth=0",
];

describe("非法 CSS selector → INVALID_SELECTOR（不可重试）", () => {
  for (const bad of INVALID_SELECTORS) {
    it(`${JSON.stringify(bad)} 抛 INVALID_SELECTOR 而非 NOT_ATTACHED/TIMEOUT`, async () => {
      vi.resetModules();
      setupActionabilityEnv({ html: "<button>搜索</button>" });
      await import("../src/page-side/actionability.js");
      const { waitActionable } = await import("../src/action/auto-wait.js");

      await expect(
        waitActionable(1, undefined, bad, { timeout: 2000 }),
      ).rejects.toMatchObject({ code: VtxErrorCode.INVALID_SELECTOR });
    });
  }

  it("立即失败，不耗满 timeout 预算（此前空转到 TIMEOUT）", async () => {
    vi.resetModules();
    setupActionabilityEnv({ html: "<button>搜索</button>" });
    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    const started = Date.now();
    await expect(
      waitActionable(1, undefined, "text=搜索", { timeout: 3000 }),
    ).rejects.toThrow();
    // 不可重试分支应在首次 probe 后立刻抛；给 1000ms 宽限吸收 jsdom 加载抖动。
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("错误信息点明支持的 target 语法，避免调用方误判为时序问题", async () => {
    vi.resetModules();
    setupActionabilityEnv({ html: "<button>搜索</button>" });
    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    const err = await waitActionable(1, undefined, "text=搜索", { timeout: 2000 })
      .then(() => null)
      .catch((e) => e as Error);

    expect(err).not.toBeNull();
    // 必须给出正确语法，而不是 "detached from DOM" 这类反方向诊断
    expect(err!.message).toMatch(/CSS/i);
    expect(err!.message).not.toMatch(/detached/i);
  });

  it("合法 CSS 不受影响：仍走原有可操作性检查（jsdom 无 layout → 0×0 rect → NOT_VISIBLE）", async () => {
    vi.resetModules();
    setupActionabilityEnv({ html: "<button>搜索</button>" });
    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    const err = await waitActionable(1, undefined, "button", { timeout: 300 })
      .then(() => null)
      .catch((e) => e as { code?: string; extra?: { context?: { extras?: { lastReason?: string } } } });

    // 正断言而非 not.toBe：负断言在 err===undefined（意外通过）时也会绿。
    expect(err).not.toBeNull();
    expect(err!.code).toBe(VtxErrorCode.TIMEOUT);
    expect(err!.extra?.context?.extras?.lastReason).toBe("NOT_VISIBLE");
  });

  it("真实不存在的元素仍是可重试的 NOT_ATTACHED（不被新分支吞掉）", async () => {
    vi.resetModules();
    setupActionabilityEnv({ html: "<button>搜索</button>" });
    await import("../src/page-side/actionability.js");
    const { waitActionable } = await import("../src/action/auto-wait.js");

    const err = await waitActionable(1, undefined, "#nope", { timeout: 300 })
      .then(() => null)
      .catch((e) => e as { code?: string; extra?: { context?: { extras?: { lastReason?: string } } } });

    expect(err!.code).toBe(VtxErrorCode.TIMEOUT);
    // lastReason 才是"仍可重试"的载体，也是 descriptor 自愈通道的准入判据，
    // 只断 code=TIMEOUT 不足以锁住行为。
    expect(err!.extra?.context?.extras?.lastReason).toBe("NOT_ATTACHED");
  });
});
