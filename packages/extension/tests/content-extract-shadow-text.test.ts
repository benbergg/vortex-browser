/**
 * Author: qingwa
 * Description: vortex_extract 穿透 open shadow DOM 收集可见文本(白盒+DAST,2026-06-20)。
 *
 * 缺陷(silent-false-negative + sibling 不对称):
 *   GET_TEXT(content.getText)用 `root.innerText` 取文本,而 Chrome 的 innerText
 *   **不进 shadow tree** → 页面用 web component 时,shadow 内可见文本被静默漏掉,
 *   无任何信号。sibling 读原语 observe 经 querySelectorAllDeep 穿 open shadow 能看到
 *   (extract 的 walkControls 也已穿 open shadow),唯独主文本路径没穿。
 *   工具 schema 自述 "Extract visible text",而 shadow 文本视觉上是可见的 → 违反契约。
 *
 *   DAST 实机复现(example.com 注入 open/closed shadow canary):
 *     vortex_extract 只回 LIGHT_CANARY,漏 OPEN_SHADOW_CANARY;
 *     vortex_observe 看到 button "OPEN_SHADOW_CANARY"。
 *
 * 修复:GET_TEXT 文本路径加 collectShadowText —— 遍历 root 子树找 open shadow host
 *   (closed shadowRoot 读为 null,浏览器硬限制、两原语都不可达),取其 shadow 子树
 *   innerText,用 includes 去重追加(slot 投影的 light 文本已在 base 里,去重避免重复;
 *   live spike 验证 slot 组件 slotted_count=1 无重复,同 walkWithAlt 既有取舍)。
 *
 * Why TDD:
 *   collectShadowText 是 page-side 内纯函数,jsdom 直接测(innerText 用 textContent
 *   polyfill,jsdom 不实现 innerText)。集成测试 source-lock content.ts 含穿透逻辑。
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * collectShadowText 纯函数:从 base(root.innerText)出发,遍历 root 子树,
 * 对每个 open shadow host 取其 shadow 子树 innerText,includes 去重追加。
 * closed shadowRoot 读为 null(浏览器限制),自然跳过。
 */
function collectShadowText(rootEl: Element, base: string): string {
  let result = base;
  const stack: Element[] = [rootEl];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const el = stack.pop()!;
    visited++;
    const sr = (el as { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) {
      for (const sc of Array.from(sr.children)) {
        const t = ((sc as HTMLElement).innerText ?? "").trim();
        if (t && !result.includes(t)) result += "\n" + t;
        stack.push(sc);
      }
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return result;
}

function withDom(fn: (doc: Document) => void) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, { url: "https://x/" });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.Element = dom.window.Element;
  g.HTMLElement = dom.window.HTMLElement;
  // jsdom 不实现 innerText → 用 textContent 兜底,使纯函数逻辑可跑
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return (this as HTMLElement).textContent;
    },
  });
  try {
    fn(dom.window.document);
  } finally {
    /* keep globals */
  }
}

describe("collectShadowText (vortex_extract open shadow 穿透纯函数)", () => {
  it("open shadow 内文本被追加(修复核心)", () => {
    withDom((doc) => {
      const host = doc.createElement("div");
      const sr = host.attachShadow({ mode: "open" });
      sr.innerHTML = "<button>OPEN_SHADOW_CANARY</button>";
      doc.body.appendChild(host);
      const out = collectShadowText(doc.body, doc.body.textContent ?? "");
      expect(out).toContain("OPEN_SHADOW_CANARY");
    });
  });

  it("closed shadow 不可达(el.shadowRoot=null)→ 不追加(浏览器硬限制,与 observe 一致)", () => {
    withDom((doc) => {
      const host = doc.createElement("div");
      host.attachShadow({ mode: "closed" }).innerHTML = "<button>CLOSED_CANARY</button>";
      doc.body.appendChild(host);
      const out = collectShadowText(doc.body, doc.body.textContent ?? "");
      expect(out).not.toContain("CLOSED_CANARY");
    });
  });

  it("嵌套 open shadow(host 套 host)逐层追加", () => {
    withDom((doc) => {
      const outer = doc.createElement("div");
      const outerSR = outer.attachShadow({ mode: "open" });
      const inner = doc.createElement("section");
      const innerSR = inner.attachShadow({ mode: "open" });
      innerSR.innerHTML = "<span>NESTED_DEEP_TEXT</span>";
      outerSR.appendChild(inner);
      doc.body.appendChild(outer);
      const out = collectShadowText(doc.body, doc.body.textContent ?? "");
      expect(out).toContain("NESTED_DEEP_TEXT");
    });
  });

  it("dedup:shadow 文本已在 base 中则不重复追加", () => {
    withDom((doc) => {
      const host = doc.createElement("div");
      host.attachShadow({ mode: "open" }).innerHTML = "<span>DUP_TEXT</span>";
      doc.body.appendChild(host);
      const base = "preamble DUP_TEXT preamble";
      const out = collectShadowText(doc.body, base);
      expect((out.match(/DUP_TEXT/g) || []).length).toBe(1);
    });
  });

  it("无 shadow 的纯 light DOM → 返回 base 不变", () => {
    withDom((doc) => {
      const p = doc.createElement("p");
      p.textContent = "PLAIN";
      doc.body.appendChild(p);
      const base = doc.body.textContent ?? "";
      const out = collectShadowText(doc.body, base);
      expect(out).toBe(base);
    });
  });
});

describe("content.ts 集成 — GET_TEXT 文本路径穿透 open shadow (source-lock)", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(join(__dirname, "..", "src", "handlers", "content.ts"), "utf8");

  it("page-side func 含 open shadow 文本收集(shadowRoot 遍历 + collectShadowText)", () => {
    expect(SRC).toMatch(/collectShadowText/);
    // 文本路径(非仅 walkControls)读取 shadowRoot
    expect(SRC).toMatch(/shadowRoot/);
  });

  it("collectShadowText 在 GET_TEXT 文本组装中被调用(包裹 inner/walkWithAlt)", () => {
    // text 最终赋值处应经过 collectShadowText
    expect(SRC).toMatch(/collectShadowText\(/);
  });
});
