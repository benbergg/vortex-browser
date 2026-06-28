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

    let stdoutEnded = false;
    stdout.on("end", () => { stdoutEnded = true; });

    let listChangedCount = 0;
    stdout.on("data", (c: Buffer) => {
      // 独立计数器(不消费 waitFor 用的同一 framer,各自维护)
      for (const { msg } of new LineFramer().push(c)) {
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
    // 断言:(a) Claude 连接(stdout)全程未 end
    expect(stdoutEnded).toBe(false);

    sup.stop();
  });
});
