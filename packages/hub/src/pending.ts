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
  fail(error: VtxErrorPayload): void;
}

export class PendingTable {
  private readonly byId = new Map<string, HubPending>();
  private readonly bySession = new Map<string, Set<string>>();
  private readonly byBrowser = new Map<string, Set<string>>();

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

  clear(): void {
    for (const pending of this.byId.values()) clearTimeout(pending.timeout);
    this.byId.clear();
    this.bySession.clear();
    this.byBrowser.clear();
  }

  get size(): number {
    return this.byId.size;
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
      pending?.fail(error);
    }
  }

  private remove(pending: HubPending): void {
    clearTimeout(pending.timeout);
    this.byId.delete(pending.hubRequestId);
    this.removeFromIndex(this.bySession, pending.sessionId, pending.hubRequestId);
    this.removeFromIndex(this.byBrowser, pending.browserId, pending.hubRequestId);
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) index.delete(key);
  }
}
