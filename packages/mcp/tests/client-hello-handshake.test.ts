import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket as WS } from "ws";
import type { AddressInfo } from "node:net";

/**
 * 真 import client.ts + 真 WS 对端。
 *
 * 不用手写替身:替身发不发 hello 由测试作者决定,而缺陷恰恰是生产代码不发 hello,
 * 替身永远咬不到（tests/client.test.ts 那份复制粘贴的 isTransient 就是前车之鉴）。
 */
interface Harness {
  port: number;
  frames: Record<string, unknown>[];
  close(): Promise<void>;
}

let harness: Harness | null = null;

async function startFakeHub(opts: { sendWelcome?: boolean } = {}): Promise<Harness> {
  const sendWelcome = opts.sendWelcome ?? true;
  const wss = new WebSocketServer({ port: 0, path: "/ws" });
  const frames: Record<string, unknown>[] = [];
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));

  wss.on("connection", (ws: WS) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      frames.push(msg);
      if (msg.type === "hello") {
        if (sendWelcome) {
          ws.send(JSON.stringify({ type: "welcome", wireVersion: 2, hubVersion: "test", sessionId: msg.sessionId }));
        }
        return;
      }
      // 非 hello 帧一律当请求应答，让 client 的调用能 resolve
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

afterEach(async () => {
  await harness?.close();
  harness = null;
  vi.unstubAllEnvs();
});

describe("MCP client ↔ hub 握手", () => {
  it("第一帧必须是 hello,而不是请求", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();

    await sendRequest("tab.list", {}, harness.port);

    expect(harness.frames.length).toBeGreaterThanOrEqual(2);
    expect(harness.frames[0].type).toBe("hello");
  });

  it("hello 带 role=mcp、wireVersion 与非空 sessionId", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();

    await sendRequest("tab.list", {}, harness.port);

    const hello = harness.frames[0];
    expect(hello.role).toBe("mcp");
    expect(hello.wireVersion).toBe(2);
    expect(typeof hello.sessionId).toBe("string");
    expect((hello.sessionId as string).length).toBeGreaterThan(0);
  });

  it("请求帧带上与 hello 相同的 sessionId", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();

    await sendRequest("tab.list", {}, harness.port);

    const hello = harness.frames[0];
    // 先钉死 hello 真的存在且 sessionId 非空,否则 undefined === undefined 会假绿
    expect(hello.type).toBe("hello");
    expect(hello.sessionId).toBeTruthy();

    const req = harness.frames.find((f) => f.action === "tab.list");
    expect(req).toBeDefined();
    expect(req!.sessionId).toBe(hello.sessionId);
  });

  it("同一进程内多次调用只握手一次", async () => {
    harness = await startFakeHub();
    const { sendRequest } = await loadClient();

    await sendRequest("tab.list", {}, harness.port);
    await sendRequest("tab.list", {}, harness.port);

    expect(harness.frames.filter((f) => f.type === "hello")).toHaveLength(1);
  });

  it("hub 不回 welcome 时降级放行,不把调用永久卡死", async () => {
    harness = await startFakeHub({ sendWelcome: false });
    const { sendRequest } = await loadClient();

    const res = await sendRequest("tab.list", {}, harness.port, undefined, 20000);

    expect(res.success).toBe(true);
    expect(harness.frames[0].type).toBe("hello");
  }, 20000);

  it("hello 带上 VORTEX_BROWSER 指定的 preferBrowser", async () => {
    vi.stubEnv("VORTEX_BROWSER", "edge");
    vi.resetModules();
    harness = await startFakeHub();
    const { sendRequest } = await import("../src/client.js");
    await sendRequest("tab.list", {}, harness.port);

    expect(harness.frames[0]).toMatchObject({ type: "hello", preferBrowser: "edge" });
  });

  it("VORTEX_BROWSER 为空白时不带 preferBrowser", async () => {
    vi.stubEnv("VORTEX_BROWSER", "   ");
    vi.resetModules();
    harness = await startFakeHub();
    const { sendRequest } = await import("../src/client.js");
    await sendRequest("tab.list", {}, harness.port);

    expect(harness.frames[0]).not.toHaveProperty("preferBrowser");
  });
});
