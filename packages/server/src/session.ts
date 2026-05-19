import type { WebSocket } from "ws";

/**
 * Single-client WS session holder.
 *
 * Policy: at most one WS client (vortex-mcp) is registered at a time. When
 * a second WS client connects, the existing one is evicted with a clean
 * close (code 1000, reason "replaced by new connection"). The newcomer
 * wins because the common cause is a legitimate mcp reconnect after
 * process restart, and there is no way to distinguish that from a
 * stray duplicate at the WS layer.
 *
 * The eviction is loud on both sides: the displaced client observes a
 * close event and surfaces EXTENSION_DISCONNECTED in its eventStore,
 * while the server emits `[ws] evicting previous client …` to stderr so
 * operators can spot accidental double-connect during debug.
 */
export class SessionManager {
  private client: { ws: WebSocket; clientId: string } | null = null;

  register(ws: WebSocket): string {
    const clientId = `client-${Date.now()}`;
    if (this.client) {
      console.error(
        `[ws] evicting previous client ${this.client.clientId} on new connection ${clientId}`,
      );
      this.client.ws.close(1000, "replaced by new connection");
    }
    this.client = { ws, clientId };
    return clientId;
  }

  unregister(ws: WebSocket): void {
    if (this.client?.ws === ws) {
      this.client = null;
    }
  }

  getClient(): WebSocket | null {
    return this.client?.ws ?? null;
  }

  hasClient(): boolean {
    return this.client !== null;
  }
}
