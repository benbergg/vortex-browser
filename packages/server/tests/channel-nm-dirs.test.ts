import { describe, it, expect } from "vitest";
import { join } from "path";
import { channelNmDirs, parseInstallArgs } from "../src/install-nm-host.js";

describe("channelNmDirs", () => {
  it("darwin 覆盖 Chrome 全 channel 与 Edge 全 channel", () => {
    const dirs = channelNmDirs("/home/x", "darwin");
    const labels = dirs.map((d) => d.label);

    expect(labels).toEqual([
      "Google Chrome",
      "Google Chrome Beta",
      "Google Chrome Dev",
      "Google Chrome Canary",
      "Google Chrome for Testing",
      "Chromium",
      "Microsoft Edge",
      "Microsoft Edge Beta",
      "Microsoft Edge Dev",
      "Microsoft Edge Canary",
    ]);
  });

  it("Chrome stable 必须排第一:默认单 channel 安装靠它保持原行为", () => {
    for (const plat of ["darwin", "linux"]) {
      expect(channelNmDirs("/home/x", plat)[0].label).toBe("Google Chrome");
    }
  });

  it("darwin 路径为 Library/Application Support/<产品>/NativeMessagingHosts", () => {
    const dirs = channelNmDirs("/home/x", "darwin");
    const chrome = dirs.find((d) => d.label === "Google Chrome")!;
    const edge = dirs.find((d) => d.label === "Microsoft Edge")!;

    expect(chrome.profileDir).toBe(
      join("/home/x", "Library/Application Support/Google/Chrome"),
    );
    expect(chrome.nmDir).toBe(join(chrome.profileDir, "NativeMessagingHosts"));
    expect(edge.profileDir).toBe(
      join("/home/x", "Library/Application Support/Microsoft Edge"),
    );
  });

  it("linux 路径为 .config/<产品>/NativeMessagingHosts,Dev channel 名为 unstable", () => {
    const dirs = channelNmDirs("/home/x", "linux");
    const byLabel = new Map(dirs.map((d) => [d.label, d]));

    expect(byLabel.get("Google Chrome")!.nmDir).toBe(
      join("/home/x", ".config/google-chrome/NativeMessagingHosts"),
    );
    expect(byLabel.get("Google Chrome Dev")!.profileDir).toBe(
      join("/home/x", ".config/google-chrome-unstable"),
    );
    expect(byLabel.get("Microsoft Edge")!.profileDir).toBe(
      join("/home/x", ".config/microsoft-edge"),
    );
  });

  it("linux 无 Canary/for Testing(这两个 channel 不发布 Linux 版)", () => {
    const labels = channelNmDirs("/home/x", "linux").map((d) => d.label);
    expect(labels).not.toContain("Google Chrome Canary");
    expect(labels).not.toContain("Google Chrome for Testing");
    expect(labels).not.toContain("Microsoft Edge Canary");
  });

  it("非 darwin/linux 平台退化为 linux 布局而非抛错", () => {
    expect(channelNmDirs("/home/x", "freebsd")).toEqual(
      channelNmDirs("/home/x", "linux"),
    );
  });
});

describe("parseInstallArgs", () => {
  // Chrome 启动 NM host 时会追加 chrome-extension://<id>/ 位置参数,
  // 解析必须只认 install 后的裸 ID,别把 flag 或 origin 当 ID。
  const argv = (...rest: string[]) => ["node", "vortex-server", "install", ...rest];

  it("裸调用取默认 ID、单 channel", () => {
    expect(parseInstallArgs(argv())).toEqual({
      extensionId: "fbonhjdohmkcejfgmaicnkknpfafihnd",
      usingDefault: true,
      allChannels: false,
    });
  });

  it("--all-channels 不被当作 extension ID", () => {
    expect(parseInstallArgs(argv("--all-channels"))).toEqual({
      extensionId: "fbonhjdohmkcejfgmaicnkknpfafihnd",
      usingDefault: true,
      allChannels: true,
    });
  });

  it("显式 ID 与 --all-channels 可同时给出,顺序无关", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const expected = { extensionId: id, usingDefault: false, allChannels: true };
    expect(parseInstallArgs(argv(id, "--all-channels"))).toEqual(expected);
    expect(parseInstallArgs(argv("--all-channels", id))).toEqual(expected);
  });

  it("chrome-extension:// origin 参数不被当作 ID", () => {
    expect(
      parseInstallArgs(argv("chrome-extension://fbonhjdohmkcejfgmaicnkknpfafihnd/")),
    ).toEqual({
      extensionId: "fbonhjdohmkcejfgmaicnkknpfafihnd",
      usingDefault: true,
      allChannels: false,
    });
  });
});
