/**
 * Author: qingwa
 * Description: Verifies the shared browser-internal URL rule.
 *
 * 内部页（chrome:// 等）内容脚本注入不进去，hub 与 cli 必须用**同一个**判定把它们排除，
 * 否则 cli 会把内部页当显式 tabId 发出去，而 hub 的旧路径不会 —— 两条路口径不一致。
 */
import { describe, expect, it } from "vitest";
import { isInternalUrl } from "../src/index.js";

describe("shared isInternalUrl", () => {
  it.each([
    "chrome://newtab/",
    "chrome://downloads/",
    "chrome://downloads-manager/",
    "chrome-untrusted://newtab/",
    "chrome-devtools://devtools/bundled/inspector.html",
    "devtools://devtools/bundled/inspector.html",
    // Edge 各 channel 已由 install --all-channels 纳入，其内部页同样不可注入
    "edge://newtab/",
    "edge://settings/privacy",
    "edge://extensions/",
  ])("rejects %s", (url) => {
    expect(isInternalUrl(url)).toBe(true);
  });

  it.each([
    "https://example.test/edge://not-really",
    "https://edge.example.test/",
    "http://localhost:6800/",
    "about:blank",
    "",
  ])("still accepts %s", (url) => {
    expect(isInternalUrl(url)).toBe(false);
  });

  it("is case-insensitive on the scheme", () => {
    expect(isInternalUrl("CHROME://newtab/")).toBe(true);
    expect(isInternalUrl("  Chrome://NewTab/  ")).toBe(true);
    expect(isInternalUrl("Edge://newtab/")).toBe(true);
  });

  it("does not treat a non-string as internal", () => {
    expect(isInternalUrl(undefined)).toBe(false);
    expect(isInternalUrl(null)).toBe(false);
    expect(isInternalUrl(42)).toBe(false);
    expect(isInternalUrl({ url: "chrome://newtab/" })).toBe(false);
  });
});
