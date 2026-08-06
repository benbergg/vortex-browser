import { describe, expect, it } from "vitest";
import type { BrowserEntry, SessionEntry } from "../src/registry.js";
import { allocate } from "../src/registry.js";

function browser(
  browserId: string,
  options: Partial<Pick<BrowserEntry, "connectedAt" | "nmConnected">> = {},
): BrowserEntry {
  return {
    browserId,
    label: browserId,
    ws: undefined,
    peerVersion: "test",
    connectedAt: options.connectedAt ?? 1,
    lastSeenAt: 1,
    nmConnected: options.nmConnected ?? true,
    sessions: new Set(),
    tabOwner: new Map(),
    opener: new Map(),
  };
}

function session(sessionId: string): SessionEntry {
  return {
    sessionId,
    role: "mcp",
    label: sessionId,
    ws: null,
    wireVersion: 2,
    connectedAt: 1,
    lastSeenAt: 1,
    browserId: null,
    lastBrowserId: null,
    rebindUntil: 0,
    buffer: [],
    ownedTabs: new Set(),
    currentTabId: null,
    claiming: null,
    pinned: false,
    strictTab: false,
  };
}

function browserMap(...entries: BrowserEntry[]): ReadonlyMap<string, BrowserEntry> {
  return new Map(entries.map((entry) => [entry.browserId, entry]));
}

const sleepingBrowserMap = browserMap(
  browser("sleeping", { connectedAt: 0, nmConnected: false }),
  browser("available"),
);

describe("allocate", () => {
  it("returns null when no browser is available", () => {
    expect(allocate(session("s1"), new Map())).toBeNull();
  });

  it("selects the only available browser", () => {
    expect(allocate(session("s1"), browserMap(browser("b1")))).toBe("b1");
  });

  it("splits two sessions across two browsers", () => {
    const b1 = browser("b1", { connectedAt: 1 });
    const b2 = browser("b2", { connectedAt: 2 });
    const s1 = session("s1");
    const s2 = session("s2");
    const browsers = browserMap(b1, b2);
    const first = allocate(s1, browsers);
    b1.sessions.add(s1.sessionId);
    const second = allocate(s2, browsers);

    expect([first, second]).toEqual(["b1", "b2"]);
  });

  it("shares only for the third session and picks the least-loaded browser", () => {
    const b1 = browser("b1", { connectedAt: 1 });
    const b2 = browser("b2", { connectedAt: 2 });
    const browsers = browserMap(b1, b2);
    const s1 = session("s1");
    const s2 = session("s2");
    const s3 = session("s3");

    b1.sessions.add(s1.sessionId);
    b2.sessions.add(s2.sessionId);
    const third = allocate(s3, browsers);

    expect(third).toBe("b1");
  });

  it("keeps a sticky session on its online browser", () => {
    const s = session("s1");
    s.browserId = "b2";

    expect(allocate(s, browserMap(browser("b1"), browser("b2")))).toBe("b2");
  });

  it("returns a restored last browser before load balancing", () => {
    const s = session("s1");
    s.lastBrowserId = "b2";
    const b1 = browser("b1");
    const b2 = browser("b2");
    b2.sessions.add("other-1");
    b2.sessions.add("other-2");

    expect(allocate(s, browserMap(b1, b2))).toBe("b2");
  });

  it("uses an online pinned browser", () => {
    const s = session("s1");
    s.pinned = true;
    s.browserId = "b2";

    expect(allocate(s, browserMap(browser("b1"), browser("b2")))).toBe("b2");
  });

  it("does not fall back when the pinned browser is offline", () => {
    const s = session("s1");
    s.pinned = true;
    s.browserId = "missing";

    expect(allocate(s, browserMap(browser("b1")))).toBeNull();
  });

  it("excludes browsers without an NM connection", () => {
    expect(
      allocate(
        session("s1"),
        browserMap(browser("offline", { nmConnected: false }), browser("online")),
      ),
    ).toBe("online");
  });

  it("uses a deterministic browserId tiebreak", () => {
    const browsers = browserMap(browser("z"), browser("a"));
    const results = Array.from({ length: 5 }, () => allocate(session("s1"), browsers));

    expect(results).toEqual(["a", "a", "a", "a", "a"]);
  });

  it("SW 休眠不触发改嫁：sticky 仍命中 map 中的 NM 断开浏览器", () => {
    const sticky = session("sticky");
    sticky.browserId = "sleeping";

    expect(allocate(sticky, sleepingBrowserMap)).toBe("sleeping");
  });

  it("SW 休眠不触发误分配：全新 session 走规则 4 时跳过 NM 断开浏览器", () => {
    expect(allocate(session("new"), sleepingBrowserMap)).toBe("available");
  });
});
