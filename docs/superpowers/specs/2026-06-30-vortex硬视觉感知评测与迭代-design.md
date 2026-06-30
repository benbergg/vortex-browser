# vortex 硬视觉感知评测与迭代 设计

> 上游谱系:[[Knowledge-Library/07-Tech/20260630-vortex截图退化-归因与解决方案]](Layer A/B/C 主方案)+ [[20260630-vortex截图退化-M3自主dogfood实证]](上轮 8 场景)+ [[2026-06-30-observe-g2-chart-recognition-design]](图表桶在建)。
> 本设计是上述工作的**广度扩展**:上轮 8 场景偏文本友好站(结论 R1-R4 零命中疑似样本偏差),本轮专攻**上轮系统性回避的硬视觉桶**。

## 0. 一句话

把「需要截图」当作感知层质量的反向指标,通过 ≥12 个**硬视觉场景**的评测+白盒归因,找出 vortex 在「看似视觉、实可文本化」上的能力缺口,产出能力缺口谱与迭代计划;核心是把已 ship 的「盲区→readback 指路」泛化成系统化的「每桶通道降解引擎」,并为真·光栅残余加一层复用 ref 的薄视觉兑底,**让模型长上一双智能的眼睛——优先文本眼,必要时高效的视觉眼**。

## 1. 背景与目标

- **问题**:模型频繁截图是症状,根因常是 observe/extract 的文本表征不足以理解页面。
- **上轮局限**:8 场景几乎都是文本友好站(Wikipedia infobox / ECharts demo 源码即数据 / Excalidraw React state),得出「R1-R4 零命中、主因仅 R5/R6 通道发现」——**疑似样本偏差**,未触碰真正的硬视觉。
- **本轮目标**:刻意覆盖硬视觉桶(布局空间 / SVG 非主流库图表 / 配色视觉态 / 真光栅图像 / 地图 / PDF),对每个截图诱因归因:**是真·光栅,还是有未被发现的 DOM/几何/源码通道**;据此制订治标治本兼顾的迭代计划。
- **定位**:vortex 属 text-first 阵营(同 Stagehand / playwright-mcp),本轮强化其差异化能力,不转向 vision-first。

## 2. 行业对标(调研结论,4 轨)

1. **text-first 已收敛到「a11y 树 + ref 为唯一/主通道,截图 opt-in」**:Stagehand 正移除 `useVision`(实测视觉无效);Playwright MCP 以 a11y snapshot 为默认主路径(~200-400 token vs 截图 ~3000-5000),Vision Mode 仅 opt-in。
2. **vortex 的「框架主动推送盲区/通道信号」是行业空白(差异化点)**:所有被调研工具都是 agent-pull(模型自决 `take_screenshot`),**没有一个**在 snapshot 里主动告知「此处盲区、存在更好文本通道」。vortex 已原型化的 `[blindspot=canvas]`/`[virtual:N/M]`/`#blindspots` 正填此空白——应深化、泛化到更多桶。
3. **薄视觉兑底的正确形态 = 复用 ref 做 SoM + OmniParser 式结构化摘要**:网页 SoM 不走像素分割而是 DOM 元素叠框;关键是**复用现有 ref 作标记号**,实现「截图号 = DOM ref = 动作参数」三位一体,零错位。
4. **每个硬视觉桶都有成熟的「降解到文本」技术 + 明确的「仍需像素」边界**:
   | 桶 | 降解技术(治本) | 仍需像素的边界 |
   |---|---|---|
   | 布局/空间 | `getBoundingClientRect` 几何(四向相交判重叠、同坐标判对齐、`a.bottom≤b.top` 判上方) | transform/clip-path/格式塔分组 |
   | 配色/视觉态 | `getComputedStyle` + WCAG 亮度公式算对比度 | 背景图/渐变/blend-mode/canvas 内配色 |
   | SVG/非主流库图表 | 库 introspection(`getOption`/Chart.js/Highcharts API/D3 `__data__`)→ visually-hidden 数据表 | 纯 canvas 且未暴露实例、无数据表 |
   | 真光栅图像 | src/figcaption/上下文 → BLIP caption 兜底 | 信息图/含字图/细粒度 → 必须 VLM |
   - 通道落地率分层(治本依据):landmark/heading/阅读顺序「高」→ alt/aria「中」→ PDF.js 文本层「中高」→ **visually-hidden 数据表「低但存在即金矿」** → canvas 像素「0」。

**战略含义**:不是「补字段」,而是把「盲区→readback」泛化成系统化「每桶通道降解引擎」+ 一层薄视觉兑底。这条路在行业里是空白、高价值、差异化。

## 3. 评测 campaign(Phase 1)

### 3.1 双层执行分工

- **M3 探针(opencode,tmux)**:当「弱视觉 agent 行为探针」,代表真实编码 agent 的下限——它会不会被迫截图、能否纯文本完成任务。M3 视觉弱故不可当裁判。
- **Claude 白盒裁判**:每场景三件套——**现象**(M3 行为轨迹)+**代码**(observe/blindspot 路径为何没给通道)+**spike**(真浏览器验证「不截图能否拿到」)+ 强视觉 ground-truth(截图到底有没有解决问题)。

### 3.2 反污染(吸取上轮教训)

- 评测前确认 `vortex_evaluate` 在 M3 会话不再返回 `undefined`(上轮的坑,污染了 evaluate 路径)。
- M3 提示词**不**把 screenshot 写成「最后手段+强制归因」(上轮压制了自然行为致「0 截图」假象),而是中性放开,真实观测截图倾向。
- **报告默认不可信**:M3 报告须经 Claude 白盒逐场景核验(承接历史教训:子模型自跑报告须批判性校正)。

### 3.3 场景集(国内 ToB 高频优先,~12 场景)

> 优势:vortex 驱动已登录的真实 Chrome,M3 经同一 vortex-server/扩展共享登录态,鉴权后真实 ToB 站点可直接评测。Phase 0 先确认登录态。

| 桶 | 场景 | 预判处方 |
|---|---|---|
| **布局/空间** ×3 | ①班牛/bytenew 工作台浮层/弹窗是否被遮挡(memory #42/#64 真实案例)②阿里云/腾讯云控制台 dashboard 卡片栅格对齐/响应式塌陷 ③禅道看板/表单 label 与控件对齐 | `getBoundingClientRect` 几何 |
| **SVG/非主流库图表** ×3 | ④阿里云/腾讯云监控图表(自绘 canvas/非 echarts)⑤AntV G2Plot(antv.antgroup.com,接续 G2 设计)⑥DataV 大屏/国内 BI | 库 introspection/数据表 |
| **配色/视觉态** ×2 | ⑦禅道/班牛工单状态色(bug 优先级、状态行配色)⑧TDesign/Arco 暗色模式对比度 | `getComputedStyle`+WCAG |
| **真光栅图像** ×2 | ⑨班牛工单附件图(无 alt 读内容)⑩电商商品图/信息图 | src/上下文→BLIP/视觉兑底 |
| **对照采样** ×2 | ⑪高德/百度地图点位 ⑫禅道/钉钉文档 PDF 预览文本层 | 边界确认:真·必须像素 |

> 国内罕见技术(D3/Chart.js/Highcharts)已替换为国内等价物(云监控自绘图/AntV/DataV),保留「非 echarts/G2 库图表」挑战且贴合实际使用。

## 4. 解决方案架构(Phase 2,证据驱动)

> 不预先承诺建所有桶,由 Phase 1 归因排序。以下是架构形态与候选菜单。

### 4.1 治本主轴 —— 「每桶盲区 → 通道降解」affordance 引擎

沿用现有代码模式(检测=纯分类器设信号 / 渲染层 `chartReadbackHint` 式映射 signal→提示,单一真源),扩展 detector registry:

| 新增 detector | 触发 | 输出 readback 提示 |
|---|---|---|
| 图表库扩展 | Chart.js / Highcharts / D3 `__data__` / visually-hidden 数据表 | `chart=chartjs readback=evaluate:Chart.getChart()` / `readback=table:#data-table`(接续 echarts/G2 hint 映射,单一真源加一行) |
| 图像 alt 缺失 | `<img>` 无 alt 且无 figcaption | `[blindspot=image readback=query:src/context]` → 兜底才视觉 |

### 4.2 派生 helper(仅几何 + 对比度两处)

affordance 提示是主轴(让 agent 用既有 `query`/`evaluate` 自取);仅两处「agent 难自算」做轻量派生:
- **几何关系**:observe/query 暴露 bbox(已有 includeBoxes)后,「重叠/对齐/X 在 Y 上方」需四向相交、同坐标比对——给几何 readback 提示或 `vortex_query mode=geometry` 直接产出关系判定。
- **对比度**:`getComputedStyle` 拿 rgba 后,WCAG 相对亮度公式 agent 易错——提示里直接给 contrast ratio 或 helper。

### 4.3 治标兑底 —— 复用 ref 的薄视觉层(仅真·光栅残余)

- **`vortex_screenshot` 加 `marks=true`**:复用现有 includeBoxes + ref,在 bbox 角上叠 ref 编号——「截图号 = DOM ref = `act(ref)` 参数」三位一体(行业 SoM 最佳实践)。
- **OmniParser 式结构化摘要**(defer/可选):区域划分 + 元素语义标签替代整高分图,更省 token。看 Phase 1 真·光栅频次再定。

### 4.4 架构原则(承接现有教训)

- 检测纯分类器,方法映射放渲染层单一真源(G2 `chartReadbackHint` 模式泛化)。
- page-side detector 自包含、无模块级 helper(注入约束),parity 守内联副本。
- **承重墙改动必活浏览器 spike**(历史教训:page-side func 内联丢作用域、单测假绿)。

## 5. 分期、交付物、度量

### 5.1 分期

- **Phase 0 环境就绪**:`vortex_evaluate` undefined 排查;opencode+m3 tmux 就绪;站点登录态确认。
- **Phase 1 评测+归因**:12 场景,M3 探针 + Claude 白盒裁判 → 能力缺口谱。**本 brainstorm 后先 writing-plans 规划 Phase 1。**
- **Phase 2 实现**:按 Phase 1 排序建 detector/helper + 视觉兑底,TDD + 活 spike + bench 回归,每项过 requesting-code-review。**Phase 1 出结果后单独再 plan。**

### 5.2 能力缺口谱(Phase 1 核心交付,每场景一行)

桶/场景/站点 · M3 行为(是否截图/能否纯文本完成)· Claude 裁判(真光栅 vs 有未发现通道;有效/无效退化)· 根因(R5/R6/新)· 处方(治本 detector/helper / 治标视觉兑底)· 优先级(频次×降解可行性)。

### 5.3 度量(截图率为反向指标)

- 截图率:实现前后同批场景重跑对比。
- 无效退化次数:实现前后对比。
- 每桶降解成功率:文本通道足够完成任务的比例。
- bench 回归零破坏:现有 case 保持。

### 5.4 产出文档

- Phase 1 → 知识库 `07-Tech/` 评测+归因报告(接续今天三份文档谱系)。
- Phase 2 → 各 detector `docs/superpowers/specs/` 设计 + 实现(沿用现有 spec/plan 流程)。
- ship 过 ship checklist(reflexion 双轮 / 数字三处一致 / silent fallback 测试)。

## 6. 非目标(YAGNI)

- 不追求 0 截图;保留真·光栅(地图瓦片/设计美学/信息图)的合法视觉,如实标注。
- 不转 vision-first;薄视觉兑底仅服务不可降解残余。
- OmniParser 式结构化摘要本轮 defer。
- 不预先全建所有桶 detector,由 Phase 1 归因排序。
- BLIP 等本地视觉兑底先标注路径,是否落地看 Phase 1 真光栅频次。

## 7. 关键风险

- **M3 弱视觉混淆**:M3 不可当视觉裁判,只做行为探针;裁判权在 Claude 白盒+spike。
- **鉴权站点 M3 可达性**:依赖当前 Chrome 登录态;Phase 0 须确认,失败则换公共等价站。
- **承重墙改动假绿**:detector 进 4 处(真源+inline ×2),parity 守;必活浏览器 spike。
- **样本偏差重演**:本轮刻意攻硬视觉,避免再选文本友好站自证;对照采样桶(地图/PDF)用于确认「真·必须像素」边界存在。
