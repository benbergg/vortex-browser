// 回归锁:observe 盲区降级信号(2026-06-17 感知层 A 族)。
//
// 修复前 observe 遇虚拟列表/canvas 静默返回局部不给信号,agent 把局部当全局。
// 修复后:
//   - 虚拟列表(aria-rowcount/setsize 远大于渲染)→ 顶部 `# blindspots: ... virtual(N/M)`
//   - 可交互大 canvas → 行内 `[blindspot=canvas]` + meta `canvas-editor`
// 负例(同 fixture 内):普通 button / setsize 与渲染相符的小 listbox 不得误报。
//
// 证据:reports/_dogfood/spike-perception-blindspot-2026-06-17.md(ag-grid/Excalidraw live)

import type { CaseDefinition } from "../src/types.js";
import { extractText } from "./_helpers.js";

const def: CaseDefinition = {
  name: "observe-blindspot",
  playgroundPath: "/observe-blindspot.html",
  tier: "hard",
  async run(ctx) {
    const snap = extractText(await ctx.call("vortex_observe", { scope: "full", filter: "all" }));

    // A2 虚拟列表:Big Data Grid 声明 1000 行,只渲染 10 → virtual 信号
    ctx.assert(
      /# blindspots:[^\n]*virtual\(1000\/\d+\)/.test(snap),
      `虚拟列表应出 # blindspots virtual(1000/M)。snapshot head:\n${snap.slice(0, 700)}`,
    );

    // A1 canvas:大尺寸画布行内标注
    ctx.assert(
      snap.includes("[blindspot=canvas]"),
      `可交互大 canvas 应出 [blindspot=canvas]。snapshot head:\n${snap.slice(0, 700)}`,
    );

    // 负例:小 listbox(setsize=3,渲染 3)不得被误标虚拟
    ctx.assert(
      !/Small List[^\n]*virtual/.test(snap) && !/virtual\(3\//.test(snap),
      `setsize 与渲染相符的小 listbox 不应误报虚拟。snapshot:\n${snap.slice(0, 900)}`,
    );
  },
};

export default def;
