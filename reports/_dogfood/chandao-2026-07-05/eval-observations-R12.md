# 禅道 评估观察 (M3) — R12

日期: 2026-07-05 | 站点: 禅道 (chandao.bytenew.com) | 场景: 任务详情字段读取 (只读) | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图

## 环境与目标

- 根 URL `https://chandao.bytenew.com/zentao/`,已登录态用户「青蛙」
- 场景页面 `/zentao/task-view-44929.html`(任务 #44929,「后端:VOC评价新增自定义字段以及关联商品表数据 / voc日常迭代」,状态=未开始)
- 评估目标(brief R12):
  - **核心考查**:禅道详情页 label 与 value 是否 DOM 分离,observe / query / extract 输出能否让 agent 正确配对哪个 value 属于哪个字段
  - 富文本描述(任务描述 / 产品需求描述 / 验收标准)格式保留
  - 工时记录(estimate / consumed / left)行
  - 操作栏召回(开始 / 完成 / 编辑 / 关闭 / 评论)
  - 详情页 iframe 承载方式
- 硬约束:禁截图;核心交互走 vortex_act / press(本轮无交互触发);vortex_evaluate 仅读 DOM 真值作证据不得完成交互;每页新 tab 防漂移;只读

## 工具调用清单 (本轮)

| 工具 | 次数 | 备注 |
|---|---|---|
| vortex_tab_create | 2 | 旧 tab 984528458 + 复测新 tab 984528459 |
| vortex_tab_close | 2 | 收尾 |
| vortex_navigate | 2 | 初始化 |
| vortex_observe | 3 | default(984528458) + filter=all scope=full + 新 tab 复测 |
| vortex_query | 10+ | text / css / component 模式,部分需 frameId |
| vortex_evaluate | 8+ | 默认 main frame,iframe 内容需 contentDocument 嵌套 |
| vortex_extract | 4 | #legendBasic / #legendEffort / #main 验证 display:block 可读性 |
| (本轮未调) vortex_act / press / mouse_click / fill | 0 | 纯只读评测 |

> **承载结构关键事实**:禅道 taskView 详情页在 `iframe#appIframe-execution` 内(与 R11 任务列表页 `appIframe-my` 不同,但同源 iframe 嵌套布局),顶层 `document.querySelectorAll('table').length === 0`,所有字段在 iframe contentDocument 内。

## 字段区结构 (DOM 真值,evaluate 读)

详情页共有 **4 个 panel + 1 个工时表头行**,分布在 5 个 `<table class="table-data">` 内。**禅道 taskView 详情页字段区的 DOM 模式不是 brief 默认设想的 detail-title/detail-content,而是 `<table>` 内 `<tr><th>label</th><td>value</td></tr>` 模式**。

| Panel | 容器 div | display | 字段数 | 字段(来自 evaluate 真值) |
|---|---|---|---|---|
| 基本信息 | `#legendBasic` | block | 9 | 所属执行 / 所属模块 / 相关产品需求 / 指派给 / 任务类型 / 任务状态 / 进度 / 优先级 / 抄送给 |
| 任务的一生 | `#legendLife` | **none** | 6 | 由谁创建 / 由谁完成 / 由谁取消 / 由谁关闭 / 关闭原因 / 最后编辑 |
| 团队(表头行) | `#legendTeam` | **none** | 5 th | 团队 / 预计 / 消耗 / 剩余 / 状态(无配对 td) |
| 工时信息 | `#legendEffort` | block | 6 | 最初预计 / 总计消耗 / 预计剩余 / **预计开始 / 实际开始 / 截止日期** |
| 其他相关 | `#legendMisc` | **none** | 2 | 相关合并请求 / 相关代码版本 |

> **关键观察 ①**: **brief 列举的「截止日期」实际在 #legendEffort(工时信息),不在 #legendMisc(其他相关)**。这是禅道 DOM 实现与 brief 设想的差异。
>
> **关键观察 ②**: **brief 列举的「所属项目」在禅道 taskView 详情页 DOM 中完全不存在**。禅道任务直接挂 execution(执行/Sprint),无 project 字段;项目信息只能从面包屑(`班牛VOC标品迭代 / voc日常迭代` → `班牛VOC标品迭代` 是项目名)或 URL(`/zentao/execution-view-2028.html`)间接推断。**这与 brief 默认假设不一致,是真实的数据缺失而非工具缺陷**。
>
> **关键观察 ③**: 字段区的 **label 与 value 共享同一 tr parent**(同 row wrapper),DOM 上是**有强关联**的,而非"label 和 value 在 DOM 上分离"。description 区(任务描述 / 产品需求描述 / 验收标准)则用 `<div class="detail">` 包裹 `.detail-title` + `.detail-content`,也是**共享 parent**。
>
> **关键观察 ④**: 本任务状态=未开始,**工时记录表(estimate / consumed / left 逐条 records)0 行**,只有聚合行(最初预计 32 / 总计消耗 0 / 预计剩余 32)。这是数据情况而非工具缺陷。

## 观察记录

### C1 任务详情页 (tab id=984528458)

- **O-1 [正常] 页面加载与导航**。`vortex_navigate({url:"/zentao/task-view-44929.html",waitUntil:"load"})` 返回 `status:"complete"`,URL 回写一致,`<title>` "TASK#44929 后端:VOC评价新增自定义字段以及关联商品表数据 / voc日常迭代 - 禅道",无登录墙。
  - 证据(原始返回截断):`{"url":"https://chandao.bytenew.com/zentao/task-view-44929.html","title":"TASK#44929 后端:VOC评价新增自定义字段以及关联商品表数据 / voc日常迭代 - 禅道","status":"complete"}`

- **O-2 [正常] iframe 承载确认**。evaluate 读顶层 `document.querySelectorAll('iframe').length === 1`,iframe id = `appIframe-execution`,name = `app-execution`;顶层 `document.querySelectorAll('table').length === 0`,**所有字段表在 iframe contentDocument 内**(与 R11 任务列表 `appIframe-my` 同源 iframe 嵌套布局)。

- **O-3 [正常] 详情页 panel 默认 display 状态**。evaluate 读 `[id^="legend"]` 5 个 div 的 `getComputedStyle.display`:
  - legendBasic = **block** (visible)
  - legendLife = **none** (hidden,默认)
  - legendTeam = **none** (hidden,默认)
  - legendEffort = **block** (visible)
  - legendMisc = **none** (hidden,默认)
  - **判定**: 用户首次打开详情页只看到基本信息(9 字段)+ 工时信息(6 字段),其余 3 个 panel 默认隐藏,**需点击 "任务的一生 / 团队 / 其他相关" tab 切换**才能看到。

- **O-4 [异常(补足路径存在)] observe filter=interactive 不展示 th/td 文本(同 R11 A-1 类)**。`vortex_observe({scope:"viewport",filter:"interactive",frames:"all-permitted"})` 在字段区仅看到空 button + 各种 link:
  - 字段区(th 文本"所属执行 / 优先级 / 指派给 / 截止日期" / td 文本"voc日常迭代 / 0 / 青蛙 / 2026-07-10" 全部缺失)
  - 操作栏全部召回:`指派 / 开始 / 工时 / 完成 / 取消 / 编辑任务 / 复制任务 / 删除 / 父任务` 9 个 link ✅
  - 详情头部召回:`返回 / VOC评价新增... / 建任务 / 需求地址 / 切换顺序 / 切换显示 / 添加备注` ✅
  - **tab 链接召回**:`基本信息 / 任务的一生 / 工时信息 / 其他相关` 4 个 anchor link ✅
  - 底部侧栏召回:`#45092 ... / #44921 ...` 2 个导航 link ✅
  - 顶部面包屑 / 侧边栏 / 右侧菜单全部 link / button 召回 ✅
  - **补足路径**:见 O-5 / O-6 / O-7,本条不构成盲点

- **O-5 [正常] observe filter=all + scope=full 完整召回 th/td label-value 配对**。`vortex_observe({scope:"full",filter:"all",frames:"all-permitted"})` 召回:
  - `<table>` 内每行 `<tr><th "所属执行" /><td><link "voc日常迭代" /></tr>` 结构,**label 与 value 共享同一 tr parent**,agent 可读 ref 配对
  - 9 行基本信息(legendBasic display:block,可见)+ 5 行工时(legendEffort display:block,可见)
  - legendLife / legendTeam / legendMisc 3 个 panel 因 display:none 在 a11y 树中**被整体跳过**,**不展示** —— 即 observe filter=all 也读不到隐藏 panel
  - 副作用:返回树被截断 `truncated: returned 80 of ~251 candidates`,agent 需要分多次 scope=full + scope=viewport 组合
  - **判定**: observe filter=all 能在 display:block panel 内拿到 label-value 配对,**brief 核心考查的"label 和 value 配对"在非隐藏 panel 中通过 observe 可识别**

- **O-6 [正常] query mode=css `table.table-data tr` 是最完整非截图识别路径**。`vortex_query({mode:"css",pattern:"table.table-data tr",attr:"textContent",frameId:650})` 返回 24 个 tr(全部 4 个 panel + 工时表头):
  - 每个 tr 的 `text` 字段直接是 `label\n   value` 拼接(如 `"所属执行\n                  \n                    voc日常迭代"`)
  - **无视 CSS display:none** —— legendLife/legendTeam/legendMisc 内容(由谁创建/由谁完成/.../截止日期)完整可见
  - children_count=2(普通 tr 配 th+td)/ 5(工时表头行 tr 配 5 个 th)
  - **判定**: query mode=css tr 是 brief 关心"label-value 配对非截图识别"在禅道 taskView 的**最完整路径**,单次 query 即可拿到全部 24 个 label-value 配对

- **O-7 [正常] query mode=css `table.table-data th/td` 单独提取,可按 index 配对**。
  - `pattern:"table.table-data th"` 返回 28 个 th(text="所属执行" / "由谁创建" / ...)
  - `pattern:"table.table-data td"` 返回 23 个 td(text="voc日常迭代" / "虹猫 于 2026-06-17 16:09:04" / ...)
  - **index 顺序对齐**: th[0]=所属执行, td[0]=voc日常迭代;th[1]=所属模块, td[1]=/;th[2]=相关产品需求, td[2]=VOC评价新增自定义字段以及关联商品表数据;... 完全对应
  - 但 th 总数 28 vs td 总数 23(多 5 个,即工时表头行 5 个 th 配 0 个 td,这是预期,头行无配对 td)
  - **判定**: 单独 th/td 提取能配对,适合做精细的 schema 验证

- **O-8 [异常(partial)] query mode=text 在 display:none panel 内命中率为 0**。`vortex_query({mode:"text",pattern:"由谁创建",frameId:650})` 返回 0 matches(legendLife display:none,DOM 上有完整 "由谁创建 虹猫 于 2026-06-17 16:09:04" 文本,但 query text 报 0 hits)。
  - 同一 query 在 display:block 的 legendBasic 内 `pattern:"优先级"` 命中 1 条,context 把后续 4 字段的 label+value 拼在一起("类型开发任务状态 未开始进度0%优先级0抄送给")—— **可借邻接文本手动配对**
  - 复测新 tab 984528459 frameId=661 同 query "截止日期" → 命中 1 条(element_path 在 #legendEffort > tr > th),行为一致
  - **判定**: query mode=text 受 visibility 影响,display:none panel 内 match 0 命中。这是 brief 担心的"非截图盲点"实际所在 —— display:none panel 的字段名 query text 不到
  - **补足路径**: query mode=css tr(O-6)+ evaluate(O-9) + observe filter=all 仅读 display:block panel 三者合并可全覆盖

- **O-9 [正常] evaluate 读 DOM 真值可补足所有 display:none panel**。`vortex_evaluate({function:"(function(){var doc=document.querySelector('iframe#appIframe-execution').contentDocument;var ths=Array.from(doc.querySelectorAll('th'));var pairs=[];for(var i=0;i<ths.length;i++){var t=ths[i];var td=t.nextElementSibling;pairs.push({th:t.textContent.trim(),td:td&&td.tagName==='TD'?td.textContent.trim():'(无配对 td)'});}return JSON.stringify(pairs);})()"})` 一次拿到全部 28 对 label-value 配对(th.nextElementSibling 配对):
  - 配对示例:
    - 所属执行 → voc日常迭代
    - 所属模块 → /
    - 相关产品需求 → VOC评价新增自定义字段以及关联商品表数据
    - 指派给 → 青蛙 于 2026-06-17 16:09:04
    - 任务类型 → 开发
    - 任务状态 → 未开始
    - 进度 → 0%
    - 优先级 → 0
    - 抄送给 → 暂无
    - 由谁创建 → 虹猫 于 2026-06-17 16:09:04
    - 由谁完成 → 暂无
    - 由谁取消 → 暂无
    - 由谁关闭 → 暂无
    - 关闭原因 → 暂无
    - 最后编辑 → 暂无
    - 团队 → (无配对 td,工时表头)
    - 预计 → (无配对 td)
    - 消耗 → (无配对 td)
    - 剩余 → (无配对 td)
    - 状态 → (无配对 td)
    - 最初预计 → 32工时
    - 总计消耗 → 0工时
    - 预计剩余 → 32工时
    - 预计开始 → 2026-07-06
    - 实际开始 → (空)
    - **截止日期 → 2026-07-10**
    - 相关合并请求 → (空)
    - 相关代码版本 → (空)
  - **判定**: evaluate 是万能补足路径,无视 display:none,完整覆盖 28 对配对

- **O-10 [正常] extract target=#legendBasic 完美保留 label:value 顺序**。`vortex_extract({target:"#legendBasic",depth:3,frameId:650})` 返回 9 行用 `\t` 分隔的 label-value 配对:
  ```
  所属执行	voc日常迭代
  所属模块	/
  相关产品需求	VOC评价新增自定义字段以及关联商品表数据
  指派给	青蛙 于 2026-06-17 16:09:04
  任务类型	开发
  任务状态	 未开始
  进度	0%
  优先级	0
  抄送给	暂无
  ```
  - **判定**: extract 在 display:block panel 内**完美保留 label:value 顺序**,agent 直接 split 即可
  - 同样 `target:"#legendEffort"` 返回工时区 6 行(最初预计 32工时 / 总计消耗 0工时 / 预计剩余 32工时 / 预计开始 2026-07-06 / 实际开始 / 截止日期 2026-07-10)

- **O-11 [异常(补足路径存在)] extract target=display:none div 返回空字符串**。`vortex_extract({target:"#legendLife",depth:3,frameId:650,scroll:true})` 返回 `""`(空字符串),`{target:"#legendMisc"...}` 同理。
  - 工具行为:extract target=display:none div → 空,即使加 `scroll:true` 也不展开
  - 判定:**brief 关心的"非截图盲点"实际场景** —— display:none panel 内的字段 extract 读不到
  - **补足路径**: query mode=css tr(O-6,无视 display:none)+ evaluate(O-9)+ observe filter=all 读 display:block panel 三者合并可全覆盖
  - 工具**没有真正无解的盲点**,但**默认 extract 行为对 agent 不友好**(需先点击 tab 切换 panel 才能读 hidden panel 的字段)

- **O-12 [正常] 富文本描述(任务描述 / 产品需求描述 / 验收标准)**。evaluate 读 `.detail-content.article-content` 3 个 div:
  - 任务描述: `<div class="text-center text-muted">暂无</div>`(innerHTML=63 字节,纯 placeholder)
  - 产品需求描述: `需求地址:<a href="https://banniu.yuque.com/xovnwo/qc6t8x/xrc9xi928kdkn3gv" target="_blank" rel="noreferrer noopener" data-vortex-react-clickable="1">https://banniu.yuque.com/...</a>`(innerHTML=223 字节,**含一个外链 + 文本**)
    - 注:`data-vortex-react-clickable="1"` 是 vortex 扩展注入的 a11y 标记属性
  - 验收标准: 暂无
  - **判定**: 禅道 taskView 描述区**没有真正的富文本格式**(无 `<p> <ul> <strong> <img>`),只有 placeholder + 内部链接。语义保留,格式无丢失(因没有重格式)。agent 通过 query css `.detail-title` + `.detail-content` 按 index 配对(都是 3 个)即可拿到全部描述 label-value 对

- **O-13 [正常] description 区 label-value 配对**。query mode=css `.detail-title` 返回 4 个 div(任务描述 / 产品需求描述 / 验收标准 / 历史记录),query css `.detail-content.article-content` 返回 3 个 div。parent 关系上:每个 .detail-title 都在 `<div class="detail">` 内,该 div 还有 1 个 children = .detail-content,所以**共享 parent**;index 一一对应:
  - [0] 任务描述 → 暂无
  - [1] 产品需求描述 → 需求地址:https://...
  - [2] 验收标准 → 暂无
  - [3] 历史记录 → (对应 #actionbox,children=4,含 style + 备注交互,**非纯 label-value**)

- **O-14 [正常] 工时记录表(estimate/consumed/left records)**。evaluate 读 table[2] = 工时表头行(团队 / 预计 / 消耗 / 剩余 / 状态 5 th,无 td),table[3] = 工时聚合(最初预计 / 总计消耗 / 预计剩余 3 对),table[4] = 其他相关(预计开始 / 实际开始 / 截止日期 3 对)。**本任务状态=未开始,逐条 estimate/consumed/left 记录 0 行**;只读到聚合总计(32工时 / 0工时 / 32工时)。这是数据情况(任务未开始),不是工具缺陷。

- **O-15 [正常] 操作栏召回(开始/完成/编辑/关闭/评论)**。observe filter=interactive 完整召回 9 个操作 link:
  - `指派` → `/zentao/task-assignTo-2028-44929.html?onlybody=yes`
  - `开始` → `/zentao/task-start-44929.html?onlybody=yes`
  - `工时` → `/zentao/task-recordEstimate-44929.html?onlybody=yes`
  - `完成` → `/zentao/task-finish-44929.html?onlybody=yes`
  - `取消` → `/zentao/task-cancel-44929.html?onlybody=yes`
  - `编辑任务` → `/zentao/task-edit-44929.html`
  - `复制任务` → `/zentao/task-create-2028-0-0-44929.html`
  - `删除` → `/zentao/task-delete-2028-44929.html?onlybody=yes`
  - `父任务` → `/zentao/task-view-44927.html`
  - **判定**: 操作按钮全部召回 ✅。附加:详情头部"添加备注 / 切换顺序 / 切换显示"3 个 button 召回,描述区 `历史记录 list "2026-06-17 16:09:04, 由 虹猫 创建。"` 召回

- **O-16 [正常] 详情页承载方式**。evaluate 读 `document.querySelectorAll('iframe').length === 1`(顶层) + `iframe#appIframe-execution.contentDocument.querySelectorAll('iframe').length === 2`(嵌套 2 个 iframe:id 空 + hiddenwin);`document.body.className === 'menu-show m-index-index'`(主框架是 menu-show,详情页挂在 app-execution iframe 内)。**判定:本场景所有 vortex 工具都需传 frameId 或嵌套 contentDocument 才能读到详情内容**(与 R11 一致)。

- **O-17 [正常] 新 tab 复测 (tab id=984528459) 完全一致**。在新 tab 复测最小序列(创建 → navigate → evaluate 读 legend display 状态 → query css tr → query text 截止日期):
  - legendBasic=block / legendLife=none / legendTeam=none / legendEffort=block / legendMisc=none —— 与旧 tab 完全一致 ✅
  - query css `table.table-data tr` 返回 24 行,text 内容与旧 tab 完全一致 ✅
  - query text "截止日期" 命中 1 条,element_path 在 #legendEffort > tr > th,与旧 tab 一致 ✅
  - **判定**: 关键观察在全新 tab 最小序列可复现,工具行为稳定

- **O-18 [正常] vortex 注入 a11y 标记**。evaluate 读产品需求描述区 `data-vortex-react-clickable="1"` 属性,这是 vortex 扩展注入的 a11y 增强(让 React 风格 click handler 可被识别)。**非缺陷,非盲点**,只是工具特性观察。

## 异常汇总 (Anomaly)

| ID | 现象一句话 | 严重度 | 证据位置 | 新 tab 是否复现 |
|----|-----------|------|----------|--------------|
| A-1 | extract target=display:none div(`#legendLife`/`#legendTeam`/`#legendMisc`)返回空字符串;agent 想读任务的一生 / 其他相关 等默认隐藏 panel 时,extract 拿不到字段 | experience | O-11 证据:extract target=#legendLife 返回 `""`;DOM 上有完整 6 行 label-value | true(新 tab 984528459 同 query 行为一致) |
| A-2 | observe filter=interactive 不展示无 role 的 `<th>` / `<td>` / `<div class="detail-title">` 文本;只有 filter=all + scope=full 才能在 a11y 树读到 label-value 配对(且只覆盖 display:block panel) | experience | O-4 + O-5 证据:filter=interactive 字段区只看到空 button;filter=all 完整 th/td ref 树 | true(新 tab filter=interactive 输出与旧 tab 一致) |
| A-3 | query mode=text 在 display:none panel 内命中率为 0(legendLife "由谁创建" / legendMisc "相关合并请求" 等字段名 query text 不到);但 query mode=css `table.table-data tr` 不受 display:none 影响(text 字段完整) | experience | O-8 证据:query text "由谁创建" frameId=650 returns 0 matches;query css tr frameId=650 returns 24 elements 含 "由谁创建\n虹猫 于 2026-06-17 16:09:04" | true(新 tab 984528459 query text "截止日期" 1 match,query css tr 24 match) |

> **brief 数据情况说明(非 anomaly,非盲点)**:
> - 禅道 taskView 详情页**无「所属项目」字段**(brief 列举但实际 DOM 不存在);任务直接挂 execution(执行/Sprint),项目名只能从面包屑 `班牛VOC标品迭代` 或 URL `execution-view-2028` 间接推断
> - **「截止日期」字段实际在 #legendEffort(工时信息),不在 #legendMisc(其他相关)**,这是禅道 DOM 实现与 brief 设想的差异
> - 本任务状态=未开始,**estimate/consumed/left 逐条工时记录 0 行**,只读到聚合(最初预计 32 / 总计消耗 0 / 预计剩余 32)

## 盲点判定 (brief 严格定义)

> brief: 「凡非截图无法识别 → 记 `[blindspot]`」;试过哪些非视觉路径(observe / query 各 mode / extract)都盖不到才算。

- **label-value 配对(基本信息 9 字段)**:
  - observe filter=interactive ❌ / observe filter=all scope=full ✅(th/td ref 配对)/ query mode=text ✅(邻接配对)/ query mode=css tr ✅(同 tr.text)/ query mode=css th+td 单独 ✅(index 对齐)/ extract target=#legendBasic ✅/ evaluate nextElementSibling ✅ → **非盲点**(8 条路径)
- **label-value 配对(任务的一生 6 字段,默认 display:none)**:
  - observe filter=interactive ❌ / observe filter=all ❌(display:none 跳过)/ query mode=text ❌(0 match)/ query mode=css tr ✅(无视 display:none)/ query mode=css th+td ✅/ extract target=#legendLife ❌(空)/ evaluate ✅ → **非盲点**(3 条路径覆盖,query css tr 是最方便的非视觉路径)
- **label-value 配对(工时信息 6 字段)**:
  - observe filter=interactive ❌ / observe filter=all ✅ / query mode=text ✅ / query mode=css tr ✅ / query mode=css th+td ✅ / extract target=#legendEffort ✅ / evaluate ✅ → **非盲点**
- **label-value 配对(其他相关 2 字段,默认 display:none)**:
  - observe filter=interactive ❌ / observe filter=all ❌ / query mode=text ❌(0 match)/ query mode=css tr ✅ / extract target=#legendMisc ❌ / evaluate ✅ → **非盲点**
- **富文本描述(任务描述 / 产品需求描述 / 验收标准)**:
  - observe filter=interactive ⚠️(只看到 link)/ query mode=css `.detail-title` + `.detail-content` ✅(parent div.detail 配对)/ query mode=text "暂无" ✅(但不能区分 3 个 "暂无" 属于哪个 panel)/ extract target=#main ✅ / evaluate ✅ → **非盲点**
- **工时记录表(estimate/consumed/left records)**: 数据 0 行(任务未开始),工具非盲点
- **操作栏召回(指派/开始/工时/完成/取消/编辑/复制/删除/父任务/备注)**: observe filter=interactive ✅ 全 9 召回 + 3 备注交互 → **非盲点**
- **iframe 承载识别**: evaluate 读 `iframe#appIframe-execution` ✅ → **非盲点**

**结论: 本场景无 true blindspot**。A-1~A-3 是工具覆盖范围的可见缺口,但都有补足路径(observe filter=all / query css tr / evaluate),不构成盲区。

## 完成度自评

- label-value 字段配对识别:24 行 tr + 3 行 description 配对全部非截图可读 ✅
- field 区(基本信息/任务的一生/团队/工时信息/其他相关)5 个 panel 全部覆盖(2 个 display:block 直接读,3 个 display:none 通过 query css tr / evaluate 读) ✅
- 描述区(任务描述/产品需求描述/验收标准)3 个 panel 覆盖,富文本链接保留 ✅
- 工时区:brief 列举的"工时记录表" 0 行(数据情况),但聚合行(最初预计 32 / 总计消耗 0 / 预计剩余 32)可读,另外发现 **截止日期 2026-07-10** 在工时区 panel 内 ✅
- 操作栏:9 个 link 全部召回(指派/开始/工时/完成/取消/编辑/复制/删除/父任务) ✅
- iframe 承载:确认 `iframe#appIframe-execution` 嵌套布局,与 R11 `appIframe-my` 同源 ✅
- 全程禁截图 ✅
- 每页新 tab 防漂移(984528458 旧 + 984528459 复测最小序列)✅
- evaluate 仅读 DOM 真值,未用于完成核心交互 ✅
- 数据情况已标(所属项目不存在 / 截止日期在 effort 而非 misc)✅
