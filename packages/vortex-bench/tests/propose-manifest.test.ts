// packages/vortex-bench/tests/propose-manifest.test.ts
import { describe, it, expect } from "vitest";
import { proposeManifest } from "../src/runner/propose-manifest.js";
import type { RawCandidate } from "../src/snapshot-types.js";
import type { ObserveRow } from "../src/scan-types.js";

const meta = { fixture: "demo", path: "/synth/demo.html", source: "https://x.com/p", capturedAt: "2026-05-26T00:00:00Z" };
const cand = (id: string, bbox: [number, number, number, number], name = "x", pattern = "native"): RawCandidate =>
  ({ id, role: "button", name, pattern, bbox });
const row = (bbox: ObserveRow["bbox"], name = "x"): ObserveRow =>
  ({ ref: "@" + name, role: "button", name, flags: [], bbox, frameId: 0 });

describe("proposeManifest", () => {
  it("候选与 observe 行几何命中 → agree", () => {
    const m = proposeManifest([cand("c0", [10, 10, 20, 20])], [row([12, 12, 16, 16])], meta);
    const e = m.entries.find((x) => x.id === "c0")!;
    expect(e._review).toBe("agree");
    expect(e.interactive).toBe(true);
  });

  it("候选无 observe 命中 → observe-missed(最高价值)", () => {
    const m = proposeManifest([cand("c0", [10, 10, 20, 20])], [], meta);
    const e = m.entries.find((x) => x.id === "c0")!;
    expect(e._review).toBe("observe-missed");
  });

  it("observe 行无候选命中 → observe-extra(joinBy:name)", () => {
    const m = proposeManifest([], [row([500, 500, 10, 10], "孤儿")], meta);
    const e = m.entries.find((x) => x._review === "observe-extra")!;
    expect(e).toBeDefined();
    expect(e.joinBy).toBe("name");
    expect(e.expectedName).toBe("孤儿");
  });

  it("排序:observe-missed → observe-extra → agree", () => {
    const m = proposeManifest(
      [cand("agreeC", [10, 10, 20, 20]), cand("missC", [200, 200, 20, 20])],
      [row([12, 12, 16, 16], "x"), row([900, 900, 10, 10], "孤儿")],
      meta,
    );
    const reviews = m.entries.map((e) => e._review);
    expect(reviews[0]).toBe("observe-missed");
    expect(reviews[reviews.length - 1]).toBe("agree");
    expect(reviews).toContain("observe-extra");
  });

  it("manifest 元数据:_proposed/source/capturedAt", () => {
    const m = proposeManifest([cand("c0", [10, 10, 20, 20])], [], meta);
    expect(m._proposed).toBe(true);
    expect(m.source).toBe("https://x.com/p");
    expect(m.capturedAt).toBe("2026-05-26T00:00:00Z");
    expect(m.fixture).toBe("demo");
    expect(m.path).toBe("/synth/demo.html");
  });
});
