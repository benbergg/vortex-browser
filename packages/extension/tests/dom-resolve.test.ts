import { describe, it, expect, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";

describe("dom-resolve page-side module", () => {
  // 每个 it 使用 vi.resetModules() + 新 JSDOM 窗口，保证 version 守卫对每个 case 均从干净状态开始。
  beforeEach(() => {
    const dom = new JSDOM('<div id="host"></div>');
    globalThis.window = dom.window as any;
    globalThis.document = dom.window.document as unknown as Document;
    (globalThis as any).HTMLElement = dom.window.HTMLElement;
  });

  it("挂载 __vortexDomResolve（version=1，含三个函数含 deepElementFromPoint）", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");
    const ns = (window as any).__vortexDomResolve;
    expect(ns.version).toBe(1);
    expect(typeof ns.queryDeep).toBe("function");
    expect(typeof ns.queryAllDeep).toBe("function");
    expect(typeof ns.deepElementFromPoint).toBe("function");
  });

  it("queryDeep 穿 open shadow 命中", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");
    const sr = document.getElementById("host")!.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.setAttribute("data-vortex-rid", "r9");
    sr.appendChild(btn);
    expect((window as any).__vortexDomResolve.queryDeep('[data-vortex-rid="r9"]')).toBe(btn);
  });

  it("无效 CSS selector 当作未命中（不抛）", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");
    const ns = (window as any).__vortexDomResolve;
    expect(ns.queryDeep(":::bad")).toBeNull();
    expect(ns.queryAllDeep(":::bad")).toEqual([]);
  });

  it("queryAllDeep light-DOM 优先：light-DOM 有命中时不穿 shadow（length=1）", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");

    // light-DOM 中的 .x
    const lightEl = document.createElement("span");
    lightEl.className = "x";
    document.body.appendChild(lightEl);

    // shadow 内同样有一个 .x，但 light-DOM 非空，不应穿 shadow
    const sr = document.getElementById("host")!.attachShadow({ mode: "open" });
    const shadowEl = document.createElement("div");
    shadowEl.className = "x";
    sr.appendChild(shadowEl);

    const results = (window as any).__vortexDomResolve.queryAllDeep(".x");
    expect(results.length).toBe(1);
    expect(results).toContain(lightEl);
    expect(results).not.toContain(shadowEl);
  });

  it("deepElementFromPoint：elementFromPoint 返回 host，下钻后命中 shadow 内 button", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");

    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    sr.appendChild(btn);

    // jsdom 不实现 elementFromPoint，手动 mock：document 返回 host
    Object.defineProperty(document, "elementFromPoint", {
      value: () => host,
      configurable: true,
    });
    // shadowRoot 返回 btn
    Object.defineProperty(sr, "elementFromPoint", {
      value: () => btn,
      configurable: true,
    });

    const result = (window as any).__vortexDomResolve.deepElementFromPoint(5, 5);
    expect(result).toBe(btn);
  });

  it("queryAllDeep shadow 兜底：light-DOM 零命中时穿 shadow，多命中仍返回全部（length=2）", async () => {
    vi.resetModules();
    await import("../src/page-side/dom-resolve.js");

    // light-DOM 无 .y 元素
    const sr = document.getElementById("host")!.attachShadow({ mode: "open" });
    const shadowEl1 = document.createElement("div");
    shadowEl1.className = "y";
    const shadowEl2 = document.createElement("span");
    shadowEl2.className = "y";
    sr.appendChild(shadowEl1);
    sr.appendChild(shadowEl2);

    const results = (window as any).__vortexDomResolve.queryAllDeep(".y");
    expect(results.length).toBe(2);
    expect(results).toContain(shadowEl1);
    expect(results).toContain(shadowEl2);
  });
});
