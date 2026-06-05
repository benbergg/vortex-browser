#!/usr/bin/env node
import { appendFileSync } from "fs";
import { Command } from "commander";
import { startServer } from "../src/index.js";
import { installNmHost, DEFAULT_EXTENSION_ID } from "../src/install-nm-host.js";

// ─────────────────────────────────────────────────────────────────────────────
// install 子命令：手动 argv 检测，不用 commander subcommand。
// 原因：Chrome Native Messaging 启动时会把 chrome-extension://<id>/ 作为位置参数
// 追加进 argv，若用 commander .command('install') 可能把未知位置参数当未知命令报错。
// 手动检测可精确匹配 "install" 字符串，chrome-extension:// 开头的参数自然跳过。
// ─────────────────────────────────────────────────────────────────────────────
if (process.argv[2] === "install") {
  // 不带 ID 时用 manifest 钉死 key 对应的默认扩展 ID(方案 B),无需用户复制粘贴。
  // 仅当加载的扩展 ID 不同(如商店分发改了 key)才需显式 `install <id>` 覆盖。
  const extId = process.argv[3] || DEFAULT_EXTENSION_ID;
  const usingDefault = !process.argv[3];
  try {
    const r = installNmHost(extId);
    console.log(`✓ Native messaging host registered: ${r.hostName}`);
    console.log(`  extension id: ${extId}${usingDefault ? " (default, pinned)" : ""}`);
    console.log(`  manifest: ${r.manifestPath}`);
    console.log(`  host script: ${r.nativeHostPath}`);
    console.log(`\nReload the Vortex extension in chrome://extensions to connect.`);
    process.exit(0);
  } catch (e: any) {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  }
}

const LOG = "/tmp/vortex-server.log";
const log = (msg: string) => appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);

log("=== vortex-server starting ===");
log(`pid=${process.pid} argv=${process.argv.join(" ")}`);
log(`stdin isTTY=${process.stdin.isTTY} stdout isTTY=${process.stdout.isTTY}`);

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (err) => {
  log(`UNHANDLED: ${err}`);
});

const program = new Command();
program
  .option("--port <port>", "local HTTP/WS port", String(process.env.VORTEX_PORT ?? "6800"))
  // Chrome Native Messaging 启动时会追加未知参数（--parent-window 等）以及
  // chrome-extension://<id>/ 等位置参数，全部放行
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .parse(process.argv);

const opts = program.opts();

try {
  const port = Number(opts.port) || 6800;

  log(`startServer opts: port=${port}`);

  startServer({ port });
  log("startServer() returned");
} catch (err: any) {
  log(`STARTUP ERROR: ${err.stack ?? err.message}`);
  console.error(`[vortex-server] startup error: ${err.message}`);
  process.exit(1);
}
