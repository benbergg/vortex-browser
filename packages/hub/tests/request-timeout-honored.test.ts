/**
 * Author: qingwa
 * Description: Verifies the hub honors the per-request timeout instead of its hardcoded default.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VtxErrorCode } from "@vortex-browser/shared";
import {
  connectClient,
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
  type TestClient,
} from "./helpers/harness.js";

/**
 * 缺陷：hub 的 deadline 恒为 now + REQUEST_TIMEOUT_MS，无视调用方要求。
 * live 复现：vortex_evaluate({timeout: 45000}) 在 30s 被 hub 砍，报
 * "Request js.evaluateAsync timed out" —— extension 允许 45s、MCP 传输等 50s，
 * 唯独 hub 不知道调用方要多久，因为 VtxRequest 上根本没有这个字段。
 */
describe("hub 尊重请求自带的 timeoutMs", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent;
  let client: TestClient;
  let port: number;

  const startWith = async (requestTimeoutMs: number) => {
    const started = await startTestHub({ requestTimeoutMs });
    port = started.port;
    closeHub = started.close;
    // 永不应答的 agent：只有 hub 自己的 deadline 能结束这次请求
    agent = await connectFakeAgent(port, { browserId: "browser-a", handle: () => new Promise(() => {}) });
    client = await connectClient(port, { sessionId: "session-a" });
  };

  beforeEach(() => {
    closeHub = undefined;
  });

  afterEach(async () => {
    await Promise.all([client?.close(), agent?.close()]);
    await closeHub?.();
    closeHub = undefined;
  });

  it("请求带 timeoutMs 时按请求值超时，而非 hub 默认值", async () => {
    await startWith(30_000);
    const t0 = Date.now();
    const resp = await client.request({ action: "js.evaluate", id: "r-1", tabId: 1, timeoutMs: 300 });
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("请求的 timeoutMs 大于 hub 默认值时也生效，不被默认值截断", async () => {
    await startWith(300);
    const pending = client.request({ action: "js.evaluate", id: "r-2", tabId: 1, timeoutMs: 4_000 });
    const settledEarly = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 1_500)),
    ]);
    expect(settledEarly).toBe(false);
    const resp = await pending;
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
  });

  it("请求不带 timeoutMs 时沿用 hub 默认值", async () => {
    await startWith(300);
    const t0 = Date.now();
    const resp = await client.request({ action: "js.evaluate", id: "r-3", tabId: 1 });
    expect(resp.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
