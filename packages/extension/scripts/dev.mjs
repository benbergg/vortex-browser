#!/usr/bin/env node
// Dev 编排器:vite serve(crx HMR)+ page-side IIFE watch。
//
// 为何需要编排:crx serve 启动会 EMPTY dist(实测 2026-06-07),而 page-side IIFE 由独立
// build-page-side.mjs(configFile:false 隔离 crx 避免 code-splitting)产出。必须等 serve 起来、
// crx 重建 dist 后再 build page-side 写回,否则 dom.* 的
// executeScript({ files: ['page-side/<name>.js'] }) 读不到文件。
// 顺序:1) 起 vite serve  2) 等 dist/manifest.json 出现  3) page-side --watch 写回并持续守。
//
// 重载语义(实测确认):
//  - 改 handler / background → crx 自动 reload 扩展(免手动点 chrome://extensions 🔄;
//    但整扩展 reload 会断 native messaging,改后需在 opencode 跑 /mcp reconnect)
//  - 改 page-side → watch 重建文件,下次 executeScript 自动取新(无需任何 reload)
//  - 改 content-main(world:MAIN)→ crx 整体 reload(MAIN world 不支持模块级 HMR)
//
// 注:crx serve 仅在 server **启动**时 empty dist。若手动重启 vite,需重跑本脚本让 page-side 回写。

import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

const children = [];
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// 1. vite serve(crx HMR)。捕获 stdout 转发 + 检测 "ready":
//    **不能**用 manifest.json 出现当就绪信号——crx serve 启动时早早写 manifest,但之后
//    继续 empty/重写 dist 直到 ready,会把过早写回的 page-side 又抹掉(实测竞态)。
//    必须等 crx 打印 ready 后 dist 才稳定,再建 page-side。
const vite = spawn("pnpm", ["exec", "vite"], {
  stdio: ["inherit", "pipe", "pipe"],
  cwd: pkgRoot,
});
children.push(vite);
vite.on("exit", (code) => {
  console.error(`[dev] vite serve 退出 (code=${code})，停止 dev loop`);
  shutdown(code ?? 0);
});

const viteReady = new Promise((resolveReady) => {
  let done = false;
  const scan = (buf) => {
    const s = buf.toString();
    if (!done && /ready in|Load dist as unpacked/.test(s)) {
      done = true;
      resolveReady();
    }
  };
  vite.stdout.on("data", (b) => { process.stdout.write(b); scan(b); });
  vite.stderr.on("data", (b) => { process.stderr.write(b); scan(b); });
});

// 2. 等 crx serve 就绪(ready),再 settle 让 dist 写盘稳定
process.stdout.write("[dev] 等 vite/crx serve ready ...\n");
const timeout = sleep(45000).then(() => "timeout");
const winner = await Promise.race([viteReady.then(() => "ready"), timeout]);
if (winner === "timeout") {
  console.error("[dev] 超时:45s 内 vite serve 未 ready");
  shutdown(1);
}
await sleep(1200); // ready 后 crx 仍可能异步落盘 content-scripts,settle 后再写 page-side

// 3. page-side IIFE --watch 写回(emptyOutDir:false，不动 crx 的输出)
const ps = spawn("node", [join("scripts", "build-page-side.mjs"), "--watch"], {
  stdio: "inherit",
  cwd: pkgRoot,
});
children.push(ps);
ps.on("exit", (code) => {
  console.error(`[dev] page-side watch 退出 (code=${code})`);
  shutdown(code ?? 0);
});

console.log(
  "[dev] vortex 扩展 dev loop 就绪 → chrome://extensions 加载/重载一次 dist。\n" +
  "      改 handler 自动 reload(改后 /mcp reconnect);改 page-side 下次调用自动生效。",
);
