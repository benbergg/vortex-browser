import { describe, expect, it } from "vitest";
import { renderObserveCompact, renderObserveTree } from "../src/lib/observe-render.js";

const snapshot: any = {
  snapshotId: "frame-snapshot", url: "https://main.example/", title: "Main",
  viewport: { width: 1200, height: 800, scrollY: 10, scrollHeight: 1600 },
  frames: [{ frameId: 29, parentFrameId: 17, url: "https://nested.example/", title: "Nested page", viewport: { width: 400, height: 600, scrollY: 0, scrollHeight: 600 }, offset: { x: 0, y: 0 }, elementCount: 1, truncated: false, scanned: true }],
  elements: [{ index: 0, frameId: 29, tag: "button", role: "button", name: "Open", semanticSource: "dom" }],
};

describe("frame metadata rendering", () => {
  it.each([renderObserveTree, renderObserveCompact])("preserves main headers and exposes selected frame details", (render) => {
    const text = render(snapshot, null);
    expect(text).toContain("URL: https://main.example/");
    expect(text).toContain("Viewport: 1200x800, scrollY=10/1600");
    expect(text).toContain("https://nested.example/");
    expect(text).toContain("Nested page");
    expect(text).toMatch(/400\s*x\s*600/);
    expect(text).toMatch(/\bdom\b/i);
  });
});
