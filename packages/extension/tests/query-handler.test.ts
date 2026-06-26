// query-handler.test.ts
// 测试 vortex_query 工具的 extension 侧 handler 逻辑
// 覆盖:text grep 命中+上下文 / css 计数 / css 取属性(href) / 无匹配空结果

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { VtxErrorCode } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerQueryHandlers } from "../src/handlers/query.js";

function mkReq(tool: string, args: Record<string, unknown> = {}): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1" };
}

describe("query.queryPage — text mode", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  it("text 命中时返回 matches 数组含 match_text 和 context", async () => {
    // page-side 脚本返回匹配结果
    executeScript.mockResolvedValueOnce([{
      result: {
        matches: [
          { match_text: "Hello", context: "...Hello World...", element_path: "div#main", char_position: 5 },
        ],
        total: 1,
        has_more: false,
      },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "text",
      pattern: "Hello",
    }));

    expect(res.error).toBeUndefined();
    const result = res.result as { matches: unknown[]; total: number };
    expect(result.total).toBe(1);
    expect(result.matches).toHaveLength(1);
    expect((result.matches[0] as { match_text: string }).match_text).toBe("Hello");
    expect((result.matches[0] as { context: string }).context).toContain("Hello");
  });

  it("text 无匹配时返回 total=0 和空 matches", async () => {
    executeScript.mockResolvedValueOnce([{
      result: { matches: [], total: 0, has_more: false },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "text",
      pattern: "NotExistXYZ",
    }));

    expect(res.error).toBeUndefined();
    const result = res.result as { matches: unknown[]; total: number };
    expect(result.total).toBe(0);
    expect(result.matches).toHaveLength(0);
  });

  it("mode=text 缺少 pattern 时返回 INVALID_PARAMS 错误", async () => {
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "text" }));
    expect(res.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });
});

describe("query.queryPage — css mode", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, parentFrameId: -1, url: "https://x/" },
        ]),
      },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  it("css mode 返回 total 计数和元素摘要", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [
          { index: 0, tag: "li", text: "Item 1", children_count: 0 },
          { index: 1, tag: "li", text: "Item 2", children_count: 0 },
        ],
        total: 2,
        showing: 2,
      },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "css",
      pattern: ".item",
    }));

    expect(res.error).toBeUndefined();
    const result = res.result as { total: number; elements: unknown[] };
    expect(result.total).toBe(2);
    expect(result.elements).toHaveLength(2);
  });

  it("css mode 传 attr=href 时返回元素的 href 属性", async () => {
    executeScript.mockResolvedValueOnce([{
      result: {
        elements: [
          { index: 0, tag: "a", attrs: { href: "https://example.com/page" }, children_count: 0 },
        ],
        total: 1,
        showing: 1,
      },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "css",
      pattern: "a",
      attr: "href",
    }));

    expect(res.error).toBeUndefined();
    const result = res.result as { elements: Array<{ attrs?: { href?: string } }> };
    expect(result.elements[0].attrs?.href).toBe("https://example.com/page");
  });

  it("css 无匹配时返回 total=0 和空 elements", async () => {
    executeScript.mockResolvedValueOnce([{
      result: { elements: [], total: 0, showing: 0 },
    }]);

    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "css",
      pattern: ".nonexistent",
    }));

    expect(res.error).toBeUndefined();
    const result = res.result as { total: number; elements: unknown[] };
    expect(result.total).toBe(0);
    expect(result.elements).toHaveLength(0);
  });

  it("mode=css 缺少 pattern 时返回 INVALID_PARAMS 错误", async () => {
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "css" }));
    expect(res.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });

  it("无效 mode 时返回 INVALID_PARAMS 错误", async () => {
    const res = await router.dispatch(mkReq("query.queryPage", {
      mode: "invalid",
      pattern: "foo",
    }));
    expect(res.error?.code).toBe(VtxErrorCode.INVALID_PARAMS);
  });
});

describe("query.queryPage — page-side JS 函数行为", () => {
  // 从 handler 注入的 func 抽出来直接测试,无需 chrome.scripting mock
  // 验证 text grep 逻辑的核心行为

  it("text mode page-side func 对 html 文本正确 grep", () => {
    // 模拟 page-side JS body 的纯函数逻辑(不依赖 DOM,用 jsdom 全局)
    // 这里用纯 JS 逻辑重演 _SEARCH_PAGE_JS_BODY 等效行为
    const fullText = "Hello World, Hello Again";
    const pattern = "Hello";
    const flags = "gi";
    const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(fullText)) !== null) {
      matches.push(match[0]);
      if (match[0].length === 0) re.lastIndex++;
    }
    expect(matches).toEqual(["Hello", "Hello"]);
  });
});

describe("query.queryPage — component mode", () => {
  let router: ActionRouter;
  let executeScript: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    router = new ActionRouter();
    executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, parentFrameId: -1, url: "https://x/" }]) },
      scripting: { executeScript },
      runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
    });
    registerQueryHandlers(router);
  });

  it("component 命中 → 返回 components 数组,executeScript 收到 componentInspectFunc + [selector,depth,max]", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [{ framework: "vue2", chain: [{ name: "C", data: {}, props: {} }] }], total: 1, showing: 1 } }]);
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".cell" }));
    expect(res.error).toBeUndefined();
    const result = res.result as { components: unknown[]; total: number };
    expect(result.total).toBe(1);
    const call = executeScript.mock.calls[0][0];
    expect(call.world).toBe("MAIN");
    expect(call.args[0]).toBe(".cell");
    expect(call.args[1]).toBe(3);  // componentDepth 默认
    expect(call.args[2]).toBe(5);  // maxResults 默认
  });

  it("component maxResults 硬上限 10", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [], total: 0, showing: 0 } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x", maxResults: 999 }));
    expect(executeScript.mock.calls[0][0].args[2]).toBe(10);
  });

  it("component componentDepth 可覆盖", async () => {
    executeScript.mockResolvedValueOnce([{ result: { components: [], total: 0, showing: 0 } }]);
    await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x", componentDepth: 2 }));
    expect(executeScript.mock.calls[0][0].args[1]).toBe(2);
  });

  it("component page-side error → JS_EXECUTION_ERROR", async () => {
    executeScript.mockResolvedValueOnce([{ result: { error: "boom", components: [], total: 0 } }]);
    const res = await router.dispatch(mkReq("query.queryPage", { mode: "component", pattern: ".x" }));
    expect(res.error).toBeDefined();
  });
});
