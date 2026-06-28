import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSupervisor } from "../src/supervisor.js";
import { LineFramer, frame, type JsonRpcMessage } from "../src/lib/jsonrpc-stream.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = join(__dirname, "fixtures", "stub-mcp-child.mjs");
const CRASH_STUB = join(__dirname, "fixtures", "stub-mcp-crashloop.mjs");

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

  /**
   * 回归测试 C1:意外崩溃(SIGKILL)后 supervisor 自动重启并换进程。
   * 未修复前:crash 分支 child 不置 null → doRestart 对已退出进程 kill() 不抛 → catch 不触发
   * → continueRestartAfterChildExit 永不被调 → 状态机死锁。
   */
  it("意外崩溃后自动重启并换进程(C1 回归)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames = new LineFramer();

    let listChangedCount = 0;
    const lcFramer = new LineFramer();
    stdout.on("data", (c: Buffer) => {
      for (const { msg } of lcFramer.push(c)) {
        if (msg.method === "notifications/tools/list_changed") listChangedCount++;
      }
    });

    const sup = createSupervisor({
      childEntry: STUB,
      childArgs: [],
      stdin,
      stdout,
      killTimeoutMs: 300,
      reinitTimeoutMs: 3000,
    });
    sup.start();

    // 握手
    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    await waitFor(frames, stdout, (m) => m.id === 1 && (m as any).result?.serverInfo?.name === "stub");
    stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));

    // 记录崩溃前 pid
    stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    await waitFor(frames, stdout, (m) => m.id === 2);
    const pidBefore = sup.getChildPid()!;
    expect(pidBefore).toBeTypeOf("number");

    // 从测试进程直接 SIGKILL 子进程,模拟意外崩溃
    process.kill(pidBefore, "SIGKILL");

    // supervisor 应自动重启并发 list_changed
    await waitFor(frames, stdout, (m) => m.method === "notifications/tools/list_changed", 6000);

    // 新 child 应响应后续请求
    stdin.write(frame({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    const afterResp = await waitFor(frames, stdout, (m) => m.id === 3, 5000);
    const pidAfter = sup.getChildPid()!;

    expect(pidAfter).toBeTypeOf("number");
    expect(pidAfter).not.toBe(pidBefore);
    expect((afterResp as any).result.tools[0].description).toBe(`pid:${pidAfter}`);
    expect(listChangedCount).toBe(1);

    sup.stop();
  });

  /**
   * 回归测试 I2:重启过程中 stop() 后不再拉起新 child(无泄漏)。
   * 未修复前:onChildExit 先检查 restarting → continueRestartAfterChildExit → spawn 新 child,
   * 而 stopped 检查在后 → 新 child 永不被 stop,成为僵尸进程。
   */
  it("重启过程中 stop() 后不再拉起新 child(I2 回归)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames = new LineFramer();

    // 用自定义 spawnFn 追踪实际 spawn 次数
    let spawnCount = 0;
    const trackSpawnFn = ((cmd: string, args: string[], opts: object) => {
      spawnCount++;
      return nodeSpawn(cmd, args, opts as Parameters<typeof nodeSpawn>[2]);
    }) as typeof nodeSpawn;

    const sup = createSupervisor({
      childEntry: STUB,
      childArgs: [],
      stdin,
      stdout,
      spawnFn: trackSpawnFn,
      killTimeoutMs: 200,
      reinitTimeoutMs: 3000,
    });
    sup.start();
    // 初始 spawn → spawnCount = 1

    // 握手
    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    await waitFor(frames, stdout, (m) => m.id === 1 && (m as any).result?.serverInfo?.name === "stub");
    stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));

    // 确认正常可用
    stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    await waitFor(frames, stdout, (m) => m.id === 2);
    expect(spawnCount).toBe(1);

    // 触发重启,立即 stop() — 不等重启完成
    sup.triggerRestart("test-mid-restart");
    sup.stop();

    // 等待足够时间让老 child 退出及任何潜在的异步 spawn 发生
    await new Promise<void>((r) => setTimeout(r, 600));

    // 验证:stop() 后无新 child 被 spawn(spawnCount 仍为 1)
    expect(spawnCount).toBe(1);
  });

  /**
   * 回归测试 I3:新 child 持续崩溃耗尽重试后对缓冲请求合成 JSON-RPC error。
   * 场景:triggerRestart 后新 child 每次都立即退出(模拟损坏的构建产物),
   * supervisor 带退避重试 MAX_INIT_RETRIES(3)次后放弃,对缓冲请求回复 -32000 错误。
   */
  it("新 child 持续崩溃耗尽重试后对缓冲请求合成错误(I3 回归)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames = new LineFramer();

    // 第 1 次 spawn 用正常 stub(完成握手),之后的 spawn 用 crashloop stub
    let spawnCount = 0;
    const testSpawnFn = ((cmd: string, args: string[], opts: object) => {
      spawnCount++;
      const effectiveArgs = spawnCount === 1 ? args : [CRASH_STUB];
      return nodeSpawn(cmd, effectiveArgs, opts as Parameters<typeof nodeSpawn>[2]);
    }) as typeof nodeSpawn;

    const sup = createSupervisor({
      childEntry: STUB,
      childArgs: [],
      stdin,
      stdout,
      spawnFn: testSpawnFn,
      killTimeoutMs: 200,
      // 使用较小值加速测试(重试退避 200ms+400ms,总耗时约 1s)
      reinitTimeoutMs: 3000,
    });
    sup.start();

    // 握手(使用第 1 个正常 stub)
    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    await waitFor(frames, stdout, (m) => m.id === 1 && (m as any).result?.serverInfo?.name === "stub");
    stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    await waitFor(frames, stdout, (m) => m.id === 2);

    // 触发重启并立即塞入一个缓冲请求(新 child 将反复崩溃)
    sup.triggerRestart("broken-build");
    stdin.write(frame({ jsonrpc: "2.0", id: 99, method: "tools/list" }));

    // 等待缓冲请求的错误响应(重试 3 次后放弃,约 200+400ms ≈ 600ms)
    const errorResp = await waitFor(
      frames, stdout,
      (m) => m.id === 99,
      8000,
    );

    expect((errorResp as any).error).toBeDefined();
    expect((errorResp as any).error.code).toBe(-32000);
    // 确认重试确实发生了:初始 1 次 + 重试 MAX_INIT_RETRIES(3) 次 = 4 次 spawn
    expect(spawnCount).toBe(4);

    sup.stop();
  }, 12000);
});
