/**
 * Author: qingwa
 * Description: Verifies HubLink agent command dispatch and injected side effects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/relauncher.js", () => ({
  relaunchTrusted: vi.fn(),
}));

import { relaunchTrusted } from "../src/relauncher.js";
import { HubLink } from "../src/hub-link.js";

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

class MemoryWritable {
  readonly chunks: Buffer[] = [];

  write(chunk: Uint8Array | string): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
}

describe("HubLink agent commands", () => {
  let link: HubLink | undefined;

  afterEach(() => {
    link?.stop();
    link = undefined;
    vi.clearAllMocks();
  });

  it("dispatches trusted-mode to the injected detector", async () => {
    const socket = new FakeSocket();
    const detectTrustedMode = vi.fn(() => true);
    link = createLink(socket, { detectTrustedMode });

    emitCommand(socket, "command-trusted", "trusted-mode");
    await flush();

    expect(detectTrustedMode).toHaveBeenCalledTimes(1);
    expect(lastFrame(socket)).toEqual({
      type: "agent-result",
      id: "command-trusted",
      result: true,
    });
  });

  it("dispatches relaunch-trusted only through the injected executor", async () => {
    const socket = new FakeSocket();
    const relaunch = vi.fn(() => true);
    link = createLink(socket, { relaunchTrusted: relaunch });

    emitCommand(socket, "command-relaunch", "relaunch-trusted");
    await flush();

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(relaunchTrusted)).not.toHaveBeenCalled();
    expect(lastFrame(socket)).toEqual({
      type: "agent-result",
      id: "command-relaunch",
      result: true,
    });
  });

  it("dispatches reload-extension through the injected trigger", async () => {
    const socket = new FakeSocket();
    const reloadExtension = vi.fn(() => ({ reloaded: true }));
    link = createLink(socket, { reloadExtension });

    emitCommand(socket, "command-reload", "reload-extension", "test reload");
    await flush();

    expect(reloadExtension).toHaveBeenCalledWith("test reload");
    expect(lastFrame(socket)).toEqual({
      type: "agent-result",
      id: "command-reload",
      result: { reloaded: true },
    });
  });

  it("returns the configured extension distribution info", async () => {
    const socket = new FakeSocket();
    link = createLink(socket, { buildStamp: "stamp-2" });

    emitCommand(socket, "command-info", "ext-dist-info");
    await flush();

    expect(lastFrame(socket)).toEqual({
      type: "agent-result",
      id: "command-info",
      result: {
        extDist: "/worktree/extension/dist",
        buildStamp: "stamp-2",
        repoRoot: "/worktree",
      },
    });
  });

  it("uses writeNmMessage framing for the default reload trigger", async () => {
    const socket = new FakeSocket();
    const stdout = new MemoryWritable();
    link = createLink(socket, { stdout });

    emitCommand(socket, "command-default-reload", "reload-extension");
    await flush();

    expect(readNmMessages(stdout)).toEqual([{
      type: "control",
      action: "reload-extension",
    }]);
    expect(lastFrame(socket)).toEqual({
      type: "agent-result",
      id: "command-default-reload",
      result: true,
    });
  });
});

function createLink(
  socket: FakeSocket,
  overrides: Record<string, unknown> = {},
): HubLink {
  const stdout = (overrides.stdout ?? { write: vi.fn() }) as NodeJS.WritableStream;
  const options = {
    stdout,
    extensionDist: "/worktree/extension/dist",
    repoRoot: "/worktree",
    resolvePort: () => 4321,
    createSocket: () => socket,
    random: () => 0.5,
    ...overrides,
  };
  const result = new HubLink(options as never);
  result.handleNmMessage({
    type: "hello",
    browserId: "browser-command",
    extensionVersion: "1.0.0",
  });
  result.start();
  socket.readyState = 1;
  socket.emit("open");
  return result;
}

function emitCommand(socket: FakeSocket, id: string, command: string, reason?: string): void {
  socket.emit("message", JSON.stringify({
    type: "agent-command",
    id,
    command,
    ...(reason ? { reason } : {}),
  }));
}

function lastFrame(socket: FakeSocket): unknown {
  return JSON.parse(socket.sent[socket.sent.length - 1]);
}

function readNmMessages(stdout: MemoryWritable): Array<Record<string, unknown>> {
  const buffer = Buffer.concat(stdout.chunks);
  const messages: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")));
    offset += length;
  }
  return messages;
}

function flush(): Promise<void> {
  return Promise.resolve();
}
