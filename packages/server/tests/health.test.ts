import { describe, it, expect, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MessageRouter } from "../src/message-router.js";

function mkStdout() {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream;
}
function mkSessions() {
  return { getClient: () => null } as any;
}

async function startApp(connected: boolean): Promise<{ port: number; close: () => void }> {
  const router = new MessageRouter(mkStdout(), mkSessions());
  if (connected) router.setNmConnected(true);
  const { createHttpRoutes } = await import("../src/http-routes.js");
  const app = express();
  app.use(createHttpRoutes(router));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

describe("GET /health A-3:暴露 NM 连接状态", () => {
  it("扩展未连:nmConnected=false(监控据此判定链路不可用,非假绿)", async () => {
    const { port, close } = await startApp(false);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.nmConnected).toBe(false);
    close();
  });

  it("扩展已连:nmConnected=true", async () => {
    const { port, close } = await startApp(true);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(body.nmConnected).toBe(true);
    close();
  });
});
