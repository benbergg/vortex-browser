# Round 0 Recon — newbeta.bytenew.com 站点地图（M3，🚫零截图）

你（MiniMax-M3）本轮只做**侦察**：用 vortex MCP 的 `vortex_observe` + `vortex_extract` + `vortex_query` 摸清 newbeta 有哪些可评测页面、每页主组件类型、难度。**不改代码、不提交 git、禁 `vortex_screenshot`**。

## 站点背景（已知）

- `https://newbeta.bytenew.com/`（**已登录态**，直接用当前 Chrome）。这是「班牛」低代码平台：顶部导航 = 首页 / 犇犇 / 小程序 / moreNav(其他应用) / 搜索；左侧是一堆「小程序」（VOC工作台 / 退款管理 / 评价管理（演示专用） / 工单测试表0611 / ERP工作台 / 售后管理 …）。
- 每个小程序打开后通常是「表格 + 工具栏（新建/导入/导出/流程/筛选/列统计/列表设置）」。

## 侦察任务（约束：每个 app 用全新 tab，总工具调用 ~30 次内）

用 `vortex_tab_create({url:"https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255", active:true})` 打开首页，`vortex_observe` 看顶部导航 + 左侧小程序清单。然后**逐个点开 3~5 个有代表性的小程序**（优先 VOC工作台 / 退款管理 / 评价管理（演示专用） / 工单测试表0611），每个用 observe + extract 摸清：

对每个探到的页面/小程序，回答：
1. **主组件类型**（勾出全部）：表单填写 / 数据表格(行列) / 弹窗或 popover / 下拉筛选 / **图表(柱/饼/折线，判断是 canvas 还是 svg)** / **canvas 电子表格(类 Excel 网格)** / **流程图或画布(节点连线)** / 拖拽排序 / 富文本。
2. **难度初判**：易 / 中 / 难（易=纯 DOM 结构清晰；难=canvas/画布/虚拟长列表/深浮层）。
3. 关键：**哪个 app 里有图表？哪个有流程图/画布（试点「流程」按钮看是否弹出节点连线图）？有没有类 Excel 的 canvas 网格电子表格？有没有拖拽？** —— 这几个直接决定后续评测能否覆盖。

## 识别手段（非视觉，练功点）

- 结构/控件：`vortex_observe filter=interactive`（看 role/name/state）。
- 判断图表是 canvas 还是 svg：`vortex_query mode=css pattern="canvas"` 与 `pattern="svg"`（看命中数）。
- 判断有无流程画布：observe 里找「流程」按钮点开，或 `vortex_query mode=css pattern=".x6-graph, .flow, svg g"` 之类。
- 文本内容：`vortex_extract`。
- **看不清 ≠ 截图**：看不清就在 recon.md 里记「这类内容 observe/query/extract 都识别不了」——这是宝贵线索。

## 产出：`reports/_dogfood/newbeta-2026-07-04/recon.md`

```markdown
# newbeta recon 站点地图 (M3, 2026-07-04)

## 顶部导航 & 小程序清单
（observe 抓到的可达入口列表）

## 逐 app 组件类型 & 难度
| app/页面 | URL/入口 | 主组件类型 | canvas还是svg图表 | 有无流程画布 | 有无canvas电子表格 | 有无拖拽 | 难度 | 备注 |
|----------|----------|-----------|------------------|-------------|-------------------|---------|------|------|

## 关键结论（回答后续场景能否覆盖）
- 图表在哪个 app？canvas/svg？
- 流程图/画布在哪个 app？（决定 mode=flow 轮能否做）
- canvas 电子表格有没有？（决定 mode=sheet 轮能否做）
- 拖拽在哪？
- 识别不了的盲区（如有）
```

## 完成标志

`recon.md` 写完，含小程序清单 + ≥4 个 app 的组件类型表 + 关键结论。完成后一段话报告：探了几个 app、图表/流程/canvas 表格各在哪。
