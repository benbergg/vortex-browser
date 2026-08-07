import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestHub, connectFakeAgent } from "./helpers/harness.js";

/**
 * 守门员：真 spawn MCP 子进程走 stdio JSON-RPC，对面是真 hub + 两个 fake agent。
 *
 * 存在的理由：harness 的 connectClient 是手写 hello 的替身，而生产 client.ts 曾经
 * 压根不发 hello——替身与真实产物不等价，替身测再多也咬不到。这条用真产物。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = join(HERE, "../../mcp/dist/src/server.js");

interface McpProc {
  child: ChildProcess;
  call(method: string, params?: unknown): Promise<Record<string, unknown>>;
  kill(): void;
}

const procs: McpProc[] = [];

function startMcp(port: number, sessionId: string): McpProc {
  const child = spawn(process.execPath, [MCP_ENTRY], {
    env: { ...process.env, VORTEX_PORT: String(port), VORTEX_SESSION_ID: sessionId },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = msg.id as number | undefined;
      if (id != null && pending.has(id)) {
        pending.get(id)!(msg);
        pending.delete(id);
      }
    }
  });

  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 25000);
    });

  const proc: McpProc = { child, call, kill: () => child.kill("SIGKILL") };
  procs.push(proc);
  return proc;
}

async function handshake(mcp: McpProc): Promise<void> {
  await mcp.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  mcp.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}

/** tools/call 的结果文本；工具层错误会以文本形式回来，所以原样返回给断言看。 */
function resultText(res: Record<string, unknown>): string {
  const result = res.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? JSON.stringify(res);
}

afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});

describe("两个真 MCP 子进程并发（守门员）", () => {
  it("MCP dist 已构建，否则本测试形同虚设", () => {
    expect(existsSync(MCP_ENTRY), `缺少 ${MCP_ENTRY}，先跑 pnpm -r build`).toBe(true);
  });

  it("两个 MCP 各自拿到 tab.list，互不踢下线", async () => {
    const hub = await startTestHub();
    try {
      await connectFakeAgent(hub.port, {
        browserId: "browser-a",
        tabs: [{ id: 11, url: "https://a.example", title: "A", active: true }],
      });
      await connectFakeAgent(hub.port, {
        browserId: "browser-b",
        tabs: [{ id: 22, url: "https://b.example", title: "B", active: true }],
      });

      const a = startMcp(hub.port, "sess-a");
      const b = startMcp(hub.port, "sess-b");
      await handshake(a);
      await handshake(b);

      const ra = await a.call("tools/call", { name: "vortex_tab_list", arguments: {} });
      const rb = await b.call("tools/call", { name: "vortex_tab_list", arguments: {} });
      const ta = resultText(ra);
      const tb = resultText(rb);

      expect(ta).not.toContain("Connection closed");
      expect(tb).not.toContain("Connection closed");

      // 交替再各来一轮：互踢的话第二轮必现断连
      const ra2 = await a.call("tools/call", { name: "vortex_tab_list", arguments: {} });
      const rb2 = await b.call("tools/call", { name: "vortex_tab_list", arguments: {} });
      expect(resultText(ra2)).not.toContain("Connection closed");
      expect(resultText(rb2)).not.toContain("Connection closed");
    } finally {
      await hub.close();
    }
  }, 60000);

  it("两个 MCP 的 hello 各自建出独立 session，并分到不同 browser", async () => {
    const hub = await startTestHub();
    try {
      await connectFakeAgent(hub.port, { browserId: "browser-a" });
      await connectFakeAgent(hub.port, { browserId: "browser-b" });

      const a = startMcp(hub.port, "sess-a");
      const b = startMcp(hub.port, "sess-b");
      await handshake(a);
      await handshake(b);
      await a.call("tools/call", { name: "vortex_tab_list", arguments: {} });
      await b.call("tools/call", { name: "vortex_tab_list", arguments: {} });

      const sessions = [...hub.hub.sessions.values()];
      const mcpSessions = sessions.filter((s) => s.role === "mcp");
      expect(mcpSessions.map((s) => s.sessionId).sort()).toEqual(["sess-a", "sess-b"]);

      const assigned = mcpSessions.map((s) => s.browserId);
      expect(new Set(assigned).size).toBe(2);
    } finally {
      await hub.close();
    }
  }, 60000);
});
