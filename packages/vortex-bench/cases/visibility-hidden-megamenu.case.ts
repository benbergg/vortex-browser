// Reproduces Notion mega-menu pattern that surfaced CSS-module
// garbage names (e.g. `navItem_navItem_`) in observe output during a
// real-site dogfood run against notion.com/help (2026-05-20).
//
// Root cause in the wild:
//   - <a> wraps a decorative svg/icon span + a text-bearing span
//   - The text span has visibility:hidden because the parent mega-menu
//     wrapper is in collapsed (hover-to-expand) state
//   - innerText returns "" (innerText respects visibility:hidden);
//     getAccessibleName falls through to iconNameFromClass, which
//     hits the CSS-module class `navItem_navItem__qrlp3` and emits
//     `navItem_navItem_` (trailing-underscore strip only runs on the
//     denylist check path, not on the returned value)
//
// Tested guarantee — even if className tokenization gets smarter in
// the future, observe must not surface `visibility:hidden` elements
// at all: they are not user-interactable (clicks fall through, hit
// tests skip them) so emitting them as actionable candidates is a
// false positive that wastes LLM tokens and produces broken plans.
//
// Visible siblings (top-trigger nav links, main-content link) must
// continue to surface — this is the regression bar.

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "visibility-hidden-megamenu",
  playgroundPath: "/visibility-hidden-megamenu.html",
  tier: "easy",
  async run(ctx) {
    await new Promise((r) => setTimeout(r, 200));
    const snap = extractText(await ctx.call("vortex_observe", {}));
    ctx.recordMetric("snapshotBytes", snap.length);

    // 1. Visible top-level nav must surface — the regression bar.
    //    These are plain <a> with cursor:default but accessible-name
    //    via innerText is well-defined ("Home" / "Pricing"). If
    //    visibility filter is too aggressive it will kill these too.
    ctx.assert(
      /\[link\]\s+"Home"/.test(snap),
      `visible top-trigger "Home" must surface. snapshot:\n${snap.slice(0, 600)}`,
    );
    ctx.assert(
      /\[link\]\s+"Pricing"/.test(snap),
      `visible top-trigger "Pricing" must surface. snapshot:\n${snap.slice(0, 600)}`,
    );
    ctx.assert(
      /\[link\]\s+"Visible documentation link"/.test(snap),
      `main-content visible link must surface. snapshot:\n${snap.slice(0, 600)}`,
    );

    // 2. Hidden mega-menu links must NOT appear under any name —
    //    not their (visibility:hidden) accessible name, not the
    //    CSS-module class garbage `navItem_navItem_` or `nav-item-class-leak`.
    //    This is the bug we're locking.
    ctx.assert(
      !/Calendar \(hidden\)/.test(snap),
      `hidden mega-menu Calendar link should not surface (visibility:hidden):\n${snap}`,
    );
    ctx.assert(
      !/Mail \(hidden\)/.test(snap),
      `hidden mega-menu Mail link should not surface (visibility:hidden):\n${snap}`,
    );
    ctx.assert(
      !/nav-item-class-leak|nav_item_class_leak/.test(snap),
      `CSS-module garbage from hidden links must not leak as accessible name:\n${snap}`,
    );

    // 3. Total link count sanity — exactly the 3 visible links
    //    (Home, Pricing, Visible documentation link). Hidden 5 must
    //    not be counted.
    const linkMatches = snap.match(/\[link\]/g) ?? [];
    ctx.assert(
      linkMatches.length === 3,
      `expected exactly 3 visible links surfaced, got ${linkMatches.length}. snapshot:\n${snap}`,
    );
  },
};

export default def;
