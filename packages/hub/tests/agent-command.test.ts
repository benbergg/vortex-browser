/**
 * Author: qingwa
 * Description: Verifies agent command framing, results, timeouts, and disconnects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VtxErrorCode,
  type VtxAgentCommand,
  type VtxAgentResult,
} from "@vortex-browser/shared";
import {
  connectFakeAgent,
  startTestHub,
  type FakeAgent,
} from "./helpers/harness.js";
import { BrowserRegistry, SessionRegistry } from "../src/registry.js";
import { HubRouter } from "../src/router.js";

describe("hub agent commands", () => {
  let agent: FakeAgent | undefined;
  let closeHub: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await agent?.close();
    await closeHub?.();
    agent = undefined;
    closeHub = undefined;
  });

  it("round trips trusted-mode through a real browser WebSocket", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 250 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    replyToCommands(agent, () => ({ result: true }));

    const result = await hub.hub.sendAgentCommand("browser-command", "trusted-mode");

    expect(result.type).toBe("agent-result");
    expect(result.result).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("round trips relaunch-trusted through a real browser WebSocket", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 250 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    replyToCommands(agent, () => ({ result: false }));

    const result = await hub.hub.sendAgentCommand("browser-command", "relaunch-trusted", "test");

    expect(result.type).toBe("agent-result");
    expect(result.result).toBe(false);
  });

  it("round trips reload-extension through a real browser WebSocket", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 250 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    replyToCommands(agent, () => ({ result: { reloaded: true } }));

    const result = await hub.hub.sendAgentCommand("browser-command", "reload-extension");

    expect(result.type).toBe("agent-result");
    expect(result.result).toEqual({ reloaded: true });
  });

  it("round trips ext-dist-info through a real browser WebSocket", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 250 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    replyToCommands(agent, () => ({
      result: {
        extDist: "/worktree/extension/dist",
        buildStamp: "stamp-1",
        repoRoot: "/worktree",
      },
    }));

    const result = await hub.hub.sendAgentCommand("browser-command", "ext-dist-info");

    expect(result.type).toBe("agent-result");
    expect(result.result).toEqual({
      extDist: "/worktree/extension/dist",
      buildStamp: "stamp-1",
      repoRoot: "/worktree",
    });
  });

  it("preserves an agent error payload instead of treating it as success", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 250 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    const error = {
      code: VtxErrorCode.PERMISSION_DENIED,
      message: "trusted mode is unavailable",
      recoverable: false,
      context: { extras: { source: "agent" } },
    };
    replyToCommands(agent, () => ({ error }));

    const result = await hub.hub.sendAgentCommand("browser-command", "trusted-mode");

    expect(result.error).toEqual(error);
    expect(result.result).toBeUndefined();
  });

  it("rejects an in-flight command immediately when the browser disconnects", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 1_000 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });
    const pending = hub.hub.sendAgentCommand("browser-command", "trusted-mode");
    await agent.waitFor((message): message is VtxAgentCommand => isAgentCommand(message));
    const rejected = expect(pending).rejects.toThrow("Browser agent disconnected");

    await agent.close();
    await rejected;
  });

  it("uses the existing request timeout for an unanswered command", async () => {
    const hub = await startTestHub({ requestTimeoutMs: 20 });
    closeHub = hub.close;
    agent = await connectFakeAgent(hub.port, { browserId: "browser-command" });

    await expect(hub.hub.sendAgentCommand("browser-command", "trusted-mode"))
      .rejects.toThrow("Agent command trusted-mode timed out");
  });

  it("cleans pending state when sending a command throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const browsers = new BrowserRegistry();
      browsers.set({
        browserId: "browser-send-error",
        label: "Send error",
        ws: {} as never,
        peerVersion: "test",
        connectedAt: 0,
        lastSeenAt: 0,
        nmConnected: true,
        sessions: new Set(),
        tabOwner: new Map(),
        opener: new Map(),
      });
      const router = new HubRouter({
        sessions: new SessionRegistry(),
        browsers,
        requestTimeoutMs: 20,
        sendToSession: () => {},
        sendToBrowser: () => {
          throw new Error("send failed");
        },
      });

      const pending = router.sendAgentCommand("browser-send-error", "trusted-mode");

      await expect(pending).rejects.toThrow("send failed");
      expect((router as unknown as { agentCommandPending: Map<string, unknown> }).agentCommandPending.size)
        .toBe(0);
      vi.advanceTimersByTime(20);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function replyToCommands(
  agent: FakeAgent,
  makeResult: (command: VtxAgentCommand) => Omit<VtxAgentResult, "type" | "id">,
): void {
  agent.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString()) as unknown;
    if (!isAgentCommand(message)) return;
    agent.ws.send(JSON.stringify({ type: "agent-result", id: message.id, ...makeResult(message) }));
  });
}

function isAgentCommand(message: unknown): message is VtxAgentCommand {
  if (!message || typeof message !== "object") return false;
  const frame = message as Partial<VtxAgentCommand>;
  return frame.type === "agent-command" && typeof frame.id === "string" && typeof frame.command === "string";
}
