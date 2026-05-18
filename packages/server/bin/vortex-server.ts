import { appendFileSync } from "fs";
import { Command } from "commander";
import { startServer } from "../src/index.js";

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
  // Chrome Native Messaging 启动时会追加未知参数（--parent-window 等），放行
  .allowUnknownOption(true)
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
