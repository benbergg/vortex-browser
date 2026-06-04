// el-message-box（命令式弹窗）：DOM 由 JS 动态挂到 body，不在 Vue 组件树。
// 测：触发后 observe 能否捕捉 message-box 的 "确定" 按钮 → click → result 更新。
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
  name: "el-message-box",
  playgroundPath: "/#/el-message-box",
  tier: "medium",
  async run(ctx) {
    // 1. 点触发按钮
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-msgbox-trigger\"] button"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500
    });

    // 2. observe，期望 "确定" 按钮 ref（message-box teleport 到 body）
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const okRef = findRef(snap, "确定");
    if (okRef) {
      await ctx.call("vortex_act", {
        action: "click",
        target: okRef
      });
    } else {
      ctx.recordObserveMiss(1);
      await ctx.fallbackEvaluate({
        code: `(() => {
          for (const b of document.querySelectorAll('.el-message-box button')) {
            if ((b.textContent || '').trim() === '确定') { b.click(); return 'ok'; }
          }
          return 'not-found';
        })()`,
      });
    }

    await assertResultContains(ctx, "确认");
  },
};

export default def;
