/**
 * Author: qingwa
 * Description: Resolves a browser preference string to a registered browser.
 */
import type { BrowserEntry, BrowserMapLike } from "./registry.js";

export function compareBrowsers(a: BrowserEntry, b: BrowserEntry): number {
  return (
    a.sessions.size - b.sessions.size ||
    a.connectedAt - b.connectedAt ||
    (a.browserId < b.browserId ? -1 : 1)
  );
}

/** 只要求浏览器在册：NM 瞬时断流时仍命中，让请求走缓冲而非立刻失败。 */
export function matchBrowser(pref: string, browsers: BrowserMapLike): BrowserEntry | null {
  const needle = pref.trim().toLowerCase();
  if (needle.length === 0) return null;

  const all = [...browsers.values()];
  const exactId = all.find((browser) => browser.browserId === pref.trim());
  if (exactId) return exactId;

  const byLabel = all.filter((browser) => browser.label.toLowerCase() === needle);
  const candidates = byLabel.length > 0
    ? byLabel
    : all.filter((browser) => browser.label.toLowerCase().includes(needle));
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareBrowsers)[0];
}

export function noBrowserMessage(pref: string | null, browsers: BrowserMapLike): string {
  // 无偏好时能走到这里就说明没有可用浏览器
  if (!pref) return "No browser is connected to the hub";
  const online = [...new Set(
    [...browsers.values()].filter((browser) => browser.nmConnected).map((browser) => browser.label),
  )].sort();
  const tail = online.length > 0
    ? `online: ${online.join(", ")}`
    : "no browser is connected to the hub";
  return `No browser matching "${pref}"; ${tail}`;
}
