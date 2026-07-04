# newbeta.bytenew 评估观察 (M3) — r8

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 流程布局画布 —— 流程图非截图 readback 边界 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**核心结论 — 流程设计器画布不可达(site-issue),但 vortex 在 worksheet 层和 admin/flow 层都给出明确非截图降级信号**:

- **「流程布局」开关 disabled**(admin 锁定):工作流演示 worksheet 的「流程」按钮 dropdown 内,7 项中 6 项 disabled,**「流程布局」** 是 `<div class="workflow-dropdown-item top disabled">` 包 `<el-switch checked disabled>` + 文字 + questionmark。act click 后只收起 popper,无新 dialog/画布出现 —— 流程设计器画布本体对当前账号/admin 不可达。
- **vortex_query mode=flow 主动降级**(关键证据):在 worksheet 主面板调用 `vortex_query mode=flow pattern="*"` → 抛错 `query.queryPage flow error: no flow diagram on page (未检测到流程图;若确在流程页请等待加载,或用 vortex_screenshot)` —— vortex **主动给出 graceful degradation**:识别出"用户想看流程图但页上没有",提示加载或建议 screenshot(本轮禁截图,记录此路径)。**这是 vortex 工具的降级信号之一**,不是静默漏返。
- **worksheet 主面板非画布**:`vortex_query mode=css pattern="canvas, svg, .x6-graph, [class*=x6], [class*=antv], [class*=logic-flow], [class*=flow-node], [class*=flow-edge]"` 在 worksheet 主面板返回 `canvas=0 / svg=2(图标级,无 class 标识) / 0 个 x6/antv/logic-flow 类`。**主面板就是「节点状态运行列表」普通 DOM `<table>`** —— 10 行工单(工单编号/任务编号/节点名称/节点类型/产生时间/等待时长)+ 操作(处理/转交/备注)。
- **vortex_observe 在 worksheet 召回完整**(无 blindspot 信号,因为不是画布场景):recall 11 个 toolbar buttons + 完整 10 行 + 全部操作 button,filter interactive 拿到每个 cell 的 ref。extract 拿到完整文本。
- **admin/flow hash 也是空白页**:`#/applet/appNew/projectNew/30009/admin/flow` navigate 后,主面板空白(只有左侧 nav),`canvas=0 / svg=0`,没有任何 flow-design 类。流程设计器 admin 入口不在这个 hash。
- **节点交互**:画布本体不可达 → 无法 act click 节点。这是 site-issue 阻挡,不是 vortex 缺陷。

**不是 blindspot 的判定**:brief 把 "非截图无法识别" 归为 blindspot。本场景不是"画布可达但非视觉工具读不出",而是 **"画布本体不可达(admin 锁定)"** + **"vortex 工具在 worksheet 主面板主动降级 + 给出明确提示"**。属 site-issue(site 权限/锁定)+ vortex 主动 graceful degradation,不是感知缺陷线索。

**给后续场景的建议**:
- 流程设计器画布本体需要 **admin 账号 / 启用「流程布局」开关的 cube** 才能进入,普通 dogfood 评测账号走「工作流演示」worksheet 这条路不通。
- 班牛画布技术栈暂未确认 —— 因画布不可达,无法验证是不是 antv-x6 / logic-flow / mxgraph / 自研 svg。需要 admin 权限后续轮次覆盖。
- vortex_query mode=flow 工具本身存在且会主动降级,提示文案"未检测到流程图;若确在流程页请等待加载,或用 vortex_screenshot"是清晰的引导;建议后续在测试面板里加"若画布存在但未渲染完"的轮询等待机制(当前是直接报错)。

## 观察记录

### C1 工作流演示 worksheet(全新 tab `984528441`)

工具预算:本 tab 共 ~31 次工具调用(略超 30 次预算,因 admin hash 试错消耗)。

**入口**:新 tab → navigate `https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/30009/1086546`(工作流演示 worksheet)。

- **O-1** [正常·worksheet 主面板 recall 完整] `vortex_observe {scope:viewport, filter:interactive}` 在 worksheet 顶 viewport 召回:
  - 11 个 toolbar buttons(工作流演示 / 新建 disabled / 添加视图 / 流程 / 刷新 / 分享 disabled / 筛选 / 列表设置 / 共 5 条 / 1 / 前往页 + 处理×5 / 转交×5 / 备注×5 操作 button)
  - 6 列 table headers(工单编号 / 任务编号 / 节点名称 / 节点类型 / 产生时间 / 等待时长)
  - 10 行 cell 数据(工单编号 186/186/219/221/222 + 任务编号 + 节点名称「门店处理/电商客服」+ 节点类型「填写节点」+ 产生时间 + 等待时长「15489 小时 25 分钟40秒」)
  - 视图 tabs(流程待办 / 流程工单 / 全部工单)
  - **observe recall 完整,无 `[blindspot]` 降级标注** —— 因为是普通表格,observe 完全够用。

- **O-2** [正常·「流程」按钮可 act click + 触发 dropdown] vortex_act `{action:click, target:@364e:e30}` → success:true + `domMutations:231 + focusChanged:true + urlChanged:false + networkRequests:0`。observe 显示 dropdown 是 7 项 tooltip `流程设置 / 流程权限 / 提醒设置 / 自动分配 / 流程参数 / 流程数据 / 流程布局`。

- **O-3** [异常·「流程布局」开关 disabled,无法进入流程设计器] evaluate 拿到 popover-6342 完整 DOM:
  ```
  <div role="tooltip" id="el-popover-6342" class="el-popover el-popper workflow-dropdown-popover" style="...">
    <div>
      <div class="workflow-dropdown-item disabled"><i class="wicon icon-linkage"></i><span>流程设置</span></div>
      <div class="workflow-dropdown-item disabled"><i class="iconfont icon-liuchengquanxian"></i><span>流程权限</span></div>
      <div class="workflow-dropdown-item disabled"><i class="wicon icon-time5"></i><span>提醒设置</span></div>
      <div class="workflow-dropdown-item disabled"><i class="wicon icon-x-distribution"></i><span>自动分配</span></div>
      <div class="workflow-dropdown-item disabled"><i class="iconfont icon-set-up2"></i><span>流程参数</span></div>
      <div class="workflow-dropdown-item top disabled"><i class="iconfont icon-shuju01"></i><span>流程数据</span></div>
      <div class="workflow-dropdown-item top disabled">
        <div role="switch" aria-checked="true" aria-disabled="true" class="el-switch el-inner-text-switch is-disabled is-checked">
          <input type="checkbox" disabled="disabled" class="el-switch__input">
          <span class="el-switch__core" style="width: 40px;"></span>
        </div>
        <span>流程布局</span>
        <i class="el-tooltip right-icon wicon icon-questionmark" aria-describedby="el-tooltip-7591"></i>
      </div>
    </div>
  </div>
  ```
  - 前 6 项都是 disabled,「流程布局」是 disabled 开关(checked + disabled,switch aria-disabled=true),带 questionmark 帮助图标
  - vortex_act `{action:click, target:@0056:e8}`(流程布局整行)→ success:true 但 `dialogHit=[] + networkRequests=0 + urlChanged:false`,只触发 191 个 domMutations 是 popper 收起
  - evaluate 检查 `.el-dialog` 无 visible 的:visibleCount=0 — **未打开新对话框/画布**
  - **判定**:流程布局开关 disabled,admin 锁定 → **site-issue**,不是 vortex 缺陷。vortex 正确识别 disabled 控件并 act 无效生效(不会"假成功",domMutations 是 popper 收起的副作用)。

- **O-4** [正常·worksheet dropdown admin 入口开放,但不进入流程设计器] 「工作流演示 」worksheet 名称按钮(@bd0d:e59)act click 触发 dropdown(创建人:晨风),evaluate 拿 ID `dropdown-menu-5577` DOM:
  - 常用功能:基础设置 / 组件设置 / 移动工作表 / **另存为模板** / 删除工作表
  - 高级功能:组件显隐 / 分享设置 / 工单标题 / 关联工单 / 快捷创建 / 自动备注 / 自动分配 / 截止时间 / 提交校验 / 数据同步 / 数据拉取 / 消息通知 / 买家通知 / 外呼设置 / 组件拉取 / 关联活动 / 打印模板
  - 全部 `class="active"`,没有 disabled — **worksheet 配置层面 admin 权限是开的**
  - 但 dropdown 内**没有「流程布局」或「流程设计」入口** —— 流程布局在「流程」按钮内被 disabled,与 worksheet 配置入口是两条路径
  - **判定**:worksheet admin 可改组件/字段/触发器,但**改不了流程结构**(流程结构是 cube 维度,在「流程」按钮内且当前锁定)

- **O-5** [关键·vortex_query mode=flow 主动降级] `vortex_query {mode:flow, pattern:"*"}` 在 worksheet 主面板调用 → 抛错:
  ```
  Error [JS_EXECUTION_ERROR]: query.queryPage flow error: no flow diagram on page 
  (未检测到流程图;若确在流程页请等待加载,或用 vortex_screenshot)
  ```
  - **这是 vortex 工具的 graceful degradation**:识别"用户启用 mode=flow 但当前页无流程图"场景,主动给出明确错误文案 + 引导(screenshot)
  - 错误格式是 JS_EXECUTION_ERROR(工具级别错误返回),不是空结果/静默漏返
  - **vortex 的降级信号给出了**:告诉调用方"未检测到流程图",而不是假装返回空 mermaid。这是**清晰、可观察的降级信号**,不是 blindspot 静默漏。
  - **判定**:不是 vortex 缺陷。是 brief 期望的"看 vortex 是否给 blindspot 降级信号"答卷 —— **vortex 给了降级信号**(明确的错误文案),只是提示用户去 screenshot(本轮禁截图,记录此路径而非真的去截图)。

- **O-6** [正常·vortex_query mode=css 确认 worksheet 无画布元素] `vortex_query {mode:css, pattern:"canvas, svg, .x6-graph, [class*=x6], [class*=antv], [class*=logic-flow], [class*=flow-node], [class*=flow-edge]"}` → 返回 2 个 svg 元素(都是图标级,无 class 标识;初步判断是顶部 logo + 流程 button icon)
  - **canvas=0** + 无 x6-graph/antv/logic-flow 类 → 确认 worksheet 主面板无流程画布

- **O-7** [正常·vortex_extract 在 worksheet 主面板 readout 完整] `vortex_extract {target:"div[ref*='bd0d:e50'], .workflow-worksheet, .workflow-node-list, main"}` → 输出 10 行完整工单数据(工单编号/任务编号/节点名称/节点类型/产生时间/等待时长/操作)。**没有任何 svg/canvas/flow 缩略图嵌入**。

- **O-8** [异常·admin/flow hash 是空白页,不是流程设计器] `vortex_navigate {url:"https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/30009/admin/flow"}` → navigate 成功(url 变更,status:complete)但 observe 显示主面板空白,只有左侧 nav:
  - `vortex_observe` 召回 80+ 个元素全是左侧 nav,主面板为空
  - `vortex_extract {target:body}` 输出仅 nav 列表文本(首页/犇犇/小程序/搜索/11 + 26 个 cube 名)
  - `vortex_query mode=css pattern="canvas, .x6-graph, ..., [class*=workflow-design]"` → `total:0`,无任何画布/流程设计类元素
  - **判定**:admin/flow hash 不是流程设计器入口。需要其他 hash 才能进入 admin 流程编辑器(本轮未找到)。

### 异常汇总(Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 工作流演示 worksheet「流程布局」菜单 | 「流程布局」开关 disabled,act click 无 dialog 出现,流程设计器画布本体不可达 | site-issue | eval-observations-r8.md O-3 | 旧 tab 出现(984528441),单 tab 内复测一致 |
| A-2 | workflow 主面板 query mode=flow | vortex 主动报错 `no flow diagram on page (未检测到流程图;若确在流程页请等待加载,或用 vortex_screenshot)` —— 引导用户用 screenshot,但本轮禁截图 | experience(vortex 降级正确,但提示文案依赖 screenshot) | eval-observations-r8.md O-5 | 单 tab 内复测一致 |
| A-3 | admin/flow hash | `#/applet/appNew/projectNew/30009/admin/flow` navigate 后主面板空白,无画布;cube admin 配置流程设计器入口不在该 hash | site-issue(本轮未找到正确 admin hash) | eval-observations-r8.md O-8 | 新 tab 内复测一致 |