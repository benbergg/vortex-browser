// el-autocomplete：type 触发异步建议，等 popper 出现后选项 click。
import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractText } from "./_helpers.js";

function findRef(snapshot: string, name: string): string | null {
  // a11y-tree 格式：`- role "name" [ref=@..]`，ref 在 [ref=] 内（旧扁平是行首 @ref [role] "name"）。
  // 必须锁定 role=option：el-autocomplete 单建议项时,外层 listbox/region 容器会继承该
  // 选项名("banana"),裸正则会先命中容器 div(不可点)而非真正可点的 option <li>,点容器
  // 不触发 select → 值不提交(issue #107 实测 clickRes 命中 tag=div)。
  const re = new RegExp(`-\\s+option\\s+"([^"]*?)"\\s+\\[ref=(@[\\w:]+)\\]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[1].trim() === name) return m[2];
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
    // 异步建议 fetch-suggestions 是 ~100ms debounce:用 mode=idle/dom 会在 fetch 触发前的
    // 间隙误判 settled(mutationsSeen=0,~300ms),observe 可能在 popper 渲染前跑。改用
    // mode=element 显式等建议 li 实际渲染,确保 observe 能取到稳定的 option。
    await ctx.call("vortex_wait_for", {
      mode: "element",
      value: ".el-autocomplete-suggestion li",
      timeout: 2000
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
