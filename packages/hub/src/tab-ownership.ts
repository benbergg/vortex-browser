/**
 * Author: qingwa
 * Description: Resolves session tab ownership and request tab binding.
 */
import {
  VtxErrorCode,
  vtxError,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import { type BrowserEntry, type SessionEntry } from "./registry.js";

export const GLOBAL_ACTIONS = new Set(["tab.list", "tab.create", "diagnostics.version", "events.drain"]);

export type BrowserCall = (request: VtxRequest) => Promise<VtxResponse>;
export type ClaimRetryPolicy = (error: unknown) => boolean;

export interface PreparedRequest {
  request: VtxRequest;
  needsTabResolution: boolean;
  tabIdBackfilledByHub: boolean;
}

export function isInternalUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("chrome://") ||
    normalized.startsWith("devtools://") ||
    normalized.startsWith("chrome-devtools://") ||
    normalized === "chrome://downloads" ||
    normalized.startsWith("chrome://downloads/") ||
    normalized === "chrome://downloads-manager" ||
    normalized.startsWith("chrome://downloads-manager/");
}

export async function ensureCurrentTab(
  session: SessionEntry,
  browser: BrowserEntry,
  call: BrowserCall,
  shouldRetryClaim: ClaimRetryPolicy = () => false,
): Promise<number> {
  if (hasOwnedCurrentTab(session, browser)) {
    return session.currentTabId!;
  }
  let existingClaim = session.claiming;
  while (existingClaim) {
    try {
      return await existingClaim;
    } catch (error: unknown) {
      if (!shouldRetryClaim(error)) throw error;
      const nextClaim = session.claiming;
      if (nextClaim && nextClaim !== existingClaim) {
        existingClaim = nextClaim;
        continue;
      }
      break;
    }
  }

  const claiming = (async () => {
    const listResponse = await call({
      action: "tab.list",
      params: {},
      id: `hub-tab-list-${session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (listResponse.error) {
      throw vtxError(VtxErrorCode.INTERNAL_ERROR, listResponse.error.message, {
        extras: { action: "tab.list" },
      });
    }
    const tabs = tabRecords(listResponse.result);
    const usable = tabs.filter((tab) => tab.id !== undefined && !isInternalUrl(tab.url));
    const lastFocusedActive = usable.find((tab) =>
      tab.active && tab.lastFocused && browser.tabOwner.get(tab.id!) === undefined,
    );
    const active = usable.find((tab) => tab.active && browser.tabOwner.get(tab.id!) === undefined);
    const unowned = lastFocusedActive ?? active ?? usable.find((tab) => browser.tabOwner.get(tab.id!) === undefined);
    if (unowned?.id !== undefined) {
      claimWithoutAdoption(session, browser, unowned.id);
      return unowned.id;
    }

    const createResponse = await call({
      action: "tab.create",
      params: { active: false },
      id: `hub-tab-create-${session.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (createResponse.error) {
      throw vtxError(VtxErrorCode.INTERNAL_ERROR, createResponse.error.message, {
        extras: { action: "tab.create" },
      });
    }
    const createdId = tabIdFromResult(createResponse.result);
    if (createdId === undefined) {
      throw vtxError(VtxErrorCode.INTERNAL_ERROR, "tab.create did not return a tab id", {
        extras: { action: "tab.create" },
      });
    }
    claimWithoutAdoption(session, browser, createdId);
    return createdId;
  })();
  session.claiming = claiming;
  try {
    return await claiming;
  } finally {
    if (session.claiming === claiming) session.claiming = null;
  }
}

export async function prepareRequest(
  session: SessionEntry,
  browser: BrowserEntry,
  request: VtxRequest,
  call: BrowserCall,
  shouldRetryClaim: ClaimRetryPolicy = () => false,
): Promise<VtxRequest> {
  const prepared = await prepareRequestWithState(session, browser, request, call, shouldRetryClaim);
  return prepared.request;
}

export async function prepareRequestWithState(
  session: SessionEntry,
  browser: BrowserEntry,
  request: VtxRequest,
  call: BrowserCall,
  shouldRetryClaim: ClaimRetryPolicy = () => false,
): Promise<PreparedRequest> {
  if (request.tabId != null) {
    return { request, needsTabResolution: false, tabIdBackfilledByHub: false };
  }
  if (GLOBAL_ACTIONS.has(request.action)) {
    return { request, needsTabResolution: false, tabIdBackfilledByHub: false };
  }
  const needsTabResolution = !hasOwnedCurrentTab(session, browser);
  const tabId = await ensureCurrentTab(session, browser, call, shouldRetryClaim);
  return {
    request: { ...request, tabId, tabIdBackfilled: true },
    needsTabResolution,
    tabIdBackfilledByHub: true,
  };
}

interface TabRecord {
  id?: number;
  url?: string;
  active?: boolean;
  lastFocused?: boolean;
}

function tabRecords(result: unknown): TabRecord[] {
  if (!Array.isArray(result)) return [];
  return result.filter((tab): tab is TabRecord => typeof tab === "object" && tab !== null);
}

function tabIdFromResult(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const raw = result as { id?: unknown; tabId?: unknown };
  if (typeof raw.id === "number") return raw.id;
  if (typeof raw.tabId === "number") return raw.tabId;
  return undefined;
}

function claimWithoutAdoption(session: SessionEntry, browser: BrowserEntry, tabId: number): void {
  browser.tabOwner.set(tabId, session.sessionId);
  session.ownedTabs.add(tabId);
  session.currentTabId = tabId;
}

function hasOwnedCurrentTab(session: SessionEntry, browser: BrowserEntry): boolean {
  return session.currentTabId !== null &&
    browser.tabOwner.get(session.currentTabId) === session.sessionId;
}
