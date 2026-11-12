// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { JSDOM } from "jsdom";
import { ActionRouter } from "../src/lib/router.js";
import { registerObserveHandlers } from "../src/handlers/observe.js";

vi.mock("../src/adapter/page-side-loader.js", () => ({ loadPageSideModule: async () => undefined }));
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "../src/handlers/observe.ts"), "utf8");

// 2026-06-22 APG/recharts dogfood:observe fallbackPool 选择器 `*:not(svg *)` 把所有
// svg 后代整类排除,带交互信号(role/onclick/直绑 listener/可聚焦)的 svg 子元素
// (recharts/d3 可点 rect·circle、流程图形状、地图区域)被整类漏召回——act 侧
// SVG click 崩溃(click-synthetic-inline-scope SVG 用例)的 observe 对偶。
// 正向用例实际执行 MAIN 注入,其余 source-lock 保留补集接线与尺寸门契约。
describe("observe SVG 交互元素补集(fallbackPool :not(svg *) 漏召回修复)", () => {
  it("召回带当前 owner token 的 SVG listener,不召回旧 token 或装饰节点", async () => {
    const dom = new JSDOM(`<body><svg><rect id="bar" aria-label="Listener bar"/><rect id="stale" aria-label="Stale bar" data-vtx-listener="old-token"/><rect id="decoration" aria-label="Decoration"/></svg></body>`, {
      url: "https://svg.example/", pretendToBeVisual: true, runScripts: "outside-only",
    });
    const win = dom.window as any;
    win.CSS = { escape: (value: string) => value };
    win.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 });
    win.document.elementFromPoint = () => null;
    const bar = win.document.querySelector("#bar");
    expect(bar.offsetWidth).toBeUndefined();
    const documentId = "svg-document";
    let stamped: string | null = null;
    const executeScript = vi.fn(async (details: any) => {
      const matches = details.target.documentIds ? details.target.documentIds.includes(documentId) : (details.target.frameIds ?? [0]).includes(0);
      if (!matches) return [];
      expect(details.world).toBe("MAIN");
      if (String(details.func).includes("const scanRoot")) stamped = bar.getAttribute("data-vtx-listener");
      return [{ frameId: 0, documentId, result: await win.eval(`(${String(details.func)})`)(...structuredClone(details.args ?? [])) }];
    });
    vi.stubGlobal("chrome", {
      webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId, url: win.location.href }] },
      scripting: { executeScript }, runtime: { getManifest: () => ({ host_permissions: ["<all_urls>"] }) },
    });
    const dbg = { enableDomain: vi.fn(), sendCommand: vi.fn(async (_tab: number, method: string, params: any) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "doc" } };
      if (method === "DOMDebugger.getEventListeners") return { listeners: [{ type: "click", backendNodeId: 7 }] };
      if (method === "DOM.pushNodesByBackendIdsToFrontend") return { nodeIds: [7] };
      if (method === "DOM.resolveNode") return { object: { objectId: "bar" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: win.eval(`(${params.functionDeclaration})`).apply(bar, structuredClone(params.arguments.map((arg: any) => arg.value))) } };
      return {};
    }) };
    try {
      const router = new ActionRouter();
      registerObserveHandlers(router, dbg as any);
      const response: any = await router.dispatch({ type: "tool_request", tool: "observe.snapshot", args: { frames: "main", includeAX: false, detail: "full" }, requestId: "svg-token", tabId: 42 });
      expect(response.error).toBeUndefined();
      const claim = executeScript.mock.calls.map(([details]) => details).find((details) => details.args?.[0] === "listener.claim");
      expect(claim?.target.documentIds).toEqual([documentId]);
      expect(stamped).toBe(claim!.args[1].token);
      expect(response.result.elements).toEqual([expect.objectContaining({ tag: "rect", name: "Listener bar", listenerInteractive: true })]);
      expect(response.result.meta.degraded?.listenerDiscovery).toBeUndefined();
    } finally {
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });

  it("fallback 收集循环把 svgInteractivePool 并入迭代", () => {
    expect(SRC).toContain("for (const el of [...Array.from(fallbackPool), ...Array.from(svgInteractivePool)])");
  });

  it("尺寸门对 SVG(无 offsetWidth)退回 getBoundingClientRect", () => {
    expect(SRC).toContain('if (typeof htmlEl.offsetWidth === "number")');
    expect(SRC).toContain("const __r = el.getBoundingClientRect();");
  });

  it("主 fallbackPool 仍保留 :not(svg *) 排除(补集为加性,不改原噪声治理)", () => {
    expect(SRC).toContain("*:not(svg *):not(script):not(style):not(meta):not(link):not(head):not(head *)");
  });
});
