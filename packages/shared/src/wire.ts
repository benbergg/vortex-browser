import type {
  VtxAgentCommand,
  VtxAgentResult,
  VtxEvent,
  VtxFrameFromAgent,
  VtxFrameFromClient,
  VtxHeartbeat,
  VtxHello,
  VtxRequest,
  VtxResponse,
  VtxWelcome,
  VtxNotice,
} from "./protocol.js";

type FrameObject = Record<string, unknown>;

function asObject(raw: unknown): FrameObject | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as FrameObject)
    : null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHello(o: FrameObject): o is VtxHello & FrameObject {
  return (
    o.type === "hello" &&
    isNumber(o.wireVersion) &&
    (o.role === "mcp" || o.role === "cli" || o.role === "browser-agent")
  );
}

function isRequest(o: FrameObject): o is VtxRequest & FrameObject {
  return o.type === "request" && isString(o.action) && isString(o.id);
}

function isResponse(o: FrameObject): o is VtxResponse & FrameObject {
  return o.type === "response" && isString(o.action) && isString(o.id);
}

function isEvent(o: FrameObject): o is VtxEvent & FrameObject {
  return o.type === "event" && isString(o.event) && isNumber(o.timestamp) && "data" in o;
}

function isHeartbeat(o: FrameObject): o is VtxHeartbeat & FrameObject {
  return o.type === "heartbeat" && isNumber(o.timestamp);
}

function isWelcome(o: FrameObject): o is VtxWelcome & FrameObject {
  return o.type === "welcome" && isNumber(o.wireVersion) && isString(o.hubVersion);
}

function isNotice(o: FrameObject): o is VtxNotice & FrameObject {
  return (
    o.type === "notice" &&
    (o.notice === "browser-assigned" ||
      o.notice === "browser-lost" ||
      o.notice === "browser-restored" ||
      o.notice === "session-replaced" ||
      o.notice === "tab-adopted" ||
      o.notice === "hub-shutdown")
  );
}

function isAgentCommand(o: FrameObject): o is VtxAgentCommand & FrameObject {
  return (
    o.type === "agent-command" &&
    isString(o.id) &&
    (o.command === "trusted-mode" ||
      o.command === "relaunch-trusted" ||
      o.command === "reload-extension" ||
      o.command === "ext-dist-info")
  );
}

function isAgentResult(o: FrameObject): o is VtxAgentResult & FrameObject {
  return o.type === "agent-result" && isString(o.id);
}

/** legacy 请求必须没有 type，避免把显式 wire-2 帧误判为 wire-1。 */
export function isLegacyRequest(o: Record<string, unknown>): boolean {
  return o.type === undefined && isString(o.action) && isString(o.id);
}

export function classifyFromClient(raw: unknown): VtxFrameFromClient | null {
  const o = asObject(raw);
  if (!o) return null;
  if (isHello(o)) return o.role === "mcp" || o.role === "cli" ? o : null;
  if (isRequest(o) || isHeartbeat(o)) return o;
  if (isLegacyRequest(o)) return o as unknown as VtxRequest;
  return null;
}

export function classifyFromAgent(raw: unknown): VtxFrameFromAgent | null {
  const o = asObject(raw);
  if (!o) return null;
  if (isHello(o)) return o.role === "browser-agent" ? o : null;
  if (isHeartbeat(o) || isResponse(o) || isEvent(o) || isAgentResult(o)) return o;
  return null;
}
