import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NmRequest } from "@vortex-browser/shared";
import { ActionRouter } from "../src/lib/router.js";
import { registerTabHandlers } from "../src/handlers/tab.js";

function mkReq(tool: string, args: Record<string, unknown> = {}): NmRequest {
  return { type: "tool_request", tool, args, requestId: "r-1" };
}

// macOS 上关掉全部窗口后 app 仍在运行，扩展照常连着 hub，
// 但 chrome.tabs.create 会抛 "No current window"
function noWindowChrome(overrides: Record<string, unknown> = {}) {
  return {
    tabs: {
      create: vi.fn().mockRejectedValue(new Error("No current window")),
    },
    windows: {
      getAll: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({
        id: 9,
        tabs: [{ id: 42, url: "https://a.test/", title: "A" }],
      }),
    },
    ...overrides,
  };
}

describe("tab.create 在无窗口的浏览器上", () => {
  let router: ActionRouter;
  const original = globalThis.chrome;

  beforeEach(() => {
    router = new ActionRouter();
    registerTabHandlers(router);
  });

  afterEach(() => {
    globalThis.chrome = original;
  });

  it("回退到 windows.create 并返回新标签页", async () => {
    const fake = noWindowChrome();
    globalThis.chrome = fake as unknown as typeof chrome;

    const resp = await router.dispatch(mkReq("tab.create", { url: "https://a.test/" }));

    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ id: 42, url: "https://a.test/" });
    expect(fake.windows.create).toHaveBeenCalledTimes(1);
  });

  it("active=false 时新窗口不抢焦点", async () => {
    const fake = noWindowChrome();
    globalThis.chrome = fake as unknown as typeof chrome;

    await router.dispatch(mkReq("tab.create", { url: "https://a.test/", active: false }));

    expect(fake.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ focused: false }),
    );
  });

  it("有窗口时不回退，原样抛出 tabs.create 的错误", async () => {
    const fake = noWindowChrome({
      windows: {
        getAll: vi.fn().mockResolvedValue([{ id: 1 }]),
        create: vi.fn(),
      },
    });
    fake.tabs.create = vi.fn().mockRejectedValue(new Error("Invalid url"));
    globalThis.chrome = fake as unknown as typeof chrome;

    const resp = await router.dispatch(mkReq("tab.create", { url: "not-a-url" }));

    expect(resp.error).toBeDefined();
    expect((fake.windows as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it("正常有窗口时走 tabs.create，不多调 windows API", async () => {
    const fake = noWindowChrome();
    fake.tabs.create = vi.fn().mockResolvedValue({ id: 7, url: "https://b.test/", title: "B" });
    globalThis.chrome = fake as unknown as typeof chrome;

    const resp = await router.dispatch(mkReq("tab.create", { url: "https://b.test/" }));

    expect(resp.result).toMatchObject({ id: 7 });
    expect(fake.windows.getAll).not.toHaveBeenCalled();
    expect(fake.windows.create).not.toHaveBeenCalled();
  });
});
