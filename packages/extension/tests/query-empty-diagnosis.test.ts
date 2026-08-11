/**
 * Author: qingwa
 * Description: query 零命中时自陈「我到底搜了多大范围」。
 *
 * 基线(2026-08-11)query 空返回 29.2%。调用方只拿到 `total: 0`,分不清是页面真没有、
 * 还是内容在没被搜到的 iframe 里,于是微调无关参数重试(实录:同一 pattern 把
 * contextChars 从 260 改到 300 再试一次 —— 那个参数不影响命中数)。
 *
 * page-side 函数在 JSDOM 里直接跑,验证真实遍历规模而非 mock。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { splitDiagnosis } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { textSearchFunc, cssQueryFunc, registerQueryHandlers } from "../src/handlers/query.js";
import { diagnoseEmptyQueryText, diagnoseEmptyQueryCss } from "../src/lib/empty-diagnosis.js";

function mountDom(html: string) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`);
  globalThis.window = dom.window as any;
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).NodeFilter = dom.window.NodeFilter;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
}

describe("page-side 自报扫描规模", () => {
  beforeEach(() => mountDom(""));

  it("textSearchFunc 报出扫到的字符数、文本节点数、iframe 数", () => {
    mountDom(`<p>hello world</p><iframe src="about:blank"></iframe><iframe></iframe>`);
    const r = textSearchFunc("nope", false, false, 40, 10) as any;
    expect(r.total).toBe(0);
    expect(r.scanned.chars).toBe("hello world".length);
    expect(r.scanned.nodes).toBe(1);
    expect(r.scanned.iframes).toBe(2);
  });

  it("textSearchFunc 报出下降过的 shadow root 数", () => {
    mountDom(`<div id="host"></div>`);
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = "<span>inner</span>";
    const r = textSearchFunc("nope", false, false, 40, 10) as any;
    expect(r.scanned.shadowRoots).toBe(1);
    expect(r.scanned.chars).toBe("inner".length);
  });

  it("cssQueryFunc 报出扫描的元素数与 iframe 数", () => {
    mountDom(`<div><span></span></div><iframe></iframe>`);
    const r = cssQueryFunc(".nope", null, 10, false) as any;
    expect(r.total).toBe(0);
    expect(r.scanned.elements).toBeGreaterThanOrEqual(3);
    expect(r.scanned.iframes).toBe(1);
  });

  it("有命中时 scanned 依然存在（handler 负责剥离，page-side 不做条件分支）", () => {
    mountDom(`<p>hello</p>`);
    const r = textSearchFunc("hello", false, false, 40, 10) as any;
    expect(r.total).toBe(1);
    expect(r.scanned).toBeTruthy();
  });
});

describe("query handler 剥离 scanned 并在零命中时挂自陈", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, parentFrameId: -1, url: "https://x/" },
        { frameId: 132, parentFrameId: 0, url: "https://x/sub" },
      ]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  async function run(args: Record<string, unknown>) {
    const resp = await router.dispatch({ type: "tool_request", tool: "query.queryPage", args, requestId: "r" });
    return splitDiagnosis(resp.result);
  }

  it("有命中时载荷不含 scanned，也不挂自陈（零成本）", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      matches: [{ match_text: "Hello", context: "…", element_path: "div", char_position: 5 }],
      total: 1, has_more: false, scanned: { chars: 900, nodes: 30, shadowRoots: 0, iframes: 2 },
    } }]);
    const { value, diagnosis } = await run({ mode: "text", pattern: "Hello" });
    expect(diagnosis).toBeNull();
    expect(value).toEqual({
      matches: [{ match_text: "Hello", context: "…", element_path: "div", char_position: 5 }],
      total: 1, has_more: false,
    });
  });

  it("零命中时载荷仍不含 scanned，自陈单独给出扫描规模", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      matches: [], total: 0, has_more: false, scanned: { chars: 0, nodes: 0, shadowRoots: 0, iframes: 3 },
    } }]);
    const { value, diagnosis } = await run({ mode: "text", pattern: "时间" });
    expect(value).toEqual({ matches: [], total: 0, has_more: false });
    expect(diagnosis).toMatch(/no visible text/i);
    expect(diagnosis).toContain("frameId");
  });

  it("指定了 frameId 时自陈不再劝人指定 frameId", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      matches: [], total: 0, has_more: false, scanned: { chars: 500, nodes: 9, shadowRoots: 0, iframes: 3 },
    } }]);
    const { diagnosis } = await run({ mode: "text", pattern: "时间", frameId: 132 });
    expect(diagnosis).not.toContain("frameId");
  });

  it("css 零命中时报出扫描元素数", async () => {
    executeScript.mockResolvedValueOnce([{ result: {
      elements: [], total: 0, showing: 0, scanned: { elements: 850, shadowRoots: 1, iframes: 0 },
    } }]);
    const { value, diagnosis } = await run({ mode: "css", pattern: ".el-dialog .el-select" });
    expect(value).toEqual({ elements: [], total: 0, showing: 0 });
    expect(diagnosis).toContain("850");
    expect(diagnosis).toContain(".el-dialog .el-select");
  });

  // page-side 旧构建/异常路径可能不带 scanned,不能因此崩掉
  it("page-side 没返回 scanned 时不炸，也不臆造数字", async () => {
    executeScript.mockResolvedValueOnce([{ result: { matches: [], total: 0, has_more: false } }]);
    const { value, diagnosis } = await run({ mode: "text", pattern: "x" });
    expect(value).toEqual({ matches: [], total: 0, has_more: false });
    expect(diagnosis).toBeNull();
  });
});

describe("diagnoseEmptyQueryText", () => {
  const base = { chars: 1200, nodes: 40, shadowRoots: 0, iframes: 0, pattern: "时间", isRegex: false, frameScoped: false };

  it("一个可见字符都没扫到时先说这个", () => {
    const d = diagnoseEmptyQueryText({ ...base, chars: 0, nodes: 0 });
    expect(d).toMatch(/no visible text/i);
  });

  it("有未搜索的 iframe 时指路 frameId", () => {
    const d = diagnoseEmptyQueryText({ ...base, iframes: 3 });
    expect(d).toContain("3");
    expect(d).toContain("frameId");
    expect(d).toMatch(/iframe/i);
  });

  it("已经指定了 frameId 就不再重复劝人指定 frameId", () => {
    const d = diagnoseEmptyQueryText({ ...base, iframes: 3, frameScoped: true });
    expect(d).not.toContain("frameId");
  });

  it("pattern 含 | 却没开 isRegex → 点破被当字面量", () => {
    const d = diagnoseEmptyQueryText({ ...base, pattern: "评价时间|创建时间|下单时间" });
    expect(d).toMatch(/isRegex/);
    expect(d).toMatch(/literal/i);
  });

  it("isRegex 已开则不误报", () => {
    const d = diagnoseEmptyQueryText({ ...base, pattern: "a|b", isRegex: true });
    expect(d).not.toMatch(/isRegex/);
  });

  it("普通 pattern 且扫到了内容 → 报出扫描规模并说明作用域边界", () => {
    const d = diagnoseEmptyQueryText(base);
    expect(d).toContain("1200");
    expect(d).toMatch(/hidden|closed shadow/i);
  });
});

describe("diagnoseEmptyQueryCss", () => {
  const base = { elements: 850, shadowRoots: 2, iframes: 0, selector: ".el-dialog .el-select", frameScoped: false };

  it("报出扫描的元素数与 shadow root 数", () => {
    const d = diagnoseEmptyQueryCss(base);
    expect(d).toContain("850");
    expect(d).toContain("2");
  });

  it("有未搜索的 iframe 时指路 frameId", () => {
    const d = diagnoseEmptyQueryCss({ ...base, iframes: 1 });
    expect(d).toContain("frameId");
  });

  it("任何输入都给出非空的一行", () => {
    expect(diagnoseEmptyQueryCss({ ...base, elements: 0, shadowRoots: 0 }).trim().length).toBeGreaterThan(10);
  });
});
