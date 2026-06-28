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
  /** 新 child 完成 initialize 握手的超时(默认等于 drainTimeoutMs),超时 SIGKILL 并重试。 */
  reinitTimeoutMs?: number;
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

/** 新 child 初始化失败的最大重试次数,超出后放弃并对缓冲请求合成错误。 */
const MAX_INIT_RETRIES = 3;

export function createSupervisor(deps: SupervisorDeps): SupervisorHandle {
  const spawnFn = deps.spawnFn ?? nodeSpawn;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  const killTimeoutMs = deps.killTimeoutMs ?? 3_000;
  const reinitTimeoutMs = deps.reinitTimeoutMs ?? drainTimeoutMs;

  let child: ChildProcess | null = null;
  const upstream = new LineFramer(); // Claude → supervisor
  const downstream = new LineFramer(); // child → supervisor

  // 握手重放材料(首次启动期捕获,逐字节重放)
  let initRequestRaw: string | null = null;
  let initializedRaw: string | null = null;

  // 在飞请求 id 集合(Claude→child 的 request,收到对应响应即移除)
  const inflight = new Set<string | number>();
  // I1:forceDrain 已对这些 id 合成过 error,若子进程随后发来真实响应则丢弃,避免 double-response
  const abortedIds = new Set<string | number>();

  // 状态机标志
  let restarting = false;
  let awaitingChildInit = false;
  let bufferingUpstream = false;
  let wantRestart = false;
  let pendingAgain = false;
  let restartReason = "";
  let stopped = false;
  /** I3:新 child 初始化失败的连续次数(成功后归零)。 */
  let initRetryCount = 0;
  const requestBuffer: string[] = [];
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  /** I3:新 child 完成 initialize 的看门狗计时器。 */
  let reinitTimer: ReturnType<typeof setTimeout> | null = null;
  /** I3:退避重试的定时器,stop() 时清理避免进程退出后仍触发(open handle 泄漏)。 */
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;

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
        const msgId = msg.id as string | number;
        // I1:已被 forceDrain 中止的 id,丢弃子进程在 SIGTERM 宽限期内发来的迟到真实响应
        if (abortedIds.has(msgId)) {
          abortedIds.delete(msgId);
          continue;
        }
        inflight.delete(msgId);
        maybeStartRestart(); // 响应回来可能完成排空
      }
      // raw 逐字节转发,避免重序列化差异
      if (deps.stdout.writable) deps.stdout.write(raw + "\n");
    }
  }

  function onChildExit(code: number | null): void {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    // I2:stopped 检查必须先于 restarting 分支;否则 stop() 后仍会拉起新 child 导致泄漏
    if (stopped) return;
    if (restarting) {
      if (awaitingChildInit) {
        // 新 child 在初始化期间崩溃或被 watchdog SIGKILL
        handleNewChildCrash(code);
      } else {
        // 预期内重启:老 child 退出后接力 spawn 新 child
        continueRestartAfterChildExit();
      }
      return;
    }
    // 意外崩溃:拉起来(视作一次重启,最终发 list_changed)
    log(`child exited unexpectedly (code=${code}); respawning`);
    inflight.clear(); // 崩溃时在飞响应已丢,清空避免卡排空
    // C1:先将 child 置 null 再调 doTriggerRestart:doRestart 的存活判断将走 else 分支
    //    直接调 continueRestartAfterChildExit(),避免对已退出进程调 kill() 不抛异常
    //    导致状态机永久死锁(restarting/bufferingUpstream 卡 true、无新 child)。
    child = null;
    doTriggerRestart("child-crash");
  }

  /**
   * I3:新 child 在初始化阶段失败(崩溃 or watchdog 超时后被 SIGKILL)。
   * 带指数退避重试;耗尽次数后对所有缓冲请求合成 JSON-RPC error。
   */
  function handleNewChildCrash(code: number | null): void {
    // 清理看门狗(watchdog 触发场景下此处已为 null;普通崩溃场景由此处清)
    if (reinitTimer) { clearTimeout(reinitTimer); reinitTimer = null; }
    child = null;
    initRetryCount++;
    if (initRetryCount >= MAX_INIT_RETRIES) {
      log(`新 child 已连续初始化失败 ${initRetryCount} 次;放弃重启并对缓冲请求合成错误响应`);
      // 捕获 pendingAgain:放弃期间若有新的重启信号(如好构建上线)需在重置后兑现
      const hadPending = pendingAgain;
      abortBufferedRequests();
      // 清空 inflight/abortedIds:缓冲的请求已被 abortBufferedRequests 中止,
      // 若不清空,下次 triggerRestart 时 doTriggerRestart 会把残留 inflight 视为待排空,
      // 臂 drainTimer 延迟重启;drainTimeoutMs 后 forceDrain 还会对同一 id 再次合成 -32000
      // (double-response),并在 onChildData 因 abortedIds 清空后误转发迟到响应。
      inflight.clear();
      abortedIds.clear();
      // 重置状态机:supervisor 保持存活,等待下一次成功构建触发的重启
      restarting = false;
      awaitingChildInit = false;
      bufferingUpstream = false;
      wantRestart = false;
      pendingAgain = false;
      initRetryCount = 0;
      // 若放弃期间收到了被合并的重启信号,立即触发以自动恢复(如好构建恰好在 crash-loop 期间落盘)
      if (hadPending) doTriggerRestart("coalesced-after-giveup");
      return;
    }
    const delay = Math.min(200 * Math.pow(2, initRetryCount - 1), 5_000);
    log(`新 child 崩溃(code=${code});将在 ${delay}ms 后第 ${initRetryCount}/${MAX_INIT_RETRIES} 次重试`);
    // 存储定时器:stop() 时需清理,否则进程退出后仍会触发 continueRestartAfterChildExit
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      if (stopped) return;
      continueRestartAfterChildExit();
    }, delay);
  }

  /** I3:对 requestBuffer 中全部请求合成 JSON-RPC error 并清空缓冲区。 */
  function abortBufferedRequests(): void {
    for (const raw of requestBuffer) {
      try {
        const parsed = JSON.parse(raw) as JsonRpcMessage;
        if (isRequest(parsed) && parsed.id != null) {
          writeToClaude({
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              code: -32000,
              message: "vortex MCP child failed to restart; request aborted, please retry",
            },
          });
        }
      } catch { /* 忽略格式错误的帧 */ }
    }
    requestBuffer.length = 0;
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
      // I1:记录已中止的 id;后续子进程发来的迟到真实响应将在 onChildData 中被丢弃
      abortedIds.add(id);
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
    // C1:仅当子进程确认存活时才发 SIGTERM。
    //    exitCode/signalCode 任意非 null 表示进程已退出;kill() 对已退出进程返回 false 不抛异常,
    //    依赖 catch 分支的老逻辑会导致状态机永久阻塞。
    if (child && child.exitCode === null && child.signalCode === null) {
      const dying = child;
      killTimer = setTimeout(() => {
        log("child did not exit in time; SIGKILL");
        try { dying.kill("SIGKILL"); } catch { /* already gone */ }
      }, killTimeoutMs);
      try {
        dying.kill("SIGTERM");
      } catch {
        // SIGTERM 抛异常:进程已消失,无需等 exit 事件
        // C1(Minor #1):清理 killTimer 避免 SIGKILL 空打悬挂计时器
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        continueRestartAfterChildExit();
      }
    } else {
      // child 已退出或为 null(崩溃/crash 场景),直接续行
      continueRestartAfterChildExit();
    }
  }

  function continueRestartAfterChildExit(): void {
    child = null;
    spawnChild();
    awaitingChildInit = true;
    // 重放 initialize;新 child 的 init 响应由 onChildData 吞掉 → onChildReinitialized
    if (initRequestRaw) {
      writeRawToChild(initRequestRaw);
      // I3:臂初始化看门狗,防止新 child 永远挂起不回复 initialize
      if (reinitTimer) clearTimeout(reinitTimer);
      reinitTimer = setTimeout(onReinitTimeout, reinitTimeoutMs);
    } else {
      awaitingChildInit = false;
      onChildReinitialized(); // 无握手材料(异常):直接收尾
    }
  }

  /**
   * I3:新 child 超时未回复 initialize,SIGKILL 后由 onChildExit 触发重试逻辑。
   * 已知良性竞态:若 init 响应恰好与本计时器在同一 tick 触发,onReinitTimeout 先运行,
   * 会 SIGKILL 一个已完成初始化的 child;随后 onChildReinitialized 入队但 child 已被杀,
   * onChildExit(restarting=true, awaitingChildInit=false)走非 crash 分支再 spawn 一次,
   * 多发一次 list_changed,状态机可自愈。概率极低,无需额外处理。
   */
  function onReinitTimeout(): void {
    reinitTimer = null;
    log(`新 child 超时未完成 initialize (${reinitTimeoutMs}ms); SIGKILL`);
    if (child) {
      // SIGKILL 后 onChildExit(restarting=true, awaitingChildInit=true) 将调 handleNewChildCrash
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  function onChildReinitialized(): void {
    // I3:清看门狗并重置重试计数(成功握手即归零)
    if (reinitTimer) { clearTimeout(reinitTimer); reinitTimer = null; }
    initRetryCount = 0;
    // I1:新 child 就绪后清 abortedIds,旧 child 的迟到响应窗口已关闭
    abortedIds.clear();
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
      else if (child) writeRawToChild(raw);
      else if (isRequest(msg) && msg.id != null) {
        // give-up 后 child=null 且非缓冲状态:静默丢弃会导致 Claude 请求永久挂起,
        // 合成明确的错误响应,让模型收到失败信号而非无响应超时
        inflight.delete(msg.id as string | number);
        writeToClaude({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32000,
            message: "vortex MCP child unavailable; rebuild to recover",
          },
        });
      }
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
      // I3:stop 时清理看门狗及退避重试定时器,避免 supervisor 停止后仍触发重试逻辑
      if (reinitTimer) { clearTimeout(reinitTimer); reinitTimer = null; }
      if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
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
