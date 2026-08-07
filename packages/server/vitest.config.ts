/**
 * Author: qingwa
 * Description: Resolves workspace sources during browser-agent tests without a build.
 */
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@vortex-browser/hub/paths": fileURLToPath(new URL("../hub/src/paths.ts", import.meta.url)),
      "@vortex-browser/hub/spawn": fileURLToPath(new URL("../hub/src/spawn.ts", import.meta.url)),
      "@vortex-browser/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
});
