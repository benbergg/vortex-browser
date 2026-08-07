/**
 * Author: qingwa
 * Description: Verifies the complete Hub, WebSocket, and HubLink command loop.
 */
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createHub } from "../../hub/src/hub.js";
import { HubLink } from "../src/hub-link.js";

describe("HubLink agent command loop", () => {
  it("round trips all commands through the live hub and agent WebSocket", async () => {
    const hub = await createHub({ port: 0, requestTimeoutMs: 1_000 });
    const detectTrustedMode = vi.fn(() => true);
    const relaunchTrusted = vi.fn(() => true);
    const reloadExtension = vi.fn(() => ({ reloaded: true }));
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/extension/dist",
      repoRoot: "/worktree",
      buildStamp: "stamp-loop",
      resolvePort: () => hub.port,
      createSocket: (url) => new WebSocket(url),
      detectTrustedMode,
      relaunchTrusted,
      reloadExtension,
    });

    try {
      link.handleNmMessage({
        type: "hello",
        browserId: "browser-loop",
        extensionVersion: "1.0.0",
      });
      link.start();
      await waitFor(() => hub.browsers.has("browser-loop"));

      const trusted = await hub.sendAgentCommand("browser-loop", "trusted-mode");
      const relaunched = await hub.sendAgentCommand("browser-loop", "relaunch-trusted", "loop test");
      const reloaded = await hub.sendAgentCommand("browser-loop", "reload-extension");
      const info = await hub.sendAgentCommand("browser-loop", "ext-dist-info");

      expect(trusted.result).toBe(true);
      expect(relaunched.result).toBe(true);
      expect(reloaded.result).toEqual({ reloaded: true });
      expect(info.result).toEqual({
        extDist: "/worktree/extension/dist",
        buildStamp: "stamp-loop",
        repoRoot: "/worktree",
      });
      expect(detectTrustedMode).toHaveBeenCalledTimes(1);
      expect(relaunchTrusted).toHaveBeenCalledTimes(1);
      expect(reloadExtension).toHaveBeenCalledWith(undefined);
    } finally {
      link.stop();
      await hub.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser-agent registration");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
