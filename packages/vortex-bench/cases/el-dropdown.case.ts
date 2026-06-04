// el-dropdown teleport menu：验证 observe 能否抓到 popper 里的 menuitem 并给出可点击的 @eN ref。
// 已知 vortex 盲区：observe 不扫 .el-popper。修好后 fallbackToEvaluate=0 且 missed=0。

import type { CaseDefinition } from "../src/types.js";
import { assertResultContains, extractEvalJson, extractText } from "./_helpers.js";

/** 从 observe snapshot 里提取某个可交互项的 @eN ref（按 accessible name 精确匹配） */
function findRef(snapshot: string, name: string): string | null {
  // 匹配形如：@e12 [menuitem] "选项 B"、@f34e7 [button] "选项 B"，
  // 以及 v0.8 hashed 形态 @a1b2:e12 / @a1b2:f34e7
  const re = new RegExp(`(@(?:[a-f0-9]{4}:)?(?:f\\d+)?e\\d+)\\s+\\[[^\\]]+\\]\\s+"([^"]*?)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(snapshot)) !== null) {
    if (m[2].trim() === name) return m[1];
  }
  return null;
}

const def: CaseDefinition = {
  name: "el-dropdown",
  playgroundPath: "/#/el-dropdown",
  tier: "medium",
  async run(ctx) {
    // 1. observe 必须能看到触发按钮"打开菜单"并给出可用 ref
    const snap1 = extractText(await ctx.call("vortex_observe", {}));
    const triggerRef = findRef(snap1, "打开菜单");
    ctx.assert(triggerRef !== null, `observe 应给出"打开菜单"的 @eN ref，snapshot:\n${snap1.slice(0, 400)}`);

    // 2. 点击触发按钮
    await ctx.call("vortex_act", {
      action: "click",
      target: triggerRef
    });
    await ctx.call("vortex_wait_for", {
      mode: "idle",
      value: "dom",
      timeout: 2000
    });

    // 3. 下拉展开后，observe 期望给出 3 个 menuitem 的 @eN ref
    const snap2 = extractText(await ctx.call("vortex_observe", {}));
    const expected = ["选项 A", "选项 B", "选项 C"];
    const refs = expected.map((name) => ({ name, ref: findRef(snap2, name) }));
    const missedList = refs.filter((r) => r.ref === null).map((r) => r.name);
    if (missedList.length > 0) {
      ctx.recordObserveMiss(missedList.length);
      // 兜底：用 evaluate 确认 DOM 里有这些选项，用文本匹配点击"选项 B"
      const visible = extractEvalJson<string[]>(
        await ctx.fallbackEvaluate({
          code: `(() => {
            const out = [];
            document.querySelectorAll('.el-dropdown-menu__item').forEach(el => {
              if (el.getBoundingClientRect().width > 0) out.push(el.textContent?.trim() ?? '');
            });
            return out;
          })()`,
        }),
      );
      ctx.assert(
        Array.isArray(visible) && visible.includes("选项 B"),
        `DOM 里也没有"选项 B"，visible=${JSON.stringify(visible)}`,
      );
      await ctx.fallbackEvaluate({
        code: `(() => {
          for (const el of document.querySelectorAll('.el-dropdown-menu__item')) {
            if (el.textContent?.trim() === '选项 B' && el.getBoundingClientRect().width > 0) {
              el.click(); return 'ok';
            }
          }
          return 'not-found';
        })()`,
      });
    } else {
      // 理想路径：用 observe 给的 @eN ref 点击
      const optionB = refs.find((r) => r.name === "选项 B")!.ref!;
      await ctx.call("vortex_act", {
        action: "click",
        target: optionB
      });
    }

    // 4. 验证
    await assertResultContains(ctx, "选项 B");
  },
};

export default def;
