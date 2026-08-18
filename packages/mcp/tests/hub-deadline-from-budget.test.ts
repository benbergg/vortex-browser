import { describe, it, expect, vi, beforeEach } from "vitest";

// Task 2 契约锁：hub deadline 必须由 action 预算推导（hubDeadlineFor），
// 不再是调用方 timeout 直推的 timeoutLadder(...).hub。
// 测试直接捕获 server.ts 传给 sendRequest 的第 5 参，防止只测 shared 层
// 函数、不碰实际接线的假绿（Task 1 评审已抓过这个坑）。
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "sub_test"), unsubscribe: vi.fn(() => true) },
}));

const hubArgOf = (call: unknown[]) => call[4] as number | undefined;
const paramsOf = (call: unknown[]) => call[1] as Record<string, unknown>;

describe("hub deadline 由 action 预算推导（server.ts 实际接线）", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
    vi.mocked(sendRequest).mockResolvedValue({ result: {} } as never);
  });

  it("通用路径: dom.click 传小 timeout，hub 仍按 action 预算算（35000+5000=40000）", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: {
        name: "vortex_act",
        arguments: { target: ".btn", action: "click", timeout: 2_000 },
      },
    });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(call[0]).toBe("dom.click");
    expect(hubArgOf(call)).toBe(40_000);
    // args.timeout 下发行为不变：仍是 ladder.inner（调用方原值），非 innerDeadlineFor 的推导值
    expect(paramsOf(call).timeout).toBe(2_000);
  });

  it("observe 专用路径: 不传 timeout，hub = observe.snapshot 预算 35000+5000=40000", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: { snapshotId: "snap_hub_1", url: "https://example.com", elements: [] },
    } as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_observe", arguments: { scope: "viewport" } },
    });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(hubArgOf(call)).toBe(40_000);
    // 未传 timeout 时 args.timeout 不下发，行为不变
    expect(paramsOf(call).timeout).toBeUndefined();
  });

  it("调用方传大 timeout 时 hub 跟着抬高: dom.click timeout=45000 → hub=55000", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: {
        name: "vortex_act",
        arguments: { target: ".btn", action: "click", timeout: 45_000 },
      },
    });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(hubArgOf(call)).toBe(55_000);
    expect(paramsOf(call).timeout).toBe(45_000);
  });
});
