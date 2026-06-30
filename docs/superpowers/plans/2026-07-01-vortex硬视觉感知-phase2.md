# vortex 硬视觉感知 Phase 2 Implementation Plan

> 上游:[[2026-06-30-vortex硬视觉感知评测与迭代-design]] + 缺口谱 `Knowledge-Library/07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md`(12 场景)。
> Phase 1 排序:**P0-1 图表 detector 扩展+改误导默认**(本计划首个增量) · P0-2 几何 readback · P1 配色/图像/薄视觉兑底。

**Goal:** 把图表 canvas 盲区检测从 echarts-only 扩到 Chart.js/Highcharts/G2,并把「已知图表库 canvas 误标 `readback=screenshot`」(⑥ 实证主动误导)改为 `readback=chart` + lib-aware readback hint。

**Architecture:** 检测纯分类器(blindspot-detect.ts)设 `chartLib` 信号;渲染层 `chartReadbackHint(chartLib)` 单一真源映射方法名(echarts→getOption / chartjs→Chart.getChart().data / highcharts→series / g2→getData())。4 处 parity:真源 detectBlindspot+detectChartCanvas + observe.ts 2 内联副本。承重墙→必活浏览器 spike。

## Global Constraints

- **page-side 自包含**:detector 不引模块级 helper(inline gotcha)。检测库用 MAIN-world 全局(`window.Chart`/`window.Highcharts`);祖先属性(G2 `data-chart-source-type`)。
- **4 处 parity**:改 detectBlindspot/detectChartCanvas 真源须同步 observe.ts 两内联副本;`observe-blindspot-scan.test.ts` 校验。
- **检测顺序(load-bearing)**:echarts(attr 最快)→ G2(祖先 attr)→ Chart.js(`Chart.getChart`)→ Highcharts(charts 容器)→ 框架(fiber/vue)→ screenshot。图表库优先于框架(introspection 比 component 更精确)。
- **不回归 echarts**:getOption hint 保持;`includeBoxes`/虚拟/shadow 路径不动。

## P0-1 任务分解(本计划范围)

### Task 1: chartReadbackHint 纯函数(渲染层单一真源)
- Files: `packages/mcp/src/lib/observe-render.ts`(加纯函数 + 替换 3 处硬编码 getOption);`packages/mcp/tests/` 加单测。
- 映射:echarts→`getOption()`;chartjs→`Chart.getChart(canvas).data`;highcharts→`Highcharts.charts[].series`;g2/g2plot→`getData()/getOptions()`;未知→`getOption()/getData()`。
- blindspotTag chart 分支 + blindspotSummary 两处(元素行/frame 行)调 hint。

### Task 2: detectChartCanvas 扩展(页级真源)+ 单测
- echarts(attr)→ G2(祖先 data-chart-source-type)→ Chart.js(`window.Chart?.getChart(el)`)→ Highcharts(`Highcharts.charts.find(c=>c.container.contains(el))`)→ null。
- 单测:各库 fixture → 对应 chartLib;非 chart canvas → null;大小写归一。

### Task 3: detectBlindspot canvas 分支扩展(per-element 真源)+ 单测
- 同序插入 chart-lib 判定,**在框架检测前**;命中 → `{kind:canvas, readback:chart, chartLib}`。
- 单测含「Chart.js canvas 在 React fiber 祖先内 → chart 非 component」锁顺序。

### Task 4: 同步 observe.ts 两内联副本 + parity
- inline detectBlindspot(observe.ts:~3302)+ inline detectChartCanvas(observe.ts:~3616)逐字同步。
- `observe-blindspot-scan.test.ts` parity 结构性断言补 Chart.js/Highcharts/G2 信号。

### Task 5: build + 全测 + 真站 spike
- `pnpm -C packages/extension build` + `pnpm -C packages/extension test` + `pnpm -C packages/mcp test`。
- **活浏览器 spike**:Chart.js file:// → observe 顶部出 `chart(chartjs) → … Chart.getChart().data`(不再 screenshot);echarts 站回归仍 `chart(echarts) → getOption()`。

## Phase 2 后续 backlog(本计划不含,各自 spec/plan)
- **P0-2 几何 readback / `mode=geometry`**:bbox + viewport 包含 + elementFromPoint 遮挡 + ellipsis vs clip。
- **P1-1 对比度 helper**:getComputedStyle 上溯 painted bg + WCAG。
- **P1-2 图像 affordance**:`[blindspot=image alt= src= readback=screenshot]`。
- **P1-3 薄视觉兑底**:ref-marked screenshot。
- **P2 SPA 未渲染**(g2.antv umi)独立排查。
