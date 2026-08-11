import type { VtxErrorPayload } from "./errors.js";
import type { VtxEventLevel } from "./events.js";

export const VTX_WIRE_VERSION = 2;
export type VtxPeerRole = "mcp" | "cli" | "browser-agent";

export interface VtxHello {
  type: "hello";
  wireVersion: number;
  role: VtxPeerRole;
  sessionId?: string;
  browserId?: string;
  label?: string;
  peerVersion?: string;
  extensionVersion?: string;
  buildStamp?: string;
  extDist?: string;
  repoRoot?: string;
  preferBrowserId?: string;
  /** 浏览器偏好，可填 browserId 或可读的浏览器名（如 chrome / edge） */
  preferBrowser?: string;
  capabilities?: string[];
}

export interface VtxWelcome {
  type: "welcome";
  wireVersion: number;
  hubVersion: string;
  sessionId?: string;
  browserId?: string;
  assignedBrowserId?: string | null;
  assignedBrowserLabel?: string | null;
  strictTab?: boolean;
}

export interface VtxNotice {
  type: "notice";
  notice:
    | "browser-assigned"
    | "browser-lost"
    | "browser-restored"
    | "session-replaced"
    | "tab-adopted"
    | "hub-shutdown";
  browserId?: string | null;
  browserLabel?: string | null;
  tabId?: number;
  reason?: string;
}

export interface VtxHeartbeat {
  type: "heartbeat";
  timestamp: number;
  nmConnected?: boolean;
  tabCount?: number;
}

export interface VtxAgentCommand {
  type: "agent-command";
  id: string;
  command: "trusted-mode" | "relaunch-trusted" | "reload-extension" | "ext-dist-info";
  reason?: string;
}

export interface VtxAgentResult {
  type: "agent-result";
  id: string;
  result?: unknown;
  error?: VtxErrorPayload;
}

// ========== 客户端 <-> 中间件 ==========

export interface VtxRequest {
  type?: "request";
  action: string;
  params?: Record<string, unknown>;
  id: string;
  tabId?: number;
  sessionId?: string;
  browserId?: string;
  tabIdBackfilled?: boolean;
  strictTab?: boolean;
  /** hub pending 的 deadline(ms)。缺省时 hub 用自身默认，见 timeout.ts 的阶梯 */
  timeoutMs?: number;
}

export interface VtxResponse {
  type?: "response";
  action: string;
  id: string;
  result?: unknown;
  error?: VtxErrorPayload;
  sessionId?: string;
  browserId?: string;
}

export interface VtxEvent {
  type?: "event";
  event: string;
  data: unknown;
  tabId?: number;
  frameId?: number;
  level?: VtxEventLevel;
  timestamp: number;
  browserId?: string;
  unowned?: boolean;
}

// ========== 中间件 <-> 扩展 (Native Messaging) ==========

export interface NmRequest {
  type: "tool_request";
  tool: string;
  args: Record<string, unknown>;
  requestId: string;
  tabId?: number;
  strictTab?: boolean;
}

export interface NmResponse {
  type: "tool_response";
  requestId: string;
  result?: unknown;
  error?: VtxErrorPayload;
}

export interface NmEvent {
  type: "event";
  event: string;
  data: unknown;
  tabId?: number;
  frameId?: number;
  level?: VtxEventLevel;
}

/** @deprecated 死类型：全仓没有生产者或消费者，仅保留协议兼容声明。 */
export interface NmResponseChunk {
  type: "tool_response_chunk";
  requestId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
}

export interface NmPing {
  type: "ping";
}

export interface NmPong {
  type: "pong";
}

export interface NmHello {
  type: "hello";
  browserId: string;
  extensionVersion: string;
  buildStamp?: string;
  label?: string;
}

/**
 * Server→Extension 控制消息。@since 0.4.0
 *
 * 目前仅支持 `reload-extension`：server 端 watcher 检测到扩展 dist 变化后
 * 向扩展推送此消息，扩展侧调 `chrome.runtime.reload()` 自重载并读取新 dist，
 * 避免每次 `pnpm -C packages/extension build` 后人工去 `chrome://extensions`
 * 点刷新。与 MCP 的 O-3 `fs.watch` 自 exit 对称。
 */
export interface NmControl {
  type: "control";
  action: "reload-extension";
  /** 可选：方便扩展侧日志打点/调试，不影响行为 */
  reason?: string;
}

export type NmMessageFromServer = NmRequest | NmPing | NmControl;
export type NmMessageFromExtension = NmResponse | NmEvent | NmResponseChunk | NmPong | NmHello;
export type NmMessage = NmMessageFromServer | NmMessageFromExtension;

export type VtxFrameFromClient = VtxHello | VtxRequest | VtxHeartbeat;
export type VtxFrameToClient = VtxWelcome | VtxNotice | VtxResponse | VtxEvent;
export type VtxFrameFromAgent = VtxHello | VtxHeartbeat | VtxResponse | VtxEvent | VtxAgentResult;
export type VtxFrameToAgent = VtxWelcome | VtxNotice | VtxRequest | VtxAgentCommand;
