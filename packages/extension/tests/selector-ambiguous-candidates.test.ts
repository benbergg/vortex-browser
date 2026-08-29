import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DomActions } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import {
  DOM_CLICK_PAGE_FUNC,
  DOM_COMMIT_PAGE_FUNC,
  DOM_FILL_PAGE_FUNC,
  DOM_HOVER_PAGE_FUNC,
  DOM_SELECT_PAGE_FUNC,
  DOM_TYPE_PAGE_FUNC,
  registerDomHandlers,
} from "../src/handlers/dom.js";
import {
  buildAmbiguousMessage,
  type MatchedElementSummary,
} from "../src/action/candidate-suggest.js";

vi.mock("../src/action/wait-actionable-auto-force.js", () => ({
  waitActionableAutoForce: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/adapter/page-side-loader.js", () => ({
  loadPageSideModule: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/tab-utils.js", () => ({
  getActiveTabId: vi.fn().mockResolvedValue(1),
  buildExecuteTarget: vi.fn().mockReturnValue({ tabId: 1 }),
  ensureFrameAttached: vi.fn().mockResolvedValue(undefined),
}));

const candidate = (overrides: Partial<MatchedElementSummary> = {}): MatchedElementSummary => ({
  index: 1,
  tag: "button",
  accessibleName: "保存",
  text: "保存",
  attributes: { "data-testid": "save" },
  visible: true,
  ...overrides,
});

describe("SELECTOR_AMBIGUOUS 候选正文", () => {
  it("把数量和每个候选写进 message，并保留 MCP 可见通道", () => {
    const message = buildAmbiguousMessage("button.save", 2, [
      candidate({ index: 1, accessibleName: "Save label", text: "Save body", attributes: { id: "first" } }),
      candidate({ index: 2, accessibleName: "取消", text: "取消", attributes: { id: "second" } }),
    ]);
    expect(message).toContain("matched 2 elements");
    expect(message).toContain('name="Save label"');
    expect(message).toContain('text="Save body"');
    expect(message).toContain("first");
    expect(message).toContain("second");
  });

  it("空字段、引号、换行和 Unicode 都可安全呈现", () => {
    const message = buildAmbiguousMessage('div[data-label="x"]', 2, [
      candidate({ accessibleName: '', text: 'a"b\n中 文', attributes: {} }),
      candidate({ index: 2, accessibleName: "", text: "", attributes: {} }),
    ]);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message).toContain("中 文");
  });

  it("限制字段、候选段和整条正文的 UTF-8 长度", () => {
    const huge = "x".repeat(20_000);
    const message = buildAmbiguousMessage("div[data-id]", 11, Array.from({ length: 11 }, (_, i) =>
      candidate({ index: i + 1, accessibleName: huge, text: huge, attributes: { "data-id": huge } }),
    ));
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(4096);
    expect(message).toContain("matched 11 elements");
    expect(message).toContain("omitted");
    expect(message).toMatch(/rewrite the selector with more context\.$/);
  });

  it("属性名和属性值都被清洗与截断，不把控制字符带进正文", () => {
    const message = buildAmbiguousMessage("div[data-id]", 2, [
      candidate({ index: 1, attributes: { "data-id": `a\nb\tc\u0007${"y".repeat(300)}` } }),
      candidate({ index: 2, attributes: { "data-id": "plain" } }),
    ]);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(message).toContain('data-id="a b c');
    expect(message).toMatch(/y{100,119}…/);
  });

  it("同形候选不暗示已有唯一目标", () => {
    const message = buildAmbiguousMessage("div.relative.aspect-video", 11,
      Array.from({ length: 11 }, (_, i) => candidate({ index: i + 1, tag: "div", accessibleName: "", text: "", attributes: {} })),
    );
    expect(message).toContain("cannot be distinguished by the summary alone");
    expect(message).toContain("matched 11 elements");
  });

});

describe("六个真实 handler 的 DTO→host→VtxError.message 链路", () => {
  let dom: JSDOM;
  let elements: Element[];
  let injectedFunctions: unknown[];

  beforeEach(() => {
    dom = new JSDOM(`<body>
      <div id='first' class='candidate'>Direct Alpha<style>.noise{display:none}</style><span><b>Nested Alpha</b></span></div>
      <div id='second' class='candidate' aria-label='Labeled Beta' title='Title Beta'><span>Nested Beta</span><script>script-noise</script></div>
      <div id='third' class='candidate'><section><span>Deep Gamma</span></section></div>
      <div id='fourth' class='candidate'></div>
    </body>`, { pretendToBeVisual: true });
    elements = Array.from(dom.window.document.querySelectorAll(".candidate"));
    injectedFunctions = [];
    for (const el of elements) {
      el.getBoundingClientRect = () => ({ width: 80, height: 20, top: 10, bottom: 30, left: 10, right: 90 } as DOMRect);
    }
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    (dom.window as any).__vortexDomResolve = {
      queryAllDeep: () => elements,
      isEnabled: () => true,
      deepElementFromPoint: () => elements[0],
      classifyHit: () => ({ ok: true }),
    };
    (dom.window as any).__vortexFillReject = { checkRejectPattern: () => ({ rejected: false }) };
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: async (opts: { func?: (...args: unknown[]) => unknown; args?: unknown[] }) => {
          if (!opts.func) return [{}];
          injectedFunctions.push(opts.func);
          const injected = new Function(`return (${String(opts.func)})`)() as (...args: unknown[]) => unknown;
          return [{ result: await injected(...(opts.args ?? [])) }];
        },
      },
      tabs: { query: vi.fn().mockResolvedValue([{ id: 1 }]) },
    });
  });

  it.each([
    [DomActions.CLICK, { selector: ".candidate" }],
    [DomActions.TYPE, { selector: ".candidate", text: "x" }],
    [DomActions.FILL, { selector: ".candidate", value: "x" }],
    [DomActions.SELECT, { selector: ".candidate", value: "x" }],
    [DomActions.HOVER, { selector: ".candidate" }],
    [DomActions.COMMIT, { selector: ".candidate", kind: "select", value: "x" }],
  ] as const)("%s 将候选摘要送入最终 VtxError.message", async (action, args) => {
    const router = new ActionRouter();
    registerDomHandlers(router, { attach: vi.fn(), sendCommand: vi.fn() } as never);
    const response = await router.dispatch({ type: "tool_request", tool: action, args, requestId: "ambiguous" } as never);
    expect(response.error?.code).toBe("SELECTOR_AMBIGUOUS");
    expect(response.error?.message).toContain("matched 4 elements");
    expect(response.error?.message).toContain('text="Direct Alpha"');
    expect(response.error?.message).toContain('name="Labeled Beta"');
    expect(response.error?.message).toContain('text="Nested Beta"');
    expect(response.error?.message).toContain('text="Deep Gamma"');
    expect(response.error?.message).not.toContain(".noise");
    expect(response.error?.message).not.toContain("script-noise");
    expect(response.error?.message).toMatch(/#4 <div>.*visible/);
    expect(response.error?.message).not.toMatch(/#4 <div> name=/);
    expect(response.error?.context?.extras).toMatchObject({ matchCount: 4 });
    expect(response.error?.context?.extras).not.toHaveProperty("candidates");
    expect(injectedFunctions).toContain(({
      [DomActions.CLICK]: DOM_CLICK_PAGE_FUNC,
      [DomActions.TYPE]: DOM_TYPE_PAGE_FUNC,
      [DomActions.FILL]: DOM_FILL_PAGE_FUNC,
      [DomActions.SELECT]: DOM_SELECT_PAGE_FUNC,
      [DomActions.HOVER]: DOM_HOVER_PAGE_FUNC,
      [DomActions.COMMIT]: DOM_COMMIT_PAGE_FUNC,
    } as Record<string, unknown>)[action]);
  });

  it("真实注入函数只查询一次；第六个出口仍只使用 light DOM", async () => {
    let deepQueries = 0;
    let lightQueries = 0;
    (dom.window as any).__vortexDomResolve.queryAllDeep = () => { deepQueries++; return elements; };
    const router = new ActionRouter();
    registerDomHandlers(router, { attach: vi.fn(), sendCommand: vi.fn() } as never);
    const response = await router.dispatch({ type: "tool_request", tool: DomActions.CLICK, args: { selector: ".candidate" }, requestId: "deep" } as never);
    expect(response.error?.message).toContain('text="Direct Alpha"');
    expect(deepQueries).toBe(1);
    const original = dom.window.document.querySelectorAll.bind(dom.window.document);
    dom.window.document.querySelectorAll = ((selector: string) => { lightQueries++; return original(selector); }) as typeof dom.window.document.querySelectorAll;
    const commit = await router.dispatch({ type: "tool_request", tool: DomActions.COMMIT, args: { selector: ".candidate", kind: "select", value: "x" }, requestId: "light" } as never);
    expect(commit.error?.message).toContain('text="Direct Alpha"');
    expect(lightQueries).toBeGreaterThan(0);
  });
});
