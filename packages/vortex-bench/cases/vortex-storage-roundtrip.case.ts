// Fills the public `vortex_storage` 0-coverage gap. The tool ships in
// v0.6+ and dispatches to storage.{get,set}LocalStorage /
// {get,set}SessionStorage / getCookies under the hood (see dispatch.ts
// case "vortex_storage"), but no bench case until now exercised the
// set→get roundtrip through real Chrome localStorage.
//
// Tested guarantee:
//   - vortex_storage(op=set) actually writes to the page's localStorage
//     (verifiable by triggering a page-side re-read).
//   - vortex_storage(op=get) returns a response containing the value
//     just written through the same tool.
//
// Cleanup policy: a fixed, namespaced key is used so cross-run residue
// just gets overwritten idempotently; no explicit cleanup needed.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const STORAGE_KEY = "vortex-bench-storage-key";
const STORAGE_VALUE = "hello-storage-roundtrip";

function findRef(snapshot: string, name: string): string | null {
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "vortex-storage-roundtrip",
  playgroundPath: "/storage-roundtrip.html",
  async run(ctx) {
    // 1. Write through vortex_storage(set). Same-origin localStorage on
    //    the playground tab.
    await ctx.call("vortex_storage", {
      op: "set",
      key: STORAGE_KEY,
      value: STORAGE_VALUE,
    });

    // 2. Trigger a page-side re-read by clicking the "Refresh display"
    //    button. The fixture's onclick handler runs
    //    localStorage.getItem(STORAGE_KEY) and mirrors the result into
    //    [data-testid="result"]. This proves the write actually landed
    //    in the same localStorage area the page reads from (not, for
    //    example, a different storage partition or a sessionStorage
    //    fallback).
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const refreshRef = findRef(snap, "Refresh display");
    ctx.assert(
      refreshRef !== null,
      `observe should surface "Refresh display" button. snapshot head:\n${snap.slice(0, 500)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: refreshRef });

    // 3. Result region should now mirror the written value.
    await assertResultContains(ctx, STORAGE_VALUE);

    // 4. Direct read through the same tool — closes the set→get loop
    //    independent of the page-side mirror, in case a future
    //    regression skipped one of the two paths (e.g. set wrote to
    //    sessionStorage, get reads from localStorage, or vice versa).
    const getResp = await ctx.call("vortex_storage", {
      op: "get",
      key: STORAGE_KEY,
    });
    const getText = extractText(getResp);
    ctx.assert(
      getText.includes(STORAGE_VALUE),
      `vortex_storage(op=get) should return the value just written. response:\n${getText}`,
    );
  },
};

export default def;
