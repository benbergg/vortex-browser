/**
 * Author: qingwa
 * Description: Creates and reclaims in-memory CLI sessions for hub transports.
 */
import { VTX_WIRE_VERSION } from "@vortex-browser/shared";
import { type SessionEntry, SessionRegistry } from "./registry.js";

export interface VirtualSessionDeps {
  sessions: SessionRegistry;
  now: () => number;
}

export function getOrCreateVirtualSession(
  deps: VirtualSessionDeps,
  name: string,
): SessionEntry {
  const existing = deps.sessions.get(name);
  if (existing) {
    existing.lastSeenAt = deps.now();
    return existing;
  }

  const timestamp = deps.now();
  const session: SessionEntry = {
    sessionId: name,
    role: "cli",
    label: name,
    ws: null,
    wireVersion: VTX_WIRE_VERSION,
    connectedAt: timestamp,
    lastSeenAt: timestamp,
    browserId: null,
    lastBrowserId: null,
    rebindUntil: 0,
    buffer: [],
    ownedTabs: new Set(),
    currentTabId: null,
    claiming: null,
    pinned: false,
    strictTab: process.env.VORTEX_STRICT_TAB === "1",
  };
  deps.sessions.set(session);
  return session;
}

export function sweepIdleVirtualSessions(
  deps: VirtualSessionDeps,
  idleMs: number,
  hasPending: (sessionId: string) => boolean,
  onRemove?: (session: SessionEntry) => void,
): string[] {
  const now = deps.now();
  const removed: string[] = [];
  for (const [sessionId, session] of deps.sessions.entries()) {
    if (session.ws !== null || now - session.lastSeenAt <= idleMs || hasPending(sessionId)) continue;
    if (!deps.sessions.delete(sessionId)) continue;
    onRemove?.(session);
    removed.push(sessionId);
  }
  return removed;
}
