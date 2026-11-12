import type { ListenerRequest } from "./observe-listener-ownership.js";

export type ScanRequest = ListenerRequest & { ancestorFrameIds?: number[] };

/** Serialized MAIN operation. Only this acquisition path grants scan authority. */
export function updateScanOwnership(action: "scan.claim" | "scan.check" | "scan.retire", request: ScanRequest): boolean {
  const doc = document as any;
  const old = doc.__vortexScanOwner;
  if (!request.documentId || doc.__vortexScanExitedEpochs?.has(request.epoch) ||
      (old && (old.epoch !== request.epoch || old.documentId !== request.documentId || old.frameId !== request.frameId))) return false;
  if (action === "scan.retire") {
    if (old && old.highWater > request.order) return true;
    if (old && old.highWater === request.order && old.token !== request.token) return false;
    doc.__vortexScanOwner = { ...request, highWater: request.order, owner: null, retired: true, revision: (old?.revision ?? 0) + 1 };
    return true;
  }
  if (Date.now() >= request.deadline) return false;
  if (old && old.highWater === request.order) {
    return !old.retired && old.owner === request.token && old.deadline === request.deadline;
  }
  if (action === "scan.check" || (old && old.highWater > request.order)) return false;
  doc.__vortexScanOwner = { ...request, highWater: request.order, owner: request.token, retired: false, revision: (old?.revision ?? 0) + 1 };
  return true;
}

/** Published monitor reads/cleanup use the capture capability, not the scan TTL. */
export function updatePageSnapshot(
  action: "check" | "finalize" | "cleanup",
  token: string,
  request: ScanRequest,
  completedAt = 0,
  ttl = 60_000,
): boolean {
  const states = (window as any).__vortexPageSnapshots;
  const item = states?.[token];
  if (!item || item.document !== document || item.documentId !== request.documentId ||
      item.frameId !== request.frameId || item.captureToken !== request.token) return false;
  if (action === "cleanup") {
    clearTimeout(item.timer);
    item.state.observer.disconnect();
    if (states[token] === item) delete states[token];
    return true;
  }
  if (action === "check") return Date.now() <= item.expiresAt && item.check();
  const owner = (document as any).__vortexScanOwner;
  if (!owner || owner.documentId !== request.documentId || owner.frameId !== request.frameId ||
      owner.epoch !== request.epoch || owner.highWater !== request.order || owner.owner !== request.token ||
      owner.retired || owner.deadline !== request.deadline || Date.now() >= request.deadline) return false;
  if (!item.exceeded && !item.check()) return false;
  item.expiresAt = completedAt + ttl;
  clearTimeout(item.timer);
  const doc = document;
  item.timer = setTimeout(() => {
    item.state.observer.disconnect();
    if (document === doc && states[token] === item) delete states[token];
  }, Math.max(0, item.expiresAt - Date.now() + 1));
  return true;
}
