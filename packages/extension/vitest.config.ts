/**
 * Author: qingwa
 * Description: Resolves the workspace shared source during extension tests without a build.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";
import { pageSideInstaller } from "./build/page-side-installer.js";

export default defineConfig({
  plugins: [pageSideInstaller()],
  resolve: {
    alias: {
      "@vortex-browser/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // 真 Chromium 用例需要 PLAYWRIGHT_PATH / CHROME_PATH,默认 `test` 不收它们:
    // 缺环境时它们必须在独立入口里硬失败,而不是在默认收集阶段炸掉或静默跳过。
    exclude: [...configDefaults.exclude, "**/*.browser.test.ts"],
  },
});
