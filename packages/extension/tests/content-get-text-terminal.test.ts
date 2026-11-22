/**
 * @vitest-environment jsdom
 */
/**
 * extract(GET_TEXT) 的终端逻辑行读回(P1)。
 *
 * 场景(xterm):终端把每行补齐到列宽,innerText 里全是尾随空格 → 提取结果必须是
 * 干净逻辑行,且页面其余文本保留。断言打在**真实注入 func** 的返回体上(不抄一份
 * 实现),jsdom 里跑真 DOM。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";

interface Injection {
  target?: { tabId?: number; frameIds?: number[] };
  files?: string[];
  func?: (...args: unknown[]) => unknown;
  args?: unknown[];
  world?: string;
}

// jsdom 未实现 innerText;这里按浏览器语义近似:块级子元素之间补换行。
// 不能直接用 textContent —— 那样整页只有一行,终端行匹配不到(stripTerminalLines 失效)。
const BLOCK_TAGS = new Set(["DIV", "P", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "PRE"]);
if (!("innerText" in window.HTMLElement.prototype)) {
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      const parts: string[] = [];
      const walk = (node: Node): void => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            parts.push(child.textContent ?? "");
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const el = child as HTMLElement;
            if (el.hidden || getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden") continue;
            walk(el);
            if (BLOCK_TAGS.has(el.tagName)) parts.push("\n");
          }
        }
      };
      walk(this);
      return parts.join("");
    },
  });
}

/** 注入 func 真跑在 jsdom document 上(不 mock 采集逻辑)。 */
async function setup() {
  vi.resetModules();
  const executeScript = vi.fn(async (injection: Injection) => {
    if (Array.isArray(injection?.files)) return [{ result: undefined }];
    if (typeof injection?.func === "function") {
      return [{ result: await injection.func(...(injection.args ?? [])) }];
    }
    throw new Error("Unexpected injection shape");
  });
  (globalThis as any).chrome = {
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      get: vi.fn(async () => ({ id: 1 })),
      query: vi.fn(async () => [{ id: 1 }]),
    },
    webNavigation: {
      onCommitted: { addListener: vi.fn() },
      getAllFrames: vi.fn(async () => [{ frameId: 0 }]),
    },
  };
  const { ActionRouter } = await import("../src/lib/router.js");
  const { registerContentHandlers } = await import("../src/handlers/content.js");
  const router = new ActionRouter();
  registerContentHandlers(router);
  return { router, executeScript };
}

function req(args: Record<string, unknown>): NmRequest {
  return { type: "tool_request", tool: "content.getText", args, requestId: "r1", tabId: 1 };
}

/** 最小 xterm fixture:两行,行尾补齐到 40 列。 */
function buildTerminalDom(): void {
  document.body.innerHTML = "";
  const header = document.createElement("div");
  header.textContent = "Header";
  document.body.appendChild(header);
  const rows = document.createElement("div");
  rows.className = "xterm-rows";
  for (const raw of ["root@host:/tmp# ls", "total 0"]) {
    const row = document.createElement("div");
    row.textContent = raw.padEnd(40, " ");
    rows.appendChild(row);
  }
  document.body.appendChild(rows);
}

describe("extract 的终端逻辑行读回", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it("混合页面保留原生文本且仍只注入一次", async () => {
    const { router, executeScript } = await setup();
    buildTerminalDom();

    const resp = await router.dispatch(req({}));

    expect(resp.error).toBeUndefined();
    const text = String(resp.result);
    expect(text).toContain("root@host:/tmp# ls");
    expect(text).toContain("total 0");
    expect(text).toContain("Header");
    expect(text).toBe(document.body.innerText);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("隐藏终端不泄露内容", async () => {
    const { router } = await setup();
    document.body.innerHTML = '<div>Visible</div><section hidden><div class="xterm-rows"><div>SECRET</div></div></section>';
    const resp = await router.dispatch(req({}));
    expect(String(resp.result)).not.toContain("SECRET");
  });

  it("不同来源的同文和其他编辑器内容不丢失", async () => {
    const { router } = await setup();
    document.body.innerHTML = '<div>same</div><div class="xterm-rows"><div>same</div></div><div class="view-lines"><div class="view-line">EDITOR</div></div>';
    const resp = await router.dispatch(req({}));
    expect(String(resp.result).match(/same/g)).toHaveLength(2);
    expect(String(resp.result)).toContain("EDITOR");
  });

  it("隐藏行和行内隐藏内容不会泄露", async () => {
    const { router } = await setup();
    document.body.innerHTML = '<div class="xterm-rows"><div>visible<span hidden>SECRET</span></div><div hidden>HIDDEN_ROW</div></div>';
    const resp = await router.dispatch(req({}));
    expect(String(resp.result)).toContain("visible");
    expect(String(resp.result)).not.toMatch(/SECRET|HIDDEN_ROW/);
  });

  it("目标本身是终端容器时仍读取逻辑行", async () => {
    const { router } = await setup();
    document.body.innerHTML = '<div class="xterm-rows"><div>\u00a0\u00a0indented\u00a0\u00a0\u00a0</div></div>';
    (window as any).__vortexDomResolve = { queryDeep: (sel: string) => document.querySelector(sel) };
    const resp = await router.dispatch(req({ selector: ".xterm-rows" }));
    delete (window as any).__vortexDomResolve;
    expect(String(resp.result)).toBe("  indented");
  });

  it("混合页面保持多个终端及页面原文", async () => {
    const { router } = await setup();
    document.body.innerHTML = '<div>before</div><div class="xterm-rows"><div>  first   </div><div></div><div>last   </div></div><div>middle</div><div class="xterm-rows"><div>second   </div></div><div>after</div>';
    const resp = await router.dispatch(req({}));
    expect(String(resp.result)).toBe(document.body.innerText);
  });

  it("页面没有终端时文本保持原样", async () => {
    const { router } = await setup();
    document.body.innerHTML = "";
    const plain = document.createElement("div");
    plain.textContent = "Plain body text";
    document.body.appendChild(plain);

    const resp = await router.dispatch(req({}));

    expect(resp.error).toBeUndefined();
    expect(String(resp.result)).toContain("Plain body text");
  });
});
