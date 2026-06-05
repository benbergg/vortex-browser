/**
 * 向后兼容薄壳：install.sh 通过 `node dist/scripts/install-nm-host.js <id>` 调用此文件。
 * 实际逻辑已移至 src/install-nm-host.ts 中的 installNmHost()。
 */
import { installNmHost } from "../src/install-nm-host.js";

const extensionId = process.argv[2];

if (!extensionId) {
  console.error("Usage: install-nm-host <chrome-extension-id>");
  process.exit(1);
}

try {
  const r = installNmHost(extensionId);
  console.log(`NM host manifest written to: ${r.manifestPath}`);
  console.log(`NM host script: ${r.nativeHostPath}`);
} catch (e: any) {
  console.error(`install-nm-host failed: ${e.message}`);
  process.exit(1);
}
