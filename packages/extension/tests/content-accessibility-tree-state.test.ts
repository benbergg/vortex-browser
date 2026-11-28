import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerContentHandlers } from "../src/handlers/content.js";
import type { DebuggerManager } from "../src/lib/debugger-manager.js";

/**
 * content.getAccessibilityTree:AX 节点新增 description / state / relations。
 *
 * - 归一化按属性区分:boolean 原样(显式 false 保留)、checked/pressed "mixed" 保留字符串、
 *   invalid token 保留字符串、hasPopup "true"→"menu"、level 只接受有限 number。
 * - 白名单外的属性(url/editable/settable 等)不携带;属性缺失不补造。
 * - 关系项保留 {backendDOMNodeId, text?}:text 缺失不得等同"没有关系"。
 * - 截断(description/关系 text/关系超 20 项/state 字符串超长)→ 根 truncated:true。
 * - 预算:序列化 UTF-8 ≤ 1 MiB,计算包含新增字段。
 */

const AX_MAX_BYTES = 1024 * 1024;
const AX_MAX_CHARS = 200;

function mkReq(args: Record<string, unknown> = {}): NmRequest {
  return {
    type: "tool_request",
    tool: "content.getAccessibilityTree",
    args,
    requestId: "r-a11y-state",
    tabId: 42,
  };
}

let dom: JSDOM;
let win: any;
let executeScript: ReturnType<typeof vi.fn>;

function setupPage(html: string) {
  dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: "https://github.com/microsoft/vscode/issues",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  win = dom.window as any;
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
      ]),
    },
    scripting: { executeScript },
    runtime: { lastError: null },
  });
}

function mkAxDebugger(nodes: unknown[]) {
  return {
    enableDomain: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_tabId: number, method: string) =>
      method === "Accessibility.getFullAXTree" ? { nodes } : ({} as unknown),
    ),
  } as unknown as DebuggerManager;
}

async function dispatchAx(nodes: unknown[]) {
  const router = new ActionRouter();
  const debuggerMgr = mkAxDebugger(nodes);
  registerContentHandlers(router, debuggerMgr);
  const resp = await router.dispatch(mkReq());
  expect(resp.error).toBeUndefined();
  return { tree: resp.result as any, debuggerMgr };
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

describe("content.getAccessibilityTree — AX 主路径来源", () => {
  it("真实 router dispatch 调用 getFullAXTree,返回 source=chrome-ax", async () => {
    const { tree, debuggerMgr } = await dispatchAx([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: [] },
    ]);
    const methods = (debuggerMgr.sendCommand as any).mock.calls.map((c: any[]) => c[1]);
    expect(methods).toContain("Accessibility.getFullAXTree");
    expect(tree.source).toBe("chrome-ax");
  });
});

describe("content.getAccessibilityTree — state 归一化", () => {
  const NODES = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: ["2", "3", "4", "5", "6"] },
    {
      nodeId: "2",
      parentId: "1",
      role: { value: "combobox" },
      name: { value: "Filter labels" },
      properties: [
        { name: "focused", value: { value: false } },
        { name: "focusable", value: { value: true } },
        { name: "required", value: { value: false } },
        { name: "invalid", value: { value: "false" } },
        { name: "hasPopup", value: { value: "true" } },
        { name: "autocomplete", value: { value: "list" } },
        // 白名单外:不得携带
        { name: "url", value: { value: "https://github.com/issues" } },
        { name: "editable", value: { value: "true" } },
        { name: "settable", value: { value: "false" } },
      ],
    },
    {
      nodeId: "3",
      parentId: "1",
      role: { value: "checkbox" },
      name: { value: "Mixed" },
      properties: [
        { name: "checked", value: { value: "mixed" } },
        { name: "pressed", value: { value: "mixed" } },
        { name: "invalid", value: { value: "spelling" } },
      ],
    },
    {
      nodeId: "4",
      parentId: "1",
      role: { value: "heading" },
      name: { value: "Filter by label" },
      properties: [{ name: "level", value: { value: 2 } }],
    },
    {
      nodeId: "5",
      parentId: "1",
      role: { value: "heading" },
      name: { value: "Bad level" },
      properties: [{ name: "level", value: { value: "two" } }],
    },
    {
      nodeId: "6",
      parentId: "1",
      role: { value: "button" },
      name: { value: "More" },
      properties: [{ name: "hasPopup", value: { value: "listbox" } }],
    },
  ];

  it("boolean 原样保留,字符串按属性区分归一化", async () => {
    const { tree } = await dispatchAx(NODES);
    const combo = tree.children[0];
    expect(combo.state.focused).toBe(false);
    expect(combo.state.focusable).toBe(true);
    expect(combo.state.required).toBe(false);
    expect(combo.state.invalid).toBe(false);
    expect(combo.state.haspopup).toBe("menu");
    expect(combo.state.autocomplete).toBe("list");
  });

  it("白名单外的属性不携带", async () => {
    const { tree } = await dispatchAx(NODES);
    const combo = tree.children[0];
    expect(combo.state).not.toHaveProperty("url");
    expect(combo.state).not.toHaveProperty("editable");
    expect(combo.state).not.toHaveProperty("settable");
  });

  it("checked/pressed 的 mixed、invalid 的 token 保留为字符串", async () => {
    const { tree } = await dispatchAx(NODES);
    const mixed = tree.children[1];
    expect(mixed.state.checked).toBe("mixed");
    expect(mixed.state.pressed).toBe("mixed");
    expect(mixed.state.invalid).toBe("spelling");
  });

  it("level 只接受有限 number,非数字不写入", async () => {
    const { tree } = await dispatchAx(NODES);
    expect(tree.children[2].state.level).toBe(2);
    expect(typeof tree.children[2].state.level).toBe("number");
    // 非数字 level → 不写入(该节点没有任何可写 state → 不补造空对象)
    expect(tree.children[3].state ?? {}).not.toHaveProperty("level");
  });

  it("hasPopup=listbox 原样保留", async () => {
    const { tree } = await dispatchAx(NODES);
    expect(tree.children[4].state.haspopup).toBe("listbox");
  });
});

describe("content.getAccessibilityTree — relations", () => {
  it("只有 backendDOMNodeId、没有 text 的关系项被保留", async () => {
    const { tree } = await dispatchAx([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "combobox" },
        name: { value: "Filter labels" },
        properties: [
          { name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 12 }] } },
          { name: "labelledby", value: { relatedNodes: [{ backendDOMNodeId: 20, text: "Label" }] } },
        ],
      },
    ]);
    const combo = tree.children[0];
    expect(combo.relations.controls).toHaveLength(1);
    expect(combo.relations.controls[0].backendDOMNodeId).toBe(12);
    expect(combo.relations.controls[0].text).toBeUndefined();
    expect(combo.relations.labelledby[0]).toEqual({ backendDOMNodeId: 20, text: "Label" });
    expect(tree.truncated).toBeUndefined();
  });

  it("关系项超过 20 项 → 保留 20 项且根 truncated", async () => {
    const relatedNodes = Array.from({ length: 21 }, (_, i) => ({ backendDOMNodeId: i + 1 }));
    const { tree } = await dispatchAx([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "combobox" },
        name: { value: "Filter labels" },
        properties: [{ name: "controls", value: { relatedNodes } }],
      },
    ]);
    const combo = tree.children[0];
    expect(combo.relations.controls).toHaveLength(20);
    expect(combo.relations.controls[19].backendDOMNodeId).toBe(20);
    expect(tree.truncated).toBe(true);
  });

  it("超长关系 text 截到 200 且根 truncated", async () => {
    const { tree } = await dispatchAx([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "combobox" },
        name: { value: "Filter labels" },
        properties: [
          { name: "describedby", value: { relatedNodes: [{ backendDOMNodeId: 3, text: "x".repeat(250) }] } },
        ],
      },
    ]);
    const text = tree.children[0].relations.describedby[0].text;
    expect(text.length).toBe(AX_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
    expect(tree.truncated).toBe(true);
  });
});

describe("content.getAccessibilityTree — description", () => {
  it("250 字符 description 截到 200(含 …),根 truncated", async () => {
    const { tree } = await dispatchAx([
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Issues" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "combobox" },
        name: { value: "Filter labels" },
        description: { value: "y".repeat(250) },
      },
    ]);
    const combo = tree.children[0];
    expect(combo.description.length).toBe(AX_MAX_CHARS);
    expect(combo.description.endsWith("…")).toBe(true);
    expect(combo.truncated).toBe(true);
    expect(tree.truncated).toBe(true);
  });
});

describe("content.getAccessibilityTree — 预算包含新增字段", () => {
  /** 每个节点带 description + 5 条关系 text(均为 200 字中文) */
  function bigFixture(nodeCount: number, withMeta: boolean) {
    const text = "汉".repeat(AX_MAX_CHARS);
    const nodes: any[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "root" }, childIds: [] },
    ];
    for (let i = 0; i < nodeCount; i++) {
      const id = String(i + 2);
      nodes[0].childIds.push(id);
      const node: any = {
        nodeId: id,
        parentId: "1",
        role: { value: "generic" },
        name: { value: `n${i}` },
      };
      if (withMeta) {
        node.description = { value: text };
        node.properties = [
          {
            name: "controls",
            value: {
              relatedNodes: Array.from({ length: 5 }, (_, k) => ({
                backendDOMNodeId: k + 1,
                text,
              })),
            },
          },
        ];
      }
      nodes.push(node);
    }
    return nodes;
  }

  it("不含新增字段时 <1MiB、加入后 >1MiB → 返回值 ≤1MiB 且根 truncated", async () => {
    const plainBytes = utf8Len(JSON.stringify(bigFixture(400, false)));
    expect(plainBytes).toBeLessThan(AX_MAX_BYTES);

    const { tree } = await dispatchAx(bigFixture(400, true));
    expect(utf8Len(JSON.stringify(tree))).toBeLessThanOrEqual(AX_MAX_BYTES);
    expect(tree.truncated).toBe(true);
  });

  it("界内 fixture 不误报 truncated", async () => {
    const { tree } = await dispatchAx(bigFixture(20, true));
    expect(utf8Len(JSON.stringify(tree))).toBeLessThanOrEqual(AX_MAX_BYTES);
    expect(tree.truncated).toBeUndefined();
    expect(tree.children).toHaveLength(20);
    expect(tree.children[0].description.length).toBe(AX_MAX_CHARS);
    expect(tree.children[0].relations.controls).toHaveLength(5);
  });
});
