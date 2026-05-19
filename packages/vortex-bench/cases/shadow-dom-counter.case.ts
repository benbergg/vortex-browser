// Fixture-based: playground/public/shadow-dom-counter.html uses a custom
// element with `attachShadow({ mode: 'open' })`. Complements invariant
// I22 (which mocks the CDP layer) by exercising the full real-Chrome
// pipeline against an actual open shadow root.
//
// Tested guarantee:
//   - vortex_observe surfaces interactive elements inside an open shadow
//     root via CDP's accessibility tree (which flattens shadow children
//     into the host node's subtree).
//   - vortex_act(click) with the captured ref hits the in-shadow button.
//   - State change inside the shadow propagates outward (the widget
//     mirrors its counter to a light-DOM [data-testid="result"] span).

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  // v0.8 hashed ref support: matches @eN / @fNeM / @<hash>:eN / @<hash>:fNeM
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "shadow-dom-counter",
  playgroundPath: "/shadow-dom-counter.html",
  async run(ctx) {
    // The custom element registers synchronously, so by the time
    // wait_for(idle, dom) fires from the runner harness it should be in
    // the snapshot. No extra warm-up.
    const snap = extractText(await ctx.call("vortex_observe", {}));

    // The in-shadow button has accessible name "Increment". If vortex
    // cannot see through the open shadow root, this fails fast.
    const btnRef = findRef(snap, "Increment");
    ctx.assert(
      btnRef !== null,
      `observe should surface in-shadow button "Increment". snapshot head:\n${snap.slice(0, 600)}`,
    );

    await ctx.call("vortex_act", {
      action: "click",
      target: btnRef,
    });

    // The shadow handler mirrors its counter into the light-DOM
    // [data-testid="result"] span, so assertResultContains polls
    // through the standard helper.
    await assertResultContains(ctx, "外部读数：1");
  },
};

export default def;
