/**
 * Author: qingwa
 * Description: Registers browser tab handlers for extension requests.
 */
import { TabActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";

export function registerTabHandlers(router: ActionRouter): void {
  router.registerAll({
    [TabActions.LIST]: async () => {
      const tabs = await chrome.tabs.query({});
      const lastFocusedWindow = await chrome.windows.getLastFocused();
      return tabs.map((t) => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, index: t.index, pinned: t.pinned, status: t.status,
        lastFocused: t.windowId === lastFocusedWindow.id,
      }));
    },

    [TabActions.CREATE]: async (args) => {
      const tab = await chrome.tabs.create({
        url: args.url as string | undefined,
        active: (args.active as boolean) ?? true,
      });
      return { id: tab.id, url: tab.url, title: tab.title };
    },

    [TabActions.CLOSE]: async (args, tabId) => {
      const targetId = (args.tabId as number) ?? tabId;
      if (!targetId) throw vtxError(VtxErrorCode.INVALID_PARAMS, "tabId is required");
      await chrome.tabs.remove(targetId);
      return { success: true };
    },

    [TabActions.ACTIVATE]: async (args, tabId) => {
      const targetId = (args.tabId as number) ?? tabId;
      if (!targetId) throw vtxError(VtxErrorCode.INVALID_PARAMS, "tabId is required");
      const tab = await chrome.tabs.update(targetId, { active: true });
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return { id: tab.id, url: tab.url, title: tab.title };
    },

    [TabActions.GET_INFO]: async (args, tabId) => {
      const targetId = (args.tabId as number) ?? tabId;
      if (!targetId) throw vtxError(VtxErrorCode.INVALID_PARAMS, "tabId is required");
      const tab = await chrome.tabs.get(targetId);
      return {
        id: tab.id, url: tab.url, title: tab.title, active: tab.active,
        windowId: tab.windowId, status: tab.status, favIconUrl: tab.favIconUrl,
      };
    },
  });
}
