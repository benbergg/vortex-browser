// el-select-v2 虚拟滚动跨屏：从 1000 条选项里挑 Option 500（远超初始 viewport）。
// 策略：用 filterable 在 input 里 type "500" 过滤，让 virtual list 只剩匹配项。
//
// Status: KNOWN-FAIL until the `element-plus-select` commit driver gets
// filter-mode support. Live diagnosis 2026-05-20 confirmed Element Plus's
// el-select-v2 places its placeholder div directly on top of the inner
// `<input>` (same stacking context), so dom.type's actionability check
// fails with `OBSCURED — blocker: div.el-select__placeholder` after the
// 5s retry budget. The basic `el-select-v2` case (first-batch select via
// kind="select") passes via CDP path; this case needs the same driver
// extended to accept a filter string before label match. Tracked as a
// driver feature gap, not a bench bug.
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
  name: "el-select-v2-virtual",
  playgroundPath: "/#/el-select-v2",
  async run(ctx) {
    // 1. click trigger 打开 dropdown + focus 输入框
    await ctx.call("vortex_act", {
      action: "click",
      target: "[data-testid=\"target-select-v2\"] .el-select__wrapper"
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1000  // 增加到 1s，确保 dropdown 完全展开
    });

    // 2. type 过滤，让虚拟列表只显示匹配项
    await ctx.call("vortex_act", {
      action: "type",
      target: "[data-testid=\"target-select-v2\"] input",
      text: "500"
    });
    // 关键修复：等待更长时间让虚拟列表完成过滤和重新渲染
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 1500  // 增加到 1.5s，虚拟列表过滤需要更多时间
    });

    // 3. observe 抓 "Option 500" ref
    const snap = extractText(await ctx.call("vortex_observe", {}));
    const ref = findRef(snap, "Option 500");
    
    if (ref) {
      // 找到了，直接点击
      await ctx.call("vortex_act", {
        action: "click",
        target: ref
      });
      await ctx.call("vortex_wait_for", {
        mode: "idle",
        value: "dom",
        timeout: 500
      });
    } else {
      // 没找到，记录并尝试 fallback
      ctx.recordObserveMiss(1);
      
      // 先再次 observe 确认 dropdown 是否还开着
      const snap2 = extractText(await ctx.call("vortex_observe", {}));
      const ref2 = findRef(snap2, "Option 500");
      
      if (ref2) {
        // 第二次找到了
        await ctx.call("vortex_act", {
          action: "click",
          target: ref2
        });
      } else {
        // 真的找不到，用 evaluate 兜底
        await ctx.fallbackEvaluate({
          async: true,
          code: `
            // 先确保 dropdown 还开着
            const wrapper = document.querySelector('[data-testid="target-select-v2"] .el-select__wrapper');
            if (wrapper && wrapper.getAttribute('aria-expanded') !== 'true') {
              wrapper.click();
            }
            await new Promise(r => setTimeout(r, 500));
            // 在虚拟列表中查找
            for (const el of document.querySelectorAll('[role="option"], .el-vl__item, .el-select-dropdown__item')) {
              if (el.textContent?.trim() === 'Option 500' && el.getBoundingClientRect().width > 0) {
                el.click();
                return 'ok';
              }
            }
            return 'not-found';
          `,
        });
      }
    }

    await assertResultContains(ctx, "value=opt-500");
  },
};

export default def;
