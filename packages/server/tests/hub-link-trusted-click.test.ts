/**
 * Description: Locks trustedMode injection for dom.click, replacing the deleted message-router test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("HubLink dom.click trusted mode", () => {
  let link: HubLink | undefined;

  afterEach(() => {
    link?.stop();
    link = undefined;
    vi.clearAllMocks();
  });

  it("injects trustedMode=true into dom.click args when the browser is trusted", async () => {
    const socket = new FakeSocket();
    const stdout = new MemoryWritable();
    const detectTrustedMode = vi.fn(() => true);
    link = createLink(socket, { stdout, detectTrustedMode });

    emitRequest(socket, "req-click", "dom.click", { selector: "#go" });
    await flush();

    expect(detectTrustedMode).toHaveBeenCalledTimes(1);
    expect(lastNmMessage(stdout)).toMatchObject({
      tool: "dom.click",
      args: { selector: "#go", trustedMode: true },
    });
  });

  it("injects trustedMode=false when the browser is not trusted", async () => {
    const socket = new FakeSocket();
    const stdout = new MemoryWritable();
    link = createLink(socket, { stdout, detectTrustedMode: () => false });

    emitRequest(socket, "req-click-plain", "dom.click", { selector: "#go" });
    await flush();

    expect(lastNmMessage(stdout)).toMatchObject({
      tool: "dom.click",
      args: { selector: "#go", trustedMode: false },
    });
  });

  it("does not probe trusted mode for other actions", async () => {
    const socket = new FakeSocket();
    const stdout = new MemoryWritable();
    const detectTrustedMode = vi.fn(() => true);
    link = createLink(socket, { stdout, detectTrustedMode });

    emitRequest(socket, "req-nav", "page.navigate", { url: "https://example.test" });
    await flush();

    expect(detectTrustedMode).not.toHaveBeenCalled();
    expect(lastNmMessage(stdout)).toMatchObject({
      tool: "page.navigate",
      args: { url: "https://example.test" },
    });
    expect((lastNmMessage(stdout) as { args: Record<string, unknown> }).args)
      .not.toHaveProperty("trustedMode");
  });

  it("preserves request ordering when a click is followed by another action", async () => {
    const socket = new FakeSocket();
    const stdout = new MemoryWritable();
    // detectTrustedMode 可能是异步的，注入不得让后发的请求越过 click
    link = createLink(socket, { stdout, detectTrustedMode: () => Promise.resolve(true) });

    emitRequest(socket, "req-click-first", "dom.click", { selector: "#go" });
    emitRequest(socket, "req-second", "page.navigate", { url: "https://example.test" });
    await flush();
    await flush();

    expect(readNmMessages(stdout).map((m) => m.requestId))
      .toEqual(["req-click-first", "req-second"]);
  });
});

function createLink(socket: FakeSocket, overrides: Record<string, unknown> = {}): HubLink {
  const options = {
    stdout: overrides.stdout ?? { write: vi.fn() },
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
    browserId: "browser-click",
    extensionVersion: "1.0.0",
  });
  result.start();
  socket.readyState = 1;
  socket.emit("open");
  return result;
}

function emitRequest(
  socket: FakeSocket,
  id: string,
  action: string,
  params: Record<string, unknown>,
): void {
  socket.emit("message", JSON.stringify({ type: "request", id, action, params }));
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

function lastNmMessage(stdout: MemoryWritable): Record<string, unknown> {
  const messages = readNmMessages(stdout);
  return messages[messages.length - 1];
}

async function flush(): Promise<void> {
  // 转发走 promise 链，单个微任务不够把队列排空
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
