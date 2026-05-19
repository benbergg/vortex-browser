import type { NmMessageFromExtension, NmMessageFromServer, VtxRequest, VtxResponse, VtxEvent } from "@bytenew/vortex-shared";
import { VtxErrorCode } from "@bytenew/vortex-shared";
import type { SessionManager } from "./session.js";
import { writeNmMessage } from "./native-messaging.js";

interface PendingRequest {
  vtxRequest: VtxRequest;
  timeout: ReturnType<typeof setTimeout>;
  resolve?: (resp: VtxResponse) => void; // for HTTP sync requests
}

export class MessageRouter {
  private pending = new Map<string, PendingRequest>();
  private requestBuffer: NmMessageFromServer[] = [];
  private nmConnected = false;
  private stdout: NodeJS.WritableStream;
  private sessions: SessionManager;
  private requestCounter = 0;
  private readonly REQUEST_TIMEOUT_MS = 30_000;

  constructor(stdout: NodeJS.WritableStream, sessions: SessionManager) {
    this.stdout = stdout;
    this.sessions = sessions;
  }

  setNmConnected(connected: boolean): void {
    this.nmConnected = connected;
    if (connected) this.flushBuffer();
  }

  /**
   * WS client request → forward to extension via NM.
   *
   * Async / fire-and-forget: the caller (vortex-mcp) holds a long-lived
   * session and watches `sendToClient` pushes for the matching `id`.
   *
   * NM-disconnected behavior: the NM request is queued in `requestBuffer`
   * and flushed when the extension service worker reconnects (typical
   * cause: SW slept and was relaunched on event). Pending entry is still
   * registered so the 30s timeout enforces an upper bound — if SW takes
   * too long to come back, the caller gets a TIMEOUT response via the
   * normal `sendToClient` path. This is intentionally different from the
   * HTTP path; see `routeToExtensionSync` below.
   */
  routeToExtension(vtxReq: VtxRequest): void {
    const requestId = `r-${++this.requestCounter}`;
    const nmReq: NmMessageFromServer = {
      type: "tool_request",
      tool: vtxReq.action,
      args: vtxReq.params ?? {},
      requestId,
      tabId: vtxReq.tabId,
    };

    const timeout = setTimeout(() => {
      this.handleTimeout(requestId, vtxReq);
    }, this.REQUEST_TIMEOUT_MS);

    this.pending.set(requestId, { vtxRequest: vtxReq, timeout });

    if (this.nmConnected) {
      writeNmMessage(this.stdout, nmReq);
    } else {
      this.requestBuffer.push(nmReq);
    }
  }

  /**
   * HTTP sync request → forward to extension, return Promise.
   *
   * Synchronous from the caller's perspective: vortex-cli (and external
   * scripts) fire one-shot requests and block on the response.
   *
   * NM-disconnected behavior: fail fast with `EXTENSION_NOT_CONNECTED`
   * instead of queuing. Rationale: a CLI process is not designed to
   * outlive a 30s wait for the extension SW to come back — it would
   * just observe a TIMEOUT after the wait, identical outcome but
   * worse latency. The asymmetry with `routeToExtension` (which queues
   * for long-lived WS clients) is intentional.
   */
  routeToExtensionSync(vtxReq: VtxRequest): Promise<VtxResponse> {
    if (!this.nmConnected) {
      return Promise.resolve({
        action: vtxReq.action,
        id: vtxReq.id,
        error: {
          code: VtxErrorCode.EXTENSION_NOT_CONNECTED,
          message: "Extension is not connected",
        },
      });
    }

    return new Promise((resolve) => {
      const requestId = `r-${++this.requestCounter}`;
      const nmReq: NmMessageFromServer = {
        type: "tool_request",
        tool: vtxReq.action,
        args: vtxReq.params ?? {},
        requestId,
        tabId: vtxReq.tabId,
      };

      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          action: vtxReq.action,
          id: vtxReq.id,
          error: {
            code: VtxErrorCode.TIMEOUT,
            message: `Request ${vtxReq.action} timed out`,
          },
        });
      }, this.REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, { vtxRequest: vtxReq, timeout, resolve });
      writeNmMessage(this.stdout, nmReq);
    });
  }

  /** Handle message from extension (NM stdin) */
  handleNmMessage(msg: NmMessageFromExtension): void {
    if (msg.type === "tool_response") {
      const pending = this.pending.get(msg.requestId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pending.delete(msg.requestId);

      const vtxResp: VtxResponse = {
        action: pending.vtxRequest.action,
        id: pending.vtxRequest.id,
        result: msg.result,
        error: msg.error,
      };

      if (pending.resolve) {
        pending.resolve(vtxResp);
      } else {
        this.sendToClient(vtxResp);
      }
    } else if (msg.type === "event") {
      const vtxEvent: VtxEvent = {
        event: msg.event,
        data: msg.data,
        tabId: msg.tabId,
        frameId: msg.frameId,
        level: msg.level,
        timestamp: Date.now(),
      };
      this.sendEventToClient(vtxEvent);
    }
    // pong is handled implicitly (no action needed)
  }

  private handleTimeout(requestId: string, vtxReq: VtxRequest): void {
    this.pending.delete(requestId);
    const vtxResp: VtxResponse = {
      action: vtxReq.action,
      id: vtxReq.id,
      error: {
        code: VtxErrorCode.TIMEOUT,
        message: `Request ${vtxReq.action} timed out after ${this.REQUEST_TIMEOUT_MS}ms`,
      },
    };
    this.sendToClient(vtxResp);
  }

  private flushBuffer(): void {
    for (const msg of this.requestBuffer) {
      writeNmMessage(this.stdout, msg);
    }
    this.requestBuffer = [];
  }

  private sendToClient(resp: VtxResponse): void {
    const ws = this.sessions.getClient();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(resp));
    }
  }

  private sendEventToClient(event: VtxEvent): void {
    const ws = this.sessions.getClient();
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(event));
    }
  }
}
