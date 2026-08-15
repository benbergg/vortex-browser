/**
 * Author: qingwa
 * Description: dom-resolve 暴露 classifyHit 给 dom.ts / cdp.ts 的注入函数。
 *   version 必须同步 bump——页面上残留的 v1 对象会让新方法 undefined。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { JSDOM } from "jsdom";

afterEach(() => vi.resetModules());

async function loadInto(html: string, preset?: { version: number }) {
  vi.resetModules();
  const dom = new JSDOM(`<body>${html}</body>`);
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  if (preset) (dom.window as any).__vortexDomResolve = preset;
  await import("../src/page-side/dom-resolve.js");
  return dom.window.document;
}

describe("dom-resolve.classifyHit", () => {
  it("暴露 classifyHit 且 version 为 2", async () => {
    await loadInto(`<div id="w"><button id="b">x</button></div>`);
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.version).toBe(2);
    expect(typeof ns.classifyHit).toBe("function");
  });

  it("非交互祖先 → ancestor", async () => {
    const doc = await loadInto(`<div id="w" class="row"><button id="b">x</button></div>`);
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.classifyHit(doc.getElementById("b"), doc.getElementById("w"))).toEqual({
      ok: false, blocker: "div#w.row", kind: "ancestor",
    });
  });

  it("残留的 v1 对象会被替换（version 守卫不得把新方法挡在外面）", async () => {
    await loadInto(`<button id="b">x</button>`, { version: 1 });
    const ns = (globalThis as any).window.__vortexDomResolve;
    expect(ns.version).toBe(2);
    expect(typeof ns.classifyHit).toBe("function");
  });
});
