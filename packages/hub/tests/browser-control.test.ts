import { afterEach, describe, expect, it } from "vitest";
import { connectClient, connectFakeAgent, startTestHub } from "./helpers/harness.js";

let started: Awaited<ReturnType<typeof startTestHub>> | null = null;

afterEach(async () => {
  await started?.close();
  started = null;
});

describe("浏览器控制 action", () => {
  it("browser.list 在零浏览器时也能应答", async () => {
    started = await startTestHub();
    const client = await connectClient(started.port, { sessionId: "mcp-list" });

    const resp = await client.request({ action: "browser.list", params: {}, id: "b1" });

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({ current: null, browsers: [] });
    await client.close();
  });

  it("browser.list 列出在线浏览器并标出当前绑定", async () => {
    started = await startTestHub();
    await connectFakeAgent(started.port, { browserId: "uuid-chrome", hello: { label: "Google Chrome" } });
    await connectFakeAgent(started.port, { browserId: "uuid-edge", hello: { label: "Microsoft Edge" } });
    const client = await connectClient(started.port, { sessionId: "mcp-list2", preferBrowser: "edge" });

    const resp = await client.request({ action: "browser.list", params: {}, id: "b2" });

    expect(resp.result).toEqual({
      current: "Microsoft Edge",
      browsers: ["Google Chrome", "Microsoft Edge"],
    });
    await client.close();
  });

  it("browser.select 切换绑定且不给 agent 发任何帧", async () => {
    started = await startTestHub();
    const chrome = await connectFakeAgent(started.port, { browserId: "uuid-chrome", hello: { label: "Google Chrome" } });
    await connectFakeAgent(started.port, { browserId: "uuid-edge", hello: { label: "Microsoft Edge" } });
    const client = await connectClient(started.port, { sessionId: "mcp-sel", preferBrowser: "chrome" });
    const before = chrome.messages.length;

    const resp = await client.request({ action: "browser.select", params: { browser: "edge" }, id: "b3" });

    // online 恒 true：ws-hub.ts:229 注册 agent 时就置位
    expect(resp.result).toEqual({ current: "Microsoft Edge", switched: true, online: true });
    expect(chrome.messages.length).toBe(before);

    const tabs = await client.request({ action: "tab.list", params: {}, id: "b4" });
    expect((tabs.result as { browserLabel: string }[])[0].browserLabel).toBe("Microsoft Edge");
    await client.close();
  });

  it("browser.select 切到不存在的浏览器时报错且不降级", async () => {
    started = await startTestHub();
    await connectFakeAgent(started.port, { browserId: "uuid-chrome", hello: { label: "Google Chrome" } });
    const client = await connectClient(started.port, { sessionId: "mcp-miss", preferBrowser: "chrome" });

    const resp = await client.request({ action: "browser.select", params: { browser: "safari" }, id: "b5" });
    expect(resp.error?.message).toBe('No browser matching "safari"; online: Google Chrome');

    const after = await client.request({ action: "tab.list", params: {}, id: "b6" });
    expect(after.error?.code).toBe("EXTENSION_NOT_CONNECTED");
    await client.close();
  });

  it("切换会释放旧浏览器上的 tab 归属", async () => {
    started = await startTestHub();
    await connectFakeAgent(started.port, {
      browserId: "uuid-chrome",
      hello: { label: "Google Chrome" },
      tabs: [{ id: 11, url: "https://a.test", title: "A", active: true }],
    });
    await connectFakeAgent(started.port, { browserId: "uuid-edge", hello: { label: "Microsoft Edge" } });
    const client = await connectClient(started.port, { sessionId: "mcp-own", preferBrowser: "chrome" });

    // 必须用会 claim 当前 tab 的 action 建立 ownership，tab.list 不会
    await client.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "b7" });
    const before = started.hub.sessions.get("mcp-own");
    expect(before?.ownedTabs.size).toBe(1);
    expect(started.hub.browsers.get("uuid-chrome")?.tabOwner.size).toBe(1);

    await client.request({ action: "browser.select", params: { browser: "edge" }, id: "b8" });

    const session = started.hub.sessions.get("mcp-own");
    expect(session?.ownedTabs.size).toBe(0);
    expect(session?.currentTabId).toBeNull();
    expect(started.hub.browsers.get("uuid-chrome")?.tabOwner.size).toBe(0);
    await client.close();
  });

  it("切换时在飞请求被失败掉，不会跨浏览器回写", async () => {
    started = await startTestHub();
    // handle 挂住不应答，制造一个在飞 pending
    let release: (() => void) | undefined;
    await connectFakeAgent(started.port, {
      browserId: "uuid-chrome",
      hello: { label: "Google Chrome" },
      handle: () => new Promise((resolve) => { release = () => resolve({ result: {} } as never); }),
    });
    await connectFakeAgent(started.port, { browserId: "uuid-edge", hello: { label: "Microsoft Edge" } });
    const client = await connectClient(started.port, { sessionId: "mcp-inflight", preferBrowser: "chrome" });

    const inflight = client.request({ action: "page.navigate", params: { url: "https://a.test" }, id: "b9" });
    await client.request({ action: "browser.select", params: { browser: "edge" }, id: "b10" });

    const resp = await inflight;
    expect(resp.error).toBeDefined();
    expect(started.hub.sessions.get("mcp-inflight")?.claiming).toBeNull();
    release?.();
    await client.close();
  });

  it("未命中的 select 会清掉 lastBrowserId 与 rebindUntil，不留 grace 残留", async () => {
    started = await startTestHub();
    const agent = await connectFakeAgent(started.port, { browserId: "uuid-chrome", hello: { label: "Google Chrome" } });
    const client = await connectClient(started.port, { sessionId: "mcp-residue", preferBrowser: "chrome" });
    await client.request({ action: "tab.list", params: {}, id: "b11" });
    await agent.close();

    await client.request({ action: "browser.select", params: { browser: "safari" }, id: "b12" });

    const session = started.hub.sessions.get("mcp-residue");
    expect(session?.browserId).toBeNull();
    expect(session?.lastBrowserId).toBeNull();
    expect(session?.rebindUntil).toBe(0);
    await client.close();
  });
});
