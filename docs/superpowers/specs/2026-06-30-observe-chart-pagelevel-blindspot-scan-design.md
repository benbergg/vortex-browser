# observe chart 页级盲区扫描 设计

> 上游项目:[[Knowledge-Library/07-Tech/20260630-vortex截图退化-归因与解决方案]] Layer A 后续。
> 前置已合并:observe canvas readback 指路(P0 Layer A,main `09e4c64`)。

## 1. 背景与目标

P0 Layer A 给**被收集的(交互)canvas** 加了 per-element readback 指路。但真站 live 暴露一类盲区未覆盖:**图表 canvas 常不被收集为交互元素**——
- ECharts 图表渲染在 `about:srcdoc` 子 frame 的 canvas,非交互 → 不进收集集 → 无 per-element 盲区标注(live 实测 ECharts 顶部 `# blindspots:` 无任何 chart 提示)。
- 主 frame 内非交互的图表 canvas 同理漏标。

**目标**:对**未被收集**的图表 canvas 做页级扫描,产出 frame 级盲区条目,让 agent 知道"这里有个图表,数据可经 vortex_evaluate 读 getOption() 而非截图估值"。

**范围决策(用户拍板)**:**仅图表(高信号)**。只标被识别为图表库的 canvas(echarts/zrender);纯 raster / 装饰 canvas 不页级标(零噪声)。

## 2. 架构:镜像虚拟列表 dedicated pass

复用既有 `pageBlindspots` 模式(observe.ts:3498):一个**独立于元素收集**的 pass,用 `querySelectorAllDeep` 扫全文档产出 frame 级盲区条目。**该 pass 在 MAIN-world scan func 内,observe 逐 frame 注入运行**——故 srcdoc 子 frame 被 scan 时,在该 frame 内扫 canvas 自动覆盖,srcdoc 问题免费解决(无需跨 frame 特殊处理)。

虚拟列表的 frame 级条目按 name(非 ref)产出 → 渲染进顶部 `# blindspots:`。chart 扫描沿用同通道。

## 3. 五个改动单元

### U1. 纯函数 `detectChartCanvas(el)` — `blindspot-detect.ts`
对标既有 `detectVirtualByScroll`。判据(廉价高精度,Task 4 已验真实属性):
```
detectChartCanvas(el: HTMLElement): { chartLib: string } | null
  el.tagName==="canvas" 且 el.getAttribute("data-zr-dom-id") !== null → { chartLib: "echarts" }
  否则 null
```
结构设计成加新检测器(Chart.js/AntV)是局部改动;本轮只 echarts/zrender。

### U2. 页级 canvas 扫描 — observe.ts:3498 pass 内新增段
```
querySelectorAllDeep("canvas", document) 逐个:
  ① 尺寸门:rect.width*rect.height >= 200*150(复用 CANVAS_MIN_AREA 同阈,排装饰 sparkline)
  ② dedup:跳过已被 per-element 收集的 canvas(collectedEls 已在作用域)
  ③ detectChartCanvas 命中 → push frame 级条目
     { kind:"canvas", name, chartLib, readback:"chart" }
     name = aria-label/title || "chart"
```
内联副本 + `[inline detectChartCanvas]` 标记;parity 测试守(同既有模式)。

### U3. frame 级 blindspot 类型扩 union
当前 `{ kind:"virtual"; total; rendered; name; confidence? }`(两处:`FramePageResult.blindspots` observe.ts:233、`CompactFrame.blindspots` observe-render.ts:94)扩为 union,加 canvas 变体:
```
| { kind:"virtual"; total:number; rendered:number; name:string; confidence?:"low" }
| { kind:"canvas"; name:string; chartLib:string; readback:"chart" }
```

### U4. 渲染 frame 级 canvas 条目 — `blindspotSummary`(observe-render.ts:345 frame 循环)
现有循环只处理 virtual。加 canvas 分支:
```
canvas 变体 → `${name} chart(${chartLib}) → read via vortex_evaluate getOption()${frame 标注}`
```
与 per-element chart summary 文案对齐(`→ read via vortex_evaluate getOption()`)。

### U5. dedup 守
页级扫描跳过已被 per-element 收集并已打 canvas 盲区的 canvas(避免 Excalidraw 类被双报)。`collectedEls` 在 3498 作用域可用,按成员判定跳过。

## 4. 数据流

```
[每 frame] MAIN-world scan func
  → pageBlindspots pass: detectChartCanvas 扫未收集 canvas
  → FramePageResult.blindspots += {kind:"canvas",...}
  → MCP CompactFrame.blindspots
  → blindspotSummary → 顶部 `# blindspots: <name> chart(echarts) → read via vortex_evaluate getOption() (frame N)`
```

## 5. 测试

- **U1**:`detectChartCanvas` 单测(zrender canvas→{chartLib:echarts}、非 canvas→null、无属性 canvas→null)
- **U2**:内联副本 parity(`observe-blindspot-scan.test.ts` 加 `[inline detectChartCanvas]` 结构性 + 行为断言)
- **U3/U4**:frame 级 chart 条目渲染单测(`observe-render-blindspot.test.ts`:CompactFrame.blindspots 含 canvas 变体 → 输出含 `chart(echarts) → read via vortex_evaluate`)
- **dedup**:已收集 canvas 不重复进 frame 级条目的断言
- **真站 spike**(承重,jsdom 测不到 srcdoc + 真 zrender):ECharts editor `frames=all-permitted` → 顶部 `# blindspots:` 出 chart 条目带 frame 标注;raster fixture 不出 chart 条目

## 6. 非目标(YAGNI)

- 非 echarts 图表库(Chart.js/AntV/Plotly):需全局 registry 或 SVG 处理,脆;留增量。
- 纯 raster / 装饰 canvas 页级标注:用户选 charts-only,排除。
- 图表数据**自动提取**(直接吐 series 值):属 Layer B 库感知提取器,本轮只"指路"不"代读"。
- 非交互 canvas 的通用盲区(非图表):同 Layer A backlog,本轮不碰。

## 7. 关键风险

- **第 3 份 canvas 逻辑副本**:本设计的 `detectChartCanvas` 是**独立小函数**(非复用 per-element 的 `detectBlindspot` 全分类),只做 chart 判定,与 per-element classifier 正交,不引入第 3 份全分类副本。仅 echarts 一行属性判定,parity 成本低。
- **dedup 正确性**:must 跳过已收集的 zrender canvas(若它恰好被收集),否则 per-element + 页级双报。spike 须含"主 frame 已收集 chart canvas 不双报"用例(可用交互式 echarts 构造)。
- **噪声**:charts-only + 尺寸门已把噪声压到最低;真站 spike 确认无误报(非图表大 canvas 不被标 chart)。
