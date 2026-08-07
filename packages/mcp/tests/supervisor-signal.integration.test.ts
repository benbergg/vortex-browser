import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { WebSocketServer, type WebSocket as WS } from "ws";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * 裸 SIGTERM 必须带走 child。
 *
 * 两个必要条件，缺一个测试就会假绿：
 * 1. spawn 真 supervisor.js——signal handler 只在直跑入口注册，createSupervisor() 里没有
 * 2. 让 child 真的连上 hub——持有活跃 WS handle 时 stdin EOF 不足以让 Node 退出，
 *    这正是孤儿的成因（对照实验：不连 hub 的 child 会跟着死，测不出问题）
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(HERE, "../dist/src/supervisor.js");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function findChildPid(parentPid: number): number | undefined {
  const out = execFileSync("ps", ["-eo", "pid,ppid"], { encoding: "utf8" });
  for (const line of out.split("\n").slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (ppid === parentPid && pid) return pid;
  }
  return undefined;
}

async function waitUntil(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** 最小 hub 替身：认 hello 回 welcome，其余帧一律当请求应答。 */
async function startFakeHub(): Promise<{ port: number; close(): Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, path: "/ws" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (ws: WS) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === "hello") {
        ws.send(JSON.stringify({ type: "welcome", wireVersion: 2, hubVersion: "test", sessionId: msg.sessionId }));
        return;
      }
      ws.send(JSON.stringify({ id: msg.id, success: true, data: [] }));
    });
  });
  return {
    port: (wss.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** 起 supervisor 并驱动一次工具调用，返回 child pid——此时 child 已持有到 hub 的 WS。 */
async function startConnectedSupervisor(port: number): Promise<{ sup: ChildProcess; childPid: number }> {
  const env = { ...process.env, VORTEX_PORT: String(port) };
  delete env.VORTEX_MCP_CHILD_ENTRY; // 空串会被 ?? 当成有值，必须删掉才回退到 server.js
  const sup = spawn(process.execPath, [SUPERVISOR], { env, stdio: ["pipe", "pipe", "pipe"] });
  cleanup.push(() => sup.kill("SIGKILL"));

  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  sup.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        const id = m.id as number | undefined;
        if (id != null && pending.has(id)) {
          pending.get(id)!(m);
          pending.delete(id);
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  });

  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      sup.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pending.delete(id)) resolve({ timeout: true });
      }, 20000);
    });

  await waitUntil(() => findChildPid(sup.pid!) !== undefined, 5000);
  const childPid = findChildPid(sup.pid!)!;
  expect(childPid, "supervisor 未拉起 child").toBeTruthy();
  const cmd = execFileSync("ps", ["-o", "command=", "-p", String(childPid)], { encoding: "utf8" });
  expect(cmd, "child 不是生产 server.js").toContain("server.js");

  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "signal-test", version: "0" },
  });
  sup.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  // 这一次调用让 child 真的把 WS 连上 hub —— 孤儿的必要条件
  await call("tools/call", { name: "vortex_tab_list", arguments: {} });

  cleanup.push(() => {
    if (alive(childPid)) process.kill(childPid, "SIGKILL");
  });
  return { sup, childPid };
}

describe("supervisor 信号处理", () => {
  it("dist 已构建，否则本测试测不到真入口", () => {
    expect(existsSync(SUPERVISOR), `缺少 ${SUPERVISOR}，先跑 pnpm -r build`).toBe(true);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it(`${signal} 时带走已连 hub 的 child，不留孤儿`, async () => {
      const hub = await startFakeHub();
      try {
        const { sup, childPid } = await startConnectedSupervisor(hub.port);

        sup.kill(signal);
        expect(await waitUntil(() => !alive(sup.pid!), 5000), "supervisor 自己没退出").toBe(true);
        expect(await waitUntil(() => !alive(childPid), 5000), `child ${childPid} 成了孤儿`).toBe(true);
      } finally {
        await hub.close();
      }
    }, 60000);
  }
});
