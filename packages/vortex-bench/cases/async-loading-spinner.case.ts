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
import { extractText, readResult } from "./_helpers.js";

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

    // 2. Sanity: [data-testid="result"] is empty before the click. If
    //    this fails, the fixture or its previous-case residue is wrong —
    //    not the wait_for contract.
    const before = await readResult(ctx);
    ctx.assert(
      before.trim() === "",
      `result region should be empty before click, got: "${before}"`,
    );

    // 3. Click — the page handler synchronously swaps button→spinner and
    //    schedules a setTimeout(800ms) to render the final content.
    await ctx.call("vortex_act", { action: "click", target: btnRef });

    // 4. Wait for DOM to settle. The fixture's 800 ms gap is the part
    //    dom.waitSettled must NOT skip over. timeout=3000 leaves head-
    //    room for the 800 ms + the implementation's quietMs.
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 3000,
    });

    // 5. Immediate (no-retry) read. assertResultContains would mask a
    //    regression by polling for up to 3 s on its own; we want to
    //    catch wait_for returning early, so use the one-shot readResult.
    const after = await readResult(ctx);
    ctx.assert(
      after.includes("异步加载完成 3 items"),
      `vortex_wait_for(idle, dom) should have blocked until result region was populated. Read immediately after wait_for: "${after}"`,
    );
  },
};

export default def;
