export interface HealthBrowser {
  label: string;
  browserId: string;
  nmConnected: boolean;
}

export function pickOtherBrowsers(
  health: { browsers?: HealthBrowser[] },
  currentBrowserId: string | undefined,
): string[] {
  const others = (health.browsers ?? [])
    .filter((browser) => browser.nmConnected && browser.browserId !== currentBrowserId)
    .map((browser) => browser.label);
  return [...new Set(others)].sort();
}
