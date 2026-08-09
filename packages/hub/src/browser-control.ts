import type { BrowserMapLike, SessionEntry } from "./registry.js";

export const BROWSER_CONTROL_ACTIONS = new Set(["browser.list", "browser.select"]);

export function listBrowsers(
  browsers: BrowserMapLike,
  session: SessionEntry,
): { current: string | null; browsers: string[] } {
  const online = [...browsers.values()].filter((browser) => browser.nmConnected);
  const current = online.find((browser) => browser.browserId === session.browserId);
  return {
    current: current?.label ?? null,
    browsers: [...new Set(online.map((browser) => browser.label))].sort(),
  };
}
