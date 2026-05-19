// Fills the public `vortex_debug_read(source=network)` 0-coverage gap.
// The tool dispatches to network.getLogs in the extension, which reads
// from an in-memory ring populated by CDP Network.requestWillBeSent /
// Network.responseReceived listeners. Subscription is lazy — the first
// call to a network handler attaches CDP's Network domain on the tab,
// after which requests are captured. No bench case until now exercised
// the full subscribe → fetch → read pipeline.
//
// Tested guarantee:
//   - vortex_debug_read(source=network) actually returns entries for
//     fetches issued from the page after the subscription is active.
//   - Both of two distinct fetches show up (catches a regression that
//     merges / deduplicates / drops one of multiple in-flight requests).

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const MARKER_ALPHA = "vortex-bench-net-marker-alpha";
const MARKER_BETA = "vortex-bench-net-marker-beta";

function findRef(snapshot: string, name: string): string | null {
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "vortex-debug-read-network",
  playgroundPath: "/network-fetch-marker.html",
  async run(ctx) {
    // 1. Pre-warm the CDP Network subscription. The first call to a
    //    network handler runs ensureSubscribed which attaches the
    //    Network domain on this tab; without this, fetches fired
    //    BEFORE the first vortex_debug_read are not captured.
    await ctx.call("vortex_debug_read", { source: "network" });

    // 2. Find the "Fire requests" button and click it. The page-side
    //    handler runs two fetches in Promise.all and then writes the
    //    completion line to [data-testid="result"], so when
    //    assertResultContains sees it the fetches are definitely done.
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const btnRef = findRef(snap, "Fire requests");
    ctx.assert(
      btnRef !== null,
      `observe should surface "Fire requests" button. snapshot head:\n${snap.slice(0, 500)}`,
    );
    await ctx.call("vortex_act", { action: "click", target: btnRef });
    await assertResultContains(ctx, "fired 2 requests");

    // 3. Read the network log. The handler returns an array of entries
    //    with `url` / `method` / `status` / etc.; the MCP boundary
    //    JSON-stringifies it, so the marker URLs are findable as
    //    substrings of the response text.
    const netResp = await ctx.call("vortex_debug_read", { source: "network" });
    const netText = extractText(netResp);

    // 4. Both markers must appear. Substring search is sufficient — the
    //    network log JSON includes each entry's `url` field verbatim.
    ctx.assert(
      netText.includes(MARKER_ALPHA),
      `network log should include alpha marker "${MARKER_ALPHA}". log head:\n${netText.slice(0, 800)}`,
    );
    ctx.assert(
      netText.includes(MARKER_BETA),
      `network log should include beta marker "${MARKER_BETA}". log head:\n${netText.slice(0, 800)}`,
    );
  },
};

export default def;
