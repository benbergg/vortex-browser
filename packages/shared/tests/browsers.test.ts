import { describe, expect, it } from "vitest";
import { browserChannels, launchCommand, NM_HOST_FILENAME } from "../src/browsers.js";

describe("browserChannels", () => {
  it("puts Chrome stable first on darwin", () => {
    const list = browserChannels("/Users/x", "darwin");
    expect(list[0].label).toBe("Google Chrome");
    expect(list[0].nmDir).toBe("/Users/x/Library/Application Support/Google/Chrome/NativeMessagingHosts");
  });

  it("drops mac-only channels on linux", () => {
    const labels = browserChannels("/home/x", "linux").map((c) => c.label);
    expect(labels).toContain("Google Chrome");
    expect(labels).not.toContain("Google Chrome Canary");
  });
});

describe("launchCommand", () => {
  it("builds an open -a command for the three stable browsers", () => {
    expect(launchCommand("Google Chrome", "darwin")).toEqual({ cmd: "open", args: ["-a", "Google Chrome"] });
    expect(launchCommand("Microsoft Edge", "darwin")).toEqual({ cmd: "open", args: ["-a", "Microsoft Edge"] });
    expect(launchCommand("Chromium", "darwin")).toEqual({ cmd: "open", args: ["-a", "Chromium"] });
  });

  // 扩展只报通用品牌名，Beta/Dev/Canary 选出来也无法与回读对齐
  it("refuses non-stable channels and non-darwin platforms", () => {
    expect(launchCommand("Google Chrome Beta", "darwin")).toBeNull();
    expect(launchCommand("Google Chrome", "linux")).toBeNull();
    expect(launchCommand("Firefox", "darwin")).toBeNull();
  });
});

it("exposes the native messaging manifest filename", () => {
  expect(NM_HOST_FILENAME).toBe("com.vortexbrowser.host.json");
});
