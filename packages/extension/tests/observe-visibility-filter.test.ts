import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression lock for the visibility:hidden filter added in
 * vortex-bench/cases/visibility-hidden-megamenu (Round 0 dogfood
 * 2026-05-20). Without this filter, observe surfaces
 * `visibility:hidden` elements that:
 *
 *   - still claim layout space (rect.width/height > 0)
 *   - return empty innerText (visibility:hidden propagates)
 *   - degrade to CSS-module class garbage as accessible name
 *     (e.g. notion.com/help's `navItem_navItem_` leak)
 *
 * Source-level contract: the candidate loop must check
 * getComputedStyle().visibility and skip 'hidden' / 'collapse'
 * BEFORE entering the inViewport + occlusion stages.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const OBSERVE_SRC = readFileSync(
  join(__dirname, "..", "src", "handlers", "observe.ts"),
  "utf8",
);

describe("observe visibility filter (@since 0.8.x Round-0 Notion dogfood)", () => {
  it("calls getComputedStyle on the candidate", () => {
    expect(OBSERVE_SRC).toMatch(/getComputedStyle\(htmlEl\)/);
  });

  it("skips visibility:hidden candidates with `continue`", () => {
    // The exact branch — visibility check that emits `continue`.
    // Match either single-string or boolean-or chain to be tolerant.
    expect(OBSERVE_SRC).toMatch(
      /computedStyle\.visibility\s*===\s*["']hidden["']/,
    );
  });

  it("also skips visibility:collapse (table/flex hidden rows)", () => {
    expect(OBSERVE_SRC).toMatch(
      /computedStyle\.visibility\s*===\s*["']collapse["']/,
    );
  });

  it("visibility check runs before the inViewport guard", () => {
    // The block ordering matters — bail BEFORE we waste an
    // elementFromPoint reflow on an unactionable element.
    const visIdx = OBSERVE_SRC.search(/computedStyle\.visibility\s*===\s*["']hidden["']/);
    const viewportIdx = OBSERVE_SRC.search(/const inViewport =\n\s+rect\.top/);
    expect(visIdx).toBeGreaterThan(0);
    expect(viewportIdx).toBeGreaterThan(0);
    expect(visIdx).toBeLessThan(viewportIdx);
  });

  it("visibility check runs after the zero-rect guard (cheaper bail comes first)", () => {
    const rectGuardIdx = OBSERVE_SRC.search(/rect\.width\s*===\s*0\s*\|\|\s*rect\.height\s*===\s*0/);
    const visIdx = OBSERVE_SRC.search(/computedStyle\.visibility\s*===\s*["']hidden["']/);
    expect(rectGuardIdx).toBeGreaterThan(0);
    expect(visIdx).toBeGreaterThan(0);
    expect(rectGuardIdx).toBeLessThan(visIdx);
  });
});
