// vortex_dev_reload 三个失败出口的统一错误契约测试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client.js", () => ({ sendRequest: vi.fn() }));
vi.mock("../src/lib/event-store.js", () => ({
  eventStore: {
    drain: vi.fn(() => []),
    subscribe: vi.fn(() => "s"),
    unsubscribe: vi.fn(() => true),
  },
}));

type ReloadResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

async function callReload(): Promise<{ content: Array<{ text: string }>; isError?: boolean }> {
  const { handleCallTool } = await import("../src/server.js");
  return handleCallTool({
    params: { name: "vortex_dev_reload", arguments: { timeoutMs: 1 } },
  });
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe("vortex_dev_reload 错误契约", () => {
  beforeEach(async () => {
    const { sendRequest } = await import("../src/client.js");
    vi.mocked(sendRequest).mockReset();
    vi.mocked(sendRequest).mockResolvedValue({
      action: "diagnostics.version",
      id: "1",
      result: { buildStamp: "stamp-old" },
      browserId: "chrome-uuid-1",
    } as never);
    const { setEnabledCaps } = await import("../src/tools/registry.js");
    setEnabledCaps(["dev"]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { setEnabledCaps } = await import("../src/tools/registry.js");
    setEnabledCaps([]);
  });

  it("HTTP 失败返回统一前缀、合法 code、原 message 和基于事实的 hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        error: { code: "INVALID_PARAMS", message: "browserId 必填" },
      }),
    }) satisfies ReloadResponse));

    const result = await callReload();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Error [INVALID_PARAMS]: browserId 必填\n" +
      "Hint: diagnostics.version 曾返回 browserId=chrome-uuid-1；本次 reload 请求被 vortex-server 拒绝，请依据错误信息处理。",
    );
  });

  it.each([
    {
      name: "缺 code",
      error: { message: "hub failure" },
      expectedCode: "INTERNAL_ERROR",
      expectedMessage: "hub failure",
    },
    {
      name: "缺 message",
      error: { code: "INVALID_PARAMS" },
      expectedCode: "INVALID_PARAMS",
      expectedMessage: "reload trigger failed (HTTP 400)",
    },
    {
      name: "非法 code",
      error: { code: "RELOAD_TRIGGER_FAILED", message: "hub rejected" },
      expectedCode: "INTERNAL_ERROR",
      expectedMessage: "hub rejected",
    },
  ])("HTTP 失败 $name 时独立归一化 code 与 message", async ({ error, expectedCode, expectedMessage }) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error }),
    }) satisfies ReloadResponse));

    const result = await callReload();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Error [${expectedCode}]: ${expectedMessage}\n` +
      "Hint: diagnostics.version 曾返回 browserId=chrome-uuid-1；本次 reload 请求被 vortex-server 拒绝，请依据错误信息处理。",
    );
  });

  it("非法 code 且缺 message 时只因 code 非法回退，并使用占位 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: { code: "RELOAD_TRIGGER_FAILED" } }),
    }) satisfies ReloadResponse));

    const result = await callReload();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Error [INTERNAL_ERROR]: reload trigger failed (HTTP 400)\n" +
      "Hint: diagnostics.version 曾返回 browserId=chrome-uuid-1；本次 reload 请求被 vortex-server 拒绝，请依据错误信息处理。",
    );
  });

  it("fetch 异常返回可恢复的 INTERNAL_ERROR，并指向检查 server 后重试", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }));

    const result = await callReload();
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toBe(
      "Error [INTERNAL_ERROR]: vortex-server unreachable at localhost:6800 (cannot trigger reload).\n" +
      "connect ECONNREFUSED\n" +
      "Hint: 确认 localhost:6800 的 vortex-server 正在运行后重试",
    );
    expect(text).toContain("vortex-server");
    expect(text).toContain("重试");
  });

  it("轮询超时返回 TIMEOUT，message 携带重载上下文且保留排查 hint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, targetStamp: "stamp-new" }),
    }) satisfies ReloadResponse));

    const result = await callReload();
    const text = textOf(result);
    const expectedHint =
      "buildStamp 未在超时内变化。可能:① chrome.runtime.reload() 未生效;" +
      "② Chrome 加载的扩展 dist 与本 server 服务的 dist 不是同一个(C1 路径错配)——" +
      "为当前 worktree 跑 `node packages/server/dist/bin/vortex-server.js install` 后重载扩展。";

    expect(result.isError).toBe(true);
    const escapedHint = expectedHint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(text).toMatch(
      new RegExp(
        "^Error \\[TIMEOUT\\]: vortex_dev_reload timed out waiting for buildStamp to change; " +
        "fromStamp=stamp-old; targetStamp=stamp-new; waitedMs=\\d+\\n" +
        `Hint: ${escapedHint}$`,
      ),
    );
  });
});
