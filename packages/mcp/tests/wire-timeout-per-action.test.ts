import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import type { AddressInfo } from "node:net";
import { ACTION_BUDGET_MS, hubDeadlineFor } from "@vortex-browser/shared";

/**
 * Description: 调用方省略 hubTimeoutMs 时，线上帧的 timeoutMs 必须按 action 预算推导。
 *
 * 旧缺省是扁平 30000：凡内层预算 ≥30s 的 action（dom.click/observe.snapshot/page.navigate…）
 * hub 都会先于内层 fire，四态归因永远送不到调用方——正是本轮要消灭的形态。
 * 断言用具体数字（40000/65000/> 30000），不由被测函数自己算，否则是同义反复。
 */
interface Harness {
  port: number;
  frames: Record<string, unknown>[];
  close(): Promise<void>;
}

let harness: Harness | null = null;

async function startFakeHub(): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0, path: "/ws" });
  const frames: Record<string, unknown>[] = [];
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (ws: WS) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(msg);
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ type: "welcome", wireVersion: 2, hubVersion: "test", sessionId: msg.sessionId }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, success: true, data: { ok: true } }));
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    frames,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

async function loadClient() {
  vi.resetModules();
  return await import("../src/client.js");
}

const requestFrame = (frames: Record<string, unknown>[]) =>
  frames.find((f) => f.type !== "hello") as Record<string, unknown>;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("省略 hubTimeoutMs 时线上帧按 action 预算推导", () => {
  it("dom.click → 40000（旧扁平缺省 30000 会先于 35000 内层 fire）", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();
    await sendRequest("dom.click", {}, harness.port);
    expect(requestFrame(harness.frames).timeoutMs).toBe(40_000);
  });

  it("page.navigate → 65000", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();
    await sendRequest("page.navigate", {}, harness.port);
    expect(requestFrame(harness.frames).timeoutMs).toBe(65_000);
  });

  it("调用方 params.timeout 也进推导：dom.click timeout=45000 → 55000", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();
    await sendRequest("dom.click", { timeout: 45_000 }, harness.port);
    expect(requestFrame(harness.frames).timeoutMs).toBe(55_000);
  });

  it("显式传入的 hubTimeoutMs 原样生效，不被推导覆盖", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();
    await sendRequest("tab.list", {}, harness.port, undefined, 5_000);
    expect(requestFrame(harness.frames).timeoutMs).toBe(5_000);
  });

  it("内层预算 ≥30s 的 action 一个都不能落回 30000（防扁平缺省复辟）", () => {
    const risky = Object.entries(ACTION_BUDGET_MS).filter(([, ms]) => ms >= 30_000);
    expect(risky.length).toBeGreaterThanOrEqual(9);
    for (const [action] of risky) {
      expect(hubDeadlineFor(action, undefined)).toBeGreaterThan(30_000);
    }
  });
});
