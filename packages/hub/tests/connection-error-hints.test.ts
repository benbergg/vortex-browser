/**
 * Author: qingwa
 * Description: hub 连接类错误必须给对症 hint，而不是按错误码查表的通用文案。
 *
 * 背景(2026-08-13 transcript 挖掘,最近 3 天 1107 次调用):
 * - `No browser matching "chrome"; online: Microsoft Edge` 复用 EXTENSION_NOT_CONNECTED,
 *   表 hint 说"确保浏览器打开并启用扩展"——扩展明明连着(Edge 在线),正确动作是换
 *   browser 参数或启动 Chrome。message 已含正确信息,被 hint 盖掉。3/60 次。
 * - `Request <action> timed out` 是 hub↔扩展 的 RPC 超时,表 hint 却让人 vortex_wait_for
 *   mode='idle' 等页面稳定——通道超时与页面稳定无关。3/60 次。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ERROR_META, VtxErrorCode } from "@vortex-browser/shared";
import { noBrowserHint, noBrowserMessage } from "../src/browser-match.js";
import { RPC_TIMEOUT_HINT } from "../src/error-hints.js";
import { browserMap, makeBrowser } from "./browser-fixture.js";
import { connectClient, connectFakeAgent, startTestHub, type FakeAgent, type TestClient } from "./helpers/harness.js";

// errors.hints.ts:12-17 的 hint 契约。表内测试只查 length>10（errors.test.ts:98），
// per-call hint 更没人管，所以在这里自带断言，否则新 hint 写坏了无人察觉。
function expectHintQuality(hint: string): void {
  expect(hint.length).toBeGreaterThanOrEqual(50);
  expect(hint.length).toBeLessThanOrEqual(300);
  expect(/\b(call|use|verify|check|retry|wait|set|inspect|start|pass|switch)\b/i.test(hint)).toBe(true);
  // 引用的工具名必须在 v0.6 公开面内，否则 LLM 在 tools/list 里找不到
  for (const tool of hint.match(/vortex_[a-z_]+/g) ?? []) {
    expect(["vortex_browser", "vortex_observe", "vortex_navigate", "vortex_act", "vortex_screenshot",
      "vortex_extract", "vortex_evaluate", "vortex_query", "vortex_wait_for", "vortex_fill_form",
      "vortex_debug_read"]).toContain(tool);
  }
}

describe("noBrowserHint 与 noBrowserMessage 同源", () => {
  it("有其他浏览器在线时，指向换 browser 参数而不是查扩展", () => {
    const edge = makeBrowser("uuid-edge", { label: "Microsoft Edge" });
    const hint = noBrowserHint("chrome", browserMap(edge));

    expect(hint).toBeDefined();
    expectHintQuality(hint!);
    // 核心：不能再说"扩展没连"——它连着
    expect(hint).not.toContain("not connected");
    expect(hint).toContain("Microsoft Edge");
    expect(hint).toContain("vortex_browser");
  });

  it("确实没有浏览器在线时，退回表默认（那时表文案是对的）", () => {
    expect(noBrowserHint("chrome", browserMap())).toBeUndefined();
  });

  // hint 与 message 必须共用同一判据，否则一个说"Edge 在线"另一个说"没连"
  it("判据与 message 一致：NM 断流的浏览器不算在线", () => {
    const sleeping = makeBrowser("uuid-edge", { label: "Microsoft Edge", nmConnected: false });
    expect(noBrowserMessage("chrome", browserMap(sleeping)))
      .toBe('No browser matching "chrome"; no browser is connected to the hub');
    expect(noBrowserHint("chrome", browserMap(sleeping))).toBeUndefined();
  });
});

describe("RPC_TIMEOUT_HINT", () => {
  it("不把通道超时说成页面没稳定", () => {
    expectHintQuality(RPC_TIMEOUT_HINT);
    expect(RPC_TIMEOUT_HINT).not.toContain("mode='idle'");
    expect(RPC_TIMEOUT_HINT).not.toBe(DEFAULT_ERROR_META[VtxErrorCode.TIMEOUT].hint);
  });

  // 内层就位后走到 hub 兜底 = 扩展侧连自己的超时都没报出来，不是"页面可能没问题"
  it("不再声称页面可能没问题", () => {
    expect(RPC_TIMEOUT_HINT).not.toMatch(/page itself may be fine/i);
  });
  it("不再把加大 timeout 当首选动作", () => {
    expect(RPC_TIMEOUT_HINT).not.toMatch(/Retry with a larger timeout/i);
  });
  it("指向扩展侧无应答这一真实含义", () => {
    expect(RPC_TIMEOUT_HINT).toMatch(/extension/i);
  });
});

describe("hub 端到端：错误 payload 带对症 hint", () => {
  let closeHub: (() => Promise<void>) | undefined;
  let agent: FakeAgent | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    await client?.close();
    await agent?.close();
    await closeHub?.();
    closeHub = undefined;
    agent = undefined;
    client = undefined;
  });

  it("browser.select 偏好不匹配时 hint 指向在线浏览器", async () => {
    const started = await startTestHub({ requestTimeoutMs: 500 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "uuid-edge",
      hello: { label: "Microsoft Edge" },
    });
    client = await connectClient(started.port, { sessionId: "hint-switch" });

    const response = await client.request({
      action: "browser.select",
      id: "switch-1",
      params: { browser: "chrome" },
    });

    expect(response.error?.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
    expect(response.error?.message).toBe('No browser matching "chrome"; online: Microsoft Edge');
    expect(response.error?.hint).not.toBe(DEFAULT_ERROR_META[VtxErrorCode.EXTENSION_NOT_CONNECTED].hint);
    expect(response.error?.hint).toContain("Microsoft Edge");
  });

  it("转发路径（非 browser.select）同样带对症 hint", async () => {
    const started = await startTestHub({ requestTimeoutMs: 500 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "uuid-edge",
      hello: { label: "Microsoft Edge" },
    });
    client = await connectClient(started.port, { sessionId: "hint-forward", preferBrowser: "chrome" });

    const response = await client.request({ action: "page.info", id: "forward-1", params: {} });

    expect(response.error?.code).toBe(VtxErrorCode.EXTENSION_NOT_CONNECTED);
    expect(response.error?.hint).toContain("Microsoft Edge");
  });

  it("RPC 超时的 hint 不再建议等页面 idle", async () => {
    const started = await startTestHub({ requestTimeoutMs: 50 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "browser-a",
      handle: () => new Promise(() => {}),
    });
    client = await connectClient(started.port, { sessionId: "hint-timeout" });

    const response = await client.request({ action: "diagnostics.version", id: "slow-1" });

    expect(response.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(response.error?.hint).toBe(RPC_TIMEOUT_HINT);
  });

  it("HTTP 路由的 RPC 超时走同一 hint", async () => {
    const started = await startTestHub({ requestTimeoutMs: 50 });
    closeHub = started.close;
    agent = await connectFakeAgent(started.port, {
      browserId: "uuid-chrome",
      hello: { label: "Google Chrome" },
      handle: () => new Promise(() => {}),
    });

    const res = await fetch(`http://127.0.0.1:${started.port}/api/tab/list`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vortex-session": "cli-timeout" },
      body: JSON.stringify({}),
    });
    const body = await res.json() as { error?: { code?: string; hint?: string } };

    expect(body.error?.code).toBe(VtxErrorCode.TIMEOUT);
    expect(body.error?.hint).toBe(RPC_TIMEOUT_HINT);
  });
});
