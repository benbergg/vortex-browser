import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub } from "./helpers/harness.js";

let started: Awaited<ReturnType<typeof startTestHub>> | null = null;

afterEach(async () => {
  await started?.close();
  started = null;
});

describe("浏览器偏好", () => {
  it("WS hello 的 preferBrowser 按 label 落到目标浏览器", async () => {
    started = await startTestHub();
    await connectFakeAgent(started.port, {
      browserId: "uuid-chrome",
      hello: { label: "Google Chrome" },
    });
    await connectFakeAgent(started.port, {
      browserId: "uuid-edge",
      hello: { label: "Microsoft Edge" },
    });

    const client = await connectClient(started.port, {
      sessionId: "mcp-pref",
      preferBrowser: "edge",
    });

    expect(client.welcome.assignedBrowserId).toBe("uuid-edge");
    expect(client.welcome.assignedBrowserLabel).toBe("Microsoft Edge");
    await client.close();
  });

  it("目标浏览器晚于客户端上线时自动绑上", async () => {
    started = await startTestHub();
    const client = await connectClient(started.port, {
      sessionId: "mcp-late",
      preferBrowser: "edge",
    });
    expect(client.welcome.assignedBrowserId).toBeNull();

    await connectFakeAgent(started.port, {
      browserId: "uuid-edge",
      hello: { label: "Microsoft Edge" },
    });
    const response = await client.request({ action: "tab.list", params: {}, id: "r1" });

    expect(response.error).toBeUndefined();
    await client.close();
  });

  it("HTTP 头换成匹配不到的偏好时解除既有绑定，不再沿用旧浏览器", async () => {
    started = await startTestHub();
    await connectFakeAgent(started.port, {
      browserId: "uuid-chrome",
      hello: { label: "Google Chrome" },
    });

    const call = (browser?: string) => fetch(`http://127.0.0.1:${started!.port}/api/tab/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vortex-session": "cli-pref",
        ...(browser ? { "x-vortex-browser": browser } : {}),
      },
      body: JSON.stringify({}),
    });

    expect((await call("chrome")).status).toBe(200);
    const missed = await call("edge");
    expect(missed.status).toBe(503);
    expect((await missed.json() as { error: { message: string } }).error.message)
      .toBe('No browser matching "edge"; online: Google Chrome');
  });
});
