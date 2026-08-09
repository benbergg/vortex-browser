import { describe, expect, it } from "vitest";
import { matchBrowser } from "../src/browser-match.js";
import { browserMap, makeBrowser } from "./browser-fixture.js";

const chrome = makeBrowser("uuid-chrome", { label: "Google Chrome", connectedAt: 1 });
const edge = makeBrowser("uuid-edge", { label: "Microsoft Edge", connectedAt: 2 });

describe("matchBrowser", () => {
  it("matches an exact browserId", () => {
    expect(matchBrowser("uuid-edge", browserMap(chrome, edge))?.browserId).toBe("uuid-edge");
  });

  it("matches a label case-insensitively", () => {
    expect(matchBrowser("microsoft edge", browserMap(chrome, edge))?.browserId).toBe("uuid-edge");
  });

  it("matches a label substring", () => {
    expect(matchBrowser("edge", browserMap(chrome, edge))?.browserId).toBe("uuid-edge");
  });

  it("prefers the least loaded browser when a label matches several", () => {
    const busy = makeBrowser("uuid-a", { label: "Google Chrome", sessions: new Set(["s1"]) });
    const idle = makeBrowser("uuid-b", { label: "Google Chrome", connectedAt: 9 });
    expect(matchBrowser("chrome", browserMap(busy, idle))?.browserId).toBe("uuid-b");
  });

  // 匹配只看在册，NM 瞬时断流仍命中，请求走缓冲而不是立刻报错
  it("still matches a registered browser whose native messaging dropped", () => {
    const sleeping = makeBrowser("uuid-edge", { label: "Microsoft Edge", nmConnected: false });
    expect(matchBrowser("edge", browserMap(sleeping))?.browserId).toBe("uuid-edge");
  });

  it("returns null for an unknown preference or empty string", () => {
    expect(matchBrowser("firefox", browserMap(chrome, edge))).toBeNull();
    expect(matchBrowser("", browserMap(chrome, edge))).toBeNull();
  });
});
