import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { vi } from "vitest";

const bundles = new Map<string, Promise<string>>();
export function bundle(file: string): Promise<string> {
  let pending = bundles.get(file);
  if (!pending) {
    pending = build({
      configFile: false, logLevel: "silent",
      build: {
        write: false, emptyOutDir: false, minify: "esbuild", target: "chrome120",
        lib: { entry: fileURLToPath(new URL(`../../src/${file.replace(/\.js$/, ".ts")}`, import.meta.url)),
          formats: ["iife"], name: "vortexBrowserPageModule" },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    }).then((output) => {
      const result = (Array.isArray(output) ? output[0] : output) as Rollup.RollupOutput;
      return result.output.find((item): item is Rollup.OutputChunk => item.type === "chunk")!.code;
    });
    bundles.set(file, pending);
  }
  return pending;
}

// Opaque fixture IDs belong to real Documents, not URLs, Windows or frame slots.
// This bridges Playwright, not the native chrome.scripting/webNavigation APIs.
export function stubBrowserChrome(page: any): void {
  const identityKey = "__vortexBrowserDocumentId";
  const frameIds = new Map<any, number>([[page.mainFrame(), 0]]);
  const frames = new Map<number, any>();
  const getAllFrames = async () => Promise.all(page.frames().map(async (frame: any) => {
    if (!frameIds.has(frame)) frameIds.set(frame, frameIds.size);
    const frameId = frameIds.get(frame)!;
    frames.set(frameId, frame);
    const documentId = await frame.evaluate(({ key, candidate }: any) => {
      if (!Object.prototype.hasOwnProperty.call(document, key)) {
        Object.defineProperty(document, key, { value: candidate });
      }
      return (document as any)[key];
    }, { key: identityKey, candidate: randomUUID() });
    return { frameId, parentFrameId: frame.parentFrame() ? frameIds.get(frame.parentFrame())! : -1,
      url: frame.url(), documentId };
  }));
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { getAllFrames: vi.fn(getAllFrames) },
    scripting: { executeScript: vi.fn(async ({ target, func, args = [], files }: any) => {
      const rows = await getAllFrames();
      const targets = target.documentIds
        ? target.documentIds.map((id: string) => rows.find((row: any) => row.documentId === id))
        : (target.frameIds ?? [0]).map((id: number) => rows.find((row: any) => row.frameId === id));
      if (target.tabId !== 42 || targets.some((row: any) => !row)) throw new Error("Injection target document is unavailable");
      const sources = files ? await Promise.all(files.map(bundle)) : [`(${String(func)})`];
      return Promise.all(targets.map(async (row: any) => ({
        frameId: row.frameId, documentId: row.documentId,
        result: await frames.get(row.frameId).evaluate(({ key, documentId, sources, args, isFunction }: any) => {
          if ((document as any)[key] !== documentId) throw new Error("Injection target document changed");
          if (isFunction) return (0, eval)(sources[0])(...args);
          for (const source of sources) (0, eval)(source);
        }, { key: identityKey, documentId: row.documentId, sources, args, isFunction: !files }),
      })));
    }) },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: ["<all_urls>"] }) },
  });
}
