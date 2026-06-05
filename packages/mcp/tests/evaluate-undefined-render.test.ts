import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 回归:`vortex_evaluate`(及任何成功响应)结果为 undefined / null 时的渲染。
 *
 * server.ts 通用成功路径曾用 `JSON.stringify(resp.result ?? resp, null, 2)`。
 * `??` 只兜 null/undefined,于是:
 *   - result=undefined → `undefined ?? resp` = resp,JSON 丢掉 undefined 字段
 *     → 渲染成晦涩的 `{"action":"...","id":"..."}`(像空响应/错误,泄漏内部协议字段)
 *   - result=null      → `null ?? resp` = resp → `{"action","id","result":null}`
 * 副作用型 eval(scrollTo / click / forEach / setItem …)全返回 undefined,极常见;
 * 这个渲染甚至骗过了工具作者(误诊为畸形空响应,见已关闭 #35)。
 *
 * 修复:`JSON.stringify(resp.result, null, 2) ?? "undefined"`——利用
 * `JSON.stringify(undefined)` 返回 JS undefined(非字符串)的特性,精确把 undefined
 * 渲染成 "undefined"、null 渲染成 "null",绝不再吐协议信封。falsy 值(0/false/"")
 * 不受 `??` 影响,正常渲染。
 */
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test"),
    unsubscribe: vi.fn(() => true),
  },
}));

async function evalRender(result: unknown): Promise<string> {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValue({
    action: "js.evaluate",
    id: "mcp-1-1780000000000",
    result,
  } as any);
  const { handleCallTool } = await import("../src/server.js");
  const resp = await handleCallTool({
    params: { name: "vortex_evaluate", arguments: { code: "/* any */" } },
  });
  expect(resp.isError).toBeFalsy();
  const item = resp.content[0];
  expect(item.type).toBe("text");
  return (item as { text: string }).text;
}

describe("vortex_evaluate 结果渲染:undefined / null 不再吐协议信封", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("result=undefined → 渲染 \"undefined\",不含 action/id", async () => {
    const text = await evalRender(undefined);
    expect(text).toBe("undefined");
    expect(text).not.toContain("action");
    expect(text).not.toContain("\"id\"");
  });

  it("result=null → 渲染 \"null\",不含 action/id", async () => {
    const text = await evalRender(null);
    expect(text).toBe("null");
    expect(text).not.toContain("action");
    expect(text).not.toContain("\"id\"");
  });

  it("result=值 → 正常渲染(透传)", async () => {
    expect(await evalRender(42)).toBe("42");
    expect(await evalRender("hi")).toBe('"hi"');
  });

  it("falsy 值(0 / false / \"\")不被 ?? 误伤", async () => {
    expect(await evalRender(0)).toBe("0");
    expect(await evalRender(false)).toBe("false");
    expect(await evalRender("")).toBe('""');
  });
});
