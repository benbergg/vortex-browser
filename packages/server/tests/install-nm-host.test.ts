import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * os 模块 mock：控制 platform() / homedir() 返回值，
 * 使 installNmHost 写入临时目录而非真实系统目录。
 */
vi.mock("os", async () => {
  const real = await vi.importActual<typeof import("os")>("os");
  return {
    ...real,
    // 用 getter 让各 it 里可以动态修改 __mockHomedir / __mockPlatform
    homedir: () => (globalThis as any).__mockHomedir ?? real.homedir(),
    platform: () => (globalThis as any).__mockPlatform ?? real.platform(),
  };
});

describe("installNmHost", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "vortex-test-home-"));
    (globalThis as any).__mockHomedir = tmpHome;
    // 默认使用真实 platform
    delete (globalThis as any).__mockPlatform;
  });

  afterEach(() => {
    delete (globalThis as any).__mockHomedir;
    delete (globalThis as any).__mockPlatform;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  // 延迟 import 使 mock 先生效
  async function load() {
    const mod = await import("../src/install-nm-host.js");
    return mod.installNmHost;
  }

  it("有效 extensionId 写入 manifest 内容正确", async () => {
    const installNmHost = await load();
    const extId = "abcdefghijklmnopabcdefghijklmnop";

    const result = installNmHost(extId);

    // 返回值结构
    expect(result.hostName).toBe("com.vortexbrowser.host");
    expect(result.manifestPath).toContain("com.vortexbrowser.host.json");
    expect(result.nativeHostPath).toMatch(/native-host\.sh$/);

    // manifest 文件存在且内容正确
    expect(existsSync(result.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    expect(manifest.name).toBe("com.vortexbrowser.host");
    expect(manifest.type).toBe("stdio");
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${extId}/`]);
    expect(manifest.path).toBe(result.nativeHostPath);
    expect(manifest.path).toMatch(/native-host\.sh$/);
  });

  it("darwin 平台：manifestPath 指向 Library/Application Support 目录", async () => {
    (globalThis as any).__mockPlatform = "darwin";
    const installNmHost = await load();
    const extId = "abcdefghijklmnopabcdefghijklmnop";

    const result = installNmHost(extId);

    expect(result.manifestPath).toContain(
      join("Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
    );
  });

  it("linux 平台：manifestPath 指向 .config/google-chrome 目录", async () => {
    (globalThis as any).__mockPlatform = "linux";
    const installNmHost = await load();
    const extId = "abcdefghijklmnopabcdefghijklmnop";

    const result = installNmHost(extId);

    expect(result.manifestPath).toContain(
      join(".config", "google-chrome", "NativeMessagingHosts")
    );
  });

  it("空 extensionId 抛出错误", async () => {
    const installNmHost = await load();
    expect(() => installNmHost("")).toThrow(/invalid.*extension/i);
  });

  it("非 32 位字母（太短）抛出错误", async () => {
    const installNmHost = await load();
    expect(() => installNmHost("abc")).toThrow(/invalid.*extension/i);
  });

  it("含大写字母的 ID 抛出错误", async () => {
    const installNmHost = await load();
    expect(() => installNmHost("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP")).toThrow(
      /invalid.*extension/i
    );
  });

  it("含数字的 ID 抛出错误", async () => {
    const installNmHost = await load();
    expect(() => installNmHost("abcdefghijklmnop1234567890abcdef")).toThrow(
      /invalid.*extension/i
    );
  });

  describe("--all-channels", () => {
    const extId = "abcdefghijklmnopabcdefghijklmnop";
    const appSupport = "Library/Application Support";

    /** 造出「该 channel 已安装」的痕迹:浏览器用户数据目录存在。 */
    const fakeInstalled = (...products: string[]) => {
      for (const p of products) {
        mkdirSync(join(tmpHome, appSupport, p), { recursive: true });
      }
    };

    beforeEach(() => {
      (globalThis as any).__mockPlatform = "darwin";
    });

    it("装到每个已存在的 channel,manifest 内容与单 channel 一致", async () => {
      fakeInstalled("Google/Chrome", "Microsoft Edge");
      const installNmHost = await load();

      const r = installNmHost(extId, { allChannels: true });

      expect(r.manifestPaths).toHaveLength(2);
      for (const p of r.manifestPaths) {
        expect(existsSync(p)).toBe(true);
        const m = JSON.parse(readFileSync(p, "utf-8"));
        expect(m.allowed_origins).toEqual([`chrome-extension://${extId}/`]);
        expect(m.path).toBe(r.nativeHostPath);
      }
      expect(r.manifestPaths.some((p) => p.includes("Microsoft Edge"))).toBe(true);
    });

    it("跳过未安装的 channel,不给用户目录留空壳", async () => {
      fakeInstalled("Google/Chrome");
      const installNmHost = await load();

      const r = installNmHost(extId, { allChannels: true });

      expect(r.manifestPaths).toHaveLength(1);
      expect(existsSync(join(tmpHome, appSupport, "Microsoft Edge"))).toBe(false);
      expect(existsSync(join(tmpHome, appSupport, "Google/Chrome Beta"))).toBe(false);
    });

    it("installed 报告每个 channel 的 label,供 CLI 打印", async () => {
      fakeInstalled("Google/Chrome", "Google/Chrome Canary", "Microsoft Edge Dev");
      const installNmHost = await load();

      const r = installNmHost(extId, { allChannels: true });

      expect(r.installed.map((c) => c.label)).toEqual([
        "Google Chrome",
        "Google Chrome Canary",
        "Microsoft Edge Dev",
      ]);
    });

    it("默认(不带 allChannels)只装 Chrome,Edge 装了也不碰", async () => {
      fakeInstalled("Google/Chrome", "Microsoft Edge");
      const installNmHost = await load();

      const r = installNmHost(extId);

      expect(r.manifestPaths).toEqual([r.manifestPath]);
      expect(r.manifestPath).toContain(join("Google", "Chrome"));
      expect(
        existsSync(join(tmpHome, appSupport, "Microsoft Edge", "NativeMessagingHosts")),
      ).toBe(false);
    });

    it("默认路径不依赖 Chrome 目录预先存在(全新机器也能装)", async () => {
      const installNmHost = await load();

      const r = installNmHost(extId);

      expect(existsSync(r.manifestPath)).toBe(true);
    });

    it("allChannels 下一个 channel 都没装则返回空,不抛错", async () => {
      const installNmHost = await load();

      const r = installNmHost(extId, { allChannels: true });

      expect(r.manifestPaths).toEqual([]);
      expect(r.installed).toEqual([]);
    });
  });
});
