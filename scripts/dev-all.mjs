#!/usr/bin/env node
// dev-all:一键起 vortex worktree 全自动联调环境(watcher 编排 + worktree NM 注册)。
//
// 解决的痛点(详见 CONTRIBUTING / packages/extension/README):改 extension 代码后
// 无需手动 reload 扩展、无需 /mcp reconnect。本脚本把以下编排成一条命令:
//   1. 预构建 shared/hub/server/mcp dist(extension dist 由 dev.mjs serve 产出)
//   2. 注册**本 worktree** 的 Native Messaging host(Chrome 据此 spawn 本 worktree server)
//   3. 起 extension HMR(scripts/dev.mjs:vite serve + page-side watch)
//   4. 起 shared/hub/server/mcp 的 tsc --watch(持续刷 dist)
//   5. 轮询 hub /health 确认本 worktree 的扩展已连 NM
//   6. 可选 --smoke:跑一个 bench smoke 坐实链路活
//
// 运行后改 extension/page-side 代码全自动生效(@crxjs HMR + mcp WS 自动重连,已实测);
// 仅改 mcp schema/dispatch 才需在 opencode `/mcp reconnect`。
//
// ⚠️ 扩展加载是唯一的一次性手动步骤:Chrome 137+ 已废掉 `--silent-debugger-extension-api`
//    之外的 `--load-extension`(实测 Chrome 148 stable 完全失效;Chrome for Testing 145 能
//    载入但 MV3 service worker 在 about:blank 下休眠不连 NM)。所以本脚本**不自动拉 Chrome**。
//    首次在你的 Chrome `chrome://extensions` → 开发者模式 → 加载 `packages/extension/dist`
//    **一次**,之后所有代码改动由 @crxjs HMR 自动 reload,无需再手动(已在 ① 实测坐实)。
//    hub 固定监听单端口；多个 Chrome browser-agent 通过 browserId 汇聚到 hub。
//
// 环境变量:
//   VORTEX_PORT   server 端口(默认 6800)
// flags:
//   --smoke       ready 后跑一个 bench smoke case
//   --case <name> --smoke 用的 case(默认 latency-p50)
//   --restart-hub 先请求常驻 hub 优雅关停并等待端口释放

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import { pickReadyBrowser } from "./lib/hub-ready.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const PORT = process.env.VORTEX_PORT ?? "6800";
const extDist = join(repoRoot, "packages/extension/dist");
const serverBin = join(repoRoot, "packages/server/dist/bin/vortex-server.js");

const log = (m) => console.log(`\x1b[36m[dev-all]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[dev-all] ${m}\x1b[0m`); shutdown(1); };

const children = [];
let down = false;
function shutdown(code = 0) {
  if (down) return; down = true;
  // 只杀本脚本起的 watchers;dev Chrome 是 detached,保留给用户继续用。
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* */ } }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
  if (r.status !== 0) die(`命令失败: ${cmd} ${args.join(" ")}`);
}

function getHealthSnapshot() {
  return new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/health`, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (chunk) => { body += chunk; });
      r.on("end", () => {
        if (r.statusCode !== 200) {
          res(null);
          return;
        }
        try {
          res(JSON.parse(body));
        } catch {
          res(null);
        }
      });
      r.on("error", () => res(null));
    });
    req.on("error", () => res(null));
    req.setTimeout(1000, () => { req.destroy(); res(null); });
  });
}

function health() {
  return getHealthSnapshot().then((snapshot) => pickReadyBrowser(snapshot, extDist));
}

function requestShutdown() {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${PORT}/hub/shutdown`, { method: "POST" }, (r) => {
      r.resume();
      if (r.statusCode !== 200) {
        reject(new Error(`hub shutdown failed with HTTP ${r.statusCode}`));
        return;
      }
      r.on("end", resolve);
    });
    req.on("error", reject);
    req.setTimeout(1000, () => req.destroy(new Error("hub shutdown request timed out")));
    req.end();
  });
}

async function restartHub() {
  log("请求常驻 hub 优雅关停 ...");
  await requestShutdown();
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await getHealthSnapshot()) === null) {
      log("hub 端口已释放");
      return;
    }
    if (Date.now() >= deadline) throw new Error("等待 hub 端口释放超时（10s）");
    await sleep(100);
  }
}

async function main() {
  if (has("--restart-hub")) await restartHub();

  // 1. 预构建(extension 交给 dev.mjs)
  log("预构建 shared/hub/server/mcp dist ...");
  sh("pnpm", ["--filter", "@vortex-browser/shared", "--filter", "@vortex-browser/hub",
    "--filter", "@vortex-browser/server",
    "--filter", "@vortex-browser/mcp", "build"]);

  // 2. 注册本 worktree NM host(幂等,覆盖 manifest path → 本 worktree native-host.sh)
  log("注册本 worktree Native Messaging host ...");
  sh("node", [serverBin, "install"]);

  // 3. 起 extension HMR(dev.mjs)
  log("起 extension HMR (vite serve + page-side watch) ...");
  const hmr = spawn("node", [join("packages/extension/scripts/dev.mjs")],
    { cwd: repoRoot, stdio: "inherit" });
  children.push(hmr);
  hmr.on("exit", (c) => { console.error(`[dev-all] extension HMR 退出 (${c})`); shutdown(c ?? 0); });

  // 等 dev.mjs 把 dist + page-side 写好(扩展 load-unpacked 需要完整 dist)
  process.stdout.write("[dev-all] 等 extension dist 就绪 ...");
  for (let i = 0; i < 120 && !existsSync(join(extDist, "page-side", "dom-resolve.js")); i++) await sleep(500);
  if (!existsSync(join(extDist, "page-side", "dom-resolve.js"))) die("超时:extension dist 未就绪");
  console.log(" ok");

  // 4. 起 shared/hub/server/mcp tsc --watch(持续刷 dist)
  log("起 shared/hub/server/mcp tsc --watch ...");
  const watch = spawn("pnpm", ["--filter", "@vortex-browser/shared", "--filter", "@vortex-browser/hub",
    "--filter", "@vortex-browser/server",
    "--filter", "@vortex-browser/mcp", "--parallel", "dev"], { cwd: repoRoot, stdio: "inherit" });
  children.push(watch);

  // 5. 轮询 hub /health(命中本 worktree 扩展即表示扩展已加载并连 NM)
  process.stdout.write("[dev-all] 等 hub /health(本 worktree 扩展加载并连 NM) ...");
  let readyBrowser = null;
  for (let i = 0; i < 30; i++) {
    readyBrowser = await health();
    if (readyBrowser) break;
    await sleep(1000);
  }
  const ok = readyBrowser !== null;
  if (!ok) {
    console.log(" 未连");
    log("⚠️ 扩展尚未连上。首次请在 Chrome chrome://extensions → 开发者模式 →");
    log("   「加载已解压的扩展程序」→ 选 " + extDist + "  (固定 ID,只需一次)");
    log("   之后改代码 @crxjs 自动 reload,无需再手动。");
  } else {
    console.log(` ok (${readyBrowser.browserId ?? "browser"})`);
  }

  // 6. 可选 smoke
  if (ok && has("--smoke")) {
    const c = valOf("--case", "latency-p50");
    log(`跑 bench smoke: ${c}`);
    sh("pnpm", ["--filter", "@vortex-browser/vortex-bench", "bench", "run", c], { stdio: "inherit" });
  }

  log("✅ watchers 就绪。改 extension/page-side → @crxjs 自动 reload(已实测,无需 /mcp reconnect);");
  log("   仅改 mcp schema/dispatch → opencode `/mcp reconnect`。Ctrl-C 停 watchers。");
}

main().catch((e) => die(e?.stack ?? String(e)));
