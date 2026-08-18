/**
 * Author: qingwa
 * Description: hub deadline 不得低于 hubDeadlineFor(action, timeoutMs) 的内层预算地板。
 *
 * CLI 路径（packages/cli/src/client.ts）不下发 timeoutMs，走 forwardRequest 的兜底
 * this.requestTimeoutMs。若兜底低于内层预算，hub 先于扩展内层 fire，内层按探活
 * 归因的 hint（page-unresponsive/probe-failed/tab-gone）就到不了调用方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VtxErrorCode, type VtxRequest, type VtxResponse } from "@vortex-browser/shared";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("hub deadline 地板 = hubDeadlineFor(action, timeoutMs)", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent;
  let client: TestClient;
  let port: number;

  const startWith = async (requestTimeoutMs?: number) => {
    const started = await startTestHub(requestTimeoutMs == null ? {} : { requestTimeoutMs });
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
    vi.useRealTimers();
    await Promise.all([client?.close(), agent?.close()]);
    await closeHub?.();
    closeHub = undefined;
  });

  // 多轮真实 setImmediate 让待送达的 WS 消息走完真事件循环的 poll 阶段
  function flushRealIO(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => setImmediate(() => setImmediate(resolve)));
    });
  }

  // 在 increment-1 ms 尚未超时、increment ms 恰好超时，锁死精确边界而非同义反复
  //
  // fake timers 必须在请求发出之前启用：hub 的 deadline setTimeout 是请求一到达
  // hub 就同步排定的，迟启用会让它落成真实定时器，advance 打不到它。
  //
  // 不走 client.request()：它内置 60_000ms 的放弃计时器，会先于 65s/90s 档位的
  // 用例自己触发，改用裸发送 + waitFor 自带大窗口观测同一条响应。
  async function expectTimeoutAt(request: Omit<VtxRequest, "type">, incrementMs: number): Promise<void> {
    const arrived = new Promise<void>((resolve) => {
      const listener = (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type !== "request") return;
        agent.ws.off("message", listener);
        resolve();
      };
      agent.ws.on("message", listener);
    });
    // 只假 setTimeout/Date，留 setImmediate 真实——响应经真实 socket 送达客户端，
    // 需要真事件循环的 IO 轮询阶段才能被 flush，纯微任务 await 打不到它。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    client.ws.send(JSON.stringify({ ...request, type: "request" }));
    const response = client.waitFor<VtxResponse>(
      (message): message is VtxResponse =>
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "response" &&
        (message as { id?: unknown }).id === request.id,
      incrementMs + 10_000,
    );
    await arrived;

    await vi.advanceTimersByTimeAsync(incrementMs - 1);
    let settled = false;
    void response.then(() => { settled = true; }, () => { settled = true; });
    await flushRealIO();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect(response).resolves.toMatchObject({ error: { code: VtxErrorCode.TIMEOUT } });
  }

  // tabId 显式给出以跳过内部 tab.list 解析，否则解析先超时会报 TAB_NOT_FOUND 而非 TIMEOUT
  it("CLI 形态（无 timeoutMs）+ dom.click：地板 = 35s 内层 + 5s = 40_000ms", async () => {
    await startWith();
    await expectTimeoutAt({ action: "dom.click", id: "r-1", tabId: 1 }, 40_000);
  });

  it("CLI 形态（无 timeoutMs）+ page.navigate：地板 = 60s 内层 + 5s = 65_000ms", async () => {
    await startWith();
    await expectTimeoutAt({ action: "page.navigate", id: "r-2", tabId: 1 }, 65_000);
  });

  it("调用方给更大值（90s）+ dom.click：尊重显式大值，不被地板压低", async () => {
    await startWith();
    await expectTimeoutAt({ action: "dom.click", id: "r-3", tabId: 1, timeoutMs: 90_000 }, 90_000);
  });

  it("调用方给更小值（5s）+ dom.click：不被挤到内层地板之下，仍是 40_000ms", async () => {
    await startWith();
    await expectTimeoutAt({ action: "dom.click", id: "r-4", tabId: 1, timeoutMs: 5_000 }, 40_000);
  });

  it("未登记 action，无 timeoutMs：缺省 30s + 5s = 35_000ms", async () => {
    await startWith();
    await expectTimeoutAt({ action: "foo.bar", id: "r-5", tabId: 1 }, 35_000);
  });
});
