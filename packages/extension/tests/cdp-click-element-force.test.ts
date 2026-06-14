/**
 * Author: qingwa
 * Description: Verify cdpClickElement accepts a `force` option that is plumbed
 *   through to the page-side probe so the occlusion check (ELEMENT_OCCLUDED)
 *   is skipped when force=true. All other actionability checks (not found /
 *   ambiguous / disabled / detached) still apply — only occlusion is gated.
 *
 * Source-level contract (Cases 1-6): the page-side function inside
 *   nativePageQuery is a stringified closure passed to chrome.scripting.
 *   We verify the source shape so the test remains robust without evaluating
 *   the page-side func body. See Case 7 (runtime) for behavioural verification.
 *
 * Case 7 (runtime): the source-string inspection in Cases 1-6 is brittle to
 *   refactors (e.g. `if (force) { return; }` early-return would silently break
 *   Cases 1-5). Case 7 captures the page-side func via vi.mock, then invokes
 *   it with a real jsdom element where hit-test returns a different element,
 *   asserting that the func returns ELEMENT_OCCLUDED when force=false and
 *   does NOT when force=true. This is the only true behavioural test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_TS = resolve(__dirname, "../src/adapter/cdp.ts");
const DOM_TS = resolve(__dirname, "../src/handlers/dom.ts");

describe("cdpClickElement force option — source-level contract", () => {
  it("Case 1: page-side func has force param and ELEMENT_OCCLUDED gated by !force", async () => {
    const src = await readFile(CDP_TS, "utf8");
    const start = src.indexOf("(sel: string");
    const end = src.indexOf("],\n  );", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toMatch(/sel: string,\s*force: boolean/);
    expect(body).toMatch(/if\s*\(\s*!force\s*\)\s*\{[\s\S]*?ELEMENT_OCCLUDED/);
  });

  it("Case 2: force=false (default) still runs the occlusion check (guard is `if (!force) ...`)", async () => {
    // The ELEMENT_OCCLUDED branch must be INSIDE the `if (!force) { ... }` block,
    // so when force=false (the default) the check fires and an occluded element
    // is reported. Case 1 verifies the same shape but framed as the positive
    // (force=true skips) — Case 2 re-frames it as the default-path contract.
    const src = await readFile(CDP_TS, "utf8");
    const start = src.indexOf("(sel: string");
    const end = src.indexOf("],\n  );", start);
    const body = src.slice(start, end);
    // The negation `!force` (rather than `force` as the only condition) proves
    // the default-arg path is the one that runs the occlusion check.
    expect(body).toMatch(/if\s*\(\s*!force\s*\)/);
  });

  it("Case 3: ELEMENT_NOT_FOUND branch is OUTSIDE the !force guard (force=true still reports it)", async () => {
    const src = await readFile(CDP_TS, "utf8");
    // The ELEMENT_NOT_FOUND return must appear at function body top-level
    // (no enclosing `if (!force)` block). Search for the line; if it lives
    // inside `if (!force) { ... }`, this regex would not match its line.
    expect(src).toMatch(/if\s*\(els\.length === 0\)[\s\S]*?ELEMENT_NOT_FOUND/);
    // Cross-check: NOT_FOUND is reached when els.length === 0, which is a
    // pre-occlusion check (before rect / elementFromPoint), so it must be
    // unconditional. Verify the file does NOT wrap this in !force.
    const guardedNotFound = src.match(/if\s*\(\s*!force\s*\)\s*\{[\s\S]*?ELEMENT_NOT_FOUND/);
    expect(guardedNotFound).toBeNull();
  });

  it("Case 4: ELEMENT_DISABLED branch is OUTSIDE the !force guard (force=true still reports it)", async () => {
    const src = await readFile(CDP_TS, "utf8");
    const guardedDisabled = src.match(/if\s*\(\s*!force\s*\)\s*\{[\s\S]*?ELEMENT_DISABLED/);
    expect(guardedDisabled).toBeNull();
  });

  it("Case 5: ELEMENT_DETACHED branch is OUTSIDE the !force guard (force=true still reports it)", async () => {
    const src = await readFile(CDP_TS, "utf8");
    const guardedDetached = src.match(/if\s*\(\s*!force\s*\)\s*\{[\s\S]*?ELEMENT_DETACHED/);
    expect(guardedDetached).toBeNull();
  });

  it("Case 6: dom.ts CLICK handler forwards force to cdpClickElement", async () => {
    // Both call sites (useRealMouse/trustedMode branch and deferToCdp fallback)
    // must forward `args.force` as a cdpClickElement option. We accept any
    // shape (`{ force: args.force ... }` or `{ force: args?.force ... }`).
    const src = await readFile(DOM_TS, "utf8");
    const cdpCalls = src.match(/cdpClickElement\([\s\S]*?\}\)/g) ?? [];
    expect(cdpCalls.length).toBeGreaterThan(0);
    for (const call of cdpCalls) {
      expect(call).toMatch(/force:\s*args\.force/);
    }
  });
});

describe("cdpClickElement force option — runtime (Case 7, anti-brittleness)", () => {
  /**
   * Why this test exists (complement to Cases 1-6):
   *   Cases 1-6 grep raw source for `if (!force) { ... ELEMENT_OCCLUDED ... }`.
   *   A refactor that uses `if (force) { return; }` early-return would silently
   *   pass Cases 1-5 yet break behaviour (or invert it). To lock the contract
   *   we capture the page-side func, set up a jsdom DOM where hit-test returns
   *   a different element (occlusion), and assert the runtime return value.
   *
   * Approach:
   *   - vi.mock the native.js module so nativePageQuery intercepts the call.
   *   - Capture the func arg; return its invocation result synchronously.
   *   - Set up window.__vortexDomResolve with stubbed queryAllDeep /
   *     deepElementFromPoint / isEnabled matching the page-side interface.
   *   - Set up a real jsdom button at known rect, with document.elementFromPoint
   *     mocked to return a sibling <div> (simulating occlusion).
   *   - Call the captured func with (sel, force) and inspect the return.
   */
  let mockPageQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    // armDialogPolicyCdp / readDialogCapturedAndDisarmCdp 调用 chrome.scripting.executeScript
    vi.stubGlobal("chrome", {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    });
    // Mock native.js BEFORE importing cdp.ts so cdpClickElement picks up the mock.
    mockPageQuery = vi.fn();
    vi.doMock("../src/adapter/native.js", () => ({
      pageQuery: mockPageQuery,
      mapPageError: (res: { error?: string }, _sel: unknown): never => {
        throw new Error(res.error ?? "Unknown error");
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock("../src/adapter/native.js");
    vi.restoreAllMocks();
  });

  async function setupDom(rectOverride?: Partial<DOMRect>): Promise<JSDOM> {
    const html = `<!DOCTYPE html><html><body>
      <button id="t">T</button>
      <div id="blocker" style="position:absolute;left:0;top:0;width:200px;height:50px"></div>
    </body></html>`;
    const dom = new JSDOM(html);
    const win = dom.window as unknown as Window & typeof globalThis;
    globalThis.window = win;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).HTMLElement = win.HTMLElement;
    (globalThis as any).getComputedStyle = win.getComputedStyle.bind(win);

    // Stub window.__vortexDomResolve so the page-side func uses the gated
    // branch (it checks for this object first, then falls back to light-DOM).
    // We need both queryAllDeep + deepElementFromPoint + isEnabled.
    const target = dom.window.document.getElementById("t") as HTMLElement;
    const blocker = dom.window.document.getElementById("blocker") as HTMLElement;
    Object.defineProperty(dom.window, "__vortexDomResolve", {
      value: {
        version: 1,
        queryAllDeep: (_sel: string) => [target],
        deepElementFromPoint: (_cx: number, _cy: number) => blocker,
        isEnabled: (_el: Element) => true,
      },
      writable: true,
      configurable: true,
    });

    // Provide a real rect on the target so getBoundingClientRect returns
    // non-zero dimensions (otherwise ELEMENT_DETACHED fires before occlusion).
    const rect: DOMRect = {
      x: 10, y: 10, width: 100, height: 30,
      top: 10, left: 10, right: 110, bottom: 40, toJSON: () => ({}),
      ...rectOverride,
    } as DOMRect;
    target.getBoundingClientRect = (() => rect) as typeof target.getBoundingClientRect;
    // scrollIntoView is a no-op in jsdom anyway; stub to be safe.
    target.scrollIntoView = (() => {}) as typeof target.scrollIntoView;

    return dom;
  }

  it("force=false (default) → page-side func returns ELEMENT_OCCLUDED when hit-test differs", async () => {
    await setupDom();
    // The page-side func returns { error, errorCode, extras, result? }. We
    // build a mockPageQuery that synchronously invokes the captured func.
    mockPageQuery.mockImplementation(
      async (
        _tabId: number,
        _frameId: number | undefined,
        fn: (...args: unknown[]) => unknown,
        args: unknown[],
      ) => fn(...(args as [])),
    );

    const { cdpClickElement } = await import("../src/adapter/cdp.js");
    // cdpClickElement needs a debuggerMgr + tabId; but the page-side probe
    // throws first (ELEMENT_OCCLUDED) so we never reach clickBBox. Provide
    // a stub debuggerMgr.
    const debuggerMgr = {
      attach: vi.fn(),
      sendCommand: vi.fn(),
    } as any;

    // We do NOT pass `force`, so the destructured default `false` applies.
    // The page-side func should return ELEMENT_OCCLUDED before any CDP work.
    // cdpClickElement calls mapPageError on { error }, which throws.
    await expect(
      cdpClickElement(debuggerMgr, 1, undefined, "#t"),
    ).rejects.toThrow(/occluded|covered/i);
  });

  it("force=true → page-side func returns successful result (no ELEMENT_OCCLUDED) even when hit-test differs", async () => {
    await setupDom();
    // Capture the page-side func by recording what was passed in.
    let captured: ((sel: string, force: boolean) => unknown) | null = null;
    let capturedArgs: unknown[] = [];
    mockPageQuery.mockImplementation(
      async (
        _tabId: number,
        _frameId: number | undefined,
        fn: (...args: unknown[]) => unknown,
        args: unknown[],
      ) => {
        captured = fn as (sel: string, force: boolean) => unknown;
        capturedArgs = args;
        // Invoke immediately to also test the full path.
        return fn(...(args as []));
      },
    );

    const { cdpClickElement } = await import("../src/adapter/cdp.js");
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;

    // force=true should bypass the occlusion check entirely.
    await cdpClickElement(debuggerMgr, 1, undefined, "#t", { force: true });

    // Verify the args were forwarded correctly.
    expect(captured).not.toBeNull();
    expect(capturedArgs).toEqual(["#t", true]);
  });

  // B2(2026-06-14 reactflow.dev dogfood):scrollIntoView({block:center}) 把已完全
  // 可见的元素强行滚到几何中心,在「内部 overflow/transform 容器 + JS 监听并弹回」的
  // 动态画布(React Flow)上触发容器临时滚动 → act 同步缓存坐标后容器 ~50ms 弹回 →
  // CDP 异步 dispatchMouse 坐标已失效 → 点中相邻元素(pyramid radio 被点成 cube)。
  // 修复:元素完全在视口内则跳过 scrollIntoView。jsdom 默认 viewport 1024x768。
  it("B2: 完全在视口的元素跳过 scrollIntoView(避免动态画布弹回点偏)", async () => {
    const dom = await setupDom(); // 默认 rect top:10 bottom:40 right:110 完全在 1024x768 内
    const target = dom.window.document.getElementById("t") as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy as typeof target.scrollIntoView;
    mockPageQuery.mockImplementation(
      async (_t: number, _f: number | undefined, fn: (...a: unknown[]) => unknown, args: unknown[]) =>
        fn(...(args as [])),
    );
    const { cdpClickElement } = await import("../src/adapter/cdp.js");
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    await cdpClickElement(debuggerMgr, 1, undefined, "#t", { force: true });
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("B2: 未完全在视口的元素仍 scrollIntoView 滚入(必要滚动不受影响)", async () => {
    // bottom 930 > innerHeight 768 → 未完全可见 → 必须滚入
    const dom = await setupDom({ y: 900, top: 900, bottom: 930 });
    const target = dom.window.document.getElementById("t") as HTMLElement;
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy as typeof target.scrollIntoView;
    mockPageQuery.mockImplementation(
      async (_t: number, _f: number | undefined, fn: (...a: unknown[]) => unknown, args: unknown[]) =>
        fn(...(args as [])),
    );
    const { cdpClickElement } = await import("../src/adapter/cdp.js");
    const debuggerMgr = {
      attach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
    } as any;
    await cdpClickElement(debuggerMgr, 1, undefined, "#t", { force: true });
    expect(scrollSpy).toHaveBeenCalled();
  });
});
