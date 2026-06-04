// Reproduces the contentEditable gap surfaced against
// prosemirror.net/examples/basic/ during Round 1 real-site dogfood
// (2026-05-20). Two failure modes:
//
//   - vortex_fill on a contentEditable div throws JS_EXECUTION_ERROR
//     "Illegal invocation" because the host-side path calls
//     HTMLInputElement.prototype.value.set on a non-input element.
//
//   - vortex_type on a contentEditable div reports
//     {success:true, typed:N} but the editor content is unchanged.
//     The page-side handler's `if (el.value !== undefined)` guard
//     silently no-ops, and the synthetic KeyboardEvent dispatches
//     don't reach a real rich-text editor's beforeinput pipeline
//     (isTrusted=false is filtered out by ProseMirror/Slate/Lexical).
//
// Tested guarantee — vortex_type on a contentEditable element must
// produce visible text via the CDP `Input.insertText` path, both
// against:
//   (a) a ProseMirror-like editor that preventDefaults beforeinput
//       and re-renders from an internal model
//   (b) a plain contentEditable div with no input interception
//
// Both must end with the typed text actually visible in the editor.

import type { CaseDefinition } from "../src/types.js";
import { extractEvalJson, readResult } from "./_helpers.js";

const def: CaseDefinition = {
  name: "contenteditable-rich-text",
  playgroundPath: "/contenteditable-prosemirror-like.html",
  tier: "hard",
  async run(ctx) {
    // 1. Click into the ProseMirror-like editor to give it focus.
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"rich-editor\"]",
    });

    // 2. Type into it. After fix, dom.type detects contentEditable
    //    and routes to CDP Input.insertText.
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"rich-editor\"]",
      text: "VORTEX-RICH",
    });

    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 500,
    });

    // 3. The ProseMirror-like editor only re-renders from its model
    //    when it sees a trusted beforeinput. If CDP Input.insertText
    //    fires real native events, model becomes
    //    "Initial paragraph.VORTEX-RICH" and the result region
    //    reflects it.
    const richModel = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: `document.querySelector('[data-testid=\"rich-result\"]')?.textContent?.trim() || ''`,
      }),
    );
    ctx.assert(
      richModel.includes("VORTEX-RICH"),
      `ProseMirror-like editor must receive trusted insertText. got: ${richModel}`,
    );

    // 4. Now the plain contentEditable div. Click + type.
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"plain-editor\"]",
    });
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"plain-editor\"]",
      text: "VORTEX-PLAIN",
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 500,
    });

    const plainResult = extractEvalJson<string>(
      await ctx.call("vortex_evaluate", {
        code: `document.querySelector('[data-testid=\"plain-result\"]')?.textContent?.trim() || ''`,
      }),
    );
    ctx.assert(
      plainResult.includes("VORTEX-PLAIN"),
      `plain contentEditable must receive trusted insertText. got: ${plainResult}`,
    );
  },
};

export default def;
