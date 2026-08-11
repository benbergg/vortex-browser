import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 空结果自陈的渲染契约。
 *
 * 使用基线(2026-08-11):query 空返回 29.2%、debug_read 48.5%。这些调用 isError=false、
 * 载荷合法,调用方只看到 `[]` / `total: 0`,分不清「确实没有」还是「我没搜到那儿去」,
 * 于是微调无关参数重试。handler 在空结果上挂一行自陈,渲染层拆成独立文本块。
 *
 * 硬契约:没有自陈时,输出必须与加这套机制之前**逐字节相同**——否则每次调用都在
 * 为一个只在空结果时才有用的信道付 token。
 */
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "sub_test"),
    unsubscribe: vi.fn(() => true),
  },
}));

async function callWith(result: unknown) {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValue({
    action: "console.getLogs",
    id: "mcp-1-1780000000000",
    result,
  } as any);
  const { handleCallTool } = await import("../src/server.js");
  return handleCallTool({
    params: { name: "vortex_debug_read", arguments: { source: "console", tail: 20 } },
  });
}

describe("空结果自陈渲染", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("无自陈时输出与从前逐字节相同(单块、原样 JSON)", async () => {
    const resp = await callWith([{ level: "error", text: "boom" }]);
    expect(resp.content).toHaveLength(1);
    expect((resp.content[0] as { text: string }).text).toBe(
      JSON.stringify([{ level: "error", text: "boom" }], null, 2),
    );
  });

  it("有自陈时载荷块不变，自陈另起一块", async () => {
    const { DIAGNOSIS_KEY } = await import("@vortex-browser/shared");
    const resp = await callWith({
      [DIAGNOSIS_KEY]: "console 缓冲区从本次调用才开始录",
      value: [],
    });
    expect(resp.isError).toBeFalsy();
    expect(resp.content).toHaveLength(2);
    expect((resp.content[0] as { text: string }).text).toBe("[]");
    const note = (resp.content[1] as { text: string }).text;
    expect(note).toContain("console 缓冲区从本次调用才开始录");
    // 客户端拼接相邻块不加分隔符,自陈须自带换行,否则贴成 `}[vortex-diagnosis]`
    expect(note).toMatch(/^\n\[vortex-diagnosis]/);
  });

  it("自陈不会泄漏进载荷块", async () => {
    const { DIAGNOSIS_KEY } = await import("@vortex-browser/shared");
    const resp = await callWith({ [DIAGNOSIS_KEY]: "缓冲区里有 128 条，被 filter 滤光", value: { total: 0, matches: [] } });
    const payload = (resp.content[0] as { text: string }).text;
    expect(payload).not.toContain("vtxDiagnosis");
    expect(payload).not.toContain("滤光");
    expect(JSON.parse(payload)).toEqual({ total: 0, matches: [] });
  });
});
