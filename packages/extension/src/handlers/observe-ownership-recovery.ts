import { TIMED_OUT } from "../lib/race-timeout.js";
import type { ListenerRequest } from "./observe-listener-ownership.js";

type Kind = "listener" | "ax" | "scan";
interface OwnerState {
  epoch: string;
  highWater: number;
  owner: string | null;
  deadline: number;
  revision?: number;
  documentId?: string;
  frameId?: number;
  retired?: boolean;
}
type Result = OwnerState | boolean | null;
type Injection = chrome.scripting.InjectionResult<Result>[];

/** Serialized MAIN operation. Handover revokes authority, never cleans DOM/monitors. */
export function transitionOwnership(
  action: "ownership.probe" | "ownership.handover",
  kind: Kind,
  request: ListenerRequest,
  expected: OwnerState | null = null,
): Result {
  if (kind !== "ax" && kind !== "listener" && kind !== "scan") return false;
  const doc = document as Document & {
    __vortexAXOwner?: OwnerState;
    __vortexListenerOwner?: OwnerState;
    __vortexScanOwner?: OwnerState;
    __vortexScanExitedEpochs?: Set<string>;
    __vortexAXExitedEpochs?: Set<string>;
    __vortexListenerExitedEpochs?: Set<string>;
  };
  const key = kind === "ax" ? "__vortexAXOwner" : kind === "scan" ? "__vortexScanOwner" : "__vortexListenerOwner";
  const exitedKey = kind === "ax" ? "__vortexAXExitedEpochs" : kind === "scan" ? "__vortexScanExitedEpochs" : "__vortexListenerExitedEpochs";
  const old = doc[key] as OwnerState | undefined;
  const exited = doc[exitedKey] as Set<string> | undefined;
  // Legacy AX state lacks identity; execution must be documentIds-pinned and
  // its actual InjectionResult provenance confirmed by the extension caller.
  if (!old || !request.documentId || Date.now() >= request.deadline ||
      (old.documentId !== undefined && old.documentId !== request.documentId) ||
      (old.frameId !== undefined && old.frameId !== request.frameId) ||
      (kind !== "ax" && (old.documentId !== request.documentId || old.frameId !== request.frameId))) return action === "ownership.probe" ? null : false;
  const current: OwnerState & Record<string, unknown> = { ...old, revision: old.revision ?? 0 };
  if (action === "ownership.probe") return current;
  if (action !== "ownership.handover" || !expected || exited?.has(request.epoch)) return false;
  if (old.epoch === request.epoch) {
    // A lost reply can only confirm this exact still-live lease. Do not assign:
    // subsequent same-epoch work must never have its highWater/revision reset.
    return !old.retired && old.owner === request.token && old.highWater === request.order &&
      old.deadline === request.deadline && Object.entries(request).every(([name, value]) =>
        JSON.stringify(current[name]) === JSON.stringify(value));
  }
  // The probe state returns from the page through the extension boundary, which
  // does not preserve key order. Compare the key set and every value instead of
  // the serialized objects; ancestorFrameIds stays order sensitive.
  const expectedEntries = Object.entries(expected);
  if (expectedEntries.length !== Object.keys(current).length) return false;
  for (const [name, value] of expectedEntries) {
    if (!Object.prototype.hasOwnProperty.call(current, name)) return false;
    if (JSON.stringify(current[name]) !== JSON.stringify(value)) return false;
  }
  if (!old.retired && old.owner !== null && Date.now() < old.deadline) return false;
  const tombstones = exited ?? new Set<string>();
  tombstones.add(old.epoch);
  doc[exitedKey] = tombstones;
  doc[key] = { ...request, highWater: request.order, owner: request.token, retired: false, revision: (current.revision ?? 0) + 1 };
  return true;
}

/** Only invoked after an explicitly rejected, identity-confirmed ordinary claim. */
export async function recoverDocumentOwnership(
  kind: Kind,
  tabId: number,
  request: ListenerRequest,
  wait: (work: Promise<Injection>) => Promise<Injection | typeof TIMED_OUT> = (work) => work,
): Promise<boolean> {
  const inject = async (action: "ownership.probe" | "ownership.handover", expected: OwnerState | null = null): Promise<Result> => {
    const results = await wait(chrome.scripting.executeScript({
      target: { tabId, documentIds: [request.documentId] }, world: "MAIN",
      func: transitionOwnership, args: [action, kind, request, expected],
    }));
    if (results === TIMED_OUT || results.length !== 1 || results[0].documentId !== request.documentId || results[0].frameId !== request.frameId) return null;
    return results[0].result ?? null;
  };
  const expected = await inject("ownership.probe");
  if (!expected || typeof expected !== "object" || expected.epoch === request.epoch) return false;
  let handed: Result = null;
  try { handed = await inject("ownership.handover", expected); } catch {
    // Execution may have succeeded before the response was lost. Re-submit only
    // this exact CAS once; page-side confirmation cannot reset an advanced lease.
  }
  if (handed !== null) return handed === true;
  return Date.now() < request.deadline && await inject("ownership.handover", expected) === true;
}
