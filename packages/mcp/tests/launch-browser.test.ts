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
  // state 每次新建：冷却是模块级共享的，用例之间不能互相污染
  const base = () => ({
    installed: ["Google Chrome"],
    platform: "darwin",
    spawn: vi.fn(),
    acquireLock: () => true,
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
    timeoutMs: 30_000,
    state: { cooldownUntil: 0 },
  });

  it("零浏览器时拉起一次并轮询到就绪", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base(), probe, spawn });

    expect(result).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("open", ["-a", "Google Chrome"]);
  });

  it("已有浏览器时不拉起", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    expect(await ensureBrowserRunning({ ...base(), probe, spawn })).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("拿不到锁时不重复拉起，只轮询", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base(), probe, spawn, acquireLock: () => false });

    expect(result).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("超时返回 launched-timeout", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const result = await ensureBrowserRunning({ ...base(), probe, spawn: vi.fn(), timeoutMs: 3000 });
    expect(result).toBe("launched-timeout");
  });

  it("非 darwin 或无可拉起浏览器时返回 unsupported", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    expect(await ensureBrowserRunning({ ...base(), probe, platform: "linux" })).toBe("unsupported");
    expect(await ensureBrowserRunning({ ...base(), probe, platform: "win32" })).toBe("unsupported");
    expect(await ensureBrowserRunning({ ...base(), probe, installed: [] })).toBe("unsupported");
  });

  it("open 失败时返回 unsupported，不空等到超时", async () => {
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const spawn = vi.fn(() => { throw new Error("spawn open ENOENT"); });

    expect(await ensureBrowserRunning({ ...base(), probe, spawn })).toBe("unsupported");
  });

  // 抢到锁期间别人可能已经拉起来了，二次探测到就绪就不再 spawn
  it("拿锁后二次探测到就绪则不再拉起", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ browsers: [] })
      .mockResolvedValueOnce({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({ ...base(), probe, spawn, acquireLock: () => true });

    expect(result).toBe("ready");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("拉起超时后的冷却", () => {
  // 时钟只由 sleep 推进，既能让轮询终止又能精确控制冷却判定
  const clock = (start = 0) => {
    let t = start;
    return {
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
      advance: (ms: number) => { t += ms; },
    };
  };
  const cooling = () => ({
    installed: ["Google Chrome"],
    platform: "darwin",
    acquireLock: () => true,
    timeoutMs: 30_000,
    cooldownMs: 60_000,
  });

  it("超时后冷却期内不再 spawn、不再等满超时", async () => {
    const state = { cooldownUntil: 0 };
    const c = clock();
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const spawn = vi.fn();
    const opts = { ...cooling(), probe, spawn, now: c.now, sleep: c.sleep, state };

    expect(await ensureBrowserRunning(opts)).toBe("launched-timeout");
    expect(spawn).toHaveBeenCalledTimes(1);

    c.advance(5_000);
    const callsBefore = probe.mock.calls.length;

    expect(await ensureBrowserRunning(opts)).toBe("launched-timeout");
    expect(spawn).toHaveBeenCalledTimes(1);
    // 冷却期内只探一次就返回，不再走 30 秒轮询
    expect(probe.mock.calls.length - callsBefore).toBe(1);
  });

  it("冷却期内浏览器连上就立刻恢复并清冷却", async () => {
    const state = { cooldownUntil: 999_999 };
    const c = clock();
    const probe = vi.fn().mockResolvedValue({ browsers: [{ label: "Google Chrome" }] });
    const spawn = vi.fn();

    const result = await ensureBrowserRunning({
      ...cooling(), probe, spawn, now: c.now, sleep: c.sleep, state,
    });

    expect(result).toBe("ready");
    expect(state.cooldownUntil).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("冷却过期后重新尝试拉起", async () => {
    const state = { cooldownUntil: 10_000 };
    const c = clock(10_001);
    const probe = vi.fn().mockResolvedValue({ browsers: [] });
    const spawn = vi.fn();

    await ensureBrowserRunning({ ...cooling(), probe, spawn, now: c.now, sleep: c.sleep, state });

    expect(spawn).toHaveBeenCalledTimes(1);
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
