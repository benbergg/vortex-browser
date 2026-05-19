// Fills the public `vortex_press` combo 0-coverage gap. The schema's
// description has always advertised that `Ctrl+S`-style expressions
// work; up to v0.8.x the PRESS handler only handled single keys and
// silently ignored modifier prefixes. The combo-aware path landed in
// the same commit as this case.
//
// Tested guarantee:
//   - vortex_press({ key: "Enter" }) — single key, no modifiers.
//   - vortex_press({ key: "Ctrl+s" }) — Ctrl flag MUST reach the
//     page-side keydown event with key="s".
//   - vortex_press({ key: "Shift+ArrowDown" }) — same for Shift +
//     a special key (ArrowDown).
//
// Each step overwrites [data-testid="result"] so the next assertion
// can use assertResultContains' retry without ambiguity about which
// press it refers to.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "vortex-press-combo",
  playgroundPath: "/press-combo-marker.html",
  async run(ctx) {
    // Focus the input via click — autofocus on page load is brittle if
    // the navigation cycle stole focus, but a click is deterministic.
    await ctx.call("vortex_act", { action: "click", target: "#key-target" });

    // 1. Single key — no modifiers, plain Enter.
    await ctx.call("vortex_press", { key: "Enter" });
    await assertResultContains(ctx, "key=Enter mods=(none)");

    // 2. Combo — Ctrl flag must reach the page-side event.
    await ctx.call("vortex_press", { key: "Ctrl+s" });
    await assertResultContains(ctx, "key=s mods=Ctrl");

    // 3. Combo with a special key — Shift flag + ArrowDown.
    await ctx.call("vortex_press", { key: "Shift+ArrowDown" });
    await assertResultContains(ctx, "key=ArrowDown mods=Shift");
  },
};

export default def;
