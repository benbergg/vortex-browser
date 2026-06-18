import { DiagnosticsActions } from "@vortex-browser/shared";
import type { ActionRouter } from "../lib/router.js";

// 扩展版本：build 时由 vite define 注入；未注入则回退到 "unknown"
declare const __EXTENSION_VERSION__: string | undefined;
const EXT_VERSION =
  typeof __EXTENSION_VERSION__ !== "undefined" ? __EXTENSION_VERSION__ : "unknown";

// 构建戳：每次 vite build 唯一(version+base36 时间)。dev-reload 用它验证
// chrome.runtime.reload() 后扩展确实换到了新 dist(戳变 = 新代码生效)。未注入(单测
// 或旧构建)回退 "dev"。
declare const __VORTEX_BUILD__: string | undefined;
const BUILD_STAMP =
  typeof __VORTEX_BUILD__ !== "undefined" ? __VORTEX_BUILD__ : "dev";

/**
 * 诊断 handler：返回扩展版本 + 构建戳 + 已注册的 action 列表。
 *
 * 用途：MCP server 的 vortex_ping 会调用此 action，把扩展端版本
 * 和支持的 action 集合回报给 Claude，用于"我合并了 v0.4 代码但
 * Claude 还是拿不到新工具"这类版本漂移场景的快速诊断。@since 0.4.0
 * buildStamp 供 dev-reload 验证重载是否换到了新 dist。
 */
export function registerDiagnosticsHandlers(router: ActionRouter): void {
  router.registerAll({
    [DiagnosticsActions.VERSION]: async () => {
      const actions = router.getRegisteredActions();
      return {
        extensionVersion: EXT_VERSION,
        buildStamp: BUILD_STAMP,
        actionCount: actions.length,
        actions: actions.sort(),
      };
    },
  });
}
