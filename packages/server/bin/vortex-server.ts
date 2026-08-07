#!/usr/bin/env node
import { join } from "path";
import { startServer } from "../src/index.js";
import { installNmHost, parseInstallArgs } from "../src/install-nm-host.js";

// ─────────────────────────────────────────────────────────────────────────────
// install 子命令：手动 argv 检测，不用 commander subcommand。
// 原因：Chrome Native Messaging 启动时会把 chrome-extension://<id>/ 作为位置参数
// 追加进 argv，若用 commander .command('install') 可能把未知位置参数当未知命令报错。
// 手动检测可精确匹配 "install" 字符串，chrome-extension:// 开头的参数自然跳过。
// ─────────────────────────────────────────────────────────────────────────────
if (process.argv[2] === "install") {
  // 不带 ID 时用 manifest 钉死 key 对应的默认扩展 ID(方案 B),无需用户复制粘贴。
  // 仅当加载的扩展 ID 不同(如商店分发改了 key)才需显式 `install <id>` 覆盖。
  const { extensionId, usingDefault, allChannels } = parseInstallArgs(process.argv);
  try {
    const r = installNmHost(extensionId, { allChannels });
    if (allChannels && r.installed.length === 0) {
      console.error("install failed: no Chromium-based browser found");
      process.exit(1);
    }
    console.log(`✓ Native messaging host registered: ${r.hostName}`);
    console.log(`  extension id: ${extensionId}${usingDefault ? " (default, pinned)" : ""}`);
    for (const c of r.installed) {
      console.log(`  ${c.label}: ${join(c.nmDir, `${r.hostName}.json`)}`);
    }
    console.log(`  host script: ${r.nativeHostPath}`);
    if (!allChannels) {
      console.log(`\nOther browsers (Edge, Canary, Chromium): re-run with --all-channels`);
    }
    console.log(`\nReload the Vortex extension in chrome://extensions to connect.`);
    process.exit(0);
  } catch (e: any) {
    console.error(`install failed: ${e.message}`);
    process.exit(1);
  }
}

try {
  startServer();
} catch (err: any) {
  console.error(`[vortex-server] startup error: ${err.message}`);
  process.exit(1);
}
