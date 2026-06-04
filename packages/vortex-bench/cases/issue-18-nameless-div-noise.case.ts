// REGRESSION LOCK for https://github.com/benbergg/vortex/issues/18
//
// Status: CURRENTLY PASSING — the fix is already live. Issue #18 was
// reported during the 2026-05-02 testc.bytenew.com dogfood session and
// shipped as BUG-3 of the v0.7 dogfood batch (merged to main as
// `ca43a53` PR #19 the same day; the per-step feature-branch commit is
// `7af7d43`). The issue ticket was filed 10 days later from the lagging
// dogfood notes and was never closed against the fix.
//
// The post-filter that handles this lives at
// `packages/extension/src/handlers/observe.ts` line 649-671 (see the
// comment marked "BUG-3" there): in filter='interactive' mode, an
// element matched only structurally (e.g. via the trailing
// `[tabindex]:not([tabindex='-1'])` selector) is dropped unless it
// has a form-like tag, an explicit role, an aria-label, or a non-empty
// accessible name.
//
// What this case asserts:
//   1. Positive control: "Click me" stays in the snapshot (so a future
//      regression that drops ALL elements doesn't accidentally pass).
//   2. `namelessDivCount == 0` — observe(frames=main) emits zero `[div]`
//      lines lacking a quoted name. The fixture intentionally plants
//      3 nameless `<div tabindex="0">` shells exactly matching the
//      bug pattern; the test fails immediately with the offending lines
//      attached to the failure message if the filter ever regresses.
//
// The exact noise count is also recorded as `customMetric.namelessDivCount`
// so trend reports show a partial regression (e.g. 0 → 2 → 3) before the
// strict assertion flips red.

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "issue-18-nameless-div-noise",
  playgroundPath: "/nameless-tabindex-noise.html",
  tier: "medium",
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
