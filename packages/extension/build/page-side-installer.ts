import { fileURLToPath } from "node:url";
import { build, type Plugin, type Rollup } from "vite";

const moduleId = "virtual:vortex-dom-resolve-installer";

// executeScript serializes only the function body: keep the entire real bundle inside it.
export function pageSideInstaller(): Plugin {
  return {
    name: "vortex-page-side-installer",
    resolveId(id) {
      if (id === moduleId) return "\0" + moduleId;
    },
    async load(id) {
      if (id !== "\0" + moduleId) return;
      const output = await build({
        configFile: false,
        logLevel: "silent",
        plugins: [{
          name: "vortex-installer-inputs",
          moduleParsed: (info) => { this.addWatchFile(info.id); },
        }],
        build: {
          write: false,
          lib: {
            entry: fileURLToPath(new URL("../src/page-side/dom-resolve-owned.ts", import.meta.url)),
            formats: ["iife"],
            name: "vortexOwnedDomResolve",
          },
          emptyOutDir: false,
          minify: "esbuild",
          sourcemap: false,
          target: "chrome120",
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      });
      const result = (Array.isArray(output) ? output[0] : output) as Rollup.RollupOutput;
      const chunk = result.output.find((item): item is Rollup.OutputChunk => item.type === "chunk")!;
      return `export function installDomResolveForScan(request) {
${chunk.code}
return vortexOwnedDomResolve.installOwnedDomResolve(request);
}`;
    },
  };
}
