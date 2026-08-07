/**
 * Author: qingwa
 * Description: Verifies dev-all readiness selection from the hub health snapshot.
 */
import { describe, expect, it } from "vitest";
import { pickReadyBrowser } from "../../../scripts/lib/hub-ready.mjs";

const extDist = "/worktree/packages/extension/dist";

function browser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    browserId: "browser-a",
    nmConnected: true,
    extDist,
    ...overrides,
  };
}

describe("pickReadyBrowser", () => {
  it.each([
    ["undefined health", undefined, extDist],
    ["null health", null, extDist],
    ["non-object health", "not-health", extDist],
    ["missing browsers", {}, extDist],
    ["non-array browsers", { browsers: {} }, extDist],
    ["empty browsers", { browsers: [] }, extDist],
    ["disconnected browser", { browsers: [browser({ nmConnected: false })] }, extDist],
    ["different worktree", { browsers: [browser({ extDist: "/other-worktree/packages/extension/dist" })] }, extDist],
  ])("returns null for %s", (_name, health, expectedExtDist) => {
    expect(pickReadyBrowser(health, expectedExtDist)).toBeNull();
  });

  it("returns the browser matching the connected state and extension dist", () => {
    const ready = browser();
    const health = {
      browsers: [
        browser({ browserId: "disconnected", nmConnected: false }),
        browser({ browserId: "other-worktree", extDist: "/other-worktree/packages/extension/dist" }),
        ready,
      ],
    };

    expect(pickReadyBrowser(health, extDist)).toBe(ready);
  });
});
