import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "./manifest.json";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// 每次 `vite build` 一个新的构建戳(config 求值一次/进程)。dev-reload 据此验证
// 「chrome.runtime.reload() 后扩展确实换到了新 dist」——戳变了即新代码生效。
// 注:Date.now() 在 build 期(非运行期)调用,无运行期约束。
const BUILD_STAMP = `${pkg.version}+${Date.now().toString(36)}`;

/** 把构建戳同步写到 dist/build-stamp.txt,供 vortex-server 读作 targetStamp(C1 路径锚)。 */
function buildStampFile(stamp: string): Plugin {
  return {
    name: "vortex-build-stamp",
    apply: "build",
    writeBundle(options) {
      const dir = options.dir ?? "dist";
      writeFileSync(resolve(dir, "build-stamp.txt"), stamp, "utf-8");
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest: { ...manifest, version: pkg.version } }), buildStampFile(BUILD_STAMP)],
  define: {
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
    __VORTEX_BUILD__: JSON.stringify(BUILD_STAMP),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
