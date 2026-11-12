import type { ScanRequest } from "../handlers/observe-scan-ownership.js";
import { installDomResolve } from "./dom-resolve-install.js";

// Bundled inside the injected function, not imported by the renderer at runtime.
export function installOwnedDomResolve(request: ScanRequest): boolean {
  const { documentId, frameId, epoch, order, token, deadline } = request;
  const doc = document as any;
  return installDomResolve(() => {
    // The page clock can synchronously retire the lease; read the owner afterwards.
    const now = Date.now();
    const owner = doc.__vortexScanOwner;
    return doc === document && !!documentId && !doc.__vortexScanExitedEpochs?.has(epoch) &&
      owner?.documentId === documentId && owner.frameId === frameId && owner.epoch === epoch &&
      owner.highWater === order && owner.token === token && owner.owner === token &&
      owner.deadline === deadline && owner.retired === false && now < deadline;
  });
}
