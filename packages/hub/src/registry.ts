import type { VtxRequest } from "@vortex-browser/shared";

export interface BrowserEntry {
  browserId: string;
  label: string;
  // 暂态字段：Step 3 引入 ws 依赖后再收窄为 WebSocket。
  ws: unknown;
  peerVersion: string;
  extensionVersion?: string;
  buildStamp?: string;
  extDist?: string;
  repoRoot?: string;
  connectedAt: number;
  lastSeenAt: number;
  nmConnected: boolean;
  sessions: Set<string>;
  tabOwner: Map<number, string>;
  opener: Map<number, { openerTabId: number; at: number }>;
}

export interface SessionEntry {
  sessionId: string;
  role: "mcp" | "cli";
  label: string;
  // 暂态字段：Step 3 引入 ws 依赖后再收窄为 WebSocket。
  ws: unknown;
  wireVersion: number;
  connectedAt: number;
  lastSeenAt: number;
  browserId: string | null;
  lastBrowserId: string | null;
  rebindUntil: number;
  buffer: VtxRequest[];
  ownedTabs: Set<number>;
  currentTabId: number | null;
  claiming: Promise<number> | null;
  pinned: boolean;
  strictTab: boolean;
}

/** 返回 null 表示当前无可用浏览器。纯函数，便于表驱动测试。 */
export function allocate(
  s: SessionEntry,
  browsers: ReadonlyMap<string, BrowserEntry>,
): string | null {
  // 显式 pin 且在线时不降级，避免静默跑错浏览器。
  if (s.pinned) return s.browserId && browsers.has(s.browserId) ? s.browserId : null;
  // 粘性绑定优先保持不动。
  if (s.browserId && browsers.has(s.browserId)) return s.browserId;
  // 原浏览器复归时优先恢复，保护 tab 状态。
  if (s.lastBrowserId && browsers.has(s.lastBrowserId)) return s.lastBrowserId;

  const cands = [...browsers.values()].filter((b) => b.nmConnected);
  if (cands.length === 0) return null;
  cands.sort(
    (a, b) =>
      a.sessions.size - b.sessions.size ||
      a.connectedAt - b.connectedAt ||
      (a.browserId < b.browserId ? -1 : 1),
  );
  return cands[0].browserId;
}
