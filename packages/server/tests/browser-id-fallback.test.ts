/**
 * Author: qingwa
 * Description: Verifies deterministic browser identity fallback for legacy extensions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLink, legacyBrowserId } from "../src/hub-link.js";

class FakeSocket {
  readyState = 0;
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

  close(): void {}
}

describe("browserId fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses deterministic legacy id when NmHello does not arrive within three seconds", () => {
    const sockets: FakeSocket[] = [];
    const extensionDist = "/worktree/packages/extension/dist";
    const ppid = 123;
    const link = new HubLink({
      stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
      extensionDist,
      repoRoot: "/worktree",
      ppid,
      resolvePort: () => 4321,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0.5,
    });
    link.start();

    vi.advanceTimersByTime(2_999);
    expect(sockets).toHaveLength(0);
    vi.advanceTimersByTime(1);

    expect(sockets).toHaveLength(1);
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    const hello = JSON.parse(sockets[0].sent[0]);
    expect(hello.browserId).toBe(legacyBrowserId(extensionDist, ppid));
    expect(legacyBrowserId(extensionDist, ppid)).toBe(legacyBrowserId(extensionDist, ppid));

    link.stop();
  });
});
