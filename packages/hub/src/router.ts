/**
 * Author: qingwa
 * Description: Routes hub requests, pending failures, browser recovery, and events.
 */
import {
  VtxErrorCode,
  type VtxErrorPayload,
  type VtxEvent,
  type VtxFrameFromAgent,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import {
  allocate,
  type BrowserEntry,
  BrowserRegistry,
  type SessionEntry,
  SessionRegistry,
} from "./registry.js";
import { PendingTable, type HubPending } from "./pending.js";

export const REQUEST_TIMEOUT_MS = 30_000;
export const REBIND_GRACE_MS = 15_000;

export interface RouterOptions {
  sessions: SessionRegistry;
  browsers: BrowserRegistry;
  pending?: PendingTable;
  now?: () => number;
  sendToSession: (sessionId: string, frame: object) => void;
  sendToBrowser: (browserId: string, frame: object) => void;
}

interface LostBrowser {
  entry: BrowserEntry;
  expiresAt: number;
}

export class HubRouter {
  readonly pending: PendingTable;
  private readonly sessions: SessionRegistry;
  private readonly browsers: BrowserRegistry;
  private readonly now: () => number;
  private readonly sendToSession: RouterOptions["sendToSession"];
  private readonly sendToBrowser: RouterOptions["sendToBrowser"];
  private readonly lostBrowsers = new Map<string, LostBrowser>();
  private requestCounter = 0;

  constructor(options: RouterOptions) {
    this.sessions = options.sessions;
    this.browsers = options.browsers;
    this.pending = options.pending ?? new PendingTable();
    this.now = options.now ?? Date.now;
    this.sendToSession = options.sendToSession;
    this.sendToBrowser = options.sendToBrowser;
  }

  handleRequest(sessionId: string, request: VtxRequest): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const browserId = this.ensureBrowser(session, request);
    if (!browserId) return;
    const browser = this.browsers.get(browserId);
    if (!browser?.ws) {
      this.bufferOrFail(session, request);
      return;
    }

    const hubRequestId = `${session.sessionId}#${++this.requestCounter}`;
    const timeout = setTimeout(() => {
      const pending = this.pending.take(hubRequestId);
      pending?.fail(this.error(VtxErrorCode.TIMEOUT, `Request ${request.action} timed out`));
    }, REQUEST_TIMEOUT_MS);
    const pending: HubPending = {
      hubRequestId,
      sessionId,
      browserId,
      request,
      timeout,
      fail: (error) => this.sendResponse(sessionId, request, browserId, { error }),
    };
    this.pending.add(pending);
    this.sendToBrowser(browserId, {
      ...request,
      type: "request",
      id: hubRequestId,
      sessionId,
      browserId,
    });
  }

  handleAgentFrame(browserId: string, frame: VtxFrameFromAgent): void {
    if (frame.type === "response") {
      const pending = this.pending.take(frame.id);
      if (!pending) return;
      this.updateTabState(pending, frame);
      this.sendResponse(pending.sessionId, pending.request, browserId, {
        result: frame.result,
        error: frame.error,
      });
      return;
    }
    if (frame.type === "event") this.routeEvent(browserId, frame);
  }

  handleBrowserHeartbeat(browserId: string, nmConnected: boolean, timestamp: number): void {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    browser.nmConnected = nmConnected;
    browser.lastSeenAt = timestamp;
  }

  registerBrowser(entry: BrowserEntry): void {
    const lost = this.lostBrowsers.get(entry.browserId);
    const restored = lost && lost.expiresAt > this.now();
    const next = restored
      ? { ...lost.entry, ...entry, sessions: lost.entry.sessions, tabOwner: lost.entry.tabOwner, opener: lost.entry.opener }
      : entry;
    this.lostBrowsers.delete(entry.browserId);
    this.browsers.set(next);

    if (restored) {
      for (const sessionId of next.sessions) {
        const session = this.sessions.get(sessionId);
        if (!session || session.lastBrowserId !== entry.browserId) continue;
        this.bindSession(session, entry.browserId, false);
        this.sendToSession(sessionId, {
          type: "notice",
          notice: "browser-restored",
          browserId: entry.browserId,
          browserLabel: entry.label,
        });
        this.flushBuffer(session);
      }
    }
    this.assignWaitingSessions(entry.browserId);
  }

  unregisterBrowser(browserId: string, ws: BrowserEntry["ws"]): void {
    const browser = this.browsers.get(browserId);
    if (!browser || browser.ws !== ws) return;
    this.browsers.delete(browserId);
    const expiresAt = this.now() + REBIND_GRACE_MS;
    const snapshot: BrowserEntry = {
      ...browser,
      ws: undefined,
      sessions: new Set(browser.sessions),
      tabOwner: new Map(browser.tabOwner),
      opener: new Map(browser.opener),
    };
    this.lostBrowsers.set(browserId, { entry: snapshot, expiresAt });
    for (const session of this.sessions.values()) {
      if (session.browserId !== browserId) continue;
      session.browserId = null;
      session.lastBrowserId = browserId;
      session.rebindUntil = expiresAt;
      this.sendToSession(session.sessionId, {
        type: "notice",
        notice: "browser-lost",
        browserId,
        browserLabel: browser.label,
      });
    }
    this.pending.failBrowser(browserId, this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Browser agent disconnected"));
    setTimeout(() => this.expireBrowser(browserId, expiresAt), REBIND_GRACE_MS);
  }

  unregisterSession(sessionId: string, ws: SessionEntry["ws"]): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ws !== ws) return;
    this.pending.failSession(sessionId, this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session disconnected"));
    if (session.browserId) this.browsers.get(session.browserId)?.sessions.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  assignSession(session: SessionEntry, notify = true): string | null {
    const browserId = allocate(session, this.browsers);
    if (!browserId) return null;
    this.bindSession(session, browserId, notify);
    return browserId;
  }

  routeEvent(browserId: string, event: VtxEvent): void {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    const stamped = { ...event, type: "event", browserId };
    if (event.tabId != null) {
      const owner = browser.tabOwner.get(event.tabId);
      if (owner && this.sessions.has(owner)) {
        this.sendToSession(owner, stamped);
        return;
      }
      for (const sessionId of browser.sessions) {
        this.sendToSession(sessionId, { ...stamped, unowned: true });
      }
      return;
    }
    for (const sessionId of browser.sessions) this.sendToSession(sessionId, stamped);
  }

  private ensureBrowser(session: SessionEntry, request: VtxRequest): string | null {
    if (session.browserId) return session.browserId;
    if (session.rebindUntil > this.now()) {
      this.bufferOrFail(session, request);
      return null;
    }
    return this.assignSession(session);
  }

  private bindSession(session: SessionEntry, browserId: string, notify: boolean): void {
    if (session.browserId && session.browserId !== browserId) {
      this.browsers.get(session.browserId)?.sessions.delete(session.sessionId);
    }
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    session.browserId = browserId;
    session.lastBrowserId = browserId;
    session.rebindUntil = 0;
    browser.sessions.add(session.sessionId);
    if (notify) {
      this.sendToSession(session.sessionId, {
        type: "notice",
        notice: "browser-assigned",
        browserId,
        browserLabel: browser.label,
      });
    }
  }

  private assignWaitingSessions(browserId: string): void {
    for (const session of this.sessions.values()) {
      if (session.browserId) continue;
      if (session.rebindUntil > this.now() && session.lastBrowserId !== browserId) continue;
      if (this.assignSession(session)) this.flushBuffer(session);
    }
  }

  private flushBuffer(session: SessionEntry): void {
    const queued = session.buffer.splice(0);
    for (const request of queued) this.handleRequest(session.sessionId, request);
  }

  private bufferOrFail(session: SessionEntry, request: VtxRequest): void {
    if (session.rebindUntil > this.now() && session.buffer.length < 32) {
      session.buffer.push(request);
      return;
    }
    this.sendResponse(session.sessionId, request, session.browserId ?? "", {
      error: this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "No browser agent is available"),
    });
  }

  private expireBrowser(browserId: string, expiresAt: number): void {
    const lost = this.lostBrowsers.get(browserId);
    if (!lost || lost.expiresAt !== expiresAt || expiresAt > this.now()) return;
    this.lostBrowsers.delete(browserId);
    for (const session of this.sessions.values()) {
      if (session.lastBrowserId !== browserId || session.rebindUntil > this.now()) continue;
      session.lastBrowserId = null;
      session.rebindUntil = 0;
      session.ownedTabs.clear();
      session.currentTabId = null;
      this.assignSession(session);
      this.flushBuffer(session);
    }
  }

  private updateTabState(pending: HubPending, response: VtxResponse): void {
    const session = this.sessions.get(pending.sessionId);
    const browser = this.browsers.get(pending.browserId);
    if (!session || !browser || response.error) return;
    const result = response.result as { id?: unknown; tabId?: unknown } | undefined;
    const tabId = typeof result?.id === "number" ? result.id : typeof result?.tabId === "number" ? result.tabId : undefined;
    if (pending.request.action === "tab.create" && tabId !== undefined) {
      session.currentTabId = tabId;
      session.ownedTabs.add(tabId);
      browser.tabOwner.set(tabId, session.sessionId);
    }
    if (pending.request.action === "tab.close") {
      const closedId = typeof pending.request.params?.tabId === "number" ? pending.request.params.tabId : pending.request.tabId;
      if (closedId !== undefined) {
        session.ownedTabs.delete(closedId);
        browser.tabOwner.delete(closedId);
        if (session.currentTabId === closedId) session.currentTabId = null;
      }
    }
  }

  private sendResponse(
    sessionId: string,
    request: VtxRequest,
    browserId: string,
    payload: { result?: unknown; error?: VtxErrorPayload },
  ): void {
    this.sendToSession(sessionId, {
      type: "response",
      action: request.action,
      id: request.id,
      ...payload,
      sessionId,
      browserId,
    });
  }

  private error(code: VtxErrorCode, message: string): VtxErrorPayload {
    return { code, message, recoverable: code !== VtxErrorCode.TIMEOUT };
  }
}
