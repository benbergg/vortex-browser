#!/usr/bin/env node
// Build page-side IIFE bundles via vite programmatic API.
//
// Design constraints:
// - IIFE format: required for chrome.scripting.executeScript({ files }) injection
// - configFile: false → isolates from the crx plugin (which would enable code-splitting
//   and break IIFE output format)
// - emptyOutDir: false → does not wipe main bundle outputs (dist/manifest.json / dist/src/* etc.)
// - outDir: dist/page-side/ → subdir under shared dist/
// - world: MAIN → bundles attach globals to window.*, consistent with PR #1 pageQuery
// - Each entry built independently (rollup does not support IIFE with multiple inputs)

import { build } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

const entries = [
  { name: "actionability", entry: "src/page-side/actionability.ts" },
  { name: "fill-reject", entry: "src/page-side/fill-reject.ts" },
  { name: "commit-checkbox-group", entry: "src/page-side/commit-drivers/checkbox-group.ts" },
  { name: "commit-select", entry: "src/page-side/commit-drivers/select.ts" },
  { name: "commit-aria-select", entry: "src/page-side/commit-drivers/aria-select.ts" },
  { name: "dom-resolve", entry: "src/page-side/dom-resolve.ts" },
];

// --watch:dev loop 用。vite build.watch 返回 RollupWatcher，源文件变化自动重建
// 单个 IIFE 到 dist/page-side/<name>.js（executeScript 下次调用即取新，无需扩展 reload）。
const watch = process.argv.includes("--watch");

for (const { name, entry } of entries) {
  console.log(`[page-side] building ${name}...`);
  await build({
    // Use isolated config — do NOT load vite.config.ts (which has crx plugin causing code-splitting)
    configFile: false,
    root: pkgRoot,
    logLevel: "warn",
    build: {
      watch: watch ? {} : null,
      lib: {
        entry: resolve(pkgRoot, entry),
        formats: ["iife"],
        name: `vortexPageSide_${name.replace(/-/g, "_")}`,
        fileName: () => `page-side/${name}.js`,
      },
      outDir: resolve(pkgRoot, "dist"),
      emptyOutDir: false,
      minify: "esbuild",
      sourcemap: false,
      target: "chrome120",
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
  console.log(`[page-side] ${watch ? "watching" : "built"} dist/page-side/${name}.js`);
}

console.log(watch
  ? "[page-side] all bundles built; watching for changes."
  : "[page-side] all bundles built successfully.");
