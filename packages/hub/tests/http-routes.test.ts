/**
 * Author: qingwa
 * Description: Verifies browser-targeted hub HTTP command routes.
 */
import { afterEach, describe, expect, it } from "vitest";
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

const agents: FakeAgent[] = [];

describe("hub HTTP command routes", () => {
  let started: Awaited<ReturnType<typeof startTestHub>> | undefined;

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) => agent.close()));
    await started?.close();
    started = undefined;
  });

  it("blocks relaunch with multiple browsers before sending a command", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/relaunch-trusted`, { method: "POST" });
    expect(response.status).toBe(409);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("多浏览器下无法按 profile 重启，这是已知限制");
    expect(commands).toEqual([]);
  });

  it("proxies relaunch for the only browser through the fake agent", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);
    replyToCommands(agent, () => ({ result: true }));

    const response = await fetch(`http://127.0.0.1:${started.port}/relaunch-trusted`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ ok: true });
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("relaunch-trusted");
  });

  it("uses the only browser for trusted-mode when browserId is omitted", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);
    replyToCommands(agent, () => ({ result: true }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ trustedMode: true });
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("trusted-mode");
  });

  it("requires browserId for trusted-mode with multiple browsers and lists choices", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(400);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("browser-a");
    expect(body.message).toContain("browser-b");
    expect(commands).toEqual([]);
  });

  it("targets the requested browser for trusted-mode", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);
    replyToCommands(first, () => ({ result: true }));
    replyToCommands(second, () => ({ result: false }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode?browserId=browser-b`);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ trustedMode: false });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: "trusted-mode" });
  });

  it("rejects an unknown trusted-mode browser without sending a command", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const commands: VtxAgentCommand[] = [];
    observeCommands(agent, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode?browserId=missing`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("missing");
    expect(commands).toEqual([]);
  });

  it("passes a trusted-mode agent error through as a non-success response", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const agent = await addAgent(started, "browser-a");
    const error = {
      code: VtxErrorCode.PERMISSION_DENIED,
      message: "trusted mode is unavailable",
      recoverable: false,
      context: { extras: { source: "fake-agent" } },
    };
    replyToCommands(agent, () => ({ error }));

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(502);
    const body = await response.json();

    expect(body).toMatchObject({ message: error.message, error });
  });

  it("rejects an unspecified reload with multiple browsers", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const commands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, commands);
    observeCommands(second, commands);

    const response = await fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("browserId");
    expect(commands).toEqual([]);
  });

  it("parses JSON and reloads the requested browser only", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });
    const firstCommands: VtxAgentCommand[] = [];
    const secondCommands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, firstCommands);
    observeCommands(second, secondCommands);
    replyToCommands(first, () => ({ result: { reloaded: "a" } }));
    replyToCommands(second, () => ({ result: { reloaded: "b" } }));

    const response = await fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ browserId: "browser-b" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({ ok: true });
    expect(firstCommands).toHaveLength(0);
    expect(secondCommands).toHaveLength(1);
    expect(secondCommands[0].command).toBe("reload-extension");
  });

  it("reloads all browsers concurrently and preserves each result or error", async () => {
    started = await startTestHub({ requestTimeoutMs: 500 });
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    const error = {
      code: VtxErrorCode.PERMISSION_DENIED,
      message: "reload denied",
      recoverable: false,
    };
    const { commands, allReceived } = replyToCommandsAfterAll(
      [first, second],
      [
        { result: { reloaded: "a" } },
        { error },
      ],
    );

    const request = fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    await expect(allReceived).resolves.toBeUndefined();
    const response = await request;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok?: boolean;
      results?: Array<Record<string, unknown>>;
    };

    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      { browserId: "browser-a", ok: true, result: { reloaded: "a" } },
      { browserId: "browser-b", ok: false, error },
    ]);
    expect(commands).toHaveLength(2);
  });

  it("keeps successful all results when one agent command rejects", async () => {
    started = await startTestHub({ requestTimeoutMs: 500 });
    const firstCommands: VtxAgentCommand[] = [];
    const secondCommands: VtxAgentCommand[] = [];
    const first = await addAgent(started, "browser-a");
    const second = await addAgent(started, "browser-b");
    observeCommands(first, firstCommands);
    observeCommands(second, secondCommands);
    let resolveSecondCommand: (() => void) | undefined;
    const secondCommandReceived = new Promise<void>((resolve) => {
      resolveSecondCommand = resolve;
    });
    first.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      first.ws.send(JSON.stringify({
        type: "agent-result",
        id: message.id,
        result: { reloaded: "a" },
      }));
    });
    second.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      resolveSecondCommand?.();
      second.ws.close();
    });

    const responsePromise = fetch(`http://127.0.0.1:${started.port}/dev/reload-extension`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    await expect(secondCommandReceived).resolves.toBeUndefined();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok?: boolean;
      results?: Array<Record<string, unknown>>;
    };

    expect(body.ok).toBe(false);
    expect(body.results).toEqual([
      { browserId: "browser-a", ok: true, result: { reloaded: "a" } },
      {
        browserId: "browser-b",
        ok: false,
        error: {
          code: VtxErrorCode.INTERNAL_ERROR,
          message: "Browser agent disconnected",
          recoverable: false,
        },
      },
    ]);
    expect(firstCommands).toHaveLength(1);
    expect(secondCommands).toHaveLength(1);
    await second.closed;
  });

  it("returns a clear error without sending a command when no browser is available", async () => {
    started = await startTestHub({ requestTimeoutMs: 250 });

    const response = await fetch(`http://127.0.0.1:${started.port}/trusted-mode`);
    expect(response.status).toBe(503);
    const body = await response.json() as { message?: string };

    expect(body.message).toContain("没有可用 browser");
  });
});

type StartedHub = Awaited<ReturnType<typeof startTestHub>>;

async function addAgent(hub: StartedHub, browserId: string): Promise<FakeAgent> {
  const agent = await connectFakeAgent(hub.port, { browserId });
  agents.push(agent);
  return agent;
}

function observeCommands(agent: FakeAgent, commands: VtxAgentCommand[]): void {
  agent.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString()) as unknown;
    if (isAgentCommand(message)) commands.push(message);
  });
}

function replyToCommands(
  agent: FakeAgent,
  makeReply: (command: VtxAgentCommand) => Omit<VtxAgentResult, "type" | "id">,
): void {
  agent.ws.on("message", (payload) => {
    const message = JSON.parse(payload.toString()) as unknown;
    if (!isAgentCommand(message)) return;
    agent.ws.send(JSON.stringify({ type: "agent-result", id: message.id, ...makeReply(message) }));
  });
}

function replyToCommandsAfterAll(
  agents: FakeAgent[],
  replies: Array<Omit<VtxAgentResult, "type" | "id">>,
): { commands: VtxAgentCommand[]; allReceived: Promise<void> } {
  const commands: VtxAgentCommand[] = [];
  let resolveAll: (() => void) | undefined;
  const allReceived = new Promise<void>((resolve) => {
    resolveAll = resolve;
  });
  const receivedAgents = new Set<FakeAgent>();
  agents.forEach((agent, index) => {
    agent.ws.on("message", (payload) => {
      const message = JSON.parse(payload.toString()) as unknown;
      if (!isAgentCommand(message)) return;
      commands.push(message);
      receivedAgents.add(agent);
      if (receivedAgents.size === agents.length) resolveAll?.();
      void allReceived.then(() => {
        agent.ws.send(JSON.stringify({ type: "agent-result", id: message.id, ...replies[index] }));
      });
    });
  });
  return { commands, allReceived };
}

function isAgentCommand(message: unknown): message is VtxAgentCommand {
  if (!message || typeof message !== "object") return false;
  const frame = message as Partial<VtxAgentCommand>;
  return frame.type === "agent-command" && typeof frame.id === "string" && typeof frame.command === "string";
}
