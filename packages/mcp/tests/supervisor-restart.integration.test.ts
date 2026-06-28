import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupervisor } from "../src/supervisor.js";
import { LineFramer, frame, type JsonRpcMessage } from "../src/lib/jsonrpc-stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = join(__dirname, "fixtures", "stub-mcp-child.mjs");

/** 在 stdout 流上等待满足 predicate 的第一条消息,带超时。 */
function waitFor(
  framer: LineFramer,
  stdout: PassThrough,
  predicate: (m: JsonRpcMessage) => boolean,
  timeoutMs = 4000,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
    const onData = (c: Buffer) => {
      for (const { msg } of framer.push(c)) {
        if (predicate(msg)) { clearTimeout(t); stdout.off("data", onData); resolve(msg); return; }
      }
    };
    stdout.on("data", onData);
  });
}

describe("supervisor 重启全链路(集成 spike)", () => {
  it("重启后连接不断、恰一次 list_changed、换进程、缓冲请求被应答", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames = new LineFramer();

    // 断言(a):stdout 在重启前后始终存活(未被 error/close/destroy)。
    // 'end' 事件永远不会触发(supervisor 从不调用 stdout.end()),用 error/close 才能抓到真实回归。
    // 传输连续性还由 (b)/(c)/(d) 互补证明:list_changed 与 id:3 响应都在同一 stdout 上收到,
    // 即流在重启前后都载有流量,并非巧合存活。
    let streamBroke = false;
    stdout.on("error", () => { streamBroke = true; });
    stdout.on("close", () => { streamBroke = true; });

    // 断言(b):恰好一次 list_changed。
    // 使用持久 LineFramer 实例而非逐块 new,避免跨 chunk 消息被截断而漏计。
    let listChangedCount = 0;
    const listChangedFramer = new LineFramer();
    stdout.on("data", (c: Buffer) => {
      for (const { msg } of listChangedFramer.push(c)) {
        if (msg.method === "notifications/tools/list_changed") listChangedCount++;
      }
    });

    const sup = createSupervisor({
      childEntry: STUB,
      childArgs: [],
      stdin,
      stdout,
      killTimeoutMs: 500,
    });
    sup.start();

    // 1. 握手
    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    await waitFor(frames, stdout, (m) => m.id === 1 && (m as any).result?.serverInfo?.name === "stub");
    stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));

    // 2. 重启前 tools/list 拿 pid
    stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const before = await waitFor(frames, stdout, (m) => m.id === 2);
    const descBefore = (before as any).result.tools[0].description as string;
    const pidBefore = sup.getChildPid();
    expect(descBefore).toBe(`pid:${pidBefore}`);

    // 3. 触发重启,并立刻塞一个请求(应被缓冲,重启后应答)
    sup.triggerRestart("test");
    stdin.write(frame({ jsonrpc: "2.0", id: 3, method: "tools/list" }));

    // 4. 等 list_changed
    await waitFor(frames, stdout, (m) => m.method === "notifications/tools/list_changed");

    // 5. 缓冲的 id:3 在新 child 上被应答
    const after = await waitFor(frames, stdout, (m) => m.id === 3);
    const pidAfter = sup.getChildPid();
    expect((after as any).result.tools[0].description).toBe(`pid:${pidAfter}`);

    // 断言:(c) 换进程
    expect(pidAfter).toBeDefined();
    expect(pidAfter).not.toBe(pidBefore);
    // 断言:(b) 恰一次 list_changed
    expect(listChangedCount).toBe(1);
    // 断言:(a) Claude 连接(stdout)全程未被 error/close/destroy
    expect(streamBroke).toBe(false);
    expect(stdout.writable).toBe(true);
    expect(stdout.destroyed).toBe(false);

    sup.stop();
  });
});
