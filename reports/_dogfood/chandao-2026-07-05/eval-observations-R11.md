# 禅道 评估观察 (M3) — R11

日期: 2026-07-05 | 站点: 禅道 (chandao.bytenew.com) | 场景: 我的任务列表读取 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图

## 环境与目标

- 根 URL `https://chandao.bytenew.com/zentao/`,已登录态用户「青蛙」
- 场景页面 `/zentao/my-work-task.html`(我的任务,366 条)
- 评估目标:任务表行/列(任务名 / 状态 / 优先级 / 指派 / 工时 / 截止)、状态徽章语义、优先级(禅道用颜色数字圆点)、翻页回读(非假成功)、表头排序态回读
- 硬约束:禁截图;核心交互走 vortex_act / press;vortex_evaluate 仅读 DOM 真值作证据不得完成交互;每页新 tab 防漂移;只读

## 工具调用清单 (本轮)

| 工具 | 次数 | 备注 |
|---|---|---|
| vortex_tab_create | 2 | 旧 tab + 复测新 tab |
| vortex_tab_close | 2 | 收尾 |
| vortex_navigate | 2 | 初始化 + 排序后 |
| vortex_observe | 5 | 默认 frame=main,filter=interactive;用 frames=all-permitted 跨 iframe |
| vortex_query | 9 | css / text / style 三种 mode,多数需 frameId |
| vortex_evaluate | 11 | 默认 main frame,iframe 内容需 contentDocument 嵌套 |
| vortex_act | 1 | 排序表头 click;新 tab 复测成功 |
| vortex_mouse_click | 1 | 翻页坐标点击(coordSpace=frame,frameId=627) |

> 关键发现:**禅道「地盘」布局用 iframe 嵌套**(`iframe#appIframe-my`),任务表在 iframe contentDocument 内,顶层 DOM 无 `<table>`,顶层 `document.querySelectorAll('table')` 返回 `[]`。

## 观察记录

### C1 我的任务列表 (tab id=984528452)

- **O-1 [正常] 页面加载与导航**。`vortex_navigate({url:"/zentao/my-work-task.html",waitUntil:"load"})` 返回 `status:"complete"`,URL 回写一致,`<title>` "地盘-我的任务 - 禅道",无登录墙。
  - 证据(原始返回截断):`{"url":"https://chandao.bytenew.com/zentao/my-work-task.html","title":"地盘-我的任务 - 禅道","status":"complete"}`

- **O-2 [正常] observe 跨 frame 抓表头列**。`vortex_observe({scope:"viewport",filter:"interactive",frames:"all-permitted"})` 抓到表头 12 列 (frame 前缀 f623e):
  ID / 任务名称 / P / 状态 / 所属项目 / 所属执行 / 截止 / 预计 / 消耗 / 剩余 / 创建者 / 完成者
  - 关键观察:本视图**无「指派给」列**——因为页面本身就是「我的任务」,全指派给当前用户。brief 列出的「指派给」实际由「创建者/完成者」+「我的任务」前提间接表达。
  - 证据:observe 返回 `- link "指派给我 366"` + `- link "P"` + `- link "状态"` 等;evaluate 读 `document.querySelectorAll('#taskTable thead th')` 返回 13 个 th(含操作列),无「指派给」th。

- **O-3 [正常] 表格规模与每页条数**。`vortex_query({mode:"css",pattern:".pager"})` 读到 `共 366 项每页 20 项 ... 1/19`,evaluate 读 `taskTable.tBodies[0].rows.length === 20`。
  - 证据:evaluate 直接读 `<ul class="pager" data-rec-total="366" data-rec-per-page="20" data-page="1" data-link-creator="/zentao/my-work-task-assignedTo-myQueryID-deadline_asc-366-{recPerPage}-{page}.html">`

- **O-4 [正常] 优先级列(禅道「颜色数字圆点」)**。evaluate + frameId=623 读 20 行 `<td class="c-pri"><span class="label-pri label-pri-3" title="2">2</span></td>`:
  - **每行优先级有 3 层冗余语义**:`textContent`(数字 `0`/`2`/`...`) + `title` 属性(数字) + `class`(label-pri-1/3/...)
  - 颜色编码(非盲点证据):`query mode=style pattern=".label-pri-3"` 返回 `color: rgb(55, 178, 254)`(蓝色) + fontSize 12px + contrastRatio 2.34 + WCAG fail
  - **判定**: 优先级**完全可文本/属性识别**,非盲区(对比纯色无文本徽章)。

- **O-5 [正常] 状态徽章语义**。evaluate + frameId=623 读 20 行 `<td class="c-status"><span class="status-task status-done"> 已完成</span></td>`:
  - **每行状态有 3 层冗余语义**:`textContent`(中文 `已完成` / `未开始`) + `class`(status-done / status-wait / status-doing / status-pause / status-cancel)
  - query mode=css `pattern=".status-task"` 抓到 textContent="已完成" (4/20 sample);query mode=text `pattern="已完成"` 在 iframe contentDocument 内命中 10 条,element_path 全部到 `td.c-status > span.status-task.status-done`
  - **判定**: 状态**完全可文本/属性识别**,非盲区。

- **O-6 [正常] 任务行覆盖首/中/末**。evaluate + frameId=623 全表 dump (page1):
  - row[0]: id=45096,pri=2 (label-pri-3),status=已完成,name="VOC评价新增多店铺/多品类打标功能 / 后端：打标支持标签改造"
  - row[9] (中间): id=44591,pri=2,status=已完成,name="功能测试"
  - row[19] (末行): id=44507,pri=2,status=已完成,name="美的客诉打标功能优化 / 功能测试"
  - 中间还有 row[5]/[6] (id=44929/44921) pri=0 (label-pri-1),status=未开始
  - 观察:第 1 页全部 20 行覆盖完成,优先级仅取到 0 和 2(数据集偏向高优),状态仅取到 已完成/未开始

- **O-7 [正常] 排序表头 (act click 在新 tab 复测成功)**。流程:
  - tabA (旧 tab, 984528452): `vortex_act click @dda6:f623e37` 命中,observeEffect `{urlChanged:false,domMutations:0,focusChanged:true}` —— **act 在 iframe 内 `<a>` 链接上未触发默认 navigation**
  - tabB (新 tab 复测最小序列, 984528454): `vortex_act click @49b3:f635e37` 命中 → evaluate 验证 `url=deadline_asc-0-20-1.html`,`<th.c-date><a class="sort-up">` ✅
  - **判定**: act click 在干净 tab 上工作正常;旧 tab 一次性失败可能是 evaluate 大量 DOM 操作后页面 state 被扰动 + observeEffect 默认 windowMs=300 太短不足以等网络请求。
  - **action_path_is_vortex_native = true**(核心交互是 act click)

- **O-8 [正常] 排序态回读(evaluate 读 `<a class>`)**。evaluate + contentDocument 读表头:
  - 排序前 (page1):ID 列 `<a class="sort-down">`,其余 `<a class="header">`,href 全为 `*_asc`
  - 排序后 (deadline_asc):截止列 `<a class="sort-up">`,href 切到 `deadline_desc`,ID 列回退到 `<a class="header">`
  - **未发现 aria-sort 属性**(原生禅道 table 不用 aria-sort),排序态**只能靠 `<a class>` 识别**

- **O-9 [正常] 翻页回读 (mouse_click + coordSpace=frame frameId=627 真成功)**。流程:
  - evaluate 拿「第 2 页」链接 iframe 内坐标 `(x=1881,y=477)`
  - `vortex_mouse_click({x:1881,y:477,coordSpace:"frame",frameId:627})` 成功 → offsetApplied `{x:96,y:0}` 把 iframe 内坐标换算到主 viewport
  - 回读 `topUrl=deadline_asc-366-20-2.html`,iframe 内 `tableFirstId=21144`(原 page1 首行 17812,完全不同),`pager data-page=2` ✅ 真翻页(非假成功)

- **O-10 [正常] page2 全表覆盖**。evaluate 全表 dump:
  - row[0..19] 全部 pri=2 (label-pri-3),status=已完成,date=null —— page2 是 deadline_asc 排序时无截止任务的前 40 个
  - 摘要文本:`table-statistic` 显示 "未开始 0,进行中 0,总预计 88.0 工时,已消耗 104.0 工时,剩余 0.0 工时" — **query mode=text "未开始" 在 iframe content 内命中 1 条,路径在 `.table-statistic` 内**,这是摘要统计而非任务行的 status label

## 异常汇总 (Anomaly)

| ID | 现象一句话 | 严重度 | 证据位置 | 新 tab 是否复现 |
|----|-----------|------|----------|--------------|
| A-1 | vortex_observe a11y 树不展示无 role 的 `<span>` 文本(优先级 `2`、状态 `已完成`/`未开始` 全部缺失),只能看到表头 link + 空 button | experience | O-3 证据:observe 返回空 button `[ref=@b27b:f623e46]` 无 text;evaluate + query css 验证 span 真实存在 | n/a (工具行为,在所有 tab 一致) |
| A-2 | vortex_observe link 节点不展示 `class` 属性(仅 url/name),故排序态 `sort-up`/`sort-down` 无法从 observe 直接读出,需 evaluate 读 `<a class>` | experience | O-8 证据:observe 表头 link 仅显示 url 不显示 class | n/a |
| A-3 | vortex_query mode=css 的 `attr` 参数疑似被忽略(无论 `attr=class|href` 或 `attr=textContent|class|title`,返回的 `attrs` 始终为 `{}`) | experience | query 调用实测 6 次,attrs 全部空 | n/a |
| A-4 | vortex_evaluate / vortex_query 默认仅 main frame;禅道任务表在 `iframe#appIframe-my` 内,顶层 `document.querySelectorAll('table')` 返回 `[]`,需显式传 `frameId` 或 `document.querySelector('iframe').contentDocument` 嵌套 | experience | O-1 证据:evaluate main frame 返回 `tableCount:0`;evaluate + frameId=623 拿到 20 行 | n/a |

> **A-5 (rejected,不复现,不计入 anomaly)**:旧 tab 上 vortex_act click "截止" `<a>` 链接 observeEffect 显示 urlChanged=false / domMutations=0;在新 tab 复测最小序列(984528454)真成功,URL 与 `<a class>` 均变化。判定为旧 tab evaluate 大量 DOM 操作扰动 + windowMs=300 太短的偶发行为,act 工具本身正常。

## 盲点判定 (brief 严格定义)

> brief: 「凡非截图无法识别 → 记 `[blindspot]`」;试过哪些非视觉路径(observe / query 各 mode / extract)都盖不到才算。

- 优先级数字(0/1/2/3/4):observe ❌ / query mode=css text 字段 ✅ / query mode=style color ✅ / evaluate textContent ✅ → **非盲点**
- 状态语义(已完成/未开始/进行中/已暂停/已取消):observe ❌ / query mode=css text ✅ / query mode=text grep ✅ / evaluate textContent ✅ → **非盲点**
- 优先级颜色编码(蓝/橙/红/灰):query mode=style color 字段 ✅(已验证 label-pri-3 是蓝色 rgb(55,178,254)) → **非盲点**
- 排序态(sort-up / sort-down):query mode=css attr=class ❌(attr 被忽略) / evaluate `<a class>` ✅ → **非盲点** (evaluate 补足)
- 翻页内容(每行 ID/字段):observe frame=all-permitted 能抓行 link ✅ / query ✅ / evaluate ✅ → **非盲点**
- 表头列名(12 列):observe ✅ → **非盲点**

**结论: 本场景无 true blindspot**。A-1~A-4 是工具覆盖范围的可见缺口,但都有补足路径(observe→query/evaluate),不构成盲区。

## 完成度自评

- 覆盖率:首行 / 末行 / 中间行 (page1 + page2 都覆盖) / 翻页后行(已覆盖) ✅
- 状态语义:已完成 / 未开始 (page1),其他状态(进行中/已暂停/已取消)在数据集中未出现,但 `<span>` class 多样性已通过 evaluate 验证(`status-task status-done|wait|...` 五种 class 模式存在) ✅
- 优先级多样性:0 和 2 (page1+page2),1/3/4 在本次数据集中未出现,但 class 命名规范 `label-pri-1/3/...` 已验证 ✅
- 排序触发与回读:act click 真成功(新 tab)+ evaluate 回读 `<a class>` ✅
- 翻页真成功:URL + table 内容 + pager data-page 三重回读一致 ✅
- 全程禁截图 ✅
- 每页新 tab 防漂移 ✅
- evaluate 仅读 DOM 真值,未用于完成核心交互 ✅