# observe AntV G2/G2Plot 图表识别 设计

> 上游:[[Knowledge-Library/07-Tech/20260630-vortex截图退化-归因与解决方案]] Layer A。
> 前置已合并:observe canvas readback 指路(P0,main `09e4c64`)+ chart 页级盲区扫描(echarts,main `517f722`)。
> 调研依据:[[Knowledge-Library/07-Tech/20260630-vortex图表识别能力调研-M3]](M3 跑 + Claude vortex 交叉验证)。

## 1. 背景与目标

echarts 图表识别已 ship(canvas 上 `data-zr-dom-id`)。调研 + 交叉验证确认 **AntV G2/G2Plot** 是下一个高价值目标:canvas 真盲区、信号强、国内 ToB 主流。本设计把图表识别从 echarts-only 扩到 **G2/G2Plot**。

**交叉验证(Claude vortex 实测)**:antv.antgroup.com 5 个大 canvas 中 4 个在 depth 2 祖先 div 有 `data-chart-source-type="G2Plot"`,信号真实稳定。

**范围(YAGNI)**:本轮只 G2/G2Plot。Chart.js(无库级信号,易误判)暂缓;SVG 类(Highcharts/ApexCharts/Recharts/Plotly,observe 经 a11y 已读其 `<text>`)不做专门检测。

## 2. 与 echarts 的两个关键差异

1. **信号位置**:echarts `data-zr-dom-id` 在 **canvas 本身**;G2 `data-chart-source-type` 在 **祖先 div**(depth~2)→ 需祖先链遍历。
2. **读法**:echarts 用 `getOption()`;G2 用 `getData()/getOptions()` → 渲染须**库感知**(当前硬编码 getOption)。

**⚠️ 检测顺序约束(load-bearing)**:G2 图表常在 React/Vue 应用中。`detectBlindspot` canvas 分支现序为 echarts→框架(fiber/vue→component)→screenshot。**G2 检测必须插在 echarts 之后、框架检测之前**;否则 React 应用里的 G2 图表会被框架检测先命中返回 `readback=component` 而非 `chart=g2`。

## 3. 四个改动单元

### U1. `blindspot-detect.ts` 两处加 G2 检测
- **`detectChartCanvas(el)`**(页级扫描真源):现为 `data-zr-dom-id`→echarts。在其后加:祖先链(≤6 层)找 `data-chart-source-type` 非空 → `{ chartLib: 值.toLowerCase() }`(`g2`/`g2plot`)。都不命中 → null。
- **`detectBlindspot` canvas 分支**(per-element 真源):在 echarts 检测后、**框架检测前**插入同一祖先链 G2 判定 → `{ kind:"canvas", readback:"chart", chartLib: 值.toLowerCase() }`。
- 两处祖先遍历逻辑一致(自包含,无模块级 helper,page-side 注入约束)。

### U2. `observe.ts` 两处内联副本同步
- inline `detectChartCanvas`(页级扫描段,`[inline detectChartCanvas]`)+ inline `detectBlindspot` canvas 分支(`[inline detectBlindspot]`)逐字同步 G2 判定;`observe-blindspot-scan.test.ts` parity 结构性断言补 `data-chart-source-type`。

### U3. `observe-render.ts` 库感知 readback 提示
- 加纯函数 `chartReadbackHint(chartLib): string` 映射:`echarts`→`getOption()`;`g2`/`g2plot`→`getData()/getOptions()`;未知→`getOption()/getData()`(兜底)。
- 替换 3 处硬编码 `getOption`(blindspotTag 行内 + blindspotSummary 元素行 + frame 行):
  - 行内 tag:`[blindspot=canvas chart=${chartLib} readback=evaluate:${method 短名}]`(echarts→`getOption`,g2→`getData`)
  - summary:`chart(${chartLib}) → read via vortex_evaluate ${hint}`

### U4. 测试 + 真站 spike
- `detectChartCanvas` 单测:G2 祖先 → `{chartLib:"g2plot"}`、值大小写归一、非 chart canvas → null。
- `detectBlindspot` 单测:G2 祖先 canvas(含「G2 在 React fiber 祖先内」用例)→ `chart=g2`(**验证顺序:G2 优先于 component**)。
- `chartReadbackHint` 单测:echarts/g2/g2plot/未知 各映射。
- parity:内联副本结构性断言含 `data-chart-source-type`。
- **真站 spike(承重)**:antv.antgroup.com → observe 顶部出 `chart(g2plot) → read via vortex_evaluate getData()/getOptions()`;echarts 站回归仍 `chart(echarts) → ... getOption()`(库感知未回归 echarts)。

## 4. 数据流(不变,复用既有链路)
```
page-side 检测(U1/U2)→ blindspot {kind:canvas, readback:chart, chartLib:g2plot}
  → spread 透传 → MCP CompactElement/CompactFrame
  → blindspotTag / blindspotSummary 调 chartReadbackHint(chartLib)(U3)
  → [blindspot=canvas chart=g2plot readback=evaluate:getData] / chart(g2plot) → ... getData()/getOptions()
```

## 5. 设计决策
- **方法映射放渲染层**:检测只设 `chartLib` 信号,渲染 `chartReadbackHint` 按库映射方法名——单一真源、检测保持纯分类器、加新库只改一处映射。
- **chartLib 保留 g2/g2plot 两值**:`data-chart-source-type` 区分二者,都映射 getData 提示;保留原值便于 agent 精确知道库。
- **检测顺序**:echarts(canvas attr,最快)→ G2(祖先 attr)→ 框架(fiber/vue)→ screenshot。

## 6. 非目标(YAGNI / defer)
- Chart.js(无库级 canvas 信号)、BizCharts(停维护)。
- SVG 类图表专门检测(observe 已读其文本;精确柱值留未来 SVG 增强)。
- G2 数据自动提取(本轮只"指路"`getData()`,不代读)。

## 7. 关键风险
- **顺序回归**:G2 必须先于框架检测,否则 React 中 G2 误判 component。单测须含「G2 在 React fiber 祖先内」用例锁顺序。
- **第 3+ 份副本**:G2 判定要进 4 处(detectChartCanvas 真源/inline + detectBlindspot 真源/inline),parity 守。祖先遍历是小循环,复制成本可控。
- **echarts 不回归**:U3 库感知改动须保证 echarts 仍渲染 `getOption()`(spike 回归用例)。
