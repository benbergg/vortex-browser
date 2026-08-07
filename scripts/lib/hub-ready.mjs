/**
 * Author: qingwa
 * Description: Selects a browser that proves the dev-all worktree is ready.
 */
export function pickReadyBrowser(health, extDist) {
  if (!isRecord(health) || !Array.isArray(health.browsers)) return null;
  return health.browsers.find((browser) =>
    isRecord(browser) && browser.nmConnected === true && browser.extDist === extDist,
  ) ?? null;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
