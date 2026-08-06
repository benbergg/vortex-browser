/**
 * Author: qingwa
 * Description: Verifies browser-agent retry backoff and its alarm-safe upper bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLink, RETRY_DELAYS_MS, retryDelay } from "../src/hub-link.js";

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

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

function nmHello() {
  return {
    type: "hello" as const,
    browserId: "browser-test",
    extensionVersion: "0.5.0",
    buildStamp: "stamp",
  };
}

describe("HubLink retry backoff", () => {
  let link: HubLink | undefined;

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    link?.stop();
    link = undefined;
    vi.useRealTimers();
  });

  it("uses the documented sequence and stays below the MV3 alarm window", () => {
    expect(RETRY_DELAYS_MS).toEqual([200, 400, 800, 1600, 3200]);
    expect(RETRY_DELAYS_MS.every((delay, index) => retryDelay(index, () => 0.5) === delay)).toBe(true);
    expect(Math.max(...RETRY_DELAYS_MS)).toBeLessThan(30_000);
  });

  it("waits for each retry delay before dialing again", () => {
    const sockets: FakeSocket[] = [];
    link = new HubLink({
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
    link.handleNmMessage(nmHello());
    link.start();

    expect(sockets).toHaveLength(1);
    sockets[0].close();
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
  });
});
