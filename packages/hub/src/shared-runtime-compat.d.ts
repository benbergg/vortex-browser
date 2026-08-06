/**
 * Author: qingwa
 * Description: Supplies R1 wire declarations while workspace shared dist is not rebuilt.
 */
import "@vortex-browser/shared";

declare module "@vortex-browser/shared" {
  export const VTX_WIRE_VERSION: number;

  export interface VtxHello {
    type: "hello";
    wireVersion: number;
    role: "mcp" | "cli" | "browser-agent";
    sessionId?: string;
    browserId?: string;
    label?: string;
    peerVersion?: string;
    extensionVersion?: string;
    buildStamp?: string;
    extDist?: string;
    repoRoot?: string;
    preferBrowserId?: string;
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

  export interface VtxHeartbeat {
    type: "heartbeat";
    timestamp: number;
    nmConnected?: boolean;
    tabCount?: number;
  }

  export type VtxFrameFromAgent = VtxHello | VtxHeartbeat | VtxResponse | VtxEvent | {
    type: "agent-result";
    id: string;
    result?: unknown;
    error?: VtxErrorPayload;
  };

  export function classifyFromAgent(raw: unknown): VtxFrameFromAgent | null;
  export function classifyFromClient(raw: unknown): VtxHello | VtxHeartbeat | VtxRequest | null;
}
