// REGRESSION LOCK for https://github.com/benbergg/vortex/issues/18
//
// Status: KNOWN-FAIL until issue #18 is fixed. The fixture exercises the
// exact selector pattern flagged in the bug report: a `<div tabindex="0">`
// with no label, no ARIA role, and no text content. The current
// INTERACTIVE_SELECTORS list in packages/extension/src/handlers/observe.ts
// matches such elements via the trailing `[tabindex]:not([tabindex='-1'])`
// rule but has no post-filter to drop nameless containers, so they ride
// through into the snapshot as `[div]` lines without a quoted name.
//
// What this case asserts:
//   1. Positive control: "Click me" stays in the snapshot (so a regression
//      that drops ALL elements doesn't accidentally pass this).
//   2. `namelessDivCount == 0` — i.e. observe(frames=main) emitted no
//      `[div]` lines lacking a quoted name. Today: 3 (the fixture
//      contains 3 empty tabindex shells). When the bug is fixed, this
//      flips to 0 and the case starts passing.
//
// The exact noise count is also recorded as a customMetric so trend
// reports surface partial fixes (e.g. 3 → 1 → 0).

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "issue-18-nameless-div-noise",
  playgroundPath: "/nameless-tabindex-noise.html",
  async run(ctx) {
    // Explicit frames=main: defeats the v0.7.4 auto-fallback heuristic
    // (which would not trigger here anyway since the page has no iframes,
    // but pinning the parameter makes the regression scope clear).
    const snap = extractText(
      await ctx.call("vortex_observe", { frames: "main" }),
    );

    // Positive control: the real button must still be there.
    ctx.assert(
      snap.includes("Click me"),
      `observe should surface the positive-control button "Click me". snapshot head:\n${snap.slice(0, 500)}`,
    );

    // Element line format (see observe-render.ts:71-81):
    //   `@<ref> [<role>]<state-flags?><bbox?>` when name is empty
    //   `@<ref> [<role>] "<name>"<state-flags?><bbox?>` when name is set
    //
    // A nameless `[div]` is any line that starts with `@<ref> [div]` and
    // is NOT followed by `\s+"...` for the quoted name. Tolerates trailing
    // state flags like ` [active]` and bbox segments like ` bbox=[..]`.
    const namelessDivLines: string[] = [];
    for (const line of snap.split("\n")) {
      if (/^@\S+\s+\[div\](?!\s+")/.test(line)) {
        namelessDivLines.push(line);
      }
    }
    ctx.recordMetric("namelessDivCount", namelessDivLines.length);

    ctx.assert(
      namelessDivLines.length === 0,
      `Issue #18: vortex_observe(frames=main) should not emit nameless [div] lines. Found ${namelessDivLines.length}:\n${namelessDivLines.join("\n")}`,
    );
  },
};

export default def;
