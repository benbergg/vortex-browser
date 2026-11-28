import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerContentHandlers } from "../src/handlers/content.js";
import type { DebuggerManager } from "../src/lib/debugger-manager.js";

/**
 * content.getAccessibilityTree:Chrome AX 主路径 + DOM 启发式回退。
 *
 * - AX 主路径:mock debugger 收到 Accessibility.getFullAXTree,树按 childIds 重建,
 *   ignored 中间节点的有效后代提升到父级并保序。
 * - 回退:enableDomain / getFullAXTree 抛错 → DOM 路径(source=dom-heuristic, degraded)。
 * - DOM 路径执行**序列化的生产注入函数**(jsdom eval),验证 generic role 与名称上限。
 * - 预算:AX 节点 2000 / 深度 20 / name+value 200 字符 / 序列化 1 MiB。
 */

const AX_MAX_BYTES = 1024 * 1024;
const AX_MAX_NODES = 2000;
const AX_MAX_DEPTH = 20;
const AX_MAX_CHARS = 200;

function mkReq(args: Record<string, unknown> = {}): NmRequest {
  return {
    type: "tool_request",
    tool: "content.getAccessibilityTree",
    args,
    requestId: "r-a11y",
    tabId: 42,
  };
}

let dom: JSDOM;
let win: any;
let executeScript: ReturnType<typeof vi.fn>;

function setupPage(html: string) {
  dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://developer.mozilla.org/en-US/docs/Web/Accessibility",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  win = dom.window as any;
  // jsdom 不实现 innerText:生产注入函数读 innerText,这里按 textContent 补齐,
  // 让被测的是真实注入函数而不是替身。
  Object.defineProperty(win.HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: any) {
      return this.textContent;
    },
  });
  executeScript = vi.fn(async (details: any) => {
    const result = await win.eval(`(${String(details.func)})`)(...structuredClone(details.args ?? []));
    return [{ frameId: 0, documentId: "doc-1", result: structuredClone(result) }];
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, parentFrameId: -1, url: win.location.href },
        { frameId: 5, parentFrameId: 0, url: "https://x/frame" },
      ]),
    },
    scripting: { executeScript },
    runtime: { lastError: null },
  });
}

function mkDebugger(overrides: {
  enableDomain?: () => Promise<void>;
  sendCommand?: (method: string) => Promise<unknown>;
}) {
  return {
    enableDomain: vi.fn(overrides.enableDomain ?? (async () => undefined)),
    sendCommand: vi.fn(async (_tabId: number, method: string) =>
      overrides.sendCommand ? overrides.sendCommand(method) : ({} as unknown),
    ),
  } as unknown as DebuggerManager;
}

function mkAxDebugger(nodes: unknown[]) {
  return mkDebugger({
    sendCommand: async (method) => {
      if (method === "Accessibility.getFullAXTree") return { nodes };
      return {};
    },
  });
}

/** 遍历返回树:节点数 / 最大深度 / 最长 name|value */
function measure(node: any, depth = 1) {
  let count = 1;
  let maxDepth = depth;
  let maxChars = 0;
  for (const child of node?.children ?? []) {
    const sub = measure(child, depth + 1);
    count += sub.count;
    maxDepth = Math.max(maxDepth, sub.maxDepth);
    maxChars = Math.max(maxChars, sub.maxChars);
  }
  for (const text of [node?.name, node?.value]) {
    if (typeof text === "string") maxChars = Math.max(maxChars, text.length);
  }
  return { count, maxDepth, maxChars };
}

function utf8Len(json: string): number {
  return Buffer.byteLength(json, "utf8");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  setupPage("");
});

afterEach(() => {
  dom?.window?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("content.getAccessibilityTree — Chrome AX 主路径", () => {
  const AX_NODES = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "MDN Web Docs" }, childIds: ["2", "7"] },
    // ignored 中间节点:其下有效搜索控件必须提升到父级并保序
    { nodeId: "2", parentId: "1", ignored: true, role: { value: "generic" }, childIds: ["3"] },
    {
      nodeId: "3",
      parentId: "2",
      role: { value: "combobox" },
      name: { value: "Search Wikipedia" },
      value: { value: "accessibility" },
      childIds: ["4"],
    },
    { nodeId: "4", parentId: "3", role: { value: "listbox" }, name: { value: "Search results" }, childIds: ["5", "6"] },
    { nodeId: "5", parentId: "4", role: { value: "option" }, name: { value: "Accessibility" } },
    { nodeId: "6", parentId: "4", role: { value: "option" }, name: { value: "ARIA" } },
    { nodeId: "7", parentId: "1", role: { value: "link" }, name: { value: "Guides" } },
  ];

  it("取 Chrome AX 树:role/name/value 用 Chrome 原值,ignored 节点的有效后代提升保序", async () => {
    const router = new ActionRouter();
    const debuggerMgr = mkAxDebugger(AX_NODES);
    registerContentHandlers(router, debuggerMgr);

    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;

    expect((debuggerMgr.sendCommand as any).mock.calls.map((c: any[]) => c[1])).toContain(
      "Accessibility.getFullAXTree",
    );
    expect(tree.source).toBe("chrome-ax");
    expect(tree.degraded).toBeUndefined();
    expect(tree.role).toBe("RootWebArea");

    // ignored 的中间节点自身跳过,其下的搜索控件提升到根级并保持顺序
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].role).toBe("combobox");
    expect(tree.children[0].name).toBe("Search Wikipedia");
    expect(tree.children[0].value).toBe("accessibility");
    expect(tree.children[0].children[0].role).toBe("listbox");
    expect(tree.children[0].children[0].name).toBe("Search results");
    expect(tree.children[0].children[0].children.map((n: any) => n.name)).toEqual([
      "Accessibility",
      "ARIA",
    ]);
    expect(tree.children[1].role).toBe("link");
    expect(tree.children[1].name).toBe("Guides");

    // AX 主路径不注入页内脚本
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("enableDomain 失败 → 回退 DOM 路径并标注 degraded", async () => {
    const router = new ActionRouter();
    const debuggerMgr = mkDebugger({
      enableDomain: async () => {
        throw new Error("attach failed: debugger busy");
      },
    });
    registerContentHandlers(router, debuggerMgr);

    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;
    expect(tree.source).toBe("dom-heuristic");
    expect(tree.degraded).toBe(true);
    expect(tree.degradedReason).toContain("attach failed");
  });

  it("getFullAXTree 失败 → 回退 DOM 路径并标注 degraded", async () => {
    const router = new ActionRouter();
    const debuggerMgr = mkDebugger({
      sendCommand: async (method) => {
        if (method === "Accessibility.getFullAXTree") throw new Error("Accessibility.getFullAXTree failed: boom");
        return {};
      },
    });
    registerContentHandlers(router, debuggerMgr);

    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;
    expect(tree.source).toBe("dom-heuristic");
    expect(tree.degraded).toBe(true);
    expect(tree.degradedReason).toContain("getFullAXTree failed");
  });
});

describe("content.getAccessibilityTree — DOM 回退路径(执行序列化生产注入函数)", () => {
  it("未知标签归 generic,既有合法角色不变;超长 aria-label 截到 100 并标记", async () => {
    const long = "汉".repeat(150);
    setupPage(`
      <my-widget id="w" aria-label="Widget label"></my-widget>
      <div id="d"></div>
      <span id="s"></span>
      <a id="a" href="#x">Link text</a>
      <button id="btn">Button text</button>
      <nav id="nav">Nav text</nav>
      <my-long id="long" aria-label="${long}"></my-long>
    `);
    const router = new ActionRouter();
    registerContentHandlers(router); // 无 debugger → debugger-unavailable

    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;
    expect(tree.source).toBe("dom-heuristic");
    expect(tree.degraded).toBe(true);
    expect(tree.degradedReason).toBe("debugger-unavailable");

    expect(tree.children.map((n: any) => n.role)).toEqual([
      "generic", // my-widget
      "generic", // div
      "generic", // span
      "link", // a
      "button", // button
      "navigation", // nav
      "generic", // my-long
    ]);
    expect(tree.children[0].name).toBe("Widget label");
    expect(tree.children[3].name).toBe("Link text");

    // 所有名称来源统一 100 字符上限,省略号计入上限
    const longName = tree.children[6].name;
    expect(longName.length).toBe(100);
    expect(longName.endsWith("…")).toBe(true);
    expect(tree.truncated).toBe(true);
  });
});

describe("content.getAccessibilityTree — frame 路由", () => {
  it("非零 frameId → 走 DOM 路径且不发送 AX 命令", async () => {
    const router = new ActionRouter();
    const debuggerMgr = mkAxDebugger([]);
    registerContentHandlers(router, debuggerMgr);

    const resp = await router.dispatch(mkReq({ frameId: 5 }));
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;
    expect(tree.source).toBe("dom-heuristic");
    expect((debuggerMgr.sendCommand as any).mock.calls.map((c: any[]) => c[1])).not.toContain(
      "Accessibility.getFullAXTree",
    );
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].target.frameIds).toEqual([5]);
  });
});

describe("content.getAccessibilityTree — 预算", () => {
  function axFixture(nodeCount: number, chars: number) {
    const text = "汉".repeat(chars);
    const nodes: any[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "root" }, childIds: [] },
    ];
    for (let i = 0; i < nodeCount; i++) {
      const id = String(i + 2);
      nodes[0].childIds.push(id);
      nodes.push({
        nodeId: id,
        parentId: "1",
        role: { value: "generic" },
        name: { value: text },
        value: { value: text },
      });
    }
    return nodes;
  }

  async function dispatchFixture(nodeCount: number, chars = AX_MAX_CHARS) {
    const router = new ActionRouter();
    registerContentHandlers(router, mkAxDebugger(axFixture(nodeCount, chars)));
    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    return resp.result as any;
  }

  it("1000 节点 × 200 字中文 name/value:节点数与长度合规但字节超限 → 必须截断并标记", async () => {
    const tree = await dispatchFixture(1000);
    const stats = measure(tree);
    const bytes = utf8Len(JSON.stringify(tree));

    expect(tree.source).toBe("chrome-ax");
    expect(tree.truncated).toBe(true);
    expect(stats.count).toBeLessThanOrEqual(AX_MAX_NODES);
    expect(stats.maxDepth).toBeLessThanOrEqual(AX_MAX_DEPTH);
    expect(stats.maxChars).toBeLessThanOrEqual(AX_MAX_CHARS);
    expect(bytes).toBeLessThanOrEqual(AX_MAX_BYTES);
  });

  it("超深树:层级截到 20 并可见标记", async () => {
    const nodes: any[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "root" }, childIds: ["2"] },
    ];
    for (let i = 0; i < 30; i++) {
      const id = String(i + 2);
      const next = String(i + 3);
      nodes.push({
        nodeId: id,
        parentId: i === 0 ? "1" : String(i + 1),
        role: { value: "generic" },
        name: { value: `n${i}` },
        childIds: i < 29 ? [next] : [],
      });
    }
    const router = new ActionRouter();
    registerContentHandlers(router, mkAxDebugger(nodes));
    const resp = await router.dispatch(mkReq());
    expect(resp.error).toBeUndefined();
    const tree: any = resp.result;
    expect(measure(tree).maxDepth).toBeLessThanOrEqual(AX_MAX_DEPTH);
    expect(tree.truncated).toBe(true);
  });

  it("恰好在字节界内不误报 truncated,越界即截断", async () => {
    let lo = 1;
    let hi = 1000;
    let best = 0;
    let bestBytes = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const tree = await dispatchFixture(mid);
      if (tree.truncated === undefined) {
        best = mid;
        bestBytes = utf8Len(JSON.stringify(tree));
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    expect(best).toBeGreaterThan(0);

    // 界内:未丢数据 → 不得置 truncated,且节点全在
    const inside = await dispatchFixture(best);
    expect(inside.truncated).toBeUndefined();
    expect(measure(inside).count).toBe(best + 1);
    expect(bestBytes).toBeLessThanOrEqual(AX_MAX_BYTES);
    // 边界贴合:距上限不足一个节点的大小(说明上限是按字节生效的,不是拍脑袋的保守值)
    const nodeCost = bestBytes - utf8Len(JSON.stringify(await dispatchFixture(best - 1)));
    expect(AX_MAX_BYTES - bestBytes).toBeLessThan(nodeCost);

    // 越界一个节点:必须截断,且仍落在预算内
    const over = await dispatchFixture(best + 1);
    expect(over.truncated).toBe(true);
    expect(utf8Len(JSON.stringify(over))).toBeLessThanOrEqual(AX_MAX_BYTES);
  });
});
