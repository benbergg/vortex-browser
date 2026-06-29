// el-cascader 级联：验证 vortex_fill kind=cascader 能逐层定位。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

const PATH = ["华东", "上海", "浦东"];

const def: CaseDefinition = {
  name: "el-cascader",
  playgroundPath: "/#/el-cascader",
  tier: "medium",
  async run(ctx) {
    let fillOk = false;
    let fillText = "";
    try {
      const res = await ctx.call("vortex_fill", {
        target: "[data-testid=\"target-cascader\"]",
        widget: "cascader",
        value: PATH
      });
      fillText = extractText(res);
      fillOk = !fillText.toLowerCase().includes("error") && !fillText.includes("INVALID_PARAMS");
    } catch (err) {
      fillText = err instanceof Error ? err.message : String(err);
      fillOk = false;
    }

    if (!fillOk) {
      // 兜底：点 trigger 展开面板 + 逐级点击 label
      await ctx.fallbackEvaluate({
        code: `(() => {
          const w = document.querySelector('[data-testid="target-cascader"]');
          const t = w?.querySelector('.el-cascader__search-input, input');
          if (t) { (t).click(); return 'ok'; }
          return 'no-trigger';
        })()`,
      });
      await ctx.call("vortex_wait_for", {
        mode: "idle",
        value: "dom",
        timeout: 2000
      });
      for (const label of PATH) {
        await ctx.fallbackEvaluate({
          code: `(() => {
            for (const el of document.querySelectorAll('.el-cascader-node__label')) {
              if (el.textContent?.trim() === ${JSON.stringify(label)} && el.getBoundingClientRect().width > 0) {
                el.click(); return 'ok';
              }
            }
            return 'not-found';
          })()`,
        });
        await ctx.call("vortex_wait_for", {
          mode: "idle",
          value: "dom",
          timeout: 1000
        });
      }
    }

    await assertResultContains(ctx, PATH.join("/"));
    ctx.assert(
      fillOk,
      `vortex_fill kind=cascader 直接失败: ${fillText.slice(0, 200)}`,
    );
  },
};

export default def;
