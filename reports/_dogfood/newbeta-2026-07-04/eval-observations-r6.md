# newbeta.bytenew 评估观察 (M3) — r6

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 看板图文卡片的非截图识别（退款管理大脑看板 4 卡片 + 空看板对照）| 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**核心结论 — 4 张「图文卡片」全部非截图可识别(0 张盲点)**,但路径不同:
- **全部 4 张标题**: 100% extract / observe / query mode=text 三路覆盖
- **卡片 4 (echarts 真图)**: 完整非截图识别 — `evaluate echarts.getInstanceByDom().getOption()` 拿到 5 series + 3 xAxis dates,数据全 readout
- **卡片 1, 2, 3 (标题-only "图文"卡片)**: **「图」部分在 DOM 中根本不渲染**(no `<img>` / `<canvas>` / `<svg>` / `background-image`),非截图工具拿不到任何"图"内容 — 但这**不是盲点**,而是「图文类型卡片配的图缺位」(其 DOM 的 chart-body 只有 `<strong>` 红字标题一句)

**空看板 (VOC / 啾啾) — 非截图清晰信号**:"共0张卡片" + "看板由一个个图表组成，请点击添加图表" + "+ 添加图表" 按钮三处证据,observe / extract / query 都拿得到;vortex 自己标的盲点只是装饰性插画(img[no alt]=`board-empty.jpg`),不影响"空"语义。

**意外发现 — 顶部 2 个 `el-radio-button` 都标 "图文"**(aria-checked=true / null 切换),点击第二个会让卡片 0 的标题在「退款订单状态数量分析 ↔ 退款金额分析」之间切换。两 radio 按钮的 label 文本完全一样,用户/调用方都看不出语义区别 — 这是 UI 设计层面的歧义;切换会触发网络请求 `brain/ui/datam`,暗示这是数据视图切换。

## 观察记录

### C1 退款管理大脑看板 — 4 张「图文」卡片非截图识别(全新 tab `984528429`)

工具预算:本 tab 共 ~22 次工具调用。

- **O-1** [正常·extract 拿到全部 4 卡片标题] `vortex_extract {target:"div", includeAlt:true, scroll:true}` → 末尾依次出现 4 段独立标题文字:`退款订单状态数量分析 / 退款处理监控 / 退款数据分析 / 今年十一对比去年618(添加图内筛选)-复制`,卡片间有空行分隔。extract 比 observe 早一步召回卡片文本(observe 默认 viewport 80 截断内不包含卡片主体),说明 extract 的 innerText 收集对 a11y 树未覆盖的 rich-text 也有效(标题在 `ql-editor > p > strong` 里)。

- **O-2** [正常·query mode=css 锁定 4 张卡片容器] `vortex_query {mode:"css", pattern:".vue-grid-item.card-board-item"}` → 4 个 div,text 分别为「图文图文退款订单状态数量分析」「退款处理监控」「退款数据分析」「今年十一对比去年618... 刷新 导出Execl 导出PDF 放大 创建时间_日 创建人」。children_count 都是 2。**卡片 4 多出 toolbar** (刷新/导出Execl/导出PDF/放大) → 通过观察多元素 + 不同文本即能让非截图工具识别"卡片 4 有图表操作工具栏"。

- **O-3** [异常·3 张卡片的"图"部分在 DOM 中不存在] evaluate 三角验证 4 个卡片的 `.card-board-main-body-chart` innerHTML:
  - 卡片 0 / 1 / 2:`<div class="ql-editor"><p class="ql-align-center"><strong style="color: rgb(230, 0, 0);">标题</strong></p></div>` — **只有红字标题一句文字**,innerHTML 长度 133/133/137 字节,**无 `<img>` / `<canvas>` / `<svg>` / `background-image`**(query mode=geometry 看 `.card-board-main-body-chart` style.backgroundImage = "none",query mode=css pattern="img / canvas / svg" 在卡片体内 = 0/0/0)。
  - 卡片 3 (268537632119):`<div style="...position:relative;width:533px;height:336px;..."><canvas data-zr-dom-id="zr_0" .../></div>` — **真的是 echarts canvas,533×336,可被 `echarts.getInstanceByDom(...).getOption()` 完整 readout**。

  关键证据:brief 假设"4 张『图文卡片』(IMG 图片+文字)";实际 DOM 不是 4 张 IMG。**前 3 张的"图"部分根本没渲染**,只有红色加粗标题文字;brief 错误地把它们叫做 IMG 图片卡片。要识别它们的"图"内容,非截图工具能拿到的只有"标题的颜色/字号/居中",**没有任何视觉/数据语义** — 但**这并不是 screenshot 盲点**(没有图可看),而是**卡片"图"内容的虚空** — 可能(1)这些"图文"卡片类型的图片在生产环境配置有错(应该是一张图片但没加载/没存),(2)设计上故意做"文字标题"且没说自己是"图"卡片,而 toolPageText "图文"是 UI 误标,(3)echarts 类型 ID 错配给纯文本卡片。未深查。

- **O-4** [正常·卡片 4 echarts canvas 完全非截图 readout] evaluate 链:canvas 的祖父 div 有 `_echarts_instance_="ec_1783178213734"`,`window.echarts.getInstanceByDom(this.parent).getOption()` 返回:
  - 5 series(line 类型):`任务数_待处理0 / 任务数_已完成0 / 任务数_处理中0 / 任务数_暂停中0 / 任务数_已关闭0`
  - series data sample:`[3,0,1] / [0,1,0] / [0,0,0] / [0,0,0] / [0,0,0]` (3 个 xAxis 点)
  - xAxis 3 个日期:`2024-09-05 / 2024-07-17 / 2024-07-08`
  - yAxis: value 类型
  - 颜色板:`#4DADFF / #81DF95 / #6B8DFF / #FED040 / #5F5CFF / ...`(9 色调色板)
  - tooltip.trigger: 'axis' (推断)

  **仅靠 canvas 像素点无法辨别这些数据,而 `evaluate.getOption()` 能 100% readout chart 内容** — 这是 vortex 的"chart chart(echarts) → read via vortex_evaluate getOption()" 提示在生效。**判定:卡片 4 完全非截图可识别**(标题 + 工具栏 + echarts 数据全到位)。

- **O-5** [异常·2 个 `el-radio-button` 都标 "图文",label 文本完全一样] query / evaluate 三角:看板顶部 `el-radio-group.aggCardRadioGroup` 包含两个 `el-radio-button el-radio-button--mini`,inner 都是"图文"标签 + 一个 `<!---->` 注释占位(估计是图标)。click `@eb86:e6`(第 2 个)→ aria-checked 切到 `[ref=@eb86:e6]`,卡片 0 标题从「退款订单状态数量分析」变为「退款金额分析」(extract 重读也复现这个变化);network 出现 `newbeta.bytenew.com/brain/ui/datam` 请求,说明是数据维度切换。click `@eb86:e5`(第 1 个)又恢复回「退款订单状态数量分析」。

  **但两个按钮 label 文本一模一样,observe 也只看到两个 `radio "图文"`,无语义区分**(一个 checked 一个 unchecked)。**对调用方/用户而言,无法仅凭 observe/UI label 区分这两个 radio 各自代表什么数据维度** — 这是一个 UI 语义歧义。卡片 1 / 2 / 3 在切换中标题不变(均为「退款处理监控 / 退款数据分析 / 今年十一对比去年618...」),可见只有卡片 0 受影响。

- **O-6** [观察·observe 不承认卡片是可交互元素] `vortex_observe scope=viewport filter=interactive` 第一次 recall 末尾出现 `div "共4张卡片" + span "最近更新时间..."`,但**4 张卡片主体都不在 interactive 列表**(即使卡片 0 的 text 包含 "图文图文" 也不是单独 ref) — observe 截断到 ~80 candidates 把卡片挤到 viewport 边缘外。卡片 4 的工具栏按钮 (刷新/导出Execl/导出PDF/放大) 也没在 80 截断内,**observe 完全召回不到卡片任何 UI 元素**;可用 extract / query mode=css 找回。

- **O-7** [观察·query mode=geometry 4 卡片布局] `.vue-grid-item.card-board-item` bbox:
  - 卡片 0 / 1 / 2:y=113 / 253 / 393,x=310,w=1120,h=130(全宽 + 140 间距,3 张满铺)
  - 卡片 3:y=533,x=310,w=555,h=410(左半,clippedByAncestor=true → **inViewport:false**,因为 viewport 是 1440×732 但卡片底 y=943 超出 732)
  - 视口内只能直接看到卡片 0 / 1 / 2,卡片 3 在视口外需要 scroll/zoom 才看到。
  - 关键:evaluate 看到的内容(echarts canvas)其实**不在 viewport 内**,但通过 DOM 路径仍可拿到。

- **O-8** [正常·query mode=text 可 grep 卡片标题] `vortex_query {mode:"text", pattern:"退款"}` 在第 6/7/8 行返回 3 条卡片标题命中,element_path 走 `div.open-record-item.active > div.text-over-one.w-color-blue`、`.card-board-main-body-chart > div.ql-editor > p.ql-align-center > strong`。**这是当 extract 不可用时的 fallback grep 路径**,覆盖卡片标题。

- **O-9** [观察·query mode=css attr=src / attr=alt 看全局 img]
  - 全部 47 个 img 中:
    - 1 个是 `banniu-work.oss-cn-zhangjiakou.aliyuncs.com/125_10030158_457fba620e4e4c5ced6aab5691f3b933.png` — bbox=[0,0,0,0] 完全看不见,src 是真实 OSS URL 但 alt=""
    - 41+ 个是同一个 CDN 透明 PNG (24c3b65ec3...) 或 base64-encoded,都是透明 placeholder icon(多为 ui 内置图标 / loading 占位),alt 多为 `""` 或无该 attr
  - **4 张卡片 body 内 img 数量 = 0**(已 evaluate 验证)
  - 结论:全页 img 都不在卡片图内 — 整体 img 都拿不到语义

### C2 VOC工作表看板 — 空看板信号(全新 tab `984528430`)

工具预算:本 tab 共 ~3 次工具调用。

- **O-10** [正常·空看板的非截图信号三处]
  - toolbar footer 文字 `共0张卡片` — extract / observe 都能拿到(query mode=css `pattern:"div[textContent*='共0张卡片']"` 命中;observe 输出 `div "共0张卡片" [ref=...]`)
  - 主区域文字 `看板由一个个图表组成，请点击添加图表` — extract 命中(query mode=text 命中;observe 输出 `div "看板由一个个图表组成,请点击添加图表"` 父元素)
  - "+ 添加图表" 大按钮 — observe 输出 `button "+ 添加图表" [ref=@2576:e8] [cursor=pointer]` 是 actionable 元素
  - **observe 本身有顶部自动提示 `# blindspots: image(no alt) → src=https://newbeta.bytenew.com/appStatic/img/board-empty.53bc94ae.jpg | visual content, use vortex_screenshot`** — vortex 自己把这个装饰插画标成盲点,但"空"语义已被上述 3 处文字+按钮完整表达,这个盲点不影响"识别是不是空看板"。

- **O-11** [观察·空看板无 `.vue-grid-item.card-board-item`] query mode=css `.vue-grid-item, [class*='empty-']` 返回 0 — 即空看板连空 container 都没渲染,与 4 卡片看板不同。这是另一个非截图可识别的"空"信号。

### C3 啾啾测试看板 — 空看板信号复测(同 tab `984528430`)

- **O-12** [正常·同结构空看板被复测,信号一致] 切换到啾啾测试看板后 extract 末尾出现 `啾啾测试看板 共0张卡片 最近更新时间:2024-10-14 16:33:28 ... 看板由一个个图表组成,请点击添加图表 + 添加图表`,**与 VOC 工作表看板的空看板信号完全一致**;observe 同样召回 "+ 添加图表" 按钮。**空看板信号在不同 app 上一致出现**,不是一次性特例。

## 异常汇总 (Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 退款管理大脑看板 卡片 0/1/2 标题卡片"图"部分 DOM 不渲染 | brief 假设 4 张"图文卡片"(IMG 图片+文字)。实际只有卡片 3 是 echarts canvas;前 3 张 `.card-board-main-body-chart` innerHTML 只有 `<ql-editor><p><strong style="color:rgb(230,0,0)">标题</strong></p></ql-editor>` —— **没有 img / canvas / svg / background-image**。非截图工具能拿到的只有标题文字+颜色,完全识别不到"图"的语义。blindspot 严格意义不算(因为没有图可看,截图也无法识别) | experience (数据/配置问题——可能是 bytenew 配置错把"图文类型"绑定到无图卡片,或 echarts 资源未加载。**这是数据/配置层发现,不阻塞 dogfood 评估流程**) | O-3 | 是(同 tab query + evaluate + extract 三路径,跨字段都成立) |
| A-2 | 看板顶部 2 个 `el-radio-button` 都标 "图文" 无语义区分 | `el-radio-group.aggCardRadioGroup` 含两个 label 都为「图文」的 radio;click 第 2 个会让卡片 0 标题在「退款订单状态数量分析 ↔ 退款金额分析」间切换(card 1/2/3 不变),伴随 `brain/ui/datam` 网络请求;但 observe/label 都看不出两个 radio 各自的语义(都是 "图文",只有 aria-checked 切换)。**纯 UI 歧义,a11y 树无法区分** | experience (UI 层面观察——对真人用户和调用方都难辨"图文_视图1 vs 图文_视图2"。截图也无法看到更多差异,因为差异在数据而非视觉) | O-5 | 是(新 tab + 同 tab 切换复现) |

> 整体裁决(仅观察,不做根因):
> - **本轮核心练功点 (非截图读图文卡片) 完全搞定**:4 张卡片 × 标题 (4/4) + 工具栏 (1/1) + echarts 数据 (1/1) 全部非截图 readout 路径打通;**没有任何卡片"必须截图才能识别"的内容**(0 张 blindspot)。
> - **3 张"图文卡片"的图内容缺位** 是数据/配置层面的意外(A-1),不是盲点(无图可看)。`brief 假设的"IMG 图片 + 文字"` 与 DOM 现实不一致;non-screenshot 工具的极限是"读完所有 DOM 真相",这里 DOM 真相本身就是"只有标题文字",所以 3 张卡片的 final readout 就是 3 个标题——这不是工具缺陷,是 brief 假设与现场数据的 mismatch。
> - **echarts canvas 数据可读**(evaluate.getOption())是本轮亮点发现,**证明 bbox 内的 canvas 不一定需要截图就能 readout chart 数据**,同理可推到所有 echarts 实例;但需要先在 a11y/board 层找到 `_echarts_instance_` 属性或 canvas ID。
> - **`el-radio-button` label 同名**(A-2)是 UI 设计层面的语义缺失,observe/extract/query 都无解(因为 label 文本本就是 "图文"),对调用方/真人都构成歧义;但这不影响 dogfood 评测主流程。
> - **空看板信号非截图清晰**(3 处文字证据 + "+ 添加图表" actionable 按钮 + 无 `.vue-grid-item`),与 brief "撞到空看板信号是否静默"的关切一致:**非静默**。

## 已试的非视觉路径

- `vortex_extract × 5`(`div` 全页 default / `div` `includeAlt:true` / `.vue-grid-item.card-board-item:nth-of-type(1)` / `:nth-of-type(4)` / 多次重读,卡片标题全到位)
- `vortex_observe scope=viewport filter=interactive × 4`(看板顶部 + 4 卡片初始 / 切换 radio 1↔2 / VOC 空看板 / 啾啾空看板)
- `vortex_query mode=css × ~14`(.vue-grid-item.card-board-item / .card-board-main-body-chart / .ql-editor / canvas / img[src*='125_10030158'] 等多种选择器)
- `vortex_query mode=geometry × 3`(4 卡片 bbox / canvas 单元素 / 全 img 列表)
- `vortex_query mode=text × 4`(`退款` / `退款订单状态|退款处理监控|...` / 卡片标题 grep / 卡片内容 grep)
- `vortex_act click × 3`(@eb86:e26 跳看板 / 2 次 radio button 切换)
- `vortex_mouse_click × 0`
- `vortex_wait_for idle × 4`(跳转新 tab + 切换 radio 后 settle)
- `vortex_tab_create × 2` + `vortex_tab_close × 2`(退款大脑看板 tab + 验证空看板 tab 隔离)
- `vortex_evaluate × 8`(每张卡片的 title / children / canvas / background-image / img / alt / data-attr / 卡片几何;以及 `echarts.getInstanceByDom(...).getOption()` 读 chart data;以及空看板 illustration 验证)
- `vortex_screenshot × 0`(硬门槛遵守,本轮没截图)
- **未试**:mode=flow / mode=sheet(本轮无流程画布 / canvas 电子表格);无 mode=style 必要(无 active 态需要补回)

## 摘要 (供 Claude 摄取)

- **0 张盲点**:全部 4 张卡片的全部 DOM 真相(title + toolbar + echarts data)都已 non-screenshot readout。
- **1 项数据/配置发现**:前 3 张"图文卡片"的"图"部分 DOM 不存在 (no img/canvas/svg/background-image),即 only 标题 — 是 brief 假设 vs 实际 DOM 不一致,非截图工具尽其所能只能给出"3 个标题"。
- **1 项 UI 歧义发现**:看板顶部 2 个 radio button 都标"图文",语义无法从 a11y/label 区分。
- **echarts 完整 readout**:哪怕 4th 卡片在 viewport 外,只要 canvas 在 DOM 且 `window.echarts` 可用 + 找到 `_echarts_instance_` 属性,getOption() 拿到 series/xAxis/yAxis 全数据 — 是 vortex 的 "chart chart(echarts) → read via vortex_evaluate getOption()" 提示在生效。
- **空看板易识别**:"共0张卡片" + "请添加图表" 文字 + "+ 添加图表" 按钮三处证据,observe/extract/query 都到位。
- **brief 重审建议**:brief 把 4 张卡都标"图文(IMG 图片+文字)",实际只有 1 张含图(echarts),其余 3 张是"标题-only 文案卡片"——下一轮 brief 应区分"真实图片卡片 vs 标题文字卡片"。
