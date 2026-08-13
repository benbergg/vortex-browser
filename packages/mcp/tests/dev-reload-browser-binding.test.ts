// vortex_dev_reload 多浏览器绑定(2026-08-11 live 实测发现)。
//
// 现象:Chrome + Edge 同时在线时 vortex_dev_reload 必然失败——
//   "browserId 必填，可选: Google Chrome, Microsoft Edge"
// 而该工具的 schema 只有 timeoutMs,**没有 browserId 可传**,调用方无路可走;
// 错误 hint 还说"扩展未连(SW 可能睡眠)",与事实相反(同一刻 tab_list 正常)。
//
// 根因:hub 的 /dev/reload-extension 支持 body.browserId(http-routes.ts:179),
// 但 server.ts 的 fetch 不发 body,于是 hub 在多浏览器下无从选择。
//
// 修法:dev_reload 第一步已经调 diagnostics.version 拿 buildStamp,其响应里就带
// browserId(VtxResponse.browserId)——用它即可,零 schema 成本(I15 预算仅余 78B),
// 且语义正确:重载「当前绑定的那个浏览器」的扩展。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: { drain: vi.fn(() => []), subscribe: vi.fn(() => "s"), unsubscribe: vi.fn(() => true) },
}));

describe("vortex_dev_reload 绑定到当前浏览器", () => {
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(async () => {
    fetchCalls = [];
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return {
          ok: true,
          json: async () => ({ ok: true, targetStamp: "stamp-new" }),
        } as unknown as Response;
      }),
    );
    const { setEnabledCaps } = await import("../src/tools/registry.js");
    setEnabledCaps(["dev"]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { setEnabledCaps } = await import("../src/tools/registry.js");
    setEnabledCaps([]);
  });

  it("把 diagnostics.version 响应里的 browserId 传给 /dev/reload-extension", async () => {
    const { sendRequest } = await import("../src/client.js");
    // 首次:拿 fromStamp + browserId;之后轮询返回新 stamp
    vi.mocked(sendRequest).mockResolvedValue({
      action: "diagnostics.version",
      id: "1",
      result: { buildStamp: "stamp-old" },
      browserId: "chrome-uuid-1",
    } as never);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_dev_reload", arguments: { timeoutMs: 1 } } });

    const reloadCall = fetchCalls.find((c) => c.url.includes("/dev/reload-extension"));
    expect(reloadCall).toBeDefined();
    const body = JSON.parse(String(reloadCall!.init?.body ?? "{}"));
    expect(body.browserId).toBe("chrome-uuid-1");
  });

  // live 实测(2026-08-11):扩展已是最新 dist 时 targetStamp === fromStamp,stamp 本就
  // 不会变,却要白等满 timeoutMs 才报 RELOAD_TIMEOUT + "查 C1 路径错配" —— 在 dogfood
  // 循环里既浪费 15s 又制造假失败信号。这正是本轮一直在消灭的东西。
  it("扩展已是最新(targetStamp === fromStamp)时立即返回,不空转到超时", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      action: "diagnostics.version",
      id: "1",
      result: { buildStamp: "same-stamp" },
      browserId: "chrome-uuid-1",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), init });
        return { ok: true, json: async () => ({ ok: true, targetStamp: "same-stamp" }) } as unknown as Response;
      }),
    );

    const { handleCallTool } = await import("../src/server.js");
    const startedAt = Date.now();
    const res = await handleCallTool({
      params: { name: "vortex_dev_reload", arguments: { timeoutMs: 15000 } },
    });
    const elapsed = Date.now() - startedAt;

    expect(res.isError).not.toBe(true);
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.alreadyCurrent).toBe(true);
    expect(payload.reloaded).toBe(false);
    // 不该空转满 timeoutMs
    expect(elapsed).toBeLessThan(5_000);
  });

  // 2026-08-13 日志:失败分支的 hint 是无条件硬编码的"扩展未连(SW 可能睡眠)",
  // 与它自己转发的 hub error code 自相矛盾。hint 应按本地已观测到的事实分支:
  // 步骤 1 拿到了 browserId,就说明扩展当刻连着。
  it("拿到 browserId 却被 hub 拒绝时，hint 不再诬告扩展未连", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      action: "diagnostics.version",
      id: "1",
      result: { buildStamp: "stamp-old" },
      browserId: "chrome-uuid-1",
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: { code: "INVALID_PARAMS", message: "browserId 必填" } }),
      } as unknown as Response)),
    );

    const { handleCallTool } = await import("../src/server.js");
    const res = await handleCallTool({ params: { name: "vortex_dev_reload", arguments: { timeoutMs: 1 } } });

    expect(res.isError).toBe(true);
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.error).toBe("INVALID_PARAMS");
    expect(payload.hint).not.toContain("扩展未连");
    expect(payload.hint).toContain("chrome-uuid-1");
  });

  it("确实拿不到 browserId 时，仍指向扩展未连（此时该判断有依据）", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockRejectedValue(new Error("no browser"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ ok: false, error: { code: "EXTENSION_NOT_CONNECTED", message: "没有可用 browser" } }),
      } as unknown as Response)),
    );

    const { handleCallTool } = await import("../src/server.js");
    const res = await handleCallTool({ params: { name: "vortex_dev_reload", arguments: { timeoutMs: 1 } } });

    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.hint).toContain("扩展未连");
  });

  it("拿不到 browserId 时不硬塞(单浏览器场景保持原行为)", async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockResolvedValue({
      action: "diagnostics.version",
      id: "1",
      result: { buildStamp: "stamp-old" },
    } as never);

    const { handleCallTool } = await import("../src/server.js");
    await handleCallTool({ params: { name: "vortex_dev_reload", arguments: { timeoutMs: 1 } } });

    const reloadCall = fetchCalls.find((c) => c.url.includes("/dev/reload-extension"));
    const body = JSON.parse(String(reloadCall!.init?.body ?? "{}"));
    expect(body.browserId).toBeUndefined();
  });
});
