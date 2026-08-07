/**
 * Author: qingwa
 * Description: Verifies browser-agent reconnects and periodically rechecks hub readiness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLink } from "../src/hub-link.js";

class FakeSocket {
  readyState = 0;
  closeCalls = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit("close");
  }
}

function hello() {
  return {
    type: "hello" as const,
    browserId: "browser-test",
    extensionVersion: "0.5.0",
  };
}

describe("HubLink reconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("redials after disconnect and calls ensureHubRunning after five failed attempts", async () => {
    const sockets: FakeSocket[] = [];
    const ensureHubRunning = vi.fn(async () => ({ status: "ok" }));
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/packages/extension/dist",
      repoRoot: "/worktree",
      ppid: 123,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ensureHubRunning,
      random: () => 0.5,
    });
    link.handleNmMessage(hello());
    link.start();

    for (const delay of [200, 400, 800, 1600]) {
      sockets[sockets.length - 1].close();
      vi.advanceTimersByTime(delay);
    }
    expect(sockets).toHaveLength(5);

    sockets[4].close();
    await Promise.resolve();
    expect(ensureHubRunning).toHaveBeenCalledTimes(1);
    expect(ensureHubRunning).toHaveBeenCalledWith({ port: 4321, role: "browser-agent" });

    link.stop();
  });

  it("reconnects after the hub announces shutdown", () => {
    const sockets: FakeSocket[] = [];
    const ensureHubRunning = vi.fn(async () => ({ status: "ok" }));
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/packages/extension/dist",
      repoRoot: "/worktree",
      ppid: 123,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ensureHubRunning,
      relaunchTrusted: vi.fn(),
      random: () => 0.5,
    });
    link.handleNmMessage(hello());
    link.start();

    try {
      expect(sockets).toHaveLength(1);

      sockets[0].emit("message", JSON.stringify({ type: "notice", notice: "hub-shutdown" }));

      expect(sockets[0].closeCalls).toBe(1);
      expect(ensureHubRunning).not.toHaveBeenCalled();
      vi.advanceTimersByTime(199);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    } finally {
      link.stop();
    }
  });

  it("rechecks hub after five failed reconnects from hub shutdown", () => {
    const sockets: FakeSocket[] = [];
    const ensureHubRunning = vi.fn(async () => ({ status: "ok" }));
    const relaunchTrusted = vi.fn();
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/packages/extension/dist",
      repoRoot: "/worktree",
      ppid: 123,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ensureHubRunning,
      relaunchTrusted,
      random: () => 0.5,
    });
    link.handleNmMessage(hello());
    link.start();

    try {
      sockets[0].emit("message", JSON.stringify({ type: "notice", notice: "hub-shutdown" }));
      for (const delay of [200, 400, 800, 1600]) {
        vi.advanceTimersByTime(delay);
        sockets[sockets.length - 1].close();
      }

      expect(sockets).toHaveLength(5);
      expect(ensureHubRunning).toHaveBeenCalledTimes(1);
      expect(ensureHubRunning).toHaveBeenCalledWith({ port: 4321, role: "browser-agent" });
      expect(relaunchTrusted).not.toHaveBeenCalled();
    } finally {
      link.stop();
    }
  });

  it("does not reconnect after a manual stop", () => {
    const sockets: FakeSocket[] = [];
    const ensureHubRunning = vi.fn(async () => ({ status: "ok" }));
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/packages/extension/dist",
      repoRoot: "/worktree",
      ppid: 123,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      ensureHubRunning,
      relaunchTrusted: vi.fn(),
      random: () => 0.5,
    });
    link.handleNmMessage(hello());
    link.start();

    link.stop("manual");
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
    expect(ensureHubRunning).not.toHaveBeenCalled();
  });

  it("reconnects with the real browserId when NmHello arrives after fallback", () => {
    const sockets: FakeSocket[] = [];
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist: "/worktree/packages/extension/dist",
      repoRoot: "/worktree",
      ppid: 123,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
    });
    link.start();
    vi.advanceTimersByTime(3_000);
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    expect(JSON.parse(sockets[0].sent[0]).browserId).toMatch(/^legacy-/);

    link.handleNmMessage({
      type: "hello",
      browserId: "browser-persisted",
      extensionVersion: "0.5.0",
    });
    expect(sockets).toHaveLength(2);
    sockets[1].readyState = 1;
    sockets[1].emit("open");
    expect(JSON.parse(sockets[1].sent[0]).browserId).toBe("browser-persisted");

    link.stop();
  });
});
