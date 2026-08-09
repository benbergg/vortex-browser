/**
 * Author: qingwa
 * Description: Registers browser tab handlers for extension requests.
 */
import { TabActions, VtxErrorCode, vtxError } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";

export function registerTabHandlers(router: ActionRouter): void {
  router.registerAll({
    [TabActions.LIST]: async () => {
      // 无窗口时 getLastFocused 会拒绝；hub 靠 tab.list 解析当前 tab，整体失败会让该浏览器全线不可用
      const [tabs, lastFocusedId] = await Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getLastFocused().then((w) => w.id, () => undefined),
      ]);
      return tabs.map((t) => ({
        id: t.id, url: t.url, title: t.title, active: t.active,
        windowId: t.windowId, index: t.index, pinned: t.pinned, status: t.status,
        lastFocused: lastFocusedId != null && t.windowId === lastFocusedId,
      }));
    },

    [TabActions.CREATE]: async (args) => {
      const url = args.url as string | undefined;
      const active = (args.active as boolean) ?? true;
      try {
        const tab = await chrome.tabs.create({ url, active });
        return { id: tab.id, url: tab.url, title: tab.title };
      } catch (err) {
        // macOS 关掉全部窗口后 app 仍在跑、扩展照常连着 hub，此时 tabs.create 抛
        // No current window。查一次窗口数再回退，避免吞掉非法 URL 之类的真错误
        if ((await chrome.windows.getAll()).length > 0) throw err;
        const win = await chrome.windows.create({ url, focused: active });
        const tab = win?.tabs?.[0];
        return { id: tab?.id, url: tab?.url, title: tab?.title };
      }
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
