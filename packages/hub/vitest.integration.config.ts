/**
 * Description: Runs only the process-spawning integration tests, serially.
 * Mirrors vitest.config.ts's shared-source alias so they resolve identically.
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
    include: ["**/*.integration.test.ts"],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 60000,
  },
});
