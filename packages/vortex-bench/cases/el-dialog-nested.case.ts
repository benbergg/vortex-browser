// el-dialog + 嵌套 el-select：测 teleport 套 teleport，observe 能否区分层级。

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
  name: "el-dialog-nested",
  playgroundPath: "/#/el-dialog-nested",
  tier: "medium",
  async run(ctx) {
    // 1. observe 定位触发按钮 → 打开 dialog
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    const openBtn = findRef(snap1, "打开对话框");
    ctx.assert(openBtn !== null, `observe 看不到"打开对话框"按钮: ${snap1.slice(0, 300)}`);
    await ctx.call("vortex_act", {
      action: "click",
      target: openBtn
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500
    });

    // 2. dialog 打开后 observe 应能看到 inside-select 区的 combobox
    //    直接使用 vortex_fill with kind=select
    await ctx.call("vortex_fill", {
      target: "[data-testid=\"inside-select\"]",
      kind: "select",
      value: "Y"
    });

    await assertResultContains(ctx, "dialogOpen=true");
    await assertResultContains(ctx, "inside=Y");
  },
};

export default def;
