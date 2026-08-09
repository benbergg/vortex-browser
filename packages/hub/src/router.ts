/**
 * Author: qingwa
 * Description: Routes hub requests, pending failures, browser recovery, and events.
 */
import {
  VtxErrorCode,
  VtxEventType,
  vtxError,
  type VtxAgentCommand,
  type VtxAgentResult,
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
import { prepareRequestWithState } from "./tab-ownership.js";

export const REQUEST_TIMEOUT_MS = 30_000;
export const REBIND_GRACE_MS = 15_000;

interface InternalPending {
  browserId: string;
  sessionId: string;
  resolve: (response: VtxResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AgentCommandPending {
  browserId: string;
  resolve: (result: VtxAgentResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class InternalRequestTimeoutError extends Error {
  constructor(action: string) {
    super(`Internal request ${action} timed out`);
    this.name = "InternalRequestTimeoutError";
  }
}

export interface RouterOptions {
  sessions: SessionRegistry;
  browsers: BrowserRegistry;
  pending?: PendingTable;
  now?: () => number;
  requestTimeoutMs?: number;
  onWarn?: (message: string, details: object) => void;
  sendToSession: (sessionId: string, frame: object) => void;
  sendToBrowser: (browserId: string, frame: object) => boolean;
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
  private readonly requestTimeoutMs: number;
  private readonly onWarn: NonNullable<RouterOptions["onWarn"]>;
  private readonly sendToSession: RouterOptions["sendToSession"];
  private readonly sendToBrowser: RouterOptions["sendToBrowser"];
  private readonly lostBrowsers = new Map<string, LostBrowser>();
  private readonly internalPending = new Map<string, InternalPending>();
  private readonly agentCommandPending = new Map<string, AgentCommandPending>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private requestCounter = 0;
  private internalRequestCounter = 0;
  private agentCommandCounter = 0;
  private acceptingRequests = true;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: RouterOptions) {
    this.sessions = options.sessions;
    this.browsers = options.browsers;
    this.pending = options.pending ?? new PendingTable();
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.onWarn = options.onWarn ?? ((message, details) => {
      console.warn(`[hub] ${message}`, details);
    });
    this.sendToSession = options.sendToSession;
    this.sendToBrowser = options.sendToBrowser;
  }

  handleRequest(sessionId: string, request: VtxRequest): void {
    if (!this.acceptingRequests) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sendResponse(sessionId, request, session.browserId ?? "", {
          error: this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down"),
        });
      }
      return;
    }
    void this.track(this.forwardRequest(sessionId, request));
  }

  sendAgentCommand(
    browserId: string,
    command: VtxAgentCommand["command"],
    reason?: string,
  ): Promise<VtxAgentResult> {
    if (!this.acceptingRequests) return Promise.reject(new Error("Hub is shutting down"));
    if (!this.browsers.get(browserId)?.ws) {
      return Promise.reject(new Error("Browser agent is unavailable"));
    }
    if (this.requestTimeoutMs <= 0) {
      return Promise.reject(new Error(`Agent command ${command} timed out`));
    }

    const id = `agent-command-${++this.agentCommandCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.agentCommandPending.delete(id);
        reject(new Error(`Agent command ${command} timed out`));
      }, this.requestTimeoutMs);
      this.agentCommandPending.set(id, { browserId, resolve, reject, timeout });
      try {
        const sent = this.sendToBrowser(browserId, {
          type: "agent-command",
          id,
          command,
          ...(reason !== undefined ? { reason } : {}),
        } satisfies VtxAgentCommand);
        if (!sent) {
          this.agentCommandPending.delete(id);
          clearTimeout(timeout);
          reject(new Error("Browser agent is unavailable"));
        }
      } catch (error: unknown) {
        this.agentCommandPending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  beginShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingRequests = false;
    const error = this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down");
    for (const session of this.sessions.values()) {
      const buffered = session.buffer.splice(0);
      for (const request of buffered) {
        this.sendResponse(session.sessionId, request, session.browserId ?? "", { error });
      }
    }
    this.failAllInternal(new InternalRequestTimeoutError("hub shutdown"));
    this.failAllAgentCommands(new Error("Hub is shutting down"));
    this.shutdownPromise = this.waitForInFlight();
    return this.shutdownPromise;
  }

  private async forwardRequest(
    sessionId: string,
    request: VtxRequest,
    retryCount = 0,
    deadline = this.now() + this.requestTimeoutMs,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!this.acceptingRequests) {
      this.sendResponse(sessionId, request, session.browserId ?? "", {
        error: this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down"),
      });
      return;
    }
    const browserId = this.ensureBrowser(session, request);
    if (!browserId) return;
    const browser = this.browsers.get(browserId);
    if (!browser?.ws) {
      this.bufferOrFail(session, request);
      return;
    }

    let prepared: VtxRequest = request;
    let needsTabResolution = false;
    let tabIdBackfilledByHub = false;
    try {
      const preparation = await prepareRequestWithState(
        session,
        browser,
        request,
        (internalRequest) => this.callBrowser(
          browserId,
          sessionId,
          internalRequest,
          Math.max(0, deadline - this.now()),
        ),
        (error) => error instanceof InternalRequestTimeoutError && deadline > this.now(),
        () => this.browsers.get(browserId) === browser,
      );
      prepared = preparation.request;
      needsTabResolution = preparation.needsTabResolution;
      tabIdBackfilledByHub = preparation.tabIdBackfilledByHub;
    } catch (error: unknown) {
      if (!this.acceptingRequests) {
        if (this.sessions.has(sessionId)) {
          this.sendResponse(sessionId, request, browserId, {
            error: this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down"),
          });
        }
        return;
      }
      if (!this.sessions.has(sessionId)) return;
      if (!this.browsers.get(browserId)?.ws) {
        if (session.browserId === null && session.lastBrowserId === browserId) {
          this.bufferOrFail(session, request);
          return;
        }
        this.failBindingMismatch(sessionId, browserId, request);
        return;
      }
      if (!this.isBoundToBrowser(session, browserId, browser)) {
        this.failBindingMismatch(sessionId, browserId, request);
        return;
      }
      this.failTabResolution(sessionId, browserId, request, error);
      return;
    }
    if (!this.isBoundToBrowser(session, browserId, browser)) {
      this.failBindingMismatch(sessionId, browserId, request);
      return;
    }
    if (!this.acceptingRequests) {
      if (this.sessions.has(sessionId)) {
        this.sendResponse(sessionId, request, browserId, {
          error: this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down"),
        });
      }
      return;
    }
    if (needsTabResolution && deadline <= this.now()) {
      if (!this.sessions.has(sessionId)) return;
      this.failTabResolution(
        sessionId,
        browserId,
        request,
        new InternalRequestTimeoutError(request.action),
      );
      return;
    }
    if (deadline <= this.now()) {
      if (!this.sessions.has(sessionId)) return;
      this.sendResponse(sessionId, request, browserId, {
        error: this.error(VtxErrorCode.TIMEOUT, `Request ${request.action} timed out`),
      });
      return;
    }
    if (prepared.strictTab === undefined && session.strictTab) {
      prepared = { ...prepared, strictTab: true };
    }
    if (request.tabId != null) this.adoptExplicitTab(session, browser, request.tabId);

    const hubRequestId = `${session.sessionId}#${++this.requestCounter}`;
    const timeout = setTimeout(() => {
      const pending = this.pending.take(hubRequestId);
      pending?.fail(this.error(VtxErrorCode.TIMEOUT, `Request ${request.action} timed out`));
    }, Math.max(0, deadline - this.now()));
    const pending: HubPending = {
      hubRequestId,
      sessionId,
      browserId,
      request: prepared,
      timeout,
      retryCount,
      deadline,
      tabIdBackfilledByHub,
      fail: (error) => this.sendResponse(sessionId, prepared, browserId, { error }),
    };
    this.pending.add(pending);
    this.sendToBrowser(browserId, {
      ...prepared,
      type: "request",
      id: hubRequestId,
      sessionId,
      browserId,
    });
  }

  handleAgentFrame(browserId: string, frame: VtxFrameFromAgent, ws?: BrowserEntry["ws"]): void {
    if (ws !== undefined && this.browsers.get(browserId)?.ws !== ws) return;
    if (frame.type === "agent-result") {
      const pending = this.agentCommandPending.get(frame.id);
      if (!pending || pending.browserId !== browserId) return;
      this.agentCommandPending.delete(frame.id);
      clearTimeout(pending.timeout);
      pending.resolve(frame);
      return;
    }
    if (frame.type === "response") {
      const internal = this.internalPending.get(frame.id);
      if (internal) {
        this.internalPending.delete(frame.id);
        clearTimeout(internal.timeout);
        if (frame.error) internal.reject(new Error(frame.error.message));
        else internal.resolve({ action: frame.action, id: frame.id, result: frame.result });
        return;
      }
      const pending = this.pending.take(frame.id);
      if (!pending) return;
      if (this.shouldHealTab(pending, frame)) {
        if (!this.acceptingRequests) {
          pending.fail(this.error(VtxErrorCode.TIMEOUT, "Hub is shutting down"));
          return;
        }
        void this.track(this.healTab(pending));
        return;
      }
      this.updateTabState(pending, frame);
      this.sendResponse(pending.sessionId, pending.request, browserId, {
        result: pending.request.action === "tab.list"
          ? this.annotateTabList(pending.sessionId, browserId, frame.result, pending.request)
          : frame.result,
        error: frame.error,
      });
      return;
    }
    if (frame.type === "event") {
      this.updateOwnershipFromEvent(browserId, frame);
      this.routeEvent(browserId, frame);
    }
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

  failAgentCommandsOnReconnect(browserId: string, ws: BrowserEntry["ws"]): void {
    if (this.browsers.get(browserId)?.ws !== ws) return;
    this.failAgentCommands(browserId, new Error("Browser agent disconnected"));
    const error = this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Browser agent replaced");
    this.pending.failBrowser(browserId, error);
    this.failInternal(browserId, new Error(error.message));
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
    this.failInternal(browserId, new Error("Browser agent disconnected"));
    this.failAgentCommands(browserId, new Error("Browser agent disconnected"));
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
    // HTTP 建的会话只是被 --follow 借用了一条 socket，断开不该连 currentTab 一起带走
    if (session.virtual) {
      session.ws = null;
      session.lastSeenAt = this.now();
      return;
    }
    this.failInternalForSession(sessionId, new Error("Session disconnected"));
    this.pending.failSession(sessionId, this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session disconnected"));
    if (session.browserId) {
      const browser = this.browsers.get(session.browserId);
      browser?.sessions.delete(sessionId);
      if (browser) {
        for (const tabId of session.ownedTabs) {
          if (browser.tabOwner.get(tabId) === sessionId) browser.tabOwner.delete(tabId);
        }
      }
    }
    this.sessions.delete(sessionId);
  }

  assignSession(session: SessionEntry, notify = true): string | null {
    const browserId = allocate(session, this.browsers);
    if (!browserId) return null;
    this.bindSession(session, browserId, notify);
    return browserId;
  }

  hasPendingForSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return this.pending.countBySession(sessionId) > 0 ||
      [...this.internalPending.values()].some((pending) => pending.sessionId === sessionId) ||
      (session?.buffer.length ?? 0) > 0 ||
      session?.claiming != null;
  }

  cleanupSession(session: SessionEntry): void {
    const cleanupError = this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Virtual session was collected");
    this.pending.failSession(session.sessionId, cleanupError);
    this.failInternalForSession(session.sessionId, new Error(cleanupError.message));
    session.claiming = null;
    session.buffer.splice(0);
    this.clearSessionBinding(session);
    session.sink = undefined;
  }

  rebindSession(session: SessionEntry, browserId: string, notify = false): string | null {
    if (
      session.browserId === browserId &&
      session.lastBrowserId === browserId &&
      this.browsers.get(browserId)?.sessions.has(session.sessionId)
    ) {
      return browserId;
    }
    const rebindError = this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session browser binding changed");
    this.pending.failSession(session.sessionId, rebindError);
    this.failInternalForSession(session.sessionId, new Error(rebindError.message));
    session.claiming = null;
    this.clearSessionBinding(session, browserId);
    session.browserId = browserId;
    session.lastBrowserId = browserId;
    session.rebindUntil = 0;
    const browser = this.browsers.get(browserId);
    if (!browser) return null;
    browser.sessions.add(session.sessionId);
    if (notify) {
      this.sendToSession(session.sessionId, {
        type: "notice",
        notice: "browser-assigned",
        browserId: browser.browserId,
        browserLabel: browser.label,
      });
    }
    this.flushBuffer(session);
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
    // 只认还在册的绑定；指向已消失的 browserId 时必须放行到重新分配，否则该 session 永久 503
    if (session.browserId && this.browsers.has(session.browserId)) return session.browserId;
    if (session.rebindUntil > this.now()) {
      this.bufferOrFail(session, request);
      return null;
    }
    const browserId = this.assignSession(session);
    if (browserId) return browserId;
    this.sendResponse(session.sessionId, request, "", {
      error: this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "No browser agent is available"),
    });
    return null;
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

  // 清理会话绑定及其 tab ownership
  clearSessionBinding(session: SessionEntry, targetBrowserId?: string): void {
    const browserIds = new Set<string>();
    if (session.browserId) browserIds.add(session.browserId);
    if (session.lastBrowserId) browserIds.add(session.lastBrowserId);
    if (targetBrowserId) browserIds.add(targetBrowserId);
    for (const browserId of browserIds) {
      const browser = this.browsers.get(browserId);
      if (!browser) continue;
      browser.sessions.delete(session.sessionId);
      const ownedTabIds = new Set<number>();
      if (browserId === session.browserId || browserId === session.lastBrowserId) {
        for (const tabId of session.ownedTabs) ownedTabIds.add(tabId);
      }
      for (const [tabId, ownerSessionId] of browser.tabOwner) {
        if (ownerSessionId !== session.sessionId) continue;
        ownedTabIds.add(tabId);
        browser.tabOwner.delete(tabId);
      }
      for (const [tabId, relation] of browser.opener) {
        if (ownedTabIds.has(tabId) || ownedTabIds.has(relation.openerTabId)) browser.opener.delete(tabId);
      }
    }
    for (const browserId of browserIds) {
      const lost = this.lostBrowsers.get(browserId);
      if (!lost) continue;
      lost.entry.sessions.delete(session.sessionId);
      const ownedTabIds = new Set<number>();
      if (browserId === session.browserId || browserId === session.lastBrowserId) {
        for (const tabId of session.ownedTabs) ownedTabIds.add(tabId);
      }
      for (const [tabId, ownerSessionId] of lost.entry.tabOwner) {
        if (ownerSessionId !== session.sessionId) continue;
        ownedTabIds.add(tabId);
        lost.entry.tabOwner.delete(tabId);
      }
      for (const [tabId, relation] of lost.entry.opener) {
        if (ownedTabIds.has(tabId) || ownedTabIds.has(relation.openerTabId)) lost.entry.opener.delete(tabId);
      }
    }
    session.ownedTabs.clear();
    session.currentTabId = null;
  }

  private assignWaitingSessions(browserId: string): void {
    const browser = this.browsers.get(browserId);
    if (!browser) return;
    for (const session of this.sessions.values()) {
      if (session.browserPref !== null && session.browserId === browserId && !browser.sessions.has(session.sessionId)) {
        this.rebindSession(session, browserId, false);
        continue;
      }
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
      this.claimTab(session, browser, tabId, true);
    }
    if (pending.request.action === "tab.activate") {
      const targetId = tabId ?? this.requestTabId(pending.request);
      if (targetId !== undefined) this.claimTab(session, browser, targetId, true);
    }
    if (pending.request.action === "tab.close") {
      const closedId = this.requestTabId(pending.request);
      if (closedId !== undefined) {
        session.ownedTabs.delete(closedId);
        browser.tabOwner.delete(closedId);
        if (session.currentTabId === closedId) session.currentTabId = null;
      }
    }
  }

  private shouldHealTab(pending: HubPending, response: VtxResponse): boolean {
    return response.error?.code === VtxErrorCode.TAB_NOT_FOUND &&
      pending.tabIdBackfilledByHub &&
      (pending.retryCount ?? 0) === 0;
  }

  private async healTab(pending: HubPending): Promise<void> {
    const session = this.sessions.get(pending.sessionId);
    const browser = this.browsers.get(pending.browserId);
    if (!session || !browser) {
      pending.fail(this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Browser agent is unavailable"));
      return;
    }
    const missingTabId = pending.request.tabId;
    if (missingTabId !== undefined && browser.tabOwner.get(missingTabId) === session.sessionId) {
      browser.tabOwner.delete(missingTabId);
      session.ownedTabs.delete(missingTabId);
      if (session.currentTabId === missingTabId) session.currentTabId = null;
    }
    const { tabId: _tabId, tabIdBackfilled: _backfilled, ...unboundRequest } = pending.request;
    await this.forwardRequest(pending.sessionId, unboundRequest, 1, pending.deadline);
  }

  private requestTabId(request: VtxRequest): number | undefined {
    if (typeof request.tabId === "number") return request.tabId;
    return typeof request.params?.tabId === "number" ? request.params.tabId : undefined;
  }

  private isBoundToBrowser(session: SessionEntry, browserId: string, browser: BrowserEntry): boolean {
    return session.browserId === browserId && this.browsers.get(browserId) === browser;
  }

  private claimTab(session: SessionEntry, browser: BrowserEntry, tabId: number, makeCurrent: boolean): void {
    if (session.browserId !== browser.browserId || this.browsers.get(browser.browserId) !== browser) return;
    const previousOwnerId = browser.tabOwner.get(tabId);
    if (previousOwnerId && previousOwnerId !== session.sessionId) {
      const previousOwner = this.sessions.get(previousOwnerId);
      previousOwner?.ownedTabs.delete(tabId);
      if (previousOwner?.currentTabId === tabId) previousOwner.currentTabId = null;
    }
    browser.tabOwner.set(tabId, session.sessionId);
    session.ownedTabs.add(tabId);
    if (makeCurrent) session.currentTabId = tabId;
  }

  private adoptExplicitTab(session: SessionEntry, browser: BrowserEntry, tabId: number): void {
    const previousOwnerId = browser.tabOwner.get(tabId);
    this.claimTab(session, browser, tabId, true);
    if (previousOwnerId && previousOwnerId !== session.sessionId) {
      this.sendToSession(session.sessionId, {
        type: "notice",
        notice: "tab-adopted",
        browserId: browser.browserId,
        browserLabel: browser.label,
        tabId,
        reason: `adopted from session ${previousOwnerId}`,
      });
    }
  }

  private updateOwnershipFromEvent(browserId: string, event: VtxEvent): void {
    const browser = this.browsers.get(browserId);
    if (!browser || event.tabId === undefined) return;
    if (event.event === VtxEventType.USER_CLOSED_TAB) {
      const ownerId = browser.tabOwner.get(event.tabId);
      if (ownerId) {
        const owner = this.sessions.get(ownerId);
        owner?.ownedTabs.delete(event.tabId);
        if (owner?.currentTabId === event.tabId) owner.currentTabId = null;
      }
      browser.tabOwner.delete(event.tabId);
      browser.opener.delete(event.tabId);
      return;
    }
    if (event.event !== VtxEventType.USER_OPENED_TAB) return;
    const data = typeof event.data === "object" && event.data !== null
      ? event.data as { openerTabId?: unknown }
      : {};
    if (typeof data.openerTabId !== "number") return;
    browser.opener.set(event.tabId, { openerTabId: data.openerTabId, at: this.now() });
    const ownerId = browser.tabOwner.get(data.openerTabId);
    const owner = ownerId ? this.sessions.get(ownerId) : undefined;
    if (owner) this.claimTab(owner, browser, event.tabId, false);
  }

  private annotateTabList(
    sessionId: string,
    browserId: string,
    result: unknown,
    request: VtxRequest,
  ): unknown {
    if (!Array.isArray(result)) return result;
    const session = this.sessions.get(sessionId);
    const browser = this.browsers.get(browserId);
    if (!session || !browser) return result;
    const ownedOnly = request.params?.owned === true;
    const annotated = result
      .filter((tab): tab is Record<string, unknown> => typeof tab === "object" && tab !== null)
      .map((tab) => {
        const tabId = typeof tab.id === "number" ? tab.id : undefined;
        const ownerId = tabId === undefined ? undefined : browser.tabOwner.get(tabId);
        const ownerSession = ownerId ? this.sessions.get(ownerId) : undefined;
        const owner = ownerId === sessionId ? "self" : ownerSession ? "other" : "none";
        return {
          ...tab,
          owner,
          ownerLabel: ownerSession?.label ?? null,
          current: tabId !== undefined && session.currentTabId === tabId,
          browserId,
          browserLabel: browser.label,
        };
      });
    const filtered = ownedOnly ? annotated.filter((tab) => tab.owner === "self") : annotated;
    return filtered.sort((a, b) => Number(b.owner === "self") - Number(a.owner === "self"));
  }

  private callBrowser(
    browserId: string,
    sessionId: string,
    request: VtxRequest,
    timeoutMs: number,
  ): Promise<VtxResponse> {
    if (!this.acceptingRequests) return Promise.reject(new InternalRequestTimeoutError(request.action));
    if (timeoutMs <= 0) return Promise.reject(new InternalRequestTimeoutError(request.action));
    const id = `hub-internal-${++this.internalRequestCounter}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.internalPending.delete(id);
        reject(new InternalRequestTimeoutError(request.action));
      }, timeoutMs);
      this.internalPending.set(id, { browserId, sessionId, resolve, reject, timeout });
      this.sendToBrowser(browserId, {
        ...request,
        type: "request",
        id,
        sessionId,
        browserId,
      });
    });
  }

  private failInternal(browserId: string, error: Error): void {
    for (const [id, pending] of this.internalPending) {
      if (pending.browserId !== browserId) continue;
      this.internalPending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failAgentCommands(browserId: string, error: Error): void {
    for (const [id, pending] of this.agentCommandPending) {
      if (pending.browserId !== browserId) continue;
      this.agentCommandPending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failInternalForSession(sessionId: string, error: Error): void {
    for (const [id, pending] of this.internalPending) {
      if (pending.sessionId !== sessionId) continue;
      this.internalPending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failAllInternal(error: Error): void {
    for (const [id, pending] of this.internalPending) {
      this.internalPending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failAllAgentCommands(error: Error): void {
    for (const [id, pending] of this.agentCommandPending) {
      this.agentCommandPending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.inFlight.add(task);
    void task.then(
      () => this.inFlight.delete(task),
      () => this.inFlight.delete(task),
    );
    return task;
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
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

  private failTabResolution(
    sessionId: string,
    browserId: string,
    request: VtxRequest,
    cause: unknown,
  ): void {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const details = { sessionId, action: request.action, reason, browserId };
    try {
      this.onWarn("tab resolution failed", details);
    } catch {
      // Warning sinks are diagnostic only and must not prevent fail-closed responses.
    }
    this.sendResponse(sessionId, request, browserId, {
      error: vtxError(
        VtxErrorCode.TAB_NOT_FOUND,
        `Hub could not resolve current tab for ${request.action}: ${reason}`,
        { extras: details },
        { hint: "Hub tab resolution failed: unable to resolve the current tab; check the browser agent and retry." },
      ).toJSON(),
    });
  }

  private failBindingMismatch(sessionId: string, browserId: string, request: VtxRequest): void {
    if (!this.sessions.has(sessionId)) return;
    this.sendResponse(sessionId, request, browserId, {
      error: this.error(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session browser binding changed"),
    });
  }

  private error(code: VtxErrorCode, message: string): VtxErrorPayload {
    return vtxError(code, message).toJSON();
  }
}
