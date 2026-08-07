/**
 * Author: qingwa
 * Description: Resolves the workspace shared source during hub tests without a build.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vortex-browser/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    // spawn 真子进程的用例改由 test:integration 单独跑
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
