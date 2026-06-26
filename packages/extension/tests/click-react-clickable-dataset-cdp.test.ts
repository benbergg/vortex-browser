/**
 * Author: qingwa
 * Description: BUG-010 N0060 京东评测 B 方案 — vortex_act click 自动检测
 *   el.dataset.vortexReactClickable === "1" (observe emit 阶段标记) → deferToCdp
 *   走 CDP 真实 mouse 路径。LLM 评测者无需手填 useRealMouse=true, 京东 3 品类
 *   列表页商品卡点击直达详情。
 *
 * 背景 (reports/jd-dogfood-V1/_meta/BUG-010-京东商品卡无ref.md):
 *   - 方案 A (commit fd1a5b9) 已加 observe 标 gate, 输出 reactClickable +
 *     clickHint 给 LLM 读; 同步在 live DOM 标 el.dataset.vortexReactClickable='1'
 *   - 方案 B: click handler 内部探测该 dataset, 命中 → deferToCdp 自动走 CDP
 *     real mouse. 最小变更 + 用户零负担 (默认行为升级)
 *
 * 关键契约 (4 条):
 *   1. 元素 dataset.vortexReactClickable === "1" → deferToCdp → 走 cdpClickElement
 *   2. 元素 dataset.vortexReactClickable === "0" / 缺省 → 走原合成 click 路径
 *   3. 显式 useRealMouse=true → 仍直接走 CDP (既有路径不退化)
 *   4. cdpAvailable=false 时 react-clickable 不 defer, 至少让合成 click 尝试
 *      (避免无 CDP 时连尝试机会都不给)
 *
 * Why TDD 通过 executeScript mock:
 *   - page-side func 是 inline 的, jsdom 不能直接调 — 通过 mock executeScript
 *     模拟 page-side func 返回 deferToCdp:true,验证 handler 改走 cdpClickElement
 *   - 与 click-submit-intent-cdp.test.ts 模式一致
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerDomHandlers } from "../src/handlers/dom.js";

vi.mock("../src/action/auto-wait.js", () => ({
  waitActionable: vi.fn().mockImplementation((_t: unknown, _f: unknown, sel: string) =>
    Promise.resolve({ ok: true, rect: { x: 0, y: 0, w: 1, h: 1 }, selector: sel })),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/cdp.js", () => ({
  cdpClickElement: vi.fn(),
  clickBBox: vi.fn(),
}));

function mkReq(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: DomActions.CLICK, args, requestId: "r-1" };
}

describe("CLICK react-clickable dataset → CDP real mouse (BUG-010 N0060 方案 B)", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;
  let cdpClickElement: ReturnType<typeof vi.fn>;
  let debuggerMgr: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    const cdp = await import("../src/adapter/cdp.js");
    cdpClickElement = vi.mocked(cdp.cdpClickElement as any);
    debuggerMgr = { attach: vi.fn().mockResolvedValue(undefined), sendCommand: vi.fn().mockResolvedValue(undefined) };
    router = new ActionRouter();
    registerDomHandlers(router, debuggerMgr);
  });

  it("契约 1: dataset.vortexReactClickable='1' → deferToCdp → 走 cdpClickElement", async () => {
    // page-side func 探测到 reactClickable dataset → deferToCdp
    executeScript.mockResolvedValue([
      { result: { result: { deferToCdp: true, element: { tag: "div" } } } },
    ]);
    cdpClickElement.mockResolvedValue({ success: true, element: { tag: "div" }, mode: "realMouse" });

    const resp = await router.dispatch(
      mkReq({ selector: "div._card_abc123", action: "click", tabId: 42 }),
    );

    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });

  it("契约 2: dataset 缺省 / !='1' → 走原合成 click 路径, 不调 cdpClickElement", async () => {
    // 合成 click 成功路径 (无 reactClickable 标)
    executeScript.mockResolvedValue([
      { result: { result: { success: true, element: { tag: "a" } } } },
    ]);

    const resp = await router.dispatch(
      mkReq({ selector: "a.normal", action: "click", tabId: 42 }),
    );

    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ success: true });
  });

  it("契约 3: 显式 useRealMouse=true → 仍直接走 CDP (不退化)", async () => {
    cdpClickElement.mockResolvedValue({ success: true, mode: "realMouse" });

    const resp = await router.dispatch(
      mkReq({ selector: "div.card", action: "click", useRealMouse: true, tabId: 42 }),
    );

    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(resp.result).toMatchObject({ mode: "realMouse" });
  });

  it("契约 4: react-clickable 但 CDP 失败 → 回退合成 click (executeScript 重跑)", async () => {
    executeScript
      .mockResolvedValueOnce([{ result: { result: { deferToCdp: true, element: { tag: "div" } } } }])
      .mockResolvedValueOnce([{ result: { result: { success: true, element: { tag: "div" } } } }]);
    cdpClickElement.mockRejectedValue(new Error("CDP attach failed"));

    const resp = await router.dispatch(
      mkReq({ selector: "div._card_abc", action: "click", tabId: 42 }),
    );

    expect(resp.error).toBeUndefined();
    expect(cdpClickElement).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(resp.result).toMatchObject({ success: true });
  });
});

/**
 * 源码契约测试 — 保证 page-side inline func 在 submit-intent 检测后
 * 追加 react-clickable dataset 探测逻辑 (顺序敏感: submit-intent 优先,
 * react-clickable 兜底)
 */
describe("CLICK react-clickable dataset 检测 — 源码契约 (BUG-010)", () => {
  it("page-side func 探测 el.dataset.vortexReactClickable", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");
    expect(src).toMatch(/vortexReactClickable/);
  });

  it("react-clickable deferToCdp 在 submit-intent 之后 (顺序敏感)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(__dirname, "..", "src", "handlers", "dom.ts"), "utf8");
    const submitIdx = src.indexOf("__isSubmitIntent");
    const reactIdx = src.indexOf("vortexReactClickable");
    expect(submitIdx).toBeGreaterThan(-1);
    expect(reactIdx).toBeGreaterThan(-1);
    expect(reactIdx).toBeGreaterThan(submitIdx);
  });
});
