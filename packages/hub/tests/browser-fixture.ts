import type { BrowserEntry } from "../src/registry.js";

export function makeBrowser(browserId: string, overrides: Partial<BrowserEntry> = {}): BrowserEntry {
  return {
    browserId,
    label: browserId,
    ws: undefined,
    peerVersion: "test",
    connectedAt: 1,
    lastSeenAt: 1,
    nmConnected: true,
    sessions: new Set(),
    tabOwner: new Map(),
    opener: new Map(),
    ...overrides,
  };
}

export function browserMap(...entries: BrowserEntry[]): ReadonlyMap<string, BrowserEntry> {
  return new Map(entries.map((entry) => [entry.browserId, entry]));
}
