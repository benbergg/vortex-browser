import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchTrustedStatus, requestRelaunch, statusLabel } from "../src/popup.js";

function stubBrowserId(browserId: string | null): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn().mockResolvedValue(browserId === null ? {} : { vortexBrowserId: browserId }),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
}

describe("popup 纯逻辑", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubBrowserId("browser-self");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetchTrustedStatus 带上自身 browserId,多浏览器下才不会被判无关", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ trustedMode: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTrustedStatus("http://h");

    expect(fetchMock).toHaveBeenCalledWith("http://h/trusted-mode?browserId=browser-self");
  });

  it("requestRelaunch 带上自身 browserId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await requestRelaunch("http://h");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://h/relaunch-trusted?browserId=browser-self",
      { method: "POST" },
    );
  });

  it("fetchTrustedStatus 成功 → connected+trustedMode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ trustedMode: true }) }));
    expect(await fetchTrustedStatus("http://h")).toEqual({ connected: true, trustedMode: true });
  });

  it("fetchTrustedStatus fetch 抛错 → 未连接", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("conn refused")));
    expect(await fetchTrustedStatus("http://h")).toEqual({ connected: false, trustedMode: false });
  });

  it("fetchTrustedStatus 非 2xx → 未连接", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }));
    expect(await fetchTrustedStatus("http://h")).toEqual({ connected: false, trustedMode: false });
  });

  it("requestRelaunch POST 成功 → true", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestRelaunch("http://h")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://h/relaunch-trusted?browserId=browser-self",
      { method: "POST" },
    );
  });

  it("requestRelaunch 抛错 → false", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    expect(await requestRelaunch("http://h")).toBe(false);
  });

  it("statusLabel 三态", () => {
    expect(statusLabel({ connected: false, trustedMode: false })).toContain("未连接");
    expect(statusLabel({ connected: true, trustedMode: true })).toContain("trusted");
    expect(statusLabel({ connected: true, trustedMode: false })).toContain("普通");
  });
});
