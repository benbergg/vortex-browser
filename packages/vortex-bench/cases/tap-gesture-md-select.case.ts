// Fixture-based: playground/public/tap-gesture-md-select.html.
//
// Tested guarantee (BUG 8, 2026-05-21 RocketMQ-Dashboard dogfood):
//   vortex_act action="click" must dispatch the full tap-style mouse
//   event sequence (pointerdown → mousedown → pointerup → mouseup →
//   click), not just el.click(). Without the sequence, frameworks that
//   recognise their own tap gesture from mousedown/mouseup (AngularJS
//   Material $mdGesture, Hammer.js, pre-v3 Element/Ant Select) silently
//   ignore vortex clicks — the original RocketMQ-Dashboard "Topic 选不
//   上" blocker.
//
// The fixture intentionally swallows lone click events
// (stopPropagation + preventDefault) so the only way to update
// result.textContent to "value=tapped" is to deliver a real tap.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "tap-gesture-md-select",
  playgroundPath: "/tap-gesture-md-select.html",
  async run(ctx) {
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target\"]",
    });
    await assertResultContains(ctx, "value=tapped");
  },
};

export default def;
