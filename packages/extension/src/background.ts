import type { NmRequest } from "@vortex-browser/shared";
import { VtxEventType } from "@vortex-browser/shared";
import { NativeMessagingClient } from "./lib/native-messaging.js";
import { ActionRouter } from "./lib/router.js";
import { DebuggerManager } from "./lib/debugger-manager.js";
import { registerTabHandlers } from "./handlers/tab.js";
import { registerFramesHandlers } from "./handlers/frames.js";
import { registerPageHandlers } from "./handlers/page.js";
import { registerJsHandlers } from "./handlers/js.js";
import { registerDomHandlers } from "./handlers/dom.js";
import { registerContentHandlers } from "./handlers/content.js";
import { registerConsoleHandlers } from "./handlers/console.js";
import { registerNetworkHandlers } from "./handlers/network.js";
import { registerStorageHandlers } from "./handlers/storage.js";
import { registerCaptureHandlers } from "./handlers/capture.js";
import { registerKeyboardHandlers } from "./handlers/keyboard.js";
import { registerMouseHandlers } from "./handlers/mouse.js";
import { registerFileHandlers } from "./handlers/file.js";
import { registerObserveHandlers } from "./handlers/observe.js";
import { registerMutationHandlers } from "./handlers/mutations.js";
import { registerEventHandlers } from "./handlers/events.js";
import { registerDiagnosticsHandlers } from "./handlers/diagnostics.js";
import { EventDispatcher, registerEventSources } from "./events/dispatcher.js";

const router = new ActionRouter();
const debuggerMgr = new DebuggerManager();

// 不需要 debugger/nm 的 handler
registerTabHandlers(router);
registerFramesHandlers(router);
registerPageHandlers(router, debuggerMgr);
registerJsHandlers(router, debuggerMgr);
registerDomHandlers(router, debuggerMgr);
registerContentHandlers(router);
registerStorageHandlers(router);
registerCaptureHandlers(router, debuggerMgr);
registerObserveHandlers(router, debuggerMgr);
registerMutationHandlers(router);
registerDiagnosticsHandlers(router);

// NM 客户端
const nm = new NativeMessagingClient(
  async (msg) => {
    if (msg.type === "tool_request") {
      const response = await router.dispatch(msg as NmRequest);
      nm.send(response);
    } else if (msg.type === "control") {
      // @since 0.4.0 (O-3b)：server 端 watcher 检测到扩展 dist 变化后推送
      // reload-extension 控制消息。chrome.runtime.reload() 会让 Chrome 重读
      // load-unpacked 的磁盘 dist，service worker 上下文会被重建，native
      // messaging port 会断开——background 重启后会重新连上新的 server 进程。
      const ctl = msg as { type: "control"; action: string; reason?: string };
      if (ctl.action === "reload-extension") {
        console.warn(
          `[vortex] reloading extension due to dist change (${ctl.reason ?? "<no reason>"})`,
        );
        // 用 setTimeout 让这条 console 先 flush，同时给上层 onMessage
        // 链路一个 tick 的余地（非必需但更稳）。
        setTimeout(() => chrome.runtime.reload(), 50);
      }
    }
  },
  () => {
    console.warn("[vortex] NM disconnected, will reconnect on next alarm");
  },
);

// 事件分发器：需要 nm，后续 handler 都可借它上报事件
const eventDispatcher = new EventDispatcher(nm);
registerEventSources(eventDispatcher);
registerEventHandlers(router, eventDispatcher);

// content script → background 的事件中继（F6/F7）
chrome.runtime.onMessage.addListener((rawMsg, sender) => {
  const msg = rawMsg as { source?: string; event?: string; data?: unknown } | null;
  if (!msg || msg.source !== "vortex-content" || typeof msg.event !== "string") return;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  // 仅中继已知事件类型，避免恶意页面通过 content bridge 注入假事件名
  if (msg.event === VtxEventType.DIALOG_OPENED) {
    eventDispatcher.emit(VtxEventType.DIALOG_OPENED, msg.data, { tabId, frameId });
  } else if (msg.event === VtxEventType.FORM_SUBMITTED) {
    eventDispatcher.emit(VtxEventType.FORM_SUBMITTED, msg.data, { tabId, frameId });
  } else if (msg.event === VtxEventType.DOM_MUTATED) {
    eventDispatcher.emit(VtxEventType.DOM_MUTATED, msg.data, { tabId, frameId });
  }
});

// 需要 debugger / nm / dispatcher 的 handler（必须在 nm + dispatcher 之后）
registerConsoleHandlers(router, debuggerMgr, nm, eventDispatcher);
registerNetworkHandlers(router, debuggerMgr, nm, eventDispatcher);
registerKeyboardHandlers(router, debuggerMgr);
registerMouseHandlers(router, debuggerMgr);
registerFileHandlers(router, nm, eventDispatcher);


console.log("[vortex] registered actions:", router.getRegisteredActions());
nm.connect();
