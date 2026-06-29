// Validates that observe's getUiState (observe.ts:437-475) picks up
// `aria-pressed` mutations across re-observes — i.e. the compact line
// for a toggle button gains a `[pressed]` flag after click and the
// flag corresponds to the live DOM, not a stale snapshot cache.
//
// 注：aria-pressed=true 渲染为 `[pressed]`(observe-render.ts:227-229 R1 B004,
// 刻意与 [active] 区分/不同源),早期断言用 [active] 已随 R1 B004 漂移,此处对齐。
//
// Tested guarantee:
//   - First observe: button line has no `[pressed]` (aria-pressed=false).
//   - After vortex_act(click): the next observe shows the SAME button
//     line with `[pressed]` appended.
//   - The button's accessible name stays stable across the click so
//     a regression cannot bypass the assertion by giving the same
//     element a different ref / line entirely.
//
// The fixture pins the accessible name via a constant `aria-label`
// so the visible text inside the button can change (off/on label)
// without affecting findRef — exactly the pattern that real toggle
// widgets use (Element Plus el-button toggle, GitHub star buttons,
// dark-mode switches, …).

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  // a11y-tree 格式：`- role "name" [ref=@..]`，ref 在 [ref=] 内（旧扁平是行首 @ref [role] "name"）。
  const re = new RegExp(`-\\s+\\S+\\s+"([^"]*?)"\\s+\\[ref=(@[\\w:]+)\\]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[1].trim() === name) return m[2];
  }
  return null;
}

/** a11y-tree 行内按 accessible name 精确匹配，返回整行（含 [active] 等 flag）。 */
function findLineWithName(snapshot: string, name: string): string | null {
  for (const line of snapshot.split("\n")) {
    // 新树格式：`  - role "name" [ref=@..] [active]`，name 在引号内
    const m = line.match(/-\s+\S+\s+"([^"]*?)"/);
    if (m && m[1].trim() === name) return line;
  }
  return null;
}

const def: CaseDefinition = {
  name: "dynamic-role-mutation",
  playgroundPath: "/toggle-aria-pressed.html",
  tier: "medium",
  async run(ctx) {
    // 1. Initial observe — the button has aria-pressed="false", so
    //    state.active must be undefined / false and the compact line
    //    must NOT include the `[active]` flag.
    const snap0 = extractText(await ctx.call("vortex_observe", {}));
    const line0 = findLineWithName(snap0, "Toggle button");
    ctx.assert(
      line0 !== null,
      `observe should surface "Toggle button". snapshot head:\n${snap0.slice(0, 500)}`,
    );
    ctx.assert(
      !line0!.includes("[pressed]"),
      `initial state should NOT have [pressed] (aria-pressed=false). line: "${line0}"`,
    );

    // 2. Click the toggle. The page handler flips aria-pressed and
    //    writes "pressed=true" into [data-testid="result"], so
    //    assertResultContains gives us a hard barrier before we re-observe.
    const btnRef = findRef(snap0, "Toggle button");
    ctx.assert(btnRef !== null, `findRef for "Toggle button" returned null`);
    await ctx.call("vortex_act", { action: "click", target: btnRef });
    await assertResultContains(ctx, "pressed=true");

    // 3. Re-observe. Same accessible name (aria-label is constant), but
    //    aria-pressed is now "true" so getUiState walks the element's
    //    ancestor chain (self + 2 above) and records state.active=true.
    //    The renderer must emit [pressed] after the quoted name.
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    const line1 = findLineWithName(snap1, "Toggle button");
    ctx.assert(
      line1 !== null,
      `re-observe should still surface "Toggle button" after click. snapshot head:\n${snap1.slice(0, 500)}`,
    );
    ctx.assert(
      line1!.includes("[pressed]"),
      `after click, [pressed] flag should be present (aria-pressed=true). line: "${line1}"`,
    );
  },
};

export default def;
