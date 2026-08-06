/**
 * 事件系统：vortex 从"被动响应请求"升格为"主动推送事件"。
 *
 * - urgent：默认推送（用户介入 / 阻塞性事件）
 * - notice：订阅后推送
 * - info：debug/观察用，需显式订阅
 */
export type VtxEventLevel = "info" | "notice" | "urgent";

export const VtxEventType = {
  // urgent
  USER_SWITCHED_TAB: "user.switched_tab",
  USER_CLOSED_TAB: "user.closed_tab",
  USER_OPENED_TAB: "user.opened_tab",
  DIALOG_OPENED: "dialog.opened",
  DOWNLOAD_COMPLETED: "download.completed",
  EXTENSION_DISCONNECTED: "extension.disconnected",

  // notice
  PAGE_NAVIGATED: "page.navigated",
  NETWORK_ERROR_DETECTED: "network.error_detected",
  CONSOLE_ERROR: "console.error",
  FORM_SUBMITTED: "form.submitted",

  // info
  DOM_MUTATED: "dom.mutated",
  NETWORK_REQUEST: "network.request",
} as const;

export type VtxEventType = (typeof VtxEventType)[keyof typeof VtxEventType];

/**
 * 每个事件类型的默认 level。未在表中的事件（例如 legacy 的
 * "console.message" / "network.requestStart"）默认视为 "info"。
 */
export const EVENT_LEVEL: Record<string, VtxEventLevel> = {
  "user.switched_tab": "urgent",
  "user.closed_tab": "urgent",
  "user.opened_tab": "notice",
  "dialog.opened": "urgent",
  "download.completed": "urgent",
  "extension.disconnected": "urgent",
  "page.navigated": "notice",
  "network.error_detected": "notice",
  "console.error": "notice",
  "form.submitted": "notice",
  "dom.mutated": "info",
  "network.request": "info",
};

export function eventLevelOf(eventName: string): VtxEventLevel {
  return EVENT_LEVEL[eventName] ?? "info";
}
