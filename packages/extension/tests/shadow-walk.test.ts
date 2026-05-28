import { describe, it, expect, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import { queryDeep, queryAllDeep, deepElementFromPoint } from "../src/page-side/shadow-walk.js";

function setup(html: string): Document {
  const dom = new JSDOM(html);
  globalThis.document = dom.window.document as unknown as Document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  return dom.window.document as unknown as Document;
}

describe("shadow-walk queryDeep", () => {
  it("light-DOM 优先：直接命中不走 shadow", () => {
    const doc = setup('<button id="b">x</button>');
    const found = queryDeep("#b", doc as unknown as Document);
    expect(found).toBe(doc.getElementById("b"));
  });

  it("穿 open shadow 命中 shadow-internal 元素", () => {
    const doc = setup('<div id="host"></div>');
    const host = doc.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    const btn = doc.createElement("button");
    btn.setAttribute("data-vortex-rid", "r1");
    sr.appendChild(btn);
    const found = queryDeep('[data-vortex-rid="r1"]', doc as unknown as Document);
    expect(found).toBe(btn);
  });

  it("嵌套两层 open shadow 也能命中（递归）", () => {
    const doc = setup('<div id="host"></div>');
    const sr1 = doc.getElementById("host")!.attachShadow({ mode: "open" });
    const inner = doc.createElement("div");
    sr1.appendChild(inner);
    const sr2 = inner.attachShadow({ mode: "open" });
    const btn = doc.createElement("button");
    btn.setAttribute("data-vortex-rid", "r2");
    sr2.appendChild(btn);
    expect(queryDeep('[data-vortex-rid="r2"]', doc as unknown as Document)).toBe(btn);
  });

  it("closed shadow 不可见（CE spec）", () => {
    const doc = setup('<div id="host"></div>');
    const sr = doc.getElementById("host")!.attachShadow({ mode: "closed" });
    const btn = doc.createElement("button");
    btn.setAttribute("data-vortex-rid", "r3");
    sr.appendChild(btn);
    expect(queryDeep('[data-vortex-rid="r3"]', doc as unknown as Document)).toBeNull();
  });

  it("queryAllDeep 跨 light + shadow 计数（消歧用）", () => {
    const doc = setup('<button class="x"></button><div id="host"></div>');
    const sr = doc.getElementById("host")!.attachShadow({ mode: "open" });
    const btn2 = doc.createElement("button");
    btn2.className = "x";
    sr.appendChild(btn2);
    expect(queryAllDeep("button.x", doc as unknown as Document).length).toBe(2);
  });

  it("深度上限：11 层嵌套时 depth=10 处停止，第 11 层返回 null", () => {
    const doc = setup('<div id="root"></div>');
    // 构建 11 层嵌套 open shadow 链，追踪当前可 appendChild 的节点
    let currentParent: Element | ShadowRoot = doc.getElementById("root")!;
    for (let i = 0; i < 11; i++) {
      const host = doc.createElement("div");
      currentParent.appendChild(host);
      currentParent = host.attachShadow({ mode: "open" });
    }
    // 在第 11 层（depth=11 > MAX_SHADOW_DEPTH=10）放目标元素
    const target = doc.createElement("button");
    target.setAttribute("data-depth", "11");
    currentParent.appendChild(target);
    expect(queryDeep('[data-depth="11"]', doc as unknown as Document)).toBeNull();
  });

  it("深度上限：depth=5 的元素仍可被找到（上限不过早截止）", () => {
    const doc = setup('<div id="root"></div>');
    // 构建 5 层嵌套 open shadow 链
    let currentParent: Element | ShadowRoot = doc.getElementById("root")!;
    for (let i = 0; i < 5; i++) {
      const host = doc.createElement("div");
      currentParent.appendChild(host);
      currentParent = host.attachShadow({ mode: "open" });
    }
    const target = doc.createElement("button");
    target.setAttribute("data-depth", "5");
    currentParent.appendChild(target);
    expect(queryDeep('[data-depth="5"]', doc as unknown as Document)).toBe(target);
  });

  describe("deepElementFromPoint", () => {
    it("light-DOM：elementFromPoint 返回无 shadowRoot 的普通元素，原样返回", () => {
      const doc = setup('<button id="btn">x</button>');
      const btn = doc.getElementById("btn")!;
      // jsdom 不实现 elementFromPoint，需手动定义
      Object.defineProperty(doc, "elementFromPoint", {
        value: () => btn,
        configurable: true,
      });
      expect(deepElementFromPoint(10, 10)).toBe(btn);
    });

    it("shadow：elementFromPoint 返回 host，下钻后返回 shadow 内的 button", () => {
      const doc = setup('<div id="host"></div>');
      const host = doc.getElementById("host")!;
      const sr = host.attachShadow({ mode: "open" });
      const btn = doc.createElement("button");
      sr.appendChild(btn);
      // mock document.elementFromPoint → host
      Object.defineProperty(doc, "elementFromPoint", {
        value: () => host,
        configurable: true,
      });
      // mock shadowRoot.elementFromPoint → btn
      Object.defineProperty(sr, "elementFromPoint", {
        value: () => btn,
        configurable: true,
      });
      expect(deepElementFromPoint(5, 5)).toBe(btn);
    });
  });

  it("queryAllDeep 嵌套两层 shadow 各有 .x 加 light-DOM .x，共累积 3 个", () => {
    const doc = setup('<button class="x"></button><div id="host1"></div>');
    // 第一层 shadow
    const sr1 = doc.getElementById("host1")!.attachShadow({ mode: "open" });
    const btn1 = doc.createElement("button");
    btn1.className = "x";
    sr1.appendChild(btn1);
    // 在第一层 shadow 内再套一个 host
    const host2 = doc.createElement("div");
    sr1.appendChild(host2);
    const sr2 = host2.attachShadow({ mode: "open" });
    const btn2 = doc.createElement("button");
    btn2.className = "x";
    sr2.appendChild(btn2);
    expect(queryAllDeep("button.x", doc as unknown as Document).length).toBe(3);
  });
});
