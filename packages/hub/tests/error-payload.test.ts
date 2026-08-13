/**
 * Description: Hub-emitted error payloads must match the shared error metadata, not a hand-rolled guess.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ERROR_META, VtxErrorCode } from "@vortex-browser/shared";
import { RPC_TIMEOUT_HINT } from "../src/error-hints.js";
import { PendingTable } from "../src/pending.js";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

describe("hub error payloads", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
  });

  // 原断言锁的是"hub 的 TIMEOUT hint == 表文案",而表文案是写给页面 actionability
  // 超时的(建议等页面 idle);hub 这条是 RPC 通道超时,页面稳不稳定无关。
  // 2026-08-13 日志 3/60 次都被引向了无效动作,故改为断言 RPC 专属 hint。
  it("emits TIMEOUT with the RPC-specific hint and the shared recoverable flag", async () => {
    const started = await startTestHub({ requestTimeoutMs: 50 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    });
    client = await connectClient(started.port, { sessionId: "session-a" });

    // 用免 tab 解析的 action，否则内部 tab.list 先卡住会先报 TAB_NOT_FOUND
    const response = await client.request({ action: "diagnostics.version", id: "slow-1" });

    expect(response.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(response.error?.recoverable).toBe(DEFAULT_ERROR_META[VtxErrorCode.TIMEOUT].recoverable);
    expect(response.error?.hint).toBe(RPC_TIMEOUT_HINT);
  });

  it("emits EXTENSION_NOT_CONNECTED with the shared hint and recoverable flag", async () => {
    const started = await startTestHub({ requestTimeoutMs: 500 });
    closeHub = started.close;
    client = await connectClient(started.port, { sessionId: "session-b" });

    const response = await client.request({ action: "page.info", id: "no-browser-1" });

    expect(response.error?.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
    expect(response.error?.recoverable)
      .toBe(DEFAULT_ERROR_META[VtxErrorCode.EXTENSION_NOT_CONNECTED].recoverable);
    expect(response.error?.hint)
      .toBe(DEFAULT_ERROR_META[VtxErrorCode.EXTENSION_NOT_CONNECTED].hint);
  });
});

describe("PendingTable.failIndex isolation", () => {
  it("keeps failing the rest after one sink throws", () => {
    const table = new PendingTable();
    const failed: string[] = [];
    for (const id of ["a", "b", "c"]) {
      table.add({
        hubRequestId: id,
        sessionId: "session-x",
        browserId: "browser-x",
        request: { action: "page.info", id, params: {} },
        timeout: setTimeout(() => undefined, 10_000),
        tabIdBackfilledByHub: false,
        fail: () => {
          if (id === "a") throw new Error("sink is gone");
          failed.push(id);
        },
      });
    }

    table.failSession("session-x", { code: VtxErrorCode.TIMEOUT, message: "boom" });

    expect(failed).toEqual(["b", "c"]);
    expect(table.size).toBe(0);
  });
});
