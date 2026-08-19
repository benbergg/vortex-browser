import { describe, it, expect, vi, beforeEach } from "vitest";

// 跨层接线锁(评审 Task 1 H-1)。liftQueryRefToTarget 的纯函数测试 + extension 侧
// 手工 index/snapshotId 测试各自全绿,也证明不了 helper 真的挂在 handleCallTool
// 这条活路径上、翻译结果真的作为 dispatch 参数发出去。这里走 handleCallTool 端到端:
// observe 建立 activeSnapshotId → vortex_query 传 @ref → 断言发往 extension 的
// 参数是 index/snapshotId/frameId 且不带 pattern/target。

vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "sub_test"), unsubscribe: vi.fn(() => true) },
}));

async function observeThenQuery(queryArgs: Record<string, unknown>) {
  const { sendRequest } = await import("../src/client.js");
  vi.mocked(sendRequest).mockResolvedValueOnce({
    result: { snapshotId: "snap_q_1", url: "", elements: [] },
  } as never);
  vi.mocked(sendRequest).mockResolvedValueOnce({
    result: { elements: [], total: 0, showing: 0 },
  } as never);

  const { handleCallTool } = await import("../src/server.js");
  await handleCallTool({ params: { name: "vortex_observe", arguments: { scope: "viewport" } } });
  const res = await handleCallTool({ params: { name: "vortex_query", arguments: queryArgs } });
  return { res, sendRequest };
}

describe("vortex_query @ref 跨层接线", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
  });

  it("@ref 经 lift + target 翻译后,发往 extension 的是 index+snapshotId", async () => {
    const { res, sendRequest } = await observeThenQuery({ mode: "style", pattern: "@e12" });

    expect(res.isError).not.toBe(true);
    const [action, params] = vi.mocked(sendRequest).mock.calls[1];
    expect(action).toBe("query.queryPage");
    const p = params as Record<string, unknown>;
    expect(p.index).toBe(12);
    expect(p.snapshotId).toBe("snap_q_1");
    // 两个中间形态都必须消失,留任何一个都会让 extension 走错分支
    expect(p.pattern).toBeUndefined();
    expect(p.target).toBeUndefined();
  });

  it("跨 frame @ref 的 frameId 一路带到 extension", async () => {
    const { sendRequest } = await observeThenQuery({ mode: "geometry", pattern: "@f7e3" });
    const p = vi.mocked(sendRequest).mock.calls[1][1] as Record<string, unknown>;
    expect(p.index).toBe(3);
    expect(p.frameId).toBe(7);
  });

  it("非选择器类 mode 的 pattern 不被 lift(text 的 @ 是要搜的字面量)", async () => {
    const { sendRequest } = await observeThenQuery({ mode: "text", pattern: "@handle" });
    const p = vi.mocked(sendRequest).mock.calls[1][1] as Record<string, unknown>;
    expect(p.pattern).toBe("@handle");
    expect(p.index).toBeUndefined();
  });

  it("CSS 选择器形态原样送达,不进 ref 翻译", async () => {
    const { sendRequest } = await observeThenQuery({ mode: "style", pattern: "h1" });
    const p = vi.mocked(sendRequest).mock.calls[1][1] as Record<string, unknown>;
    expect(p.pattern).toBe("h1");
    expect(p.index).toBeUndefined();
  });

  it("同时传 target 与 pattern → INVALID_PARAMS,且不 dispatch", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValueOnce({
      result: { snapshotId: "snap_q_2", url: "", elements: [] },
    } as never);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { scope: "viewport" } } });
    const res = await handleCallTool({
      params: { name: "vortex_query", arguments: { mode: "style", pattern: "@e1", target: "#explicit" } },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/pattern.*only|remove `target`/);
    // 只 observe 那一次,query 没有发出去
    expect(vi.mocked(sendRequest).mock.calls.length).toBe(1);
  });
});
