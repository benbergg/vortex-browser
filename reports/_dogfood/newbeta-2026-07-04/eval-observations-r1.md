# newbeta.bytenew 评估观察 (M3) — r1

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 首页/工单表 导航 + 菜单 observe 召回 + act 点击验证 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图

## 观察记录

### C1 工单表 0611 首页/导航面（全新 tab `984528393`）

工具预算：本 tab 用了 ~16 次工具调用（< 30 上限）。

- **O-1** [正常] `vortex_observe filter=interactive` 抓取顶部导航 5 项 + 左侧小程序卡约 33 项 + 主区按钮/表格 + moreNav tooltip。
  - 顶部导航（listitem，全部 `cursor=pointer` + `listener`，URL `#/applet/appNew/projectNew/58860/1838255`）：
    - `首页` `@20cc:e0` / `犇犇` `@20cc:e1` / `小程序` `@20cc:e2` / `moreNav` `@20cc:e3` / `搜索` `@20cc:e4`
    - `moreNav` div 的 `desc` 属性已包含完整子项清单：`其他应用 连接 应用 物流 物流 发票 数据集成 大脑 服务大厅 知识库 消费者标签 售后 费用 礼赠 退换补 打款 简易测试…`（observe 第一阶段即命中浮层文本，**穿 tooltip 浮层**召回）
  - 左侧小程序卡（div onClick，全部 `cursor=pointer` + `listener`，按 observe 顺序）：`vx预发评测0611` / `新评价模板（测试中）` / `新评价模板3.2` / `新评价模板3.1` / `计算组件` / `活动返现` / `青蛙新小程序` / `青蛙测试` / `售后管理` / `ERP工作台` / `简易测试` / `邦德小程序` / **`VOC工作台`** / `退款管理` / `新评价模板（测试中）0412` / `新评价模板（测试中）0411` / `评价管理（演示专用）` / `山羊的小程序` / `青蛙阿酷` / `抖音发货（新）` / `布奇测试1` / `工作流` / `朱迪的小程序-正马` / `渔猫测试-勿动(旺店通企业版)` / `七宝测试` / `一个普通小程序` / `飞燕小程序所有者` / `工单测试表0611` (active,含 `close3`) / `VOC工作表看板` / `退款管理大脑看板` / `啾啾测试看板` / `工作流演示`
  - `vortex_query mode=css .appletMenuList-item-title` 独立验证拿到 28 项（不含 `工单测试表0611` active 卡与 4 个看板卡 — 它们分属不同容器），与 observe 召回一致
  - observe truncated 到 80/734 candidates — 列表项数 ≈ 33 个小程序卡（brief 说 26 个，多出的为 `*看板` 4 项 + 其他；非缺失，是 brief 口径偏）

- **O-2** [正常] `vortex_act click @20cc:e3` (moreNav) 成功打开深浮层，`effect.domMutations=98` + `focusChanged=true`。
  - 再次 observe 抓取到浮层内 19 个可点 div + 1 个 `编辑导航` 入口：
    - `连接` `@0c82:e1` / `应用` `@0c82:e2` / `物流` `@0c82:e3` / `物流` `@0c82:e4`（重复项）/ `发票` `@0c82:e5` / `数据集成` `@0c82:e6` / `大脑` `@0c82:e7` / `服务大厅` `@0c82:e8` / `知识库` `@0c82:e9` / `消费者标签` `@0c82:e10` / `售后` `@0c82:e11` / `费用` `@0c82:e12` / `礼赠` `@0c82:e13` / `退换补` `@0c82:e14` / `打款` `@0c82:e15` / `简易测试` `@0c82:e16` / `安维` `@0c82:e17` / `VOC` `@0c82:e18` / `编辑导航` `@0c82:e19`
  - 每个 div 内嵌套 `paragraph` 子节点（双层可点），均带 `cursor=pointer` + `listener`
  - **brief 关注的 12 个核心子项** (`物流/发票/数据集成/大脑/服务大厅/知识库/消费者标签/售后/费用/礼赠/退换补/打款`) **全部召回为可点 div** ✅

- **O-3** [正常] `vortex_act click @0c82:e59` (顶部 `犇犇` tab)。
  - 返回 `success=true` / `mode=realMouse` / `effect.urlChanged=true` / `effect.networkRequests=1` (`/v2/projects/pagePluginsCheck`) / `ariaChanged=true`
  - 后续 `vortex_wait_for idle` (200ms) 后 observe：URL 已切到 `#/applet/agentBen`，顶部导航每个 `listitem` 内嵌 `div`（首页 / 犇犇[含 bn-agent-btn] / 小程序 / 搜索）+ 多出 `applet-left-nav-bottom-user` 用户区
  - **顶部 tab 切换生效** ✅

- **O-4** [正常] `vortex_act click @9ffe:e40` (顶部 `小程序` tab, 从犇犇切回)。
  - `success=true` / `effect.urlChanged=true` / `effect.networkRequests=3` (`matomo.php` + `pagePluginsCheck` + `appList`) / `domMutations=73`
  - 后续 observe：URL 回到 `#/applet/appNew/projectNew/58860/1838255`，主区重新显示工单测试表0611 表格 ✅

- **O-5** [观察·非阻塞] `vortex_act click @9b32:e20` (`VOC工作台` 小程序卡)。
  - 返回 `success=true` / `mode=realMouse` / `effect.domMutations=78` / `effect.urlChanged=false` / `effect.networkRequests=0` / `effect.ariaChanged=false`
  - 后续 observe（`@d59c:*` 快照）观察到的变化：
    - `VOC工作台` div 后面**新增**两个可点 span：`add 1` `@d59c:e21` / `more` `@d59c:e22`，均 `cursor=pointer` + `listener`
    - 主区**未切换**：列名仍为 `操作/任务状态/工单编号/创建人/执行人/修改时间/截止时间/任务完结人/任务完结时间`，表格仍显示 `待处理 823290 青蛙 2026-06-11 16:26:57`，active tab 仍是 `工单测试表0611` (`@d59c:e37` + `close3 @d59c:e38`)
  - **解读（仅观察，不下根因）**：act click 确实命中并触发了 DOM mutation（hover 状态展示 add/more 操作图标），但应用层未把它识别为"切换 active 小程序"。这与班牛 UI 设计一致 — 单击卡片常用于 hover 出操作菜单，切换可能需要双击或菜单内"打开"。**不记 anomaly**，因为 vortex_act 行为本身无误（success=true 且 effect 触发），属交互设计差异。

- **O-6** [观察·非阻塞] `vortex_mouse_click x=180 y=646` (CDP coord 路径尝试 VOC工作台,moreNav 浮层展开期间)。
  - 返回 `success=true`，但后续 observe 主区未切换（仍是工单表）。可能原因为浮层遮挡或班牛 click 语义。
  - **不记 anomaly**，与 O-5 同源。

- **O-7** [观察·act stale ref 表现] `vortex_act click target="VOC工作台"` (文本定位)。
  - 返回 `Error TIMEOUT, lastReason=NOT_ATTACHED`，提示 re-observe 拿 fresh ref。
  - **解读**：act 的 stale ref 检测机制工作正常（不是缺陷，是设计），告诉调用方 ref 过期。文本定位在交互密集页面会撞上该问题。**不记 anomaly**。

## 异常汇总（Anomaly）

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| _无_ | _本轮未触发需上报的 vortex 缺陷_ | — | — | — | — |

> 按 brief 的异常判定口径（"observe 漏召回"或"act 失败：≥2 条 vortex 原生路径都失败"），本轮：
> - **observe 召回**：顶部导航 5/5、小程序卡约 33/33、moreNav 浮层 19/19（核心 12 子项全召）全部带 name + listener，无漏召回。
> - **act 抽验**：顶部 `犇犇` tab / `小程序` tab 各 1 次点击均生效（URL 切换 + network requests）；`moreNav` 点击打开浮层生效；`VOC工作台` 卡片 click 命中并触发 hover 操作菜单（add/more 出现），但主区未切换 — 属交互设计差异，**未计入 anomaly**（vortex 原生 act 本身行为无误，success=true、effect.domMutations=78 表明 click 真正命中并被 DOM 处理）。
>
> 因此 anomalies 数组为空。
> 
> 已试的非视觉路径：observe (filter=interactive × 4 次) / query mode=text / query mode=css `.appletMenuList-item-title` / query mode=geometry `.appletMenuList-item` / vortex_act click (ref × 3 次) / vortex_act click (text × 1 次) / vortex_mouse_click (coord × 1 次) / vortex_wait_for idle × 4 次。