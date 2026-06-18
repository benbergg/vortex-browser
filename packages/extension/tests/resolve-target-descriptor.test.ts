import { describe, it, expect } from "vitest";
import { setSnapshot } from "../src/lib/snapshot-store.js";
import { resolveTarget } from "../src/lib/resolve-target.js";

describe("resolveTarget descriptor passthrough", () => {
  it("returns stored role+name as descriptor", () => {
    setSnapshot("snap_t1", {
      tabId: 1, frameId: 0, capturedAt: Date.now(),
      elements: [{ index: 3, selector: "#a", frameId: 0, role: "button", name: "Submit" }],
    });
    const r = resolveTarget({ index: 3, snapshotId: "snap_t1" });
    expect(r.selector).toBe("#a");
    expect(r.descriptor).toEqual({ role: "button", name: "Submit" });
  });

  it("descriptor undefined when role/name absent (backward compat)", () => {
    setSnapshot("snap_t2", {
      tabId: 1, frameId: 0, capturedAt: Date.now(),
      elements: [{ index: 0, selector: "#b", frameId: 0 }],
    });
    expect(resolveTarget({ index: 0, snapshotId: "snap_t2" }).descriptor).toBeUndefined();
  });
});
