import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("probeLiveness", () => {
  it("executeScript 及时返回 → page-alive", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(1)).toBe("page-alive");
  });

  it("executeScript 永不 settle → page-unresponsive（有界，不挂）", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: { executeScript: () => new Promise(() => {}) },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    let out: string | undefined;
    const p = probeLiveness(1, 300).then((r) => { out = r; });
    await vi.advanceTimersByTimeAsync(400);
    await p;
    expect(out).toBe("page-unresponsive");
  });

  it("tab 已不存在 → tab-gone", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => { throw new Error("No tab with id: 9"); } },
      scripting: { executeScript: async () => [{ result: 1 }] },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(9)).toBe("tab-gone");
  });

  it("无 tabId 时不探活，按 page-alive 处理（tabless action）", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {};
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(undefined)).toBe("page-alive");
  });

  it("executeScript 快速 reject（无权限/非法页面）→ probe-failed，不得谎报 page-alive", async () => {
    vi.resetModules();
    (globalThis as any).chrome = {
      tabs: { get: async () => ({ id: 1, active: true }) },
      scripting: {
        executeScript: async () => {
          throw new Error("Cannot access contents of the page");
        },
      },
    };
    const { probeLiveness } = await import("../src/lib/liveness-probe.js");
    expect(await probeLiveness(1)).toBe("probe-failed");
  });
});
