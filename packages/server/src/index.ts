import { createServer } from "http";
import { writeFileSync, readFileSync, unlinkSync, existsSync, watch, statSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express from "express";
import { NativeMessagingReader, writeNmMessage } from "./native-messaging.js";
import { SessionManager } from "./session.js";
import { StateCache } from "./state-cache.js";
import { MessageRouter } from "./message-router.js";
import { createWsServer } from "./ws-server.js";
import { createHttpRoutes } from "./http-routes.js";

const PIDFILE = "/tmp/vortex-server.pid";

export interface StartServerOptions {
  /** 本地 WS/HTTP 服务端口，默认 6800 */
  port?: number;
}

/**
 * Watcher 扩展 dist 变更并推送 reload-extension 控制消息（@since 0.4.0，O-3b）。
 *
 * 为什么需要：extension 走 `chrome.runtime.connectNative` 走 stdio 连到
 * vortex-server，扩展自身 dist 变了并不会触发重载（需要人去 chrome://extensions
 * 点一下）。我们在 server 侧 watch `packages/extension/dist/`，变化时主动
 * 向扩展推 `{type:"control", action:"reload-extension"}`，扩展收到后调
 * `chrome.runtime.reload()`——Chrome 对 load-unpacked 扩展会重读磁盘 dist。
 *
 * 关键安全点：
 *  - debounce 2s：vite build 写多个文件会触发多次，合并成一次 reload
 *  - 只响应 .js / manifest.json / .html，避免 .map 噪声
 *  - VORTEX_NO_EXT_AUTO_RELOAD=1 opt-out
 *  - reload 后扩展会断开 stdio，server heartbeat 自然感知并等新连接
 */
function installExtensionDistWatcher(): void {
  if (process.env.VORTEX_NO_EXT_AUTO_RELOAD === "1") return;

  // 运行位置：packages/server/dist/src/index.js，扩展 dist：packages/extension/dist
  const here = dirname(fileURLToPath(import.meta.url));
  const extDist = resolve(here, "../../../extension/dist");

  try {
    // 必须存在才 watch（避免扩展未 build 时 server 启动报错）
    statSync(extDist);
  } catch {
    console.error(
      `[vortex-server] extension dist not found at ${extDist}; auto-reload disabled. ` +
        `Build it with: pnpm -C packages/extension build`,
    );
    return;
  }

  let debounceTimer: NodeJS.Timeout | null = null;
  let lastReason = "";
  const RELEVANT = /\.(js|html)$|manifest\.json$/;

  try {
    const watcher = watch(extDist, { recursive: true }, (eventType, filename) => {
      if (!filename || !RELEVANT.test(filename)) return;
      if (eventType !== "change" && eventType !== "rename") return;
      lastReason = `${eventType} ${filename}`;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!process.stdout.writable) return;
        console.error(
          `[vortex-server] extension dist changed (${lastReason}); pushing reload-extension to Chrome`,
        );
        writeNmMessage(process.stdout, {
          type: "control",
          action: "reload-extension",
          reason: lastReason,
        });
      }, 2000);
    });
    watcher.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vortex-server] extension dist watcher error: ${msg}`);
    });
    console.error(`[vortex-server] watching extension dist: ${extDist}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[vortex-server] failed to install ext dist watcher: ${msg}`);
  }
}

// 杀掉旧的 vortex-server 进程
function killOldProcess(): void {
  try {
    if (existsSync(PIDFILE)) {
      const oldPid = readFileSync(PIDFILE, "utf-8").trim();
      if (oldPid) {
        try {
          execSync(`kill ${oldPid} 2>/dev/null`);
          // 等待旧进程释放端口
          execSync("sleep 0.5");
        } catch {
          // 旧进程已经不存在
        }
      }
    }
  } catch {
    // ignore
  }
  writeFileSync(PIDFILE, String(process.pid));
}

export function startServer(opts: StartServerOptions | number = {}): void {
  // 向后兼容：老调用方式 startServer(6800)
  const options: StartServerOptions = typeof opts === "number" ? { port: opts } : opts;
  const port = options.port ?? 6800;

  killOldProcess();
  installExtensionDistWatcher();

  const sessions = new SessionManager();
  const _stateCache = new StateCache();
  const router = new MessageRouter(process.stdout, sessions);

  // 防止 stdout EPIPE 崩溃
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      console.error("[nm] stdout pipe broken, stopping heartbeat");
      clearInterval(heartbeatTimer);
    } else {
      console.error("[nm] stdout error:", err);
    }
  });

  const nmReader = new NativeMessagingReader((msg) => {
    router.handleNmMessage(msg);
  });

  process.stdin.on("data", (chunk: Buffer) => {
    router.setNmConnected(true);
    nmReader.feed(chunk);
  });

  process.stdin.on("end", () => {
    console.error("[nm] stdin closed, extension disconnected");
    router.setNmConnected(false);
    clearInterval(heartbeatTimer);
  });

  // 退出时清理 pidfile
  process.on("exit", () => {
    try { unlinkSync(PIDFILE); } catch { /* ignore */ }
  });

  const heartbeatTimer = setInterval(() => {
    if (process.stdout.writable) {
      writeNmMessage(process.stdout, { type: "ping" });
    }
  }, 10_000);

  const app = express();
  app.use(createHttpRoutes(router));

  const httpServer = createServer(app);
  createWsServer(httpServer, sessions, router);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[vortex-server] port ${port} still in use, force killing`);
      try {
        execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`);
        setTimeout(() => httpServer.listen(port), 500);
      } catch {
        console.error(`[vortex-server] failed to free port ${port}`);
      }
    } else {
      console.error("[vortex-server] server error:", err);
    }
  });

  httpServer.listen(port, () => {
    console.error(`[vortex-server] listening on port ${port}`);
  });
}
