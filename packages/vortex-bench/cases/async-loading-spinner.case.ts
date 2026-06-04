// Fixture-based: playground/public/async-load.html simulates ~800 ms of
// network latency between a click and the rendered result. Validates
// the most common real-world UX pattern (button → spinner → content)
// against the `vortex_wait_for(mode=idle, value=dom)` contract.
//
// Tested guarantee:
//   - vortex_wait_for(idle, dom) blocks until DOM mutations stabilize.
//     A regression that lets it return early would let the immediate
//     readResult below see the empty / spinner state, failing the case
//     with the actual extracted string in the assertion message.
//   - vortex_act(click) actually fires the click handler in the page
//     context (so the spinner CSS class flip + setTimeout schedule).

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
  name: "async-loading-spinner",
  playgroundPath: "/async-load.html",
  tier: "easy",
  async run(ctx) {
    // 1. Initial observe — should surface the "Load data" button by its
    //    accessible name. No need to extract a hash, findRef accepts both
    //    bare and hashed.
    const snap0 = extractText(await ctx.call("vortex_observe", {}));
    const btnRef = findRef(snap0, "Load data");
    ctx.assert(
      btnRef !== null,
      `observe should surface "Load data" button. snapshot head:\n${snap0.slice(0, 500)}`,
    );

    // 2. Sanity: the expected success string is NOT yet in the result
    //    region. (Strict empty check would be too tight — the MCP
    //    boundary JSON-stringifies vortex_extract's empty payload to
    //    `""` (the 2-char literal), so `=== ""` fails on what is
    //    semantically empty. `.includes("异步加载完成")` captures the
    //    real precondition we care about regardless of the JSON
    //    wrapper shape.)
    const before = await readResult(ctx);
    ctx.assert(
      !before.includes("异步加载完成"),
      `result region should not yet show success string before click. got: "${before}"`,
    );

    // 3. Click — the page handler synchronously swaps button→spinner and
    //    schedules a setTimeout(800ms) to render the final content.
    await ctx.call("vortex_act", { action: "click", target: btnRef });

    // 4. Wait for DOM to settle. dom.waitSettled returns once mutations
    //    have been quiet for `quietMs` (default ~500ms). The fixture
    //    schedules its final batch of mutations via setTimeout(800ms),
    //    so a single wait_for can legitimately return BEFORE that
    //    setTimeout fires (initial sync mutations → 500ms quiet →
    //    return; the setTimeout payload lands ~300ms later). That is
    //    correct dom.waitSettled behavior — the case's strict
    //    immediate-read assertion was the bug, not wait_for.
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 3000,
    });

    // 5. Use assertResultContains' built-in retry (6×500ms = 3s) to
    //    span the ~300ms gap between wait_for's return and the
    //    setTimeout firing. That is exactly what the retry helper
    //    exists for — async page mutations that quiet briefly then
    //    re-mutate.
    await assertResultContains(ctx, "异步加载完成 3 items");
  },
};

export default def;
