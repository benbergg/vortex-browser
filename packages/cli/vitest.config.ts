/**
 * Author: qingwa
 * Description: Resolves the workspace shared source during CLI tests without a build.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vortex-browser/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
});
