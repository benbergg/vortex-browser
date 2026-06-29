// el-select-v2 virtual cross-screen select — drives a 1000-option
// filterable list from the public surface via vortex_fill kind="select".
//
// The page-side element-plus-select driver gained filter-mode in the
// commit that closed issue #24: when the wrapper has `is-filterable`,
// the driver writes each label to the in-wrapper filter input via
// nativeInputValueSetter, lets the virtual list re-render, then clicks
// the now-visible matching `.el-select-dropdown__item`. This bypasses
// dom.type's actionability check (Element Plus stacks a placeholder
// div over the filter input which previously blocked type with
// `OBSCURED — blocker: div.el-select__placeholder`).
//
// Tested guarantee:
//   - vortex_fill({ kind: "select", value: "Option 500" }) reaches an
//     option that lives past the initial virtual viewport.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains } from "./_helpers.js";

const def: CaseDefinition = {
  name: "el-select-v2-virtual",
  playgroundPath: "/#/el-select-v2",
  tier: "hard",
  async run(ctx) {
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"target-select-v2\"]",
      widget: "select",
      value: "Option 500",
    });

    await assertResultContains(ctx, "value=opt-500");
  },
};

export default def;
