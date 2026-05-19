// Fills the public `vortex_evaluate` 0-coverage gap. The tool is used
// extensively as a fallback (via `ctx.fallbackEvaluate`) across other
// cases, but no dedicated case until now exercised the direct
// public-path semantics:
//   - js.evaluate (sync) returns whatever `eval(code)` evaluates to,
//     JSON-stringified at the MCP boundary
//   - js.evaluateAsync (async:true) wraps `code` in `async () => { ... }`
//     so callers can `return await <Promise>`
//
// Tested guarantee:
//   - Sync path returns simple values (string global, arithmetic).
//   - Async path actually awaits a page-side Promise rather than
//     returning before resolution.

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "vortex-evaluate",
  playgroundPath: "/evaluate-globals.html",
  async run(ctx) {
    // 1. Sync — read a window global string. The fixture's inline
    //    <script> runs synchronously on load, so by the time the
    //    runner's wait_for(idle, dom) returns, the global is set.
    const r1 = await ctx.call("vortex_evaluate", {
      code: "window.__vortexBenchValue",
    });
    const t1 = extractText(r1);
    ctx.assert(
      t1.includes("magic-value"),
      `sync vortex_evaluate should return window.__vortexBenchValue. response: "${t1}"`,
    );

    // 2. Sync — arithmetic + string concat. Distinctive value ("sync-6")
    //    so the substring match cannot collide with anything else the
    //    MCP boundary embeds in the response (snapshotId / timestamp / …).
    const r2 = await ctx.call("vortex_evaluate", {
      code: '"sync-" + (1 + 2 + 3)',
    });
    const t2 = extractText(r2);
    ctx.assert(
      t2.includes("sync-6"),
      `sync vortex_evaluate should return "sync-6". response: "${t2}"`,
    );

    // 3. Async — wrap code in async () => { ... }, await a page-side
    //    Promise that resolves after ~200 ms. A regression that
    //    returned before the await (e.g. swapped to evaluate sync,
    //    or dropped the await keyword) would surface here because
    //    the response would not contain "slow-result".
    const r3 = await ctx.call("vortex_evaluate", {
      code: "return await window.__vortexBenchSlowFetch();",
      async: true,
    });
    const t3 = extractText(r3);
    ctx.assert(
      t3.includes("slow-result"),
      `async vortex_evaluate should await the Promise. response: "${t3}"`,
    );
  },
};

export default def;
