import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
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
});
