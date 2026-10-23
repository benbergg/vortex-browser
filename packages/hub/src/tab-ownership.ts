/**
 * Author: qingwa
 * Description: Resolves session tab ownership and request tab binding.
 */
import {
  TABLESS_ACTIONS,
  VtxErrorCode,
  isInternalUrl,
  vtxError,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import { type BrowserEntry, type SessionEntry } from "./registry.js";

export const GLOBAL_ACTIONS = TABLESS_ACTIONS;

/**
 * 内部页判定搬到 @vortex-browser/shared 了（hub 与 cli 都要用**同一个**口径）。
 * 这里原样再导出一次，保持既有的引用面不变。
 */
export { isInternalUrl };

export type BrowserCall = (request: VtxRequest) => Promise<VtxResponse>;
export type ClaimRetryPolicy = (error: unknown) => boolean;

export interface PreparedRequest {
  request: VtxRequest;
  needsTabResolution: boolean;
  tabIdBackfilledByHub: boolean;
}

/**
 * tab.create 之后,这个新 tab 是否应成为 session 的 current。
 * 与扩展侧 `args.active ?? true`(packages/extension/src/handlers/tab.ts:25)逐字对齐:
 * 只有**严格布尔 false**(显式后台 tab)才不夺取 current;缺省与 true 都成为 current。
 */
export function shouldBecomeCurrentAfterCreate(params: unknown): boolean {
  if (typeof params !== "object" || params === null) return true;
  return (params as { active?: unknown }).active !== false;
}

export async function ensureCurrentTab(
  session: SessionEntry,
  browser: BrowserEntry,
  call: BrowserCall,
  shouldRetryClaim: ClaimRetryPolicy = () => false,
  isCurrentBrowser: () => boolean = () => true,
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
      if (!claimWithoutAdoption(session, browser, unowned.id, isCurrentBrowser)) {
        throw vtxError(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session browser binding changed");
      }
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
    if (!claimWithoutAdoption(session, browser, createdId, isCurrentBrowser)) {
      throw vtxError(VtxErrorCode.EXTENSION_NOT_CONNECTED, "Session browser binding changed");
    }
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
  isCurrentBrowser: () => boolean = () => true,
): Promise<PreparedRequest> {
  if (request.tabId != null) {
    return { request, needsTabResolution: false, tabIdBackfilledByHub: false };
  }
  if (GLOBAL_ACTIONS.has(request.action)) {
    return { request, needsTabResolution: false, tabIdBackfilledByHub: false };
  }
  const needsTabResolution = !hasOwnedCurrentTab(session, browser);
  const tabId = await ensureCurrentTab(session, browser, call, shouldRetryClaim, isCurrentBrowser);
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

function claimWithoutAdoption(
  session: SessionEntry,
  browser: BrowserEntry,
  tabId: number,
  isCurrentBrowser: () => boolean,
): boolean {
  if (!isCurrentBrowser() || session.browserId !== browser.browserId) return false;
  browser.tabOwner.set(tabId, session.sessionId);
  session.ownedTabs.add(tabId);
  session.currentTabId = tabId;
  return true;
}

function hasOwnedCurrentTab(session: SessionEntry, browser: BrowserEntry): boolean {
  return session.currentTabId !== null &&
    browser.tabOwner.get(session.currentTabId) === session.sessionId;
}
