// packages/mcp/tests/observe-identity-cache.test.ts
import { describe, it, expect } from "vitest";
import { renderObserveCompact } from "../src/lib/observe-render.js";
import { lookupIdentity } from "../src/lib/observe-render.js";

describe("lookupIdentity", () => {
  it("render 后可按 frameId:index 取回 role::name::frameId", () => {
    const data = {
      snapshotId: "snapX", url: "http://t", elements: [
        { index: 5, frameId: 0, role: "button", name: "Submit" },
      ], frames: [],
    } as any;
    renderObserveCompact(data, "ab12");
    expect(lookupIdentity("snapX", 0, 5)).toBe("button::Submit::0");
    expect(lookupIdentity("snapX", 0, 99)).toBeNull();
    expect(lookupIdentity("nope", 0, 5)).toBeNull();
  });
});
