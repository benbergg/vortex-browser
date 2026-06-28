#!/usr/bin/env node
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { watch, realpathSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LineFramer,
  frame,
  isRequest,
  isResponse,
  type JsonRpcMessage,
} from "./lib/jsonrpc-stream.js";

export interface SupervisorDeps {
  /** 子进程入口脚本绝对路径(默认同目录 server.js,可经 env/测试覆盖)。 */
  childEntry: string;
  /** 透传给子进程的 argv(如 --caps=dev)。 */
  childArgs: string[];
  /** Claude → supervisor 输入流(生产为 process.stdin)。 */
  stdin: NodeJS.ReadableStream;
  /** supervisor → Claude 输出流(生产为 process.stdout)。 */
  stdout: NodeJS.WritableStream;
  /** 注入 spawn 便于测试;默认 child_process.spawn。 */
  spawnFn?: typeof nodeSpawn;
  /** 排空在飞请求的超时(默认 10s),超时强制重启并对孤儿 id 合成 error。 */
  drainTimeoutMs?: number;
  /** SIGTERM 后等待子进程退出的超时(默认 3s),超时 SIGKILL。 */
  killTimeoutMs?: number;
}

export interface SupervisorHandle {
  start(): void;
  triggerRestart(reason: string): void;
  stop(): void;
  getChildPid(): number | undefined;
}

const LIST_CHANGED: JsonRpcMessage = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
};

export function createSupervisor(deps: SupervisorDeps): SupervisorHandle {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  const killTimeoutMs = deps.killTimeoutMs ?? 3_000;

  let child: ChildProcess | null = null;
  const upstream = new LineFramer(); // Claude → supervisor
  const downstream = new LineFramer(); // child → supervisor

  // 握手重放材料(首次启动期捕获,逐字节重放)
  let initRequestRaw: string | null = null;
  let initializedRaw: string | null = null;

  // 在飞请求 id 集合(Claude→child 的 request,收到对应响应即移除)
  const inflight = new Set<string | number>();

  // 状态机标志
  let restarting = false;
  let awaitingChildInit = false;
  let bufferingUpstream = false;
  let wantRestart = false;
  let pendingAgain = false;
  let restartReason = "";
  let stopped = false;
  const requestBuffer: string[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (s: string): void => void process.stderr.write(`[supervisor] ${s}\n`);

  function writeToClaude(msg: JsonRpcMessage): void {
    if (deps.stdout.writable) deps.stdout.write(frame(msg));
  }
  function writeRawToChild(raw: string): void {
    if (child?.stdin?.writable) child.stdin.write(raw + "\n");
  }

  // ---- 子进程生命周期 ----
  function spawnChild(): void {
    const c = spawnFn(process.execPath, [deps.childEntry, ...deps.childArgs], {
      env: { ...process.env, VORTEX_MCP_SUPERVISED: "1" },
      stdio: ["pipe", "pipe", "inherit"], // stderr 直通 supervisor stderr
    });
    c.stdout!.on("data", onChildData);
    // @ts-expect-error ChildProcessByStdio.on 在 @types/node@25+moduleResolution:bundler 下
    // 类型层不可见(同 server.ts FSWatcher.on);运行时继承 EventEmitter 无问题。
    c.on("exit", onChildExit);
    child = c as unknown as ChildProcess;
  }

  function onChildData(chunk: Buffer): void {
    for (const { raw, msg } of downstream.push(chunk)) {
      // 重启期间新 child 的第一条响应即 init reply:吞掉,推进握手
      if (restarting && awaitingChildInit && isResponse(msg)) {
        awaitingChildInit = false;
        onChildReinitialized();
        continue;
      }
      if (isResponse(msg) && msg.id != null) {
        inflight.delete(msg.id as string | number);
        maybeStartRestart(); // 响应回来可能完成排空
      }
      // raw 逐字节转发,避免重序列化差异
      if (deps.stdout.writable) deps.stdout.write(raw + "\n");
    }
  }

  function onChildExit(code: number | null): void {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    if (restarting) {
      // 预期内重启:老 child 退出后接力 spawn 新 child
      continueRestartAfterChildExit();
      return;
    }
    if (stopped) return;
    // 意外崩溃:拉起来(视作一次重启,最终发 list_changed)
    log(`child exited unexpectedly (code=${code}); respawning`);
    inflight.clear(); // 崩溃时在飞响应已丢,清空避免卡排空
    doTriggerRestart("child-crash");
  }

  // ---- 重启状态机 ----
  function doTriggerRestart(reason: string): void {
    restartReason = reason;
    wantRestart = true;
    if (!drainTimer && inflight.size > 0) {
      drainTimer = setTimeout(forceDrain, drainTimeoutMs);
    }
    maybeStartRestart();
  }

  function maybeStartRestart(): void {
    if (!wantRestart || restarting) return;
    if (inflight.size > 0) return; // 等排空
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    doRestart();
  }

  function forceDrain(): void {
    drainTimer = null;
    if (restarting || !wantRestart) return;
    log(`drain timeout; force-restart, ${inflight.size} inflight aborted`);
    for (const id of inflight) {
      writeToClaude({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "vortex MCP child restarting; request aborted, please retry" },
      });
    }
    inflight.clear();
    doRestart();
  }

  function doRestart(): void {
    restarting = true;
    wantRestart = false;
    bufferingUpstream = true;
    log(`restarting child (reason=${restartReason})`);
    if (child) {
      const dying = child;
      killTimer = setTimeout(() => {
        log("child did not exit in time; SIGKILL");
        try { dying.kill("SIGKILL"); } catch { /* already gone */ }
      }, killTimeoutMs);
      try { dying.kill("SIGTERM"); } catch { continueRestartAfterChildExit(); }
    } else {
      continueRestartAfterChildExit();
    }
  }

  function continueRestartAfterChildExit(): void {
    child = null;
    spawnChild();
    awaitingChildInit = true;
    // 重放 initialize;新 child 的 init 响应由 onChildData 吞掉 → onChildReinitialized
    if (initRequestRaw) writeRawToChild(initRequestRaw);
    else { awaitingChildInit = false; onChildReinitialized(); } // 无握手材料(异常):直接收尾
  }

  function onChildReinitialized(): void {
    if (initializedRaw) writeRawToChild(initializedRaw);
    for (const raw of requestBuffer) writeRawToChild(raw); // flush 缓冲请求
    requestBuffer.length = 0;
    bufferingUpstream = false;
    restarting = false;
    writeToClaude(LIST_CHANGED); // 通知 Claude 重拉 tools/list
    log("restart complete; sent tools/list_changed");
    if (pendingAgain) { pendingAgain = false; doTriggerRestart("coalesced"); }
  }

  // ---- Claude → supervisor ----
  function onUpstreamData(chunk: Buffer): void {
    for (const { raw, msg } of upstream.push(chunk)) {
      if (msg.method === "initialize" && isRequest(msg)) initRequestRaw = raw;
      if (msg.method === "notifications/initialized") initializedRaw = raw;
      if (isRequest(msg)) inflight.add(msg.id as string | number);
      if (bufferingUpstream) requestBuffer.push(raw);
      else writeRawToChild(raw);
    }
  }

  // ---- 公开句柄 ----
  return {
    start(): void {
      spawnChild();
      deps.stdin.on("data", onUpstreamData);
      deps.stdin.on("end", () => { log("upstream(stdin) ended; stopping"); this.stop(); });
    },
    triggerRestart(reason: string): void {
      if (restarting) { pendingAgain = true; return; } // 重启中再触发 → coalesce
      doTriggerRestart(reason);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (drainTimer) clearTimeout(drainTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child) { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
    },
    getChildPid(): number | undefined { return child?.pid; },
  };
}

// ---- CLI 入口(仅 node supervisor.js 直跑时执行) ----
function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const here = dirname(fileURLToPath(import.meta.url));
  const childEntry = process.env.VORTEX_MCP_CHILD_ENTRY ?? join(here, "server.js");
  const sup = createSupervisor({
    childEntry,
    childArgs: process.argv.slice(2), // 透传 --caps=dev
    stdin: process.stdin,
    stdout: process.stdout,
  });
  sup.start();

  // 自动触发:watch MCP dist(debounce 1s,仅 .js)
  const DEBOUNCE_MS = 1_000;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher: FSWatcher = watch(here, { recursive: true }, (ev, filename) => {
      if (ev !== "change" && ev !== "rename") return;
      if (!filename || !filename.endsWith(".js")) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; sup.triggerRestart(`dist:${filename}`); }, DEBOUNCE_MS);
    });
    // @ts-expect-error FSWatcher.on 类型层歧义,运行时正确(继承自 EventEmitter)
    watcher.on("error", (e: unknown) => process.stderr.write(`[supervisor] watch error: ${String(e)}\n`));
  } catch (e) {
    process.stderr.write(`[supervisor] watch init failed: ${String(e)}; auto-restart disabled\n`);
  }

  // 手动触发信号(运维 + 应急)
  process.on("SIGUSR2", () => sup.triggerRestart("SIGUSR2"));
  // Claude 关闭管道:干净退出
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") sup.stop();
  });
}
