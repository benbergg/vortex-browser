# vortex 硬视觉感知评测 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 12 个国内 ToB 硬视觉场景评测 vortex 感知层,经 M3 探针 + Claude 白盒裁判产出「能力缺口谱」,为 Phase 2 实现排序。

**Architecture:** 双层评测——M3(opencode/tmux)当弱视觉 agent 行为探针(会不会被迫截图/能否纯文本完成);Claude 当白盒裁判,每场景做「现象(M3 轨迹+ground truth)+ 代码(observe/blindspot 路径为何没给通道)+ spike(真浏览器验证不截图能否拿到)」三件套,判定真·光栅 vs 有未发现通道,记录缺口谱一行。

**Tech Stack:** vortex MCP(observe/query/extract/evaluate/screenshot)、opencode + MiniMax-M3、Chrome + vortex 扩展、knowledge library 文档。

## Global Constraints

- **报告默认不可信**:M3 自跑结论须经 Claude 白盒逐场景核验(承接历史教训)。
- **裁判权在 Claude**:M3 视觉弱,只做行为探针,不可当视觉裁判。
- **每场景必活浏览器 spike**:预判通道须真浏览器跑通验证,不靠推测。
- **缺口谱文档**:`/Users/lg/workspace/Knowledge-Library/07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md`,每场景追加一行,全程累积。
- **不含 Phase 2 实现**:本计划只评测+归因,不改 vortex 源码(spike 用 evaluate 只读验证,不落地 detector)。
- **vortex_evaluate 契约**:传 IIFE `(() => { ...; return X })()`,**不要**传未调用的箭头表达式(上轮 M3 踩 `() => 'test'` 返 undefined 的坑)。

---

## 缺口谱行格式(每场景产出一行,Markdown 表格)

| 列 | 内容 |
|---|---|
| # | 场景编号 ①–⑫ |
| 桶 | 布局空间 / SVG图表 / 配色视觉态 / 真光栅图像 / 对照采样 |
| 站点·任务 | 站点 + 视觉问题 |
| M3行为 | 截图次数 / 是否纯文本完成 / 用了哪些工具 |
| Claude裁判 | 真光栅 \| 有未发现通道;截图=有效退化 \| 无效退化 |
| 根因 | R5盲区信号不精确 / R6库数据未提取 / 新根因(命名) |
| 处方 | 治本(哪个 detector/helper)/ 治标(视觉兑底)/ 无需(文本已够) |
| 优先级 | P0/P1/P2 = 频次 × 降解可行性 |

---

## 场景评测协议(每场景执行,各桶 Task 引用)

对每个场景,**依次**执行以下 5 步,产出一行缺口谱:

1. **M3 探针**(opencode tmux 窗口):把该场景的**中性提示词**(见 Phase 0 Task 0.3 模板)粘给 M3,让它自主完成。捕获:`vortex_screenshot` 调用次数、是否纯文本完成任务、完整工具轨迹。**不**在提示词里写「截图是最后手段」之类压制语(上轮污染源)。
2. **Claude 现象**:复核 M3 轨迹;Claude 自己用 vortex(observe/query/extract)复现任务,并截 **1 张** ground-truth 图(Claude 有视觉)确认正确答案。
3. **Claude 代码**:用 codegraph/Read 读相关 `observe.ts` / `blindspot-detect.ts` / `observe-render.ts` 路径,解释该场景的文本通道为何未被 surface(或已被 surface 但 agent 没用)。
4. **Claude spike**:用 `vortex_evaluate` 真浏览器跑该桶的**预判通道命令**(见各桶 Task),拿到的值与 ground-truth 比对——确认「不截图能否拿到答案」。
5. **Claude 裁判 + 记录**:按缺口谱格式判定并追加一行到缺口谱文档。`git add` + commit 该文档。

---

## Phase 0 — 评测环境就绪

### Task 0.1: 排查 vortex_evaluate undefined

**Files:**
- 验证用,无源码改动。若确诊为真 bug,记录到缺口谱文档「附录:工具缺陷」段(不在本计划内修)。

**Interfaces:**
- Produces: 确认 `vortex_evaluate` 在 M3 会话与 Claude 会话均能正常返回值,IIFE 契约明确。

- [ ] **Step 1: Claude 会话验证 evaluate 正常**

用 vortex 导航到 `https://example.com`,调 `vortex_evaluate` 传 `(() => { return document.title })()`。
Expected: 返回 `"Example Domain"`(非 undefined)。

- [ ] **Step 2: 验证箭头表达式陷阱**

调 `vortex_evaluate` 传 `() => 'test'`(未调用)。
Expected: 返回 undefined 或报错——确认这是契约误用(非 bug),固化「必须 IIFE」结论写入 Task 0.3 提示词模板。

- [ ] **Step 3: opencode/M3 会话验证 evaluate**

在 opencode tmux 窗口让 M3 对同一页跑 `(() => { return document.title })()`。
Expected: 返回正确 title。若仍 undefined → 确诊为 M3 会话级真 bug,记录到缺口谱附录并在场景评测中避开 evaluate 路径(用 query 替代)。

- [ ] **Step 4: 记录结论**

把「evaluate 契约 = IIFE / M3 会话是否正常」结论写入缺口谱文档附录。无需 commit(Task 0.3 一起提交)。

### Task 0.2: opencode + M3 + vortex 连通

**Files:**
- 无源码改动。

**Interfaces:**
- Consumes: Task 0.1 的 evaluate 结论。
- Produces: 可用的 opencode tmux 窗口,vortex MCP 直连,M3 能调 observe/query/extract/screenshot。

- [ ] **Step 1: 确认 tmux opencode 窗口存在**

Run: `tmux list-windows 2>/dev/null | grep -i opencode || echo "需创建 opencode 窗口"`
Expected: 列出 opencode 窗口;不存在则按用户 opencode 配置创建。

- [ ] **Step 2: 确认 vortex MCP 在 opencode 已加载**

让 M3 跑一个 smoke:`vortex_navigate` 到 `https://example.com` + `vortex_observe`。
Expected: observe 返回元素树,证明 MCP 直连可用。

- [ ] **Step 3: 确认 Claude 侧 vortex 同样连通**

Claude 调 `vortex_tab_list`。
Expected: 返回当前标签页,证明 Claude 与 M3 共享同一 Chrome/扩展会话。

### Task 0.3: 登录态确认 + 中性提示词模板

**Files:**
- Create: `/Users/lg/workspace/Knowledge-Library/07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md`(空表头 + 附录占位)

**Interfaces:**
- Produces: 缺口谱文档骨架 + 每场景复用的中性 M3 提示词模板。

- [ ] **Step 1: 确认目标站点登录态**

Claude 用 `vortex_navigate` 逐一打开:班牛工作台、bytenew 工作台/VOC、禅道、阿里云或腾讯云控制台,各跑一次 `vortex_observe` 顶部确认非登录页。
Expected: 4 类站点均为已登录内容页;未登录的记录下来,该桶场景改用公共等价站(如 element-plus/antd/tdesign demo)。

- [ ] **Step 2: 写中性 M3 提示词模板**

模板(每场景填 `{站点URL}` + `{视觉问题}`):

```
请用 vortex 工具打开 {站点URL},回答这个问题:{视觉问题}。
你可以使用任何 vortex 工具(observe/query/extract/evaluate/screenshot 等),用你认为最合适的方式完成。
完成后告诉我:答案是什么、你用了哪些工具、每个工具大致返回了什么。
注意:vortex_evaluate 传 IIFE 形式 `(() => { ...; return X })()`,不要传未调用的箭头表达式。
```

(关键:不写「优先 X」「截图是最后手段」等任何压制/诱导,真实观测 M3 自然倾向。)

- [ ] **Step 3: 写缺口谱文档骨架**

写入文档:frontmatter(created/updated/project: vortex/status: in-progress/tags)、标题、缺口谱空表头(列同上)、`## 附录:工具缺陷`(填 Task 0.1 结论)、`## M3 提示词模板`(填 Step 2)。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-06-30-vortex硬视觉感知评测-phase1.md
git -C /Users/lg/workspace/Knowledge-Library add 07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md
git commit -m "docs(plan): 硬视觉感知评测 Phase1 计划 + 缺口谱骨架"
```

---

## Phase 1 — 12 场景评测+归因

> 每个桶 Task 对其下场景**逐个**执行「场景评测协议」5 步。下面给出每场景的 `{站点URL}`、`{视觉问题}`、**预判通道 spike 命令**、**预期代码路径**。站点若 Task 0.3 未登录,用括号内公共等价站。

### Task 1: 布局/空间桶(①②③)

**Files:**
- 追加 3 行到缺口谱文档。

**Interfaces:**
- Consumes: Phase 0 环境 + 协议。
- Produces: ①②③ 缺口谱行 + 几何 readback 可行性结论。

**预判通道 spike 命令(vortex_evaluate IIFE,选择器评测时填):**

```js
(() => {
  const a = document.querySelector("SEL_A").getBoundingClientRect();
  const b = document.querySelector("SEL_B").getBoundingClientRect();
  const overlaps = !(a.right<=b.left || a.left>=b.right || a.bottom<=b.top || a.top>=b.bottom);
  return {
    a:{top:a.top,left:a.left,right:a.right,bottom:a.bottom},
    b:{top:b.top,left:b.left,right:b.right,bottom:b.bottom},
    overlaps, aAboveB: a.bottom<=b.top, leftAligned: Math.abs(a.left-b.left)<2
  };
})()
```

**预期代码路径**:`observe.ts` 默认不输出 bbox(需 `includeBoxes:true`);几何关系(重叠/对齐/上下)无任何 readback 提示——这是缺口。

- [ ] **Step 1: 场景①** — `{站点}`=班牛/bytenew 工作台(未登录用 element-plus el-popover demo);`{视觉问题}`=「某操作浮层/弹窗是否被其他元素遮挡(完整可见还是被截断)」。执行协议 5 步。spike:对浮层与疑似遮挡元素跑上面命令,看 `overlaps`。记录行 + commit。
- [ ] **Step 2: 场景②** — `{站点}`=阿里云/腾讯云控制台 dashboard(未登录用 tdesign/arco admin 模板);`{视觉问题}`=「缩小窗口到移动断点后,顶部统计卡片是否仍横向对齐,还是塌陷换行/错位」。执行协议 5 步。spike:对卡片容器跑命令看 `leftAligned`/换行。记录行 + commit。
- [ ] **Step 3: 场景③** — `{站点}`=禅道需求/任务表单(未登录用 antd Form demo);`{视觉问题}`=「表单里 label 与其输入控件是否水平对齐,有没有错位」。执行协议 5 步。spike:对 label 与 input 跑命令看 top 是否一致。记录行 + commit。
- [ ] **Step 4: 桶小结** — 在缺口谱写一句:几何 readback/`mode=geometry` helper 的可行性与优先级判断。commit。

### Task 2: SVG/非主流库图表桶(④⑤⑥)

**Files:**
- 追加 3 行到缺口谱文档。

**Interfaces:**
- Produces: ④⑤⑥ 缺口谱行 + 图表库 introspection/数据表通道结论。

**预判通道 spike 命令(按库选用):**

```js
// echarts 实例(对照,已 ship hint)
(() => { const c = echarts.getInstanceByDom(document.querySelector("canvas")); return c && c.getOption().series; })()
// Chart.js
(() => { const c = window.Chart && Chart.getChart(document.querySelector("canvas")); return c && c.data.datasets.map(d=>({label:d.label,data:d.data})); })()
// D3 自绘 SVG:节点绑定数据
(() => Array.from(document.querySelectorAll("svg .dot, svg circle, svg path")).slice(0,20).map(n=>n.__data__).filter(Boolean))()
// Highcharts
(() => window.Highcharts && Highcharts.charts.filter(Boolean).map(c=>c.series.map(s=>({name:s.name,data:s.data.map(p=>p.y)})))) ()
// visually-hidden 数据表兜底
(() => { const t = document.querySelector("table[aria-hidden], .highcharts-data-table table, [class*=visually-hidden] table"); return t && t.innerText; })()
```

**预期代码路径**:`blindspot-detect.ts` `detectChartCanvas` 现仅识别 `data-zr-dom-id`(echarts);G2 在建;Chart.js/D3/Highcharts/数据表**无检测**——`observe-render.ts` `chartReadbackHint` 只映射 echarts/g2,缺口明确。

- [ ] **Step 1: 场景④** — `{站点}`=阿里云/腾讯云监控图表(未登录用 chartjs.org/samples 折线);`{视觉问题}`=「某条折线在某 X 点的 Y 数值是多少」。执行协议 5 步。spike:跑 Chart.js 或 echarts introspection 命令取 series。记录行 + commit。
- [ ] **Step 2: 场景⑤** — `{站点}`=AntV G2Plot `https://antv.antgroup.com`(G2Plot 示例页);`{视觉问题}`=「某散点/柱的精确数值」。执行协议 5 步。spike:跑 D3 `__data__` 或 G2 `chart.getData()` 命令。记录行 + commit。
- [ ] **Step 3: 场景⑥** — `{站点}`=DataV 大屏/国内 BI(未登录用 echarts.apache.org 复杂图表);`{视觉问题}`=「图表展示的某项汇总数据」。执行协议 5 步。spike:先试 introspection,再试 visually-hidden 数据表兜底命令。记录行 + commit。
- [ ] **Step 4: 桶小结** — 写一句:`chartReadbackHint` 扩展(Chart.js/Highcharts/D3/数据表)的优先级,接续 G2 设计。commit。

### Task 3: 配色/视觉态桶(⑦⑧)

**Files:**
- 追加 2 行到缺口谱文档。

**Interfaces:**
- Produces: ⑦⑧ 缺口谱行 + getComputedStyle/对比度 helper 结论。

**预判通道 spike 命令:**

```js
(() => {
  const el = document.querySelector("SEL");
  const cs = getComputedStyle(el);
  const parse = c => c.match(/\d+(\.\d+)?/g).slice(0,3).map(Number);
  const lum = ([r,g,b]) => { const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const fg = parse(cs.color), bg = parse(cs.backgroundColor);
  const L1 = lum(fg)+0.05, L2 = lum(bg)+0.05;
  return { color:cs.color, background:cs.backgroundColor, fontWeight:cs.fontWeight, contrast: +(Math.max(L1,L2)/Math.min(L1,L2)).toFixed(2) };
})()
```

**预期代码路径**:`vortex_query` 有 attr=class(给类名)但无 computed color/对比度;observe 不输出颜色——颜色/视觉态判断无 readback 提示,缺口明确。

- [ ] **Step 1: 场景⑦** — `{站点}`=禅道 bug 列表/班牛工单(未登录用 element-plus table-with-status demo);`{视觉问题}`=「哪些行/标签被标成错误色(红),哪些是警告色(黄)」。执行协议 5 步。spike:对状态行/标签跑命令取 backgroundColor + 类名。记录行 + commit。
- [ ] **Step 2: 场景⑧** — `{站点}`=TDesign/Arco 暗色模式 demo(切到 dark theme);`{视觉问题}`=「某主按钮文字与背景的对比度是否达 WCAG AA(≥4.5)」。执行协议 5 步。spike:对按钮跑命令取 contrast。记录行 + commit。
- [ ] **Step 3: 桶小结** — 写一句:对比度 helper / computed-style readback 的优先级。commit。

### Task 4: 真光栅图像桶(⑨⑩)

**Files:**
- 追加 2 行到缺口谱文档。

**Interfaces:**
- Produces: ⑨⑩ 缺口谱行 + 图像 alt 兜底/视觉兑底层结论(验证薄视觉兑底必要性)。

**预判通道 spike 命令:**

```js
(() => {
  const img = document.querySelector("SEL img, SEL");
  return {
    src: img.currentSrc || img.src, alt: img.alt,
    figcaption: img.closest("figure")?.querySelector("figcaption")?.innerText || null,
    ariaLabel: img.getAttribute("aria-label"),
    nearbyText: img.closest("a,[class],li,div")?.innerText?.slice(0,200) || null
  };
})()
```

**预期代码路径**:observe 对无 alt `<img>` 不发盲区信号也不指路;无任何「图像→src/上下文→视觉兑底」通道——缺口明确,且这是验证**薄视觉兑底层**必要性的桶。

- [ ] **Step 1: 场景⑨** — `{站点}`=班牛工单附件图(未登录用任意电商商品详情页);`{视觉问题}`=「这张图(无 alt)展示的是什么内容」。执行协议 5 步。spike:跑命令看 src/figcaption/nearbyText 是否足够推断;不够则 Claude 截图判定为「真·光栅,需视觉兑底」。记录行 + commit。
- [ ] **Step 2: 场景⑩** — `{站点}`=含信息图/图表截图嵌入的页面(如某产品 landing/信息图文章);`{视觉问题}`=「这张信息图传达的关键数字/结论」。执行协议 5 步。spike:同上;大概率判定真·光栅。记录行 + commit。
- [ ] **Step 3: 桶小结** — 写一句:真·光栅频次 + 薄视觉兑底(ref-marked screenshot)的必要性与优先级。commit。

### Task 5: 对照采样桶(⑪⑫)

**Files:**
- 追加 2 行到缺口谱文档。

**Interfaces:**
- Produces: ⑪⑫ 缺口谱行 + 「真·必须像素」边界确认。

**预判通道 spike 命令:**

```js
// 地图:点位是否有 DOM marker(label/aria)还是纯瓦片
(() => Array.from(document.querySelectorAll("[class*=marker],[class*=label],[role=img]")).slice(0,20).map(n=>({t:n.innerText||n.getAttribute("aria-label"),c:n.className})))()
// PDF.js:文本层 span 是否存在
(() => { const sp = document.querySelectorAll(".textLayer span, .textLayer"); return { hasTextLayer: sp.length>0, sample: Array.from(sp).slice(0,30).map(s=>s.innerText).join(" ") }; })()
```

**预期代码路径**:确认这些桶里**确有**真·必须像素的边界(地图瓦片渲染/扫描型 PDF),验证「不追求 0 截图」非目标成立。

- [ ] **Step 1: 场景⑪** — `{站点}`=高德/百度地图(地图应用页);`{视觉问题}`=「地图上标注了哪几个点位,分别在什么相对位置」。执行协议 5 步。spike:跑 marker 命令。点位有 DOM=有通道;纯瓦片=真·光栅。记录行 + commit。
- [ ] **Step 2: 场景⑫** — `{站点}`=禅道/钉钉文档 PDF 预览(未登录用 mozilla.github.io/pdf.js/web/viewer.html);`{视觉问题}`=「PDF 第 1 页某段文字内容」。执行协议 5 步。spike:跑文本层命令。有文本层=可读;扫描型=真·光栅。记录行 + commit。
- [ ] **Step 3: 桶小结** — 写一句:确认真·必须像素边界存在,佐证薄视觉兑底层的合法性。commit。

---

## Task 6: 缺口谱综合 + 度量汇总

**Files:**
- Modify: 缺口谱文档,补「综合」段。

**Interfaces:**
- Consumes: ①–⑫ 全部行。
- Produces: Phase 2 排序输入(治本 detector/helper 优先级 + 视觉兑底必要性)。

- [ ] **Step 1: 量化汇总**

在缺口谱文档写「## 量化汇总」:总场景数、M3 总截图次数、有效/无效退化计数、各桶降解成功率、真·光栅场景数、根因分布(R5/R6/新)。

- [ ] **Step 2: 处方排序**

写「## Phase 2 排序输入」:按「频次 × 降解可行性」给出 detector/helper 优先级清单(如:几何 readback / chartReadbackHint 扩展 / 对比度 helper / 图像 alt 兜底 / 薄视觉兑底),每项标 P0/P1/P2 + 一句理由。

- [ ] **Step 3: 上轮校正**

写一句:本轮硬视觉样本下,R1-R4 是否仍零命中(校正上轮「样本偏差」假设);R5/R6 是否仍为主因。

- [ ] **Step 4: 更新文档状态 + Commit**

把 frontmatter `status` 改 `done`,`updated` 改当日。

```bash
git -C /Users/lg/workspace/Knowledge-Library add 07-Tech/20260630-vortex硬视觉感知评测-能力缺口谱.md
git -C /Users/lg/workspace/Knowledge-Library commit -m "docs: vortex 硬视觉感知评测能力缺口谱(12 场景)"
```

- [ ] **Step 5: 交接 Phase 2**

向用户汇报缺口谱结论 + Phase 2 排序,建议转 brainstorming/writing-plans 规划 Phase 2 高价值项实现。

---

## Self-Review(已执行)

- **Spec 覆盖**:Phase 0(环境/反污染/登录态)✓;12 场景分 5 桶 ✓;双层评测协议 ✓;缺口谱+度量 ✓;每桶 spike 命令对应设计第 2 节降解技术 ✓。不含 Phase 2 实现 ✓(符合范围)。
- **占位符扫描**:`SEL`/`SEL_A`/`{站点URL}`/`{视觉问题}` 是评测时按实际页面填的运行时参数(非计划占位),已在协议与各 Task 说明填法;spike 命令均为完整可跑代码。
- **类型一致**:缺口谱列名全程一致;spike 命令均 IIFE 契约一致;文档路径全程 `20260630-vortex硬视觉感知评测-能力缺口谱.md` 一致。
- **已修**:Task 5 步骤编号(场景⑪/场景⑫/桶小结 = Step 1/2/3)。
