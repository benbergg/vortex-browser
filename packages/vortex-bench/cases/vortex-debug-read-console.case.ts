// Fills the public `vortex_debug_read(source=console)` 0-coverage gap.
// Companion to `vortex-debug-read-network` — together they exercise
// the full `vortex_debug_read` surface against real CDP listeners.
//
// History: until the console handler's GET_LOGS / GET_ERRORS gained
// the lazy `ensureSubscribed` helper (mirrored from network.ts), the
// public path NEVER subscribed CDP's Runtime domain, so
// `vortex_debug_read(console)` always returned []. The handler now
// auto-subscribes on the first read.
//
// Tested guarantee:
//   - vortex_debug_read(source=console) auto-subscribes on first call.
//   - Subsequent emits at three different levels (log / warn / error)
//     are all captured and findable in the response text by their
//     marker strings.

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const MARKER_INFO = "vortex-bench-console-marker-info";
const MARKER_WARN = "vortex-bench-console-marker-warn";
const MARKER_ERROR = "vortex-bench-console-marker-error";

function findRef(snapshot: string, name: string): string | null {
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "vortex-debug-read-console",
  playgroundPath: "/console-emit-marker.html",
  async run(ctx) {
    // 1. Pre-warm the CDP Runtime subscription. After the auto-subscribe
    //    fix, the first vortex_debug_read(console) call enables the
    //    domain; without this, console events emitted before any
    //    debug_read call would never reach the cache.
    await ctx.call("vortex_debug_read", { source: "console" });

    // 2. Click the "Emit logs" button. The fixture's handler fires
    //    three distinct console.* calls (log / warn / error) with
    //    namespaced marker strings, then writes "emitted 3 logs"
    //    into [data-testid="result"] — a hard barrier for the case.
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const btnRef = findRef(snap, "Emit logs");
    ctx.assert(
      btnRef !== null,
      `observe should surface "Emit logs" button. snapshot head:\n${snap.slice(0, 500)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: btnRef });
    await assertResultContains(ctx, "emitted 3 logs");

    // 3. Read back. The MCP boundary JSON-stringifies the array of
    //    ConsoleEntry objects, so the marker strings (stored as the
    //    `text` field) are findable as substrings of the response.
    const logsResp = await ctx.call("vortex_debug_read", { source: "console" });
    const logsText = extractText(logsResp);

    // 4. All three markers must appear. Each level is asserted
    //    independently so a regression that drops one level / merges
    //    adjacent calls / dedupes the text surfaces with a precise
    //    failure pointing at which level broke.
    ctx.assert(
      logsText.includes(MARKER_INFO),
      `console log should include info marker "${MARKER_INFO}". log head:\n${logsText.slice(0, 800)}`,
    );
    ctx.assert(
      logsText.includes(MARKER_WARN),
      `console log should include warn marker "${MARKER_WARN}". log head:\n${logsText.slice(0, 800)}`,
    );
    ctx.assert(
      logsText.includes(MARKER_ERROR),
      `console log should include error marker "${MARKER_ERROR}". log head:\n${logsText.slice(0, 800)}`,
    );
  },
};

export default def;
