/**
 * Author: qingwa
 * Description: Session and browser partitioned pending request table.
 */
import type { VtxErrorPayload, VtxRequest } from "@vortex-browser/shared";

export interface HubPending {
  hubRequestId: string;
  sessionId: string;
  browserId: string;
  request: VtxRequest;
  timeout: ReturnType<typeof setTimeout>;
  retryCount?: number;
  deadline?: number;
  tabIdBackfilledByHub: boolean;
  fail(error: VtxErrorPayload): void;
}

export class PendingTable {
  private readonly byId = new Map<string, HubPending>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly byBrowser = new Map<string, Set<string>>();
  private readonly emptyWaiters = new Set<() => void>();

  add(pending: HubPending): void {
    this.byId.set(pending.hubRequestId, pending);
    this.addToIndex(this.bySession, pending.sessionId, pending.hubRequestId);
    this.addToIndex(this.byBrowser, pending.browserId, pending.hubRequestId);
  }

  take(hubRequestId: string): HubPending | undefined {
    const pending = this.byId.get(hubRequestId);
    if (!pending) return undefined;
    this.remove(pending);
    return pending;
  }

  failSession(sessionId: string, error: VtxErrorPayload): void {
    this.failIndex(this.bySession, sessionId, error);
  }

  failBrowser(browserId: string, error: VtxErrorPayload): void {
    this.failIndex(this.byBrowser, browserId, error);
  }

  failAll(error: VtxErrorPayload): void {
    for (const pending of [...this.byId.values()]) {
      const current = this.take(pending.hubRequestId);
      try {
        current?.fail(error);
      } catch {
        // Continue failing remaining pending requests when one response send fails.
      }
    }
  }

  waitForEmpty(timeoutMs: number): Promise<boolean> {
    if (this.byId.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onEmpty = () => {
        clearTimeout(timer);
        this.emptyWaiters.delete(onEmpty);
        resolve(true);
      };
      timer = setTimeout(() => {
        this.emptyWaiters.delete(onEmpty);
        resolve(false);
      }, Math.max(0, timeoutMs));
      this.emptyWaiters.add(onEmpty);
    });
  }

  clear(): void {
    for (const pending of this.byId.values()) clearTimeout(pending.timeout);
    this.byId.clear();
    this.bySession.clear();
    this.byBrowser.clear();
    this.notifyEmpty();
  }

  get size(): number {
    return this.byId.size;
  }

  countBySession(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  get indexSizes(): { byId: number; bySession: number; byBrowser: number } {
    return {
      byId: this.byId.size,
      bySession: this.bySession.size,
      byBrowser: this.byBrowser.size,
    };
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    let ids = index.get(key);
    if (!ids) {
      ids = new Set();
      index.set(key, ids);
    }
    ids.add(id);
  }

  private failIndex(index: Map<string, Set<string>>, key: string, error: VtxErrorPayload): void {
    const ids = [...(index.get(key) ?? [])];
    for (const id of ids) {
      const pending = this.take(id);
      try {
        pending?.fail(error);
      } catch {
        // 一个 sink 抛错不能让同分区其余请求滞留，与 failAll 保持一致
      }
    }
  }

  private remove(pending: HubPending): void {
    clearTimeout(pending.timeout);
    this.byId.delete(pending.hubRequestId);
    this.removeFromIndex(this.bySession, pending.sessionId, pending.hubRequestId);
    this.removeFromIndex(this.byBrowser, pending.browserId, pending.hubRequestId);
    this.notifyEmpty();
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) index.delete(key);
  }

  private notifyEmpty(): void {
    if (this.byId.size !== 0) return;
    for (const waiter of [...this.emptyWaiters]) waiter();
  }
}
