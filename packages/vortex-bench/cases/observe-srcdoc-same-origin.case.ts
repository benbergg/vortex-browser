// e2e regression lock for https://github.com/benbergg/vortex/issues/15 #1
//
// Before the fix in handlers/observe.ts resolveTargetFrames, the
// `all-same-origin` branch compared `safeOrigin(frame.url) === mainOrigin`
// — and for `<iframe srcdoc>` that comparison ran "null" === "https://…",
// silently excluding srcdoc bodies from the frame set. The spec says
// srcdoc inherits its parent's origin (recursively), so the fix walks
// past opaque origins through the parent chain.
//
// Tested guarantee:
//   - observe({frames:"all-same-origin"}) on a page with one srcdoc
//     iframe surfaces BOTH the main frame's button AND the srcdoc's
//     inner button.
//   - The compact output's URL header reflects the main page (not
//     "about:srcdoc"), validating the issue #15 #2 fix in passing.

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "observe-srcdoc-same-origin",
  playgroundPath: "/srcdoc-same-origin.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(
      await ctx.call("vortex_observe", { frames: "all-same-origin" }),
    );

    // Header URL must be the playground page, not "about:srcdoc". A
    // regression in the primary-frame lock (issue #15 #2) would
    // re-promote the srcdoc to "primary" and surface about:srcdoc here.
    ctx.assert(
      snap.includes("srcdoc-same-origin.html") || snap.includes("URL: http"),
      `observe header should carry main-page URL. snapshot head:\n${snap.slice(0, 500)}`,
    );
    ctx.assert(
      !/^URL:\s*about:srcdoc/m.test(snap),
      `observe header must not be about:srcdoc. snapshot head:\n${snap.slice(0, 500)}`,
    );

    // Both buttons must be in the snapshot. The srcdoc-inner one only
    // appears if the srcdoc frame was included in the scan — that's
    // the regression this case locks.
    ctx.assert(
      snap.includes("Main frame button"),
      `observe(all-same-origin) should surface main frame button. snapshot head:\n${snap.slice(0, 600)}`,
    );
    ctx.assert(
      snap.includes("Srcdoc inner button"),
      `observe(all-same-origin) should surface srcdoc-inner button (issue #15 #1). snapshot head:\n${snap.slice(0, 600)}`,
    );
  },
};

export default def;
