/**
 * Description: Runs only the real-Chromium browser tests, serially.
 * Mirrors vitest.config.ts's shared-source alias so they resolve identically.
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
    include: ["**/*.browser.test.ts"],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
