import { describe, it, expect, vi, beforeEach } from "vitest";
import { TIMEOUT_LADDER_STEP_MS } from "@vortex-browser/shared";

/**
 * 白盒审计批次 3 族 O — WAIT-TIMEOUT-MARGIN,及其 2026-08-11 的补完。
 *
 * 族 O 原始缺陷:调用方 timeout 既作 handler 内层 poll 预算又直接当传输超时,二者同
 * deadline 竞 race → 传输层先 fire,调用方见 "no response for <action>" 而非 handler
 * 干净的 condition-not-met。
 *
 * 补完发现的两个残留:
 * 1. 中间还有一层 hub。VtxRequest 没有 timeout 字段,hub 永远按自己的 30s 砍。
 *    live 复现:evaluate({timeout:45000}) 30s 报 hub 的 "Request js.evaluateAsync
 *    timed out"。修法=MCP 把 ladder.hub 发到线上,hub 照办。
 * 2. observe 专用路径把 timeout 从 params 里 destructure 掉却没塞回,handler 收不到
 *    内层预算;且传输 = 内层无 buffer。
 */
vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "sub_test"), unsubscribe: vi.fn(() => true) },
}));

const DEFAULT_TIMEOUT = 30_000;

/** sendRequest 第 5 参 = hub deadline(客户端自己的传输超时由 client 再加一档) */
const hubArgOf = (call: unknown[]) => call[4] as number | undefined;
const paramsOf = (call: unknown[]) => call[1] as Record<string, unknown>;

describe("超时阶梯在 MCP 层的落点", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
    vi.mocked(sendRequest).mockResolvedValue({ result: {} } as never);
  });

  it("通用路径:调用方 timeout 同时作内层预算和 hub deadline 的基准", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_evaluate", arguments: { code: "1", timeout: 45_000 } },
    });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(paramsOf(call).timeout).toBe(45_000);
    expect(hubArgOf(call)).toBe(45_000 + TIMEOUT_LADDER_STEP_MS);
  });

  it("通用路径:调用方要的 45s 不被 hub 默认 30s 截断", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_evaluate", arguments: { code: "1", timeout: 45_000 } },
    });
    expect(hubArgOf(vi.mocked(sendRequest).mock.calls[0] as unknown[])).toBeGreaterThan(DEFAULT_TIMEOUT);
  });

  it("通用路径:未指定 timeout 时 hub deadline 用默认值", async () => {
    const { sendRequest } = await import("../src/client.js");
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_evaluate", arguments: { code: "1" } } });
    expect(hubArgOf(vi.mocked(sendRequest).mock.calls[0] as unknown[])).toBe(DEFAULT_TIMEOUT);
  });

  it("observe 专用路径:timeout 透传给 handler 作内层预算,不再被 destructure 吞掉", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: { snapshotId: "snap_1", url: "https://example.com", elements: [] },
    } as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({
      params: { name: "vortex_observe", arguments: { scope: "viewport", timeout: 20_000 } },
    });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(paramsOf(call).timeout).toBe(20_000);
    expect(hubArgOf(call)).toBe(20_000 + TIMEOUT_LADDER_STEP_MS);
  });

  it("observe 专用路径:未指定 timeout 时与通用路径同规则", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      result: { snapshotId: "snap_2", url: "https://example.com", elements: [] },
    } as never);
    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_observe", arguments: { scope: "viewport" } } });

    const call = vi.mocked(sendRequest).mock.calls[0] as unknown[];
    expect(hubArgOf(call)).toBe(DEFAULT_TIMEOUT);
    expect(paramsOf(call).timeout).toBeUndefined();
  });
});
