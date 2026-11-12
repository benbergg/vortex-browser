import { randomUUID } from "node:crypto";
import type { JSDOM } from "jsdom";
import { vi } from "vitest";
import { bundle } from "./chromium-chrome.js";

export function stubDocumentChrome(
  frames: Array<{ frameId: number; parentFrameId: number; dom: JSDOM; url?: string }>,
  hostPermissions = ["<all_urls>"],
) {
  const rows = frames.map(({ dom, ...frame }) => {
    const win = dom.window as any;
    win.CSS ??= globalThis.CSS ?? { escape: (value: string) => value };
    if (!Object.prototype.hasOwnProperty.call(win.document, "__vortexBrowserDocumentId")) {
      Object.defineProperty(win.document, "__vortexBrowserDocumentId", { value: randomUUID() });
    }
    return { ...frame, url: frame.url ?? win.location.href, documentId: win.document.__vortexBrowserDocumentId, win };
  });
  const executeScript = vi.fn(async ({ target, func, args = [], files }: any) => {
    const selected = target.documentIds
      ? target.documentIds.map((id: string) => rows.find((row) => row.documentId === id))
      : target.allFrames ? rows : (target.frameIds ?? [0]).map((id: number) => rows.find((row) => row.frameId === id));
    if (target.tabId !== 42 || selected.some((row: any) => !row)) throw new Error("Injection target document is unavailable");
    const sources = files ? await Promise.all(files.map(bundle)) : [`(${String(func)})`];
    return Promise.all(selected.map(async (row: typeof rows[number]) => {
      if (row.win.document.__vortexBrowserDocumentId !== row.documentId) throw new Error("Injection target document changed");
      const result = files ? sources.forEach((source: string) => row.win.eval(source))
        : await row.win.eval(sources[0])(...structuredClone(args));
      return { frameId: row.frameId, documentId: row.documentId, result };
    }));
  });
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
    webNavigation: { getAllFrames: vi.fn().mockResolvedValue(rows.map(({ win: _win, ...frame }) => frame)) },
    scripting: { executeScript },
    runtime: { getManifest: vi.fn().mockReturnValue({ host_permissions: hostPermissions }) },
  });
  return { executeScript, frames: rows };
}
