import { describe, expect, it, vi } from "vitest";
import { NM_HOST_FILENAME } from "@vortex-browser/shared";
import { chooseBrowser, ensureBrowserRunning, installedBrowsers } from "../src/lib/launch-browser.js";

describe("chooseBrowser", () => {
  it("偏好优先，其次上次用过的，最后已装清单首项", () => {
    const installed = ["Google Chrome", "Microsoft Edge"];
    expect(chooseBrowser({ pref: "edge", lastUsed: "Google Chrome", installed })).toBe("Microsoft Edge");
    expect(chooseBrowser({ lastUsed: "Microsoft Edge", installed })).toBe("Microsoft Edge");
    expect(chooseBrowser({ installed })).toBe("Google Chrome");
  });

  it("一个都没装时返回 null", () => {
    expect(chooseBrowser({ pref: "chrome", installed: [] })).toBeNull();
  });
});

describe("ensureBrowserRunning", () => {
  const base = {
    installed: ["Google Chrome"],
    platform: "darwin",
    spawn: vi.fn(),
    acquireLock: () => true,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    timeoutMs: 30_000,
  };

  it("零浏览器时拉起一次并轮询到就绪", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base, probe, spawn });

    expect(result).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("open", ["-a", "Google Chrome"]);
  });

  it("已有浏览器时不拉起", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    expect(await ensureBrowserRunning({ ...base, probe, spawn })).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("拿不到锁时不重复拉起，只轮询", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base, probe, spawn, acquireLock: () => false });

    expect(result).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("超时返回 launched-timeout", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const result = await ensureBrowserRunning({ ...base, probe, spawn: vi.fn(), timeoutMs: 3000 });
    expect(result).toBe("launched-timeout");
  });

  it("非 darwin 或无可拉起浏览器时返回 unsupported", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    expect(await ensureBrowserRunning({ ...base, probe, platform: "linux" })).toBe("unsupported");
    expect(await ensureBrowserRunning({ ...base, probe, platform: "win32" })).toBe("unsupported");
    expect(await ensureBrowserRunning({ ...base, probe, installed: [] })).toBe("unsupported");
  });

  it("open 失败时返回 unsupported，不空等到超时", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const spawn = vi.fn(() => { throw new Error("spawn open ENOENT"); });

    expect(await ensureBrowserRunning({ ...base, probe, spawn })).toBe("unsupported");
  });

  // 抢到锁期间别人可能已经拉起来了，二次探测到就绪就不再 spawn
  it("拿锁后二次探测到就绪则不再拉起", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base, probe, spawn, acquireLock: () => true });

    expect(result).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("installedBrowsers", () => {
  it("按 app bundle 判断，与 open -a 的目标一致", () => {
    const exists = (p: string) => p === "/Applications/Microsoft Edge.app";
    expect(installedBrowsers("/Users/x", "darwin", exists)).toEqual(["Microsoft Edge"]);
  });

  it("认用户目录下的 app bundle", () => {
    const exists = (p: string) => p === "/Users/x/Applications/Chromium.app";
    expect(installedBrowsers("/Users/x", "darwin", exists)).toEqual(["Chromium"]);
  });

  // NM 安装 mkdir -p nmDir 会连带建出 profileDir，故这两个路径不能作判据
  it("不把 NM 安装留下的空 profileDir 当作已装", () => {
    const exists = (p: string) => p.includes("Library/Application Support") || p.endsWith(NM_HOST_FILENAME);
    expect(installedBrowsers("/Users/x", "darwin", exists)).toEqual([]);
  });

  it("非 darwin 返回空，拉起本就不支持", () => {
    expect(installedBrowsers("/home/x", "linux", () => true)).toEqual([]);
  });
});
