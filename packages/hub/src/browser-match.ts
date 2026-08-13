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

function onlineLabels(browsers: BrowserMapLike): string[] {
  return [...new Set(
    [...browsers.values()].filter((browser) => browser.nmConnected).map((browser) => browser.label),
  )].sort();
}

export function noBrowserMessage(pref: string | null, browsers: BrowserMapLike): string {
  // 无偏好时能走到这里就说明没有可用浏览器
  if (!pref) return "No browser is connected to the hub";
  const online = onlineLabels(browsers);
  const tail = online.length > 0
    ? `online: ${online.join(", ")}`
    : "no browser is connected to the hub";
  return `No browser matching "${pref}"; ${tail}`;
}

/**
 * 偏好匹配不上、但别的浏览器连着时的对症 hint。
 * 表里的 EXTENSION_NOT_CONNECTED hint 让人去查扩展是否启用，而扩展就连着，
 * 该做的是换 browser 参数或启动目标浏览器（2026-08-13 日志 3/60 次）。
 * 返回 undefined = 真的没有浏览器在线，此时表文案本就正确。
 */
export function noBrowserHint(pref: string | null, browsers: BrowserMapLike): string | undefined {
  if (!pref) return undefined;
  const online = onlineLabels(browsers);
  if (online.length === 0) return undefined;
  // 在线浏览器可能很多，hint 超长会挤掉后半句的可执行指引
  const shown = online.slice(0, 3).join(", ") + (online.length > 3 ? ", …" : "");
  return `The extension is connected, but no browser matches "${pref}". ` +
    `Call vortex_browser with one of the online labels (${shown}), ` +
    "or start the requested browser and retry. Set VORTEX_BROWSER to pin a default.";
}
