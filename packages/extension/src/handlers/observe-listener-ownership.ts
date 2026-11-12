export interface ListenerRequest {
  frameId: number;
  documentId: string;
  epoch: string;
  order: number;
  token: string;
  deadline: number;
  scanToken?: string;
}

// Self-contained: claim and retirement run in MAIN, targeted by documentIds.
// Cross-epoch authority can only be transferred by the separate CAS protocol.
export function updateListenerOwnership(
  action: "listener.claim" | "listener.retire",
  request: ListenerRequest,
  paginationToken: string | null = null,
): boolean {
  const doc = document as Document & {
    __vortexListenerOwner?: ListenerRequest & { highWater: number; owner: string | null; retired: boolean; revision?: number };
    __vortexListenerExitedEpochs?: Set<string>;
  };
  const previous = doc.__vortexListenerOwner;
  if (doc.__vortexListenerExitedEpochs?.has(request.epoch) ||
      (previous && (previous.epoch !== request.epoch || previous.documentId !== request.documentId || previous.frameId !== request.frameId))) return false;
  if (action === "listener.claim") {
    if (Date.now() >= request.deadline || (previous && (previous.highWater > request.order ||
        (previous.highWater === request.order && (previous.retired || previous.owner !== request.token || previous.deadline !== request.deadline))))) return false;
    doc.__vortexListenerOwner = { ...request, highWater: request.order, owner: request.token, retired: false, revision: (previous?.revision ?? 0) + 1 };
    return true;
  }
  // Do not mutate even old-token remnants under a newer pagination monitor.
  if (previous && previous.highWater > request.order) return true;
  if (previous && previous.highWater === request.order && previous.token !== request.token) return false;
  const retired = { ...request, highWater: request.order, owner: null, retired: true, revision: (previous?.revision ?? 0) + 1 };
  doc.__vortexListenerOwner = retired;
  const scan = (document as any).__vortexScanOwner;
  if (!scan || scan.owner !== request.scanToken || scan.documentId !== request.documentId ||
      scan.frameId !== request.frameId || scan.retired || Date.now() >= scan.deadline) return false;
  const states = (window as any).__vortexPageSnapshots;
  // Missing identity can prevent the next claim; its monitor still must not
  // observe a late old cleanup. Leave strictly unreadable token remnants.
  if (Object.keys(states ?? {}).some((token) => token !== paginationToken)) return false;
  const item = paginationToken && states?.[paginationToken];
  const until = Date.now() + 200;
  const roots: Array<Document | ShadowRoot> = [document];
  let visited = 0;
  while (roots.length) {
    const walker = document.createTreeWalker(roots.pop()!, NodeFilter.SHOW_ELEMENT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (++visited > 10000 || Date.now() >= until || doc.__vortexListenerOwner !== retired ||
          (doc as any).__vortexScanOwner !== scan || Date.now() >= scan.deadline) return false;
      const el = node as Element;
      for (const name of ["data-vtx-listener", "data-vtx-dropzone"]) {
        if (el.getAttribute(name) !== request.token) continue;
        if ((doc as any).__vortexScanOwner !== scan || scan.owner !== request.scanToken || Date.now() >= scan.deadline) return false;
        if (item) item.marker(el, name, null, scan); else el.removeAttribute(name);
      }
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return true;
}
