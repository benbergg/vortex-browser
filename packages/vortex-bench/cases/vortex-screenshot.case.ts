// Fills the public `vortex_screenshot` 0-coverage gap — the last
// remaining public tool without a dedicated bench case. The tool
// dispatches to capture.screenshot (full / clipped page) when no
// target is supplied, or capture.element (CDP-clipped to the element
// rect) when `target` resolves to a selector. The MCP boundary turns
// the captured dataUrl into either an inline `{ type: "image" }`
// content item (default, when bytes are below LARGE_IMAGE_BYTES) or a
// `{ type: "text" }` JSON pointer to a file (for large captures).
//
// Tested guarantee:
//   - vortex_screenshot({}) returns image content with non-zero size.
//   - vortex_screenshot({ target: "#capture-target" }) returns image
//     content cropped to the element — strictly smaller in byte size
//     than the full-page capture.

import type { CaseDefinition } from "../src/types.js";

/**
 * Local helper — the standard `extractText` returns "" for image
 * content. Inspect the first content item directly and surface its
 * shape so the assertions can branch on inline vs file mode without
 * having to mirror server-side thresholds.
 */
function inspectCaptureResponse(res: unknown): {
  isImage: boolean;
  mimeType: string;
  imageBytes: number;
  text: string;
} {
  const content = (res as { content?: unknown[] }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return { isImage: false, mimeType: "", imageBytes: 0, text: "" };
  }
  const first = content[0] as {
    type?: string;
    data?: string;
    text?: string;
    mimeType?: string;
  };
  if (first.type === "image" && typeof first.data === "string") {
    return {
      isImage: true,
      mimeType: first.mimeType ?? "",
      imageBytes: first.data.length,
      text: "",
    };
  }
  return {
    isImage: false,
    mimeType: "",
    imageBytes: 0,
    text: typeof first.text === "string" ? first.text : "",
  };
}

const def: CaseDefinition = {
  name: "vortex-screenshot",
  playgroundPath: "/screenshot-target.html",
  async run(ctx) {
    // 1. Full-page screenshot. No `target` supplied so dispatch routes
    //    to capture.screenshot (whole tab viewport). Expect an inline
    //    `type: "image"` content item — the playground page is small
    //    enough to stay under LARGE_IMAGE_BYTES (500_000 bytes raw).
    const fullResp = await ctx.call("vortex_screenshot", {});
    const full = inspectCaptureResponse(fullResp);
    ctx.assert(
      full.isImage,
      `vortex_screenshot({}) should return image content. got text: "${full.text}"`,
    );
    ctx.assert(
      full.mimeType === "image/png",
      `full-page screenshot mimeType should be image/png. got: "${full.mimeType}"`,
    );
    ctx.assert(
      full.imageBytes > 1000,
      `full-page screenshot base64 should be > 1000 bytes. got: ${full.imageBytes}`,
    );

    // 2. Element-cropped screenshot. `target` resolves to a CSS
    //    selector at the server boundary, then dispatch routes to
    //    capture.element which computes the element rect and feeds
    //    `clip` to CDP. The cropped PNG is a 200x100 solid-red region
    //    plus minimal anti-aliasing — strictly smaller than the
    //    full-page capture which contains the red box AND three
    //    padding blocks.
    const elResp = await ctx.call("vortex_screenshot", {
      target: "#capture-target",
    });
    const el = inspectCaptureResponse(elResp);
    ctx.assert(
      el.isImage,
      `vortex_screenshot({target:"#capture-target"}) should return image content. got text: "${el.text}"`,
    );
    ctx.assert(
      el.mimeType === "image/png",
      `element screenshot mimeType should be image/png. got: "${el.mimeType}"`,
    );
    ctx.assert(
      el.imageBytes > 0,
      `element screenshot should have non-zero base64. got: ${el.imageBytes}`,
    );
    ctx.assert(
      el.imageBytes < full.imageBytes,
      `element crop should be smaller than full page. element=${el.imageBytes} full=${full.imageBytes}`,
    );

    // Record raw sizes as customMetrics so trend reports can flag
    // sudden size changes (e.g. a regression that returned the entire
    // viewport for element captures would land here as `elementBytes`
    // jumping toward `fullBytes`).
    ctx.recordMetric("fullBytes", full.imageBytes);
    ctx.recordMetric("elementBytes", el.imageBytes);
  },
};

export default def;
