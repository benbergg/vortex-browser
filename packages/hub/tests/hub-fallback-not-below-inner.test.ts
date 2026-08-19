/**
 * Description: 跨层不变量——hub 缺省兜底 deadline 不得低于内层预算（锁 Task 5 修复）。
 *
 * 调用方不传 timeoutMs、部署方也不显式配 requestTimeoutMs 时，hub 曾用
 * action-blind 的 REQUEST_TIMEOUT_MS 常量兜底（30s），而 dom.click 内层预算
 * 是 35s——hub 先于 handler fire，调用方拿到的是"没人应答"而非语义化归因。
 * hubFallbackMs 是私有方法，这里只从外部可观测行为断言：内层预算这一时刻
 * 到点时，hub 侧的 pending 必须还没结束。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_BUDGET_MS, innerDeadlineFor, type VtxResponse } from "@vortex-browser/shared";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("hub 缺省兜底 deadline 晚于内层预算（跨层不变量）", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all([client?.close(), agent?.close()]);
    await closeHub?.();
    closeHub = undefined;
    agent = undefined;
    client = undefined;
  });

  // 多轮真实 setImmediate 让待送达的 WS 消息走完真事件循环的 poll 阶段
  function flushRealIO(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => setImmediate(() => setImmediate(resolve)));
    });
  }

  // 部署方未显式配置 requestTimeoutMs（未落 REQUEST_TIMEOUT_MS 常量分支）
  async function expectStillPendingAtInnerMark(action: string): Promise<void> {
    const started = await startTestHub({});
    closeHub = started.close;
    // 永不应答的 agent：只有 hub 自己的 deadline 能结束这次请求
    agent = await connectFakeAgent(started.port, { browserId: "browser-a", handle: () => new Promise(() => {}) });
    client = await connectClient(started.port, { sessionId: "session-a" });

    const inner = innerDeadlineFor(action, undefined);
    const id = `r-${action}`;
    const arrived = new Promise<void>((resolve) => {
      const listener = (data: Buffer) => {
        const message = JSON.parse(data.toString()) as { type?: string; action?: string };
        if (message.type !== "request" || message.action !== action) return;
        agent!.ws.off("message", listener);
        resolve();
      };
      agent!.ws.on("message", listener);
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    client.ws.send(JSON.stringify({ action, id, tabId: 1, type: "request" }));
    const response = client.waitFor<VtxResponse>(
      (message): message is VtxResponse =>
        typeof message === "object" && message !== null &&
        (message as { type?: unknown }).type === "response" &&
        (message as { id?: unknown }).id === id,
      inner + 30_000,
    );
    await arrived;

    // 恰好走到内层预算这一时刻：hub 兜底必须严格晚于它，故此刻不该已经 settle
    await vi.advanceTimersByTimeAsync(inner);
    let settled = false;
    void response.then(() => { settled = true; }, () => { settled = true; });
    await flushRealIO();
    vi.useRealTimers();
    expect(settled, `${action}: hub 兜底未晚于内层预算 ${inner}ms（疑似 action-blind 常量回归）`).toBe(false);
  }

  const actions = Object.keys(ACTION_BUDGET_MS);

  // 扫描类不变量必须自带命中数断言，否则空集也会假绿。
  it("覆盖到 ACTION_BUDGET_MS 全部 action（防空集假绿）", () => {
    expect(actions.length).toBeGreaterThanOrEqual(12);
  });

  it.each(actions)("hub 兜底 deadline 晚于内层预算：%s", async (action) => {
    await expectStillPendingAtInnerMark(action);
  });
});
