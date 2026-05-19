// Reuses the playground Vue SPA routes /el-radio-group ↔ /el-dropdown.
// The runner harness intentionally inserts an `about:blank` between cases
// because same-URL navigate in the Vue hash router does not trigger a
// remount (see run-case.ts comment). This case validates the related but
// distinct guarantee: cross-route navigate via vortex_navigate DOES
// trigger Vue router unmount, so a stateful value set on route A is
// gone after A → B → A.
//
// Regression scenarios this catches:
//   - vortex_navigate degrading to a no-op when the URL already
//     points at the playground origin (would leave page A mounted).
//   - A future change introducing <KeepAlive> in the playground App
//     wrapper (would persist A's state across the round-trip and
//     break every case that relies on the runner's about:blank reset).
//   - Vue router config drift that turns route changes into in-place
//     prop updates rather than unmount/remount.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText, readResult } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "spa-route-residue",
  // Runner navigates here first; the case body navigates away and back.
  playgroundPath: "/#/el-radio-group",
  async run(ctx) {
    // 1. Set state on route A by clicking radio "选项 B".
    const snapA0 = extractText(await ctx.call("vortex_observe", {}));
    const refB = findRef(snapA0, "选项 B");
    ctx.assert(
      refB !== null,
      `observe on /el-radio-group should surface "选项 B". snapshot head:\n${snapA0.slice(0, 500)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: refB });
    await assertResultContains(ctx, "选中：B");

    // 2. Cross-route navigate to /el-dropdown. NOT going through
    //    about:blank — that would mask the regression we want to catch.
    await ctx.call("vortex_navigate", {
      url: `${ctx.playgroundUrl}/#/el-dropdown`,
    });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 3000 });

    // 3. Verify we're actually on the dropdown route (page title says
    //    "el-dropdown") and no longer rendering radio-group content.
    const snapB = extractText(await ctx.call("vortex_observe", {}));
    ctx.assert(
      snapB.toLowerCase().includes("el-dropdown"),
      `cross-route navigate should render /el-dropdown. snapshot head:\n${snapB.slice(0, 500)}`,
    );
    ctx.assert(
      !snapB.includes("选项 B"),
      `route B should not still render radio-group content. snapshot head:\n${snapB.slice(0, 500)}`,
    );

    // 4. Navigate back to /el-radio-group. With Vue router default
    //    behavior (no KeepAlive), the component should remount fresh
    //    and `selected` ref should be back to its initial "" value,
    //    rendering "选中：(未选)" in the result region.
    await ctx.call("vortex_navigate", {
      url: `${ctx.playgroundUrl}/#/el-radio-group`,
    });
    await ctx.call("vortex_wait_for", { mode: "idle", value: "dom", timeout: 3000 });

    // 5. Strict check: state must be reset. assertResultContains would
    //    keep polling and could surface a delayed Vue remount as a
    //    pass; use one-shot readResult so a real residue regression
    //    fails the case immediately with the offending text attached.
    const resultA1 = await readResult(ctx);
    ctx.assert(
      resultA1.includes("(未选)"),
      `cross-route round-trip should reset radio-group state. After A→B→A, result was: "${resultA1}"`,
    );
    ctx.assert(
      !resultA1.includes("选中：B"),
      `radio-group state from route A leaked through cross-route round-trip. result: "${resultA1}"`,
    );
  },
};

export default def;
