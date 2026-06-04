// el-transfer：左侧勾 Item 1 + Item 2，点向右箭头移到右侧。
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
  name: "el-transfer",
  playgroundPath: "/#/el-transfer",
  tier: "medium",
  async run(ctx) {
    // observe 抓 Item 1 / Item 2 checkbox ref（label:has(input[type=checkbox]) 已收）
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    for (const label of ["Item 1", "Item 2"]) {
      const ref = findRef(snap1, label);
      if (ref) {
        await ctx.call("vortex_act", {
          action: "click",
          target: ref
        });
      } else {
        ctx.recordObserveMiss(1);
        await ctx.fallbackEvaluate({
          code: `(() => {
            for (const lab of document.querySelectorAll('[data-testid="target-transfer"] .el-transfer-panel__list .el-checkbox')) {
              if ((lab.textContent || '').includes(${JSON.stringify(label)})) {
                lab.click(); return 'ok';
              }
            }
            return 'not-found';
          })()`,
        });
      }
    }
    // 点"向右"按钮（第二个，第一个是"向左"移到左侧；用 :not(.is-disabled) 匹配 enabled）
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-transfer\"] .el-transfer__buttons button:nth-of-type(2)"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000
    });

    await assertResultContains(ctx, "selected=[1,2]");
  },
};

export default def;
