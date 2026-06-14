import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the [draggable=true] selector
 * (2026-06-14 真实站评测 the-internet/drag_and_drop).
 *
 * Without this entry in INTERACTIVE_SELECTORS, observe misses native
 * HTML5 draggable elements wired purely via the `draggable` attribute:
 *
 *   <div id="column-a" draggable="true">  (kanban / file managers / sortable)
 *
 * These elements carry no semantic role, no tabindex, no [onclick], and
 * usually no cursor:pointer CSS — so neither the static whitelist nor the
 * cursor:pointer fallback catches them. The result: observe surfaces 0 refs
 * for the drag targets, breaking the标志性 observe→ref→vortex_drag flow
 * (the drag tool itself works with raw selectors, but agents driving by
 * observe can't discover the targets).
 *
 * Only the explicit `draggable="true"` form is interactive — `draggable`
 * is an enumerated (not boolean) attribute, so `draggable=""` /
 * `draggable="false"` must NOT match. Native img/a are draggable by
 * default but already covered by a[href]; this entry targets custom
 * draggable containers.
 *
 * Why source-level: same rationale as the [onclick] lock — mocking a full
 * jsdom tree + stubbing chrome.scripting.executeScript adds noise without
 * proving the selector list is authoritative. We just hard-lock the string.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe [draggable=true] selector (@since 2026-06-14 real-site eval)", () => {
  it("INTERACTIVE_SELECTORS includes the [draggable=true] attribute selector", () => {
    expect(OBSERVE_SRC).toMatch(/INTERACTIVE_SELECTORS\s*=\s*\[[\s\S]*?"\[draggable=true\]"/);
  });

  it("[draggable=true] sits in the same array as the semantic selectors", () => {
    const arrayMatch = OBSERVE_SRC.match(
      /const INTERACTIVE_SELECTORS\s*=\s*\[([\s\S]*?)\]\.join\(",",?\s*\);?/,
    );
    expect(arrayMatch).not.toBeNull();
    expect(arrayMatch![1]).toContain('"[draggable=true]"');
  });

  it("targets only the explicit true form (not bare/false draggable)", () => {
    // 防回归成 "[draggable]"(会误收 draggable="false" 的显式禁拖元素)
    expect(OBSERVE_SRC).not.toMatch(/INTERACTIVE_SELECTORS\s*=\s*\[[\s\S]*?"\[draggable\]"/);
  });
});
