import { describe, expect, it } from "vitest";
import { parseObserveSnapshot } from "../src/runner/observe-parser.js";

// Frame details must not introduce a second unqualified URL:/Viewport: header:
// the existing parser treats those lines as main-page metadata.
describe("observe frame metadata and legacy headers", () => {
  it.each([
    '- button "Nested" [ref=@abcd:f29e0]',
    '@abcd:f29e0 [button] "Nested"',
  ])("retains main URL and viewport alongside frame details: %s", (row) => {
    const text = `SnapshotId: snap-frame
URL: https://main.example/
Title: Main
Viewport: 1200x800, scrollY=10/1600
# frame 29 parent=17 url=https://nested.example/ title=Nested viewport=400x600

${row}`;
    const parsed = parseObserveSnapshot(text);
    expect(parsed.header).toMatchObject({
      snapshotId: "snap-frame", url: "https://main.example/", title: "Main",
      viewport: { width: 1200, height: 800, scrollY: 10, scrollHeight: 1600 },
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ frameId: 29, name: "Nested" });
  });
});
