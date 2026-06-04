// el-tree：展开父节点 + 点击深层叶子。
// 默认 expand-on-click-node=true，点击 label 会展开。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

/** 从 observe snapshot 精确匹配某个 accessible name 的 @eN ref */
function findRef(snapshot: string, name: string): string | null {
  // v0.8 hashed ref support: matches @eN / @fNeM / @<hash>:eN / @<hash>:fNeM
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

async function clickTreeNode(ctx: Parameters<typeof run>[0], label: string): Promise<void> {
  const snap = extractText(await ctx.call("vortex_observe", {}));
  const ref = findRef(snap, label);
  if (ref) {
    await ctx.call("vortex_act", {
      action: "click",
      target: ref
    });
  } else {
    ctx.recordObserveMiss(1);
    await ctx.fallbackEvaluate({
      code: `(() => {
        for (const el of document.querySelectorAll('.el-tree-node__label')) {
          if (el.textContent?.trim() === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0) {
            (el).click();
            return 'ok';
          }
        }
        return 'not-found';
      })()`,
    });
  }
  await ctx.call("vortex_wait_for", {
    mode: "idle",
    value: "dom",
    timeout: 1500
  });
}

const def: CaseDefinition = {
  name: "el-tree",
  playgroundPath: "/#/el-tree",
  tier: "medium",
  run,
};

type Ctx = import("../src/types.js").CaseContext;
async function run(ctx: Ctx): Promise<void> {
  // 1. 展开 "华东"
  await clickTreeNode(ctx, "华东");
  // 2. 展开 "上海"
  await clickTreeNode(ctx, "上海");
  // 3. 点 "浦东" 叶子
  await clickTreeNode(ctx, "浦东");

  await assertResultContains(ctx, "浦东");
}

export default def;
