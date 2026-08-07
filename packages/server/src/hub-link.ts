/**
 * Author: qingwa
 * Description: Connects the native-messaging browser agent to the local hub.
 */
import { createHash } from "node:crypto";
import { ensureHubRunning as ensureHubRunningDefault } from "@vortex-browser/hub/spawn";
import { resolveHubPort } from "@vortex-browser/hub/paths";
import {
  VTX_WIRE_VERSION,
  VtxErrorCode,
  vtxError,
  type VtxAgentCommand,
  type VtxErrorPayload,
  type NmHello,
  type NmMessageFromExtension,
  type NmMessageFromServer,
  type NmRequest,
  type VtxEvent,
  type VtxRequest,
  type VtxResponse,
} from "@vortex-browser/shared";
import WebSocket from "ws";
import { writeNmMessage } from "./native-messaging.js";
import { readBuildStamp } from "./ext-dist.js";
import { relaunchTrusted as relaunchTrustedDefault } from "./relauncher.js";
import { detectTrustedMode as detectTrustedModeDefault, type TrustedModeProbe } from "./trusted-mode.js";

export const RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200] as const;
const JITTER_RATIO = 0.2;
const NATIVE_HELLO_TIMEOUT_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const SOCKET_OPEN = 1;

export interface HubSocket {
  readyState: number;
  send(payload: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface HubLinkOptions {
  stdout: NodeJS.WritableStream;
  extensionDist: string;
  repoRoot: string;
  ppid?: number;
  extensionVersion?: string;
  buildStamp?: string;
  resolvePort?: () => number;
  createSocket?: (url: string) => HubSocket;
  ensureHubRunning?: (options: { port: number; role: string }) => Promise<unknown>;
  random?: () => number;
  detectTrustedMode?: () => boolean | Promise<boolean>;
  trustedModeProbe?: TrustedModeProbe;
  relaunchTrusted?: () => boolean | void | Promise<boolean | void>;
  reloadExtension?: (reason?: string) => unknown | Promise<unknown>;
}

interface PendingRequest {
  action: string;
  sessionId?: string;
  browserId?: string;
}

type StopIntent = "manual" | "hub-shutdown";

export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)];
  const jitter = (random() * 2 - 1) * JITTER_RATIO;
  return Math.max(0, Math.round(base * (1 + jitter)));
}

export function legacyBrowserId(extensionDist: string, ppid: number): string {
  const digest = createHash("sha256").update(`${extensionDist}${ppid}`).digest("hex").slice(0, 12);
  return `legacy-${digest}`;
}

export class HubLink {
  private readonly stdout: NodeJS.WritableStream;
  private readonly extensionDist: string;
  private readonly repoRoot: string;
  private readonly ppid: number;
  private readonly extensionVersion: string;
  private readonly configuredBuildStamp: string | undefined;
  private readonly resolvePort: () => number;
  private readonly createSocket: (url: string) => HubSocket;
  private readonly ensureHubRunning: (options: { port: number; role: string }) => Promise<unknown>;
  private readonly random: () => number;
  private readonly detectTrustedMode: () => boolean | Promise<boolean>;
  private readonly relaunchTrusted: () => boolean | void | Promise<boolean | void>;
  private readonly reloadExtension: (reason?: string) => unknown | Promise<unknown>;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: HubSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeHelloTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nativeHello: NmHello | null = null;
  private usingLegacyIdentity = false;
  private nativeConnected = false;
  private failures = 0;
  private running = false;
  private stopIntent: StopIntent | null = null;

  constructor(options: HubLinkOptions) {
    this.stdout = options.stdout;
    this.extensionDist = options.extensionDist;
    this.repoRoot = options.repoRoot;
    this.ppid = options.ppid ?? process.ppid;
    this.extensionVersion = options.extensionVersion ?? "unknown";
    this.configuredBuildStamp = options.buildStamp;
    this.resolvePort = options.resolvePort ?? resolveHubPort;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.ensureHubRunning = options.ensureHubRunning ?? ensureHubRunningDefault;
    this.random = options.random ?? Math.random;
    this.detectTrustedMode = options.detectTrustedMode ?? (() =>
      detectTrustedModeDefault(Date.now(), options.trustedModeProbe));
    this.relaunchTrusted = options.relaunchTrusted ?? (() => {
      relaunchTrustedDefault();
      return true;
    });
    this.reloadExtension = options.reloadExtension ?? ((reason) => {
      this.sendToExtension({
        type: "control",
        action: "reload-extension",
        ...(reason !== undefined ? { reason } : {}),
      });
      return true;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopIntent = null;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    if (this.nativeHello) {
      this.dial();
    } else {
      this.nativeHelloTimer = setTimeout(() => this.useLegacyIdentity(), NATIVE_HELLO_TIMEOUT_MS);
    }
  }

  stop(intent: StopIntent = "manual"): void {
    if (intent === "hub-shutdown") {
      if (!this.running) return;
      this.stopIntent = null;
      this.pending.clear();
      const socket = this.socket;
      this.socket = null;
      socket?.close();
      this.scheduleReconnect();
      return;
    }
    this.running = false;
    this.stopIntent = intent;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    if (this.nativeHelloTimer !== null) clearTimeout(this.nativeHelloTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.nativeHelloTimer = null;
    this.heartbeatTimer = null;
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  setNativeMessagingConnected(connected: boolean): void {
    this.nativeConnected = connected;
  }

  handleNmMessage(message: NmMessageFromExtension): void {
    this.nativeConnected = true;
    if (message.type === "hello") {
      const previousHello = this.nativeHello;
      this.nativeHello = message;
      if (this.nativeHelloTimer !== null) clearTimeout(this.nativeHelloTimer);
      this.nativeHelloTimer = null;
      if (
        this.usingLegacyIdentity &&
        previousHello?.browserId !== message.browserId &&
        this.socket !== null
      ) {
        const oldSocket = this.socket;
        this.socket = null;
        this.pending.clear();
        this.usingLegacyIdentity = false;
        oldSocket.close();
        this.dial();
        return;
      }
      this.usingLegacyIdentity = false;
      if (this.running && this.socket === null && this.reconnectTimer === null) this.dial();
      return;
    }
    if (message.type === "tool_response") {
      this.handleNmResponse(message);
      return;
    }
    if (message.type === "event") {
      this.handleNmEvent(message);
    }
  }

  private useLegacyIdentity(): void {
    if (!this.running || this.nativeHello) return;
    this.nativeHello = {
      type: "hello",
      browserId: legacyBrowserId(this.extensionDist, this.ppid),
      extensionVersion: this.extensionVersion,
      ...(this.getBuildStamp() ? { buildStamp: this.getBuildStamp()! } : {}),
    };
    this.usingLegacyIdentity = true;
    this.nativeHelloTimer = null;
    this.dial();
  }

  private getBuildStamp(): string | undefined {
    return this.configuredBuildStamp ?? readBuildStamp(this.extensionDist) ?? undefined;
  }

  private dial(): void {
    if (!this.running || this.socket !== null || this.nativeHello === null) return;
    const port = this.resolvePort();
    const socket = this.createSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.failures = 0;
      this.sendHello();
    });
    socket.on("message", (payload: unknown) => {
      if (this.socket === socket) this.handleHubMessage(payload);
    });
    socket.on("error", () => this.handleSocketFailure(socket));
    socket.on("close", () => this.handleSocketFailure(socket));
  }

  private sendHello(): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN || !this.nativeHello) return;
    const buildStamp = this.nativeHello.buildStamp ?? this.getBuildStamp();
    this.socket.send(JSON.stringify({
      type: "hello",
      wireVersion: VTX_WIRE_VERSION,
      role: "browser-agent",
      browserId: this.nativeHello.browserId,
      extensionVersion: this.nativeHello.extensionVersion || this.extensionVersion,
      ...(buildStamp ? { buildStamp } : {}),
      ...(this.nativeHello.label ? { label: this.nativeHello.label } : {}),
      extDist: this.extensionDist,
      repoRoot: this.repoRoot,
    }));
  }

  private handleHubMessage(payload: unknown): void {
    const raw = typeof payload === "string"
      ? payload
      : payload instanceof Uint8Array
        ? new TextDecoder().decode(payload)
        : String(payload);
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "notice" && message.notice === "hub-shutdown") {
      this.stop("hub-shutdown");
      return;
    }
    if (message.type === "agent-command" && typeof message.id === "string") {
      void this.handleAgentCommand(message as unknown as VtxAgentCommand);
      return;
    }
    if (message.type === "request") {
      this.handleHubRequest(message as unknown as VtxRequest);
    }
  }

  private async handleAgentCommand(command: VtxAgentCommand): Promise<void> {
    try {
      let result: unknown;
      switch (command.command) {
        case "trusted-mode":
          result = await this.detectTrustedMode();
          break;
        case "relaunch-trusted": {
          const triggered = await this.relaunchTrusted();
          result = triggered ?? true;
          break;
        }
        case "reload-extension": {
          const triggered = await this.reloadExtension(command.reason);
          result = triggered ?? true;
          break;
        }
        case "ext-dist-info":
          result = {
            extDist: this.extensionDist,
            buildStamp: this.getBuildStamp() ?? null,
            repoRoot: this.repoRoot,
          };
          break;
        default:
          throw vtxError(VtxErrorCode.UNKNOWN_ACTION, `Unknown agent command: ${String(command.command)}`);
      }
      this.sendAgentResult({ type: "agent-result", id: command.id, result });
    } catch (error: unknown) {
      this.sendAgentResult({
        type: "agent-result",
        id: command.id,
        error: toErrorPayload(error),
      });
    }
  }

  private sendAgentResult(result: { type: "agent-result"; id: string; result?: unknown; error?: VtxErrorPayload }): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(result));
  }

  private handleHubRequest(request: VtxRequest): void {
    if (typeof request.id !== "string" || typeof request.action !== "string") return;
    const nmRequest: NmRequest = {
      type: "tool_request",
      tool: request.action,
      args: request.params ?? {},
      requestId: request.id,
      tabId: request.tabId,
      strictTab: request.strictTab,
    };
    this.pending.set(request.id, {
      action: request.action,
      sessionId: request.sessionId,
      browserId: request.browserId,
    });
    this.sendToExtension(nmRequest);
  }

  private handleNmResponse(message: Extract<NmMessageFromExtension, { type: "tool_response" }>): void {
    const pending = this.pending.get(message.requestId);
    if (!pending || !this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    this.pending.delete(message.requestId);
    const response: VtxResponse = {
      type: "response",
      action: pending.action,
      id: message.requestId,
      result: message.result,
      error: message.error,
      sessionId: pending.sessionId,
      browserId: pending.browserId,
    };
    this.socket.send(JSON.stringify(response));
  }

  private handleNmEvent(message: Extract<NmMessageFromExtension, { type: "event" }>): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    const event: VtxEvent = {
      type: "event",
      event: message.event,
      data: message.data,
      tabId: message.tabId,
      frameId: message.frameId,
      level: message.level,
      timestamp: Date.now(),
      browserId: this.nativeHello?.browserId,
    };
    this.socket.send(JSON.stringify(event));
  }

  private sendToExtension(message: NmMessageFromServer): void {
    writeNmMessage(this.stdout, message);
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify({
      type: "heartbeat",
      timestamp: Date.now(),
      nmConnected: this.nativeConnected,
    }));
  }

  private handleSocketFailure(socket: HubSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.pending.clear();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.stopIntent !== null || this.reconnectTimer !== null) return;
    const attempt = this.failures++;
    const port = this.resolvePort();
    if (this.failures % RETRY_DELAYS_MS.length === 0) {
      void this.ensureHubRunning({ port, role: "browser-agent" }).catch(() => {});
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, retryDelay(attempt, this.random));
  }
}

function toErrorPayload(error: unknown): VtxErrorPayload {
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    return error as unknown as VtxErrorPayload;
  }
  return {
    code: VtxErrorCode.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
    recoverable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
