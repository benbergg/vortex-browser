// el-autocomplete：type 触发异步建议，等 popper 出现后选项 click。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  // v0.8 hashed ref support: matches @eN / @fNeM / @<hash>:eN / @<hash>:fNeM
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "el-autocomplete",
  playgroundPath: "/#/el-autocomplete",
  tier: "medium",
  async run(ctx) {
    // 先 focus input 再 type
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-autocomplete\"] input"
    });
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"target-autocomplete\"] input",
      text: "ban"
    });
    // 异步建议 debounce ~100ms，加等
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500
    });

    const snap = extractText(await ctx.call("vortex_observe", {}));
    const ref = findRef(snap, "banana");
    if (ref) {
      await ctx.call("vortex_act", {
        action: "click",
        target: ref
      });
    } else {
      ctx.recordObserveMiss(1);
      await ctx.fallbackEvaluate({
        code: `(() => {
          for (const el of document.querySelectorAll('.el-autocomplete-suggestion li')) {
            if ((el.textContent || '').trim() === 'banana' && el.getBoundingClientRect().width > 0) {
              el.click(); return 'ok';
            }
          }
          return 'not-found';
        })()`,
      });
    }

    await assertResultContains(ctx, "value=banana");
  },
};

export default def;
