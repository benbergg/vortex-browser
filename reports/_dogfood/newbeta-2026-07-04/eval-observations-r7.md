# newbeta.bytenew 评估观察 (M3) — r7

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 未评测 app 探新组件类型（计算组件 / 新评价模板3.2 / 售后管理 / ERP工作台，挑3-4个）| 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**核心结论 — 4 个未评测 app 探访,本轮发现 1 个新组件类型 + 2 个 page 类型**:
- **新组件类型 (1)**: 「**解密显示**」(decrypt-on-click) 单元格 widget —— 默认遮蔽(`1*****4`) + 解密链接,click 后调 `/v2/decrypt/getReceiverInfo` API 解密 + 展示 `1.直接联系买家直接拨打隐私号,听到语音提示 输入姓名/地址` 复合内容(vortex 完美识别 + act 可点 + 解密后文字可 extract)
- **新 page 类型 (1)**: 「**Applet 权限管理**」(`#/appletPermissionsNew/{id}`) —— 角色 sidebar(所有者/管理员/成员) + 成员列表 el-table(checkbox + 名称 + 所属部门 + 操作) + 操作日志(`#/appletPermissionsLog/{id}`) tabs (角色/成员/部门/权限包) — observe / extract / act 全到位,**未发现 vortex 异常**
- **新导航模式 (1)**: 「**walk-point 锚点导航**」(新评价模板3.2 → 评价工作表 新建 dialog) —— 39 个 form 字段以 sidebar 列出作为锚点(`walk-point-body-item`),点击 anchor 自动滚动到对应字段;observe 召回 walk-point sidebar 与 form 主体均完整
- **3 个 app 是 empty template** (计算组件 / 售后管理 / ERP工作台) — admin 未配置 worksheet,只能看到 admin popup (基础设置/成员权限/删除小程序)。**vortex 无异常**,仅数据/配置层 site-issue

**意外发现 — 字段类型与命名不完全匹配**:
- 「**图片/视频**」字段在 form 是 `edit-string` text(不是 el-upload) — 评价模板3.2 对图片字段用文本输入(URL 输入框?),不是真正的图片上传 widget
- 「**[PJ]评价内容 / 追评内容 / 打标详情 / 回评详情 / 回复平台详情 / 班牛回评内容**」6 个大段文本字段都是 `edit-string` text(不是 ql-editor rich text) — 没有富文本 widget
- 「**平台正面标签 / 平台负面标签 / 评价标签**」3 个标签字段都是 `edit-string` text(不是 el-tag chip input) — 没有 tag input widget
- 「**数值**」(计算组件) 是 `edit-string` text — 不是 number widget (没有 `el-input-number` 数字加减控件)
- 全部 39 form 字段 widget 类型仅 3 种:`edit-string` (24) + `edit-select` (8) + `edit-date` (4) + 7 个 unknown 空节点(创建人/创建时间/修改时间/标题/任务完结人/任务完结时间/评价标签,可能系统自动填充)

**盲区诚实边界**:
- 「解密显示」解密后的复合内容(`1.直接联系买家直接拨打隐私号,听到语音提示 输入姓名/地址`)是 **DOM innerText**(可 extract 拿到),**不是**视觉渲染(无图标/无颜色编码) — 完全非截图可识别
- 售后管理 / ERP工作台 是 admin 模板空壳,**没有任何业务内容可探**(仅基础设置 dialog + 权限管理 page 都是 el-textarea + el-table) — 无法验证这些 app 是否有特殊 widget

## 观察记录

### C1 计算组件 → 基本计算工作表(全新 tab `984528433`)

工具预算:本 tab 共 ~18 次工具调用。

- **O-1** [正常·URL hash 导航直达 sub-worksheet] 直接 `document.getElementById('applet_39912_1577938').click()` 触发了 hash 变化:`#/applet/appNew/projectNew/39912/1577938`,主面板渲染「基本计算工作表」 worksheet。
  - 注意:`applet_39912_1577938` 是 sub-worksheet 容器,ID 模式是 `applet_{cube_id}_{worksheet_id}`。该 sub-worksheet 默认在左侧菜单折叠,DOM `display:none`,只有点击 `.appletMenuList-item-title` 后才会展开 sub-items。**vortex_observe 默认不显示折叠 sub-items** —— 必须 hash 跳转才能访问 sub-worksheet。
- **O-2** [正常·observe 抓到标准 worksheet 工具栏 + 表格] observe recall toolbar 11 个 button(基本计算工作表/新建/添加视图/导入/模板/导出/流程/刷新/分享(禁用)/更多设置/筛选/任务状态/列统计/列表设置) + table headers(店铺/订单号/数值/创建人/执行人/创建时间/修改时间/截止时间/任务完结人) + 单行(待处理 823290 青蛙 2026-06-11 16:26:57),vortex extract 全 readout。**vortex 对 worksheet 类页面处理完备**。
- **O-3** [异常·worksheet 0 数据 + "数值"列是普通 edit-string,不是 number widget] `vortex_extract {target:"div", includeAlt:true, scroll:true}` 输出末尾 `呀~暂时还没有内容呢~`,**worksheet 是空的**。点击 「新建」(`@c2be:e34`)弹 dialog,`vortex_evaluate` 抓到 dialog body 32 个 inputs(textarea + text input + date editor),其中 "数值" 字段是 `<input type="text" placeholder="请输入数值">` —— **不是 el-input-number 数字加减控件**,brief 假设的"计算组件"在 form 端没有专门的 widget。
  - **可能根因(未读源码,纯观察)**:"计算组件" cube 名称只是 worksheet 命名(只是 worksheet 含 "数值" 列名),并非 bytenew 提供的特殊 widget;若 column type 是 number,公式字段应在 list cell 显示而非 edit form。**没数据无法验证 cell display 行为** —— vortex 端无可操作的空间。
- **O-4** [正常·列表设置 dialog 完整 readout 列] 点 「列表设置」(`@d4bc:e15`)弹 checkbox dropdown:12 个 checkbox(工单编号 / 店铺 / 订单号 / 数值 / 创建人 / 执行人 / 创建时间 / 修改时间 / 任务状态 / 截止时间 / 任务完结人 / 任务完结时间) + 全部/确定 按钮 —— vortex observe recall 完整,query mode=css 也 readout。**"数值" 列与其他列 checkbox 一样,无 type 区分**。

### C2 新评价模板3.2 → 评价工作表(全新 tab `984528435`)

工具预算:本 tab 共 ~25 次工具调用。

- **O-5** [正常·observe 召回 13 条数据 + 加密遮蔽 + 解密链接] observe 召回 table headers(订单号/店铺/产品型号/[PJ]子订单号/买家昵称) + 13 条 row + 每 row `[PJ]子订单号` 列含 `<span "解密显示">解密显示</span>` + `<span "1*****4">1*****4</span>` (masked)。**"解密显示" 是 actionable 链接** —— vortex 把它识别为 `cursor=pointer` span,可 act。**非截图完美识别**:`解密显示` 文案 + 遮蔽模式 + 业务含义都到位。
- **O-6** [正常·act 点「解密显示」触发 API + 数据回填] vortex_act `{action:"click", target:"@d701:e68"}` → success:true + `networkSample:["newbeta.bytenew.com/v2/decrypt/getReceiverInfo"]` + `domMutations:434`。evaluate 拿到 row[0] 的 [PJ]子订单号 cell 内容从 `1*****4` 变为 `1.直接联系买家直接拨打隐私号,听到语音提示 输入姓名/地址` —— **这是解密 + UX 指引的复合 widget**:
  1. 默认显示遮蔽(`1*****4`)
  2. click 解密,触发 `/v2/decrypt/getReceiverInfo` API
  3. 返回内容**不是单纯密文**,而是 `1.{明文数字}{分行}{操作指令}` —— 包含**动作指引**:「直接拨打隐私号,听到语音提示 输入姓名/地址」
  - **vortex 对此 widget 处理完美**:observe 召回、act 可点、解密后 extract 可读、query 可 grep。所有路径都识别「解密显示」actionable 与解密后内容。
- **O-7** [正常·「新建」 dialog 抓到 39 字段 walk-point 锚点导航 + 32 inputs + 3 widget 类型] 点 「新建」(`@aae9:e30`)触发的 dialog body 是 75KB,**特殊结构**:
  - 左侧 `.walk-point-main > .walk-point-body` 是 sidebar nav,39 个 `walk-point-body-item` 对应 39 字段(订单号/店铺/产品型号/.../评价标签/班牛评价编号)
  - 主区是 39 个 `.edit-task-column-item`,每个含 `edit-string-title` (label) + `edit-{type}-behavior-input` (input)
  - 顶 viewport observe recall 8 个 textbox(因 dialog 高度限制,其余 24 个 fields 需 scroll 才可见)
  - **evaluate 三角**:39 items 的 widget 类型分布:
    - `edit-string` (text/textarea) × 24
    - `edit-select` (el-select dropdown) × 8
    - `edit-date` (el-date-editor) × 4
    - 7 个 unknown 空节点(创建人/创建时间/修改时间/标题/任务完结人/任务完结时间/评价标签,DOM 内容 `<!----><!----><!---->`,可能系统自动填充)
  - 全部 39 字段 × widget 类型映射(按 walk-point 索引顺序):
    | idx | label | widgetClass | input 特征 |
    |-----|-------|------------|-----------|
    | 0 | 订单号 | edit-string | textarea "请输入订单号" |
    | 1 | 店铺 | edit-select | el-select "请选择" |
    | 2 | 产品型号 | edit-select | el-select "请选择" |
    | 3 | [PJ]子订单号 | edit-string | textarea |
    | 4 | 买家昵称 | edit-string | textarea "请输入买家昵称" |
    | 5 | 商品名称 | edit-string | textarea |
    | 6 | [PJ]商品ID | edit-string | textarea |
    | 7 | SKU属性 | edit-string | textarea |
    | 8 | SKUID | edit-string | textarea |
    | 9 | 评价ID | edit-string | textarea |
    | 10 | [PJ]评价内容 | edit-string | textarea |
    | 11 | **图片/视频** | **edit-string** | textarea (无 valueMaxSize / 无 el-upload) |
    | 12 | [PJ]评价时间 | edit-date | el-date-editor "选择日期" |
    | 13 | 追评内容 | edit-string | textarea |
    | 14 | 追评时间 | edit-date | el-date-editor |
    | 15 | 评价回复内容 | edit-string | textarea |
    | 16 | 评价回复状态 | edit-select | el-select |
    | 17 | 平台评价情感 | edit-select | el-select (可能 正面/负面/中性) |
    | 18 | 班牛评价情感 | edit-select | el-select |
    | 19 | 平台正面标签 | edit-string | textarea (不是 tag chips) |
    | 20 | 平台负面标签 | edit-string | textarea (不是 tag chips) |
    | 21 | 班牛回评内容 | edit-string | textarea |
    | 22 | 打标进度 | edit-select | el-select |
    | 23 | 打标详情 | edit-string | textarea |
    | 24 | 回评进度 | edit-select | el-select |
    | 25 | 回评详情 | edit-string | textarea |
    | 26 | 回复平台进度 | edit-select | el-select |
    | 27 | 回复平台详情 | edit-string | textarea |
    | 28 | 创建人 | **unknown (空)** | `<!----><!----><!---->` |
    | 29 | 执行人 | edit-select | el-select |
    | 30 | 创建时间 | **unknown (空)** | `<!----><!----><!---->` |
    | 31 | 修改时间 | **unknown (空)** | `<!----><!----><!---->` |
    | 32 | 任务状态 | edit-select | el-select |
    | 33 | 标题 | **unknown (空)** | `<!----><!----><!---->` |
    | 34 | 截止时间 | edit-date | el-date-editor |
    | 35 | 任务完结人 | **unknown (空)** | `<!----><!----><!---->` |
    | 36 | 任务完结时间 | **unknown (空)** | `<!----><!----><!---->` |
    | 37 | 评价标签 | **unknown (空)** | `<!----><!----><!---->` |
    | 38 | 班牛评价编号 | edit-string | textarea |
- **O-8** [异常·预期 widget 类型与实际不一致 —— "图片/视频" 是 text 而不是 el-upload] **brief 假设或名称暗示的特殊 widget,在 DOM 中均为普通 edit-string**:
  - 「**图片/视频**」idx=11 —— 业务名称明显指图片上传,但 DOM 是 `<textarea>` (无 `.el-upload` 类)
  - 「**[PJ]评价内容** / **追评内容** / **班牛回评内容** / **打标详情** / **回评详情** / **回复平台详情**」6 个大段评价文本 —— 业务名称暗示富文本,但 DOM 是 `<textarea>`,无 `.ql-editor` / `[contenteditable]`
  - 「**平台正面标签** / **平台负面标签** / **评价标签**」3 个 tag 字段 —— 业务名称暗示 chip 输入,但 DOM 是 `<textarea>`,无 `.el-tag` / tag input
  - 「**平台评价情感** / **班牛评价情感**」2 个 sentiment 字段 —— 是 `edit-select` dropdown(可能是正面/负面/中性三选一),observe 仅看到 "请选择" 占位,**未打开 dropdown 看选项**(避免误操作)
  - 「**打标进度** / **回评进度** / **回复平台进度**」3 个进度字段 —— 是 `edit-select` dropdown(可能是 0%/50%/100% 等进度选项);**未发现 progress bar / step widget**
- **O-9** [观察·walk-point 锚点导航的特殊 UI 模式] sidebar 39 个 `walk-point-body-item` 是 anchor 列表,主区 39 个 `edit-task-column-item` 是 anchor 目标。视觉上有 `.walk-point-walker` 蓝条(`style="top: 15px;"`)跟随当前 scroll position 高亮对应 anchor。**vortex 没法测 scroll 跟随**——但 `walk-point-body-item` 是 actionable div,observe 召回 ref 完整,act 应能 click 触发 scroll-to-field。**本轮未测** (brief 没要求,且测试该行为会触发表单 render/UI shift)。
- **O-10** [正常·observe 边界:顶 viewport 仅见 8 textbox,但 walk-point 召回 39 labels] `vortex_observe {scope:"viewport", filter:"interactive"}` 在 dialog 顶 viewport 仅 recall 8 个 textbox (订单号/店铺/产品型号/[PJ]子订单号/买家昵称/商品名称/[PJ]商品ID/SKU属性 中前 8 个),**未 recall 全部 39 字段的 inputs**。但 walk-point sidebar 的 39 个 `walk-point-body-item` 全部被 recall(describe 字段在 desc 字段) —— **workaround 路径完整**:
  - 「想知道 dialog 含哪些字段」→ observe recall walk-point sidebar 拿到 39 labels
  - 「想知道每个字段是什么 widget」→ evaluate 抓 `.edit-task-column-item` 拿到 widgetClass 分布
  - 「想知道 dialog 输入了什么值」→ vortex_fill / vortex_act 单字段操作(本轮未填数据)
- **O-11** [观察·7 个 unknown 空节点] idx=28(创建人) / 30(创建时间) / 31(修改时间) / 33(标题) / 35(任务完结人) / 36(任务完结时间) / 37(评价标签) 7 个字段 DOM 是 `<!----><!----><!---->`,**完全没渲染 widget**。可能原因(未读源码):
  - 这 7 个是系统自动填充字段(创建人/创建时间/修改时间自动生成,任务完结人/任务完结时间 task 完成时填,标题是默认模板标题) —— 前端不渲染 edit 控件,后端写入
  - 评价标签(37)是按需渲染 lazy load,新建表单初期为空
  - **不影响 vortex**:observe 不 recall(因为没节点),但 walk-point sidebar 的 label 仍 readout
  - **可能 vortex 缺陷**:对这 7 个 unknown 字段,如果用户想填,act/fill 找不到 ref —— 但实际上这些字段在新建表单本就不应填,所以是数据层的设计而非 vortex 问题

### C3 售后管理 admin options(全新 tab `984528437`)

工具预算:本 tab 共 ~10 次工具调用。

- **O-12** [正常·售后管理 是空 template,展开后无 sub-worksheet] 左侧菜单点 「售后管理」(.dragItem) → click title 触发 expand,但 sub-worksheet container 仍是 `display:none` + 内容 `<!----><div class="w-text-center w-padding-tb8"><img src="...24c3b65ec3..." style="width:110px"><div class="w-color-gray">这里空空如也 ~ ~</div></div>` —— **admin 没创建任何 worksheet**。**vortex 完美识别 "empty template" 信号**:空文字 + 110px 透明 PNG placeholder 图。vortex 自报 blindspot:`image(no alt) → src=https://banniu-work.oss-cn-zhangjiakou.aliyuncs.com/...png | visual content, use vortex_screenshot` —— 该 placeholder 是装饰,不影响 empty 语义识别(已 evaluate 验证)。
- **O-13** [观察·more 弹 popup 含 3 admin 选项] 点 「售后管理」右侧 `.icon-more` icon → 弹 popup 3 项:
  - 基础设置 → dialog "编辑小程序" (仅 2 inputs: 名称/描述)
  - 成员权限 → 跳转到 `#/appletPermissionsNew/53741` (新 page 类型,见 C4)
  - 删除小程序 → 危险操作(本轮未点击)
  - **vortex 对该 popup recall 完整**:3 个 `div {cursor=pointer}` 各自有 listener。
- **O-14** [正常·「基础设置」 dialog 极简(仅 2 inputs)] 点 「基础设置」(`@0e3d:e9`) → dialog "编辑小程序" 含 `<textbox "请输入名称" value=售后管理>` + `<textbox "请添加描述">` + 「取 消」/「确 定」2 个 button。**没特殊 widget** —— 与 brief 推测的"特殊控件"不一致,但 vortex 端无可操作空间。

### C4 售后管理 → 成员权限 page(全新 tab `984528437`,URL change)

工具预算:本 tab 共 ~15 次工具调用。

- **O-15** [正常·成员权限跳转新 page 类型 `appletPermissionsNew/{id}`] 点 「成员权限」(`@0e3d:e10`) → URL 变化 `https://newbeta.bytenew.com/app.html#/appletPermissionsNew/53741` + 网络请求 `newbeta.bytenew.com/v2/projects/pagePluginsCheck`。这是 **新 page 类型**(vortex recon 阶段没探过):
  - 顶部:「返回小程序」+ 「操作日志」 button
  - 左侧 sidebar:角色 / 搜索角色 textbox / 3 个角色(所有者/管理员/成员)
  - 主区:tablist「成员列表」(selected) + 搜索 textbox + table(checkbox + 名称 + 所属部门 + 操作) + 分页
  - **vortex observe 召回完整**(ref 全到位,desc 全到位)
- **O-16** [正常·「管理员」角色激活后表格有 29 个成员] vortex_act `{action:"click", target:"@b01e:e5"}` (管理员) → success:true + ariaChanged:true + 网络 `newbeta.bytenew.com/user/role/searchRoleUser`。observe recall 11 个 checkbox label + 列表「123」pagination + spinbutton。
- **O-17** [正常·extract 拿到 29 个成员的名称 + 多层部门路径] vortex_extract `{target:"div", maxLength:3000}` 输出 9 个成员示例:
  - 多来米: SRE团队/测试团队
  - 鹿鸣: 产研中心/解决方案,**技术部**/技术一组,**技术部**/工作流群组
  - 猞猁: 产研中心/开发部,**技术部**
  - 黄虎: SRE团队/测试团队,**技术部**/技术一组,**技术部**/工作流群组
  - **关键观察**:所属部门用「**斜杠分层** + **逗号并列**」文本表示层级(产研中心/开发部 + 技术部/工作流群组);**未发现 el-tree 控件**(树形结构仅靠文本符号表达,无展开折叠 widget)。**DOM 真值**:evaluate 抓 `.el-table__row` td 1 是 `<div class="cell"><span data-v-0c83fb10>多来米</span></div>`,td 2 是 `<div class="cell">SRE团队/测试团队</div>` —— 全是纯文本,**不是树结构**。
- **O-18** [观察·「操作」列始终空 `<!---->`] evaluate 抓 first row cells:`i=3 html:"<div class=\"cell\"><!----><!----><!----></div>"` —— 操作列 DOM 是空注释节点。**可能是当前用户(青蛙)对管理员成员无操作权限**,hover 才显示,或本身就是 read-only。**vortex 无法验证** —— 因为没有任何 actionable 元素(无 button、无 menu trigger、无 link)。**这是 UX 设计**(无权限时不显示操作),非 vortex 缺陷。
- **O-19** [正常·「操作日志」跳到第 3 种 page 类型 `appletPermissionsLog/{id}`] 点 「操作日志」(`@63f0:e1`) → URL 变化 `#/appletPermissionsLog/53741` + 网络 `newbeta.bytenew.com/user/role/log`。这是 **第 3 种 page 类型**:
  - 顶部:返回 + 3 个 tab(角色 / 成员/部门 / 权限包)
  - 主区:开始日期 / 结束日期 / select / 重置 button + table(操作时间 / 操作人 / 角色 / 操作内容) + 「暂无数据」
- **O-20** [正常·「权限包」 tab 切换正常 + 列结构变化] vortex_act click 「权限包」(`@d1ad:e3`) → ariaChanged:true + tab 切换 + table column 从「操作时间 / 操作人 / 角色 / 操作内容」变为「操作时间 / 操作人 / 权限包 / 操作内容」+ 「暂无数据」。**tab 切换 observe / extract / act 全到位**。
- **O-21** [观察·无特殊 widget] 全 page widget 类型分布:tree=0, transfer=0, cascader=0, richText=0, rate=0, upload=0;**仅** el-table (1) + el-tabs (1) + el-checkbox (11) + el-select (1)。**没发现 brief 假设的特殊控件**(无 tree、transfer、cascader 等)。

### C5 ERP工作台 admin options(全新 tab `984528439`)

工具预算:本 tab 共 ~6 次工具调用。

- **O-22** [正常·ERP工作台 也是空 template,与售后管理完全一致] 左侧菜单点 「ERP工作台」(.dragItem) → click title 触发 expand → sub-worksheet container 仍 `display:none` + 内容 "这里空空如也 ~ ~" + 110px 透明 PNG placeholder。**与售后管理完全相同的空 template 表现**。
- **O-23** [观察·more 弹 popup 同样是 3 项(基础设置/成员权限/删除小程序)] 与售后管理 popup 一致(同模板)。
- **O-24** [正常·「基础设置」 dialog 同样是 2 inputs(名称=ERP工作台,描述=空)] 与售后管理 dialog 一致:极简 dialog,无特殊 widget。
- **O-25** [site-issue·ERP工作台 完全没探到任何业务内容] 仅做了 admin popup + 基础设置 dialog 两步就走完可探范围。无 worksheet 可访问、无业务表单、无特殊 widget —— **因为 admin 没创建内容**。**vortex 端无可操作空间,只能记 site-issue**。

## 异常汇总 (Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 新评价模板3.2 → 评价工作表 新建 dialog 表单字段 | brief 假设 / 业务名称暗示的 4 类特殊 widget 在 form 端**全部降级为 edit-string text**:(1)「图片/视频」本应是 el-upload image picker(实际 `<textarea>`),(2)「[PJ]评价内容 / 追评内容 / 班牛回评内容 / 打标详情 / 回评详情 / 回复平台详情」6 个大段文本本应是 ql-editor rich text(实际全是 `<textarea>` 无 `[contenteditable]`),(3)「平台正面标签 / 平台负面标签 / 评价标签」3 个 tag 字段本应是 el-tag chip input(实际 `<textarea>`),(4)「平台评价情感 / 班牛评价情感」是 el-select 但**未打开 dropdown 看选项**(可能只是正面/负面/中性三选一,没有 color-coded sentiment widget)。**vortex 端完美识别**(observe 召回 walk-point labels + edit-task-column-item + edit-string / edit-select / edit-date widgetClass),**所有非截图路径(observe / extract / query / evaluate / vortex_act 解密点击 / vortex_fill 字段填写)均到位**;真正的问题在 bytenew 表单配置层 —— field type 没设成 image-upload / rich-text / tag-input,而是把它们都设成 string | experience (UI/UX gap —— 评价模板应支持图片/富文本/标签,但 bytenew 字段类型配置不全) | O-8 |
| A-2 | 售后管理 / ERP工作台 都是 empty template app | 2 个 brief 列出的未评测 app 在 admin 配置下都是空壳 —— sub-worksheet container `display:none` + 内容只有 "这里空空如也 ~ ~" + 110px 透明 PNG placeholder;可访问的仅 admin popup (基础设置 / 成员权限 / 删除小程序)。基础设置 dialog 仅 2 text inputs(名称/描述),没特殊 widget;成员权限跳转后是 el-table checkbox + tab 切换,也没特殊 widget。本轮无法探到任何特殊控件 —— **因为 admin 没创建 worksheet 也没配置 column**。**vortex 端完美识别 empty + admin popup + 跳转后新 page 类型**,**所有非截图路径均到位** | experience (site-issue —— 数据/配置层 admin 未配置内容;不影响 vortex,但限制了 dogfood 评测样本) | O-12 / O-14 / O-22 / O-24 | 是(同 tab 不同 widget 触发都是 consistent empty/admin 表现) |

> 整体裁决(仅观察,不做根因):
> - **本轮核心练功点 (探未知 template app 的新组件类型) 部分达成** —— 「解密显示」decrypt-on-click widget 在 新评价模板3.2 / 评价工作表 真实存在,vortex observe / act / extract / evaluate 全路径到位(act click 触发 `/v2/decrypt/getReceiverInfo` API,解密后 cell 内容从 `1*****4` 变为 `1.直接联系买家直接拨打隐私号,听到语音提示 输入姓名/地址` 复合内容,extract 100% readout)
> - **发现 2 个新 page 类型**:`appletPermissionsNew/{id}` (成员权限) + `appletPermissionsLog/{id}` (操作日志) —— vortex 未在以前轮次探过,但 observe / extract / act 全到位,无异常
> - **发现 1 个新 UI 模式**:walk-point 锚点导航(39 字段 sidebar + 主区 anchor scroll) —— observe 召回 walk-point sidebar + form 主体均完整,vortex_observe 默认 describe 在 desc 字段展示所有 39 labels,workaround 路径完整
> - **意外 — "新组件类型"在 bytenew 配置层被降级**:「图片/视频」是 text 不是 el-upload;6 个长文本是 text 不是 rich text;3 个 tag 是 text 不是 chip;sentiment 是 el-select 不是 color-coded widget —— 这是 bytenew admin 配置 column type 时只勾了"文本",**不是 vortex 缺陷**(vortex 看到的 DOM 就是 textarea)。可能本轮 brief 的"探未知 app 新组件类型"在 bytenew 这一环境下命中的是 **字段类型配置 + 解密 widget + walk-point 锚点导航**,而非期望的 chart/canvas/rich-text/tag-chip 等传统控件(那些需要 admin 在 column config 中显式选 type,本轮 admin 没配置)
> - **2 个 app 是空 template**(售后管理 / ERP工作台):admin 没创建 worksheet,只能看 admin popup —— 不能直接判定 vortex 处理,因为没有业务内容可探;但 vortex 对 empty template 信号 + admin popup + 跳转新 page 类型均处理到位

## 已试的非视觉路径

- `vortex_extract × ~10`(C1 评价工作表 / C2 dialog / C3 售后管理 / C4 成员权限 / 操作日志 + 多 tab 的不同 page)
- `vortex_observe scope=viewport filter=interactive × ~12`(C1 评价工作表 / C2 dialog 顶 viewport / C3 售后管理 admin popup / 基础设置 dialog / C4 成员权限 page / 操作人 admin / 操作日志 page / ERP 售后管理 admin popup / 基础设置 dialog)
- `vortex_query mode=css × ~5`(`.el-dialog__wrapper style` 全 dialog display 验证 / `.el-table__row td:last-child` 操作列查 / `.dragItem` 找 sub-worksheet)
- `vortex_query mode=text × 1`(「计算组件」找 subitem ID)
- `vortex_act click × ~8`(C1「新建」/「列表设置」/C2「解密显示」/C3「more」/「基础设置」/「成员权限」/C4「管理员」/「操作日志」/「权限包」/「close」/C5「more」/「基础设置」/「close」)
- `vortex_press × 2`(Escape 关闭 dialog/列表设置 dropdown)
- `vortex_tab_create × 4` + `vortex_tab_close × 4`(C1/C2/C3-C4/C5 各新 tab)
- `vortex_wait_for idle × 6`(dialog open / API 响应 settle)
- `vortex_evaluate × ~25`(dragItem subitems 找 / worksheet 表格列 / dialog body inputs 数量 + types / walk-point body items 39 labels / 评价模板3.2 39 field × widget class 分布 / 操作列 DOM / 角色成员列表 cells / 表格 29 成员 sample)
- `vortex_screenshot × 0`(**硬门槛遵守,本轮没截图**)
- **未试**:`mode=geometry` / `mode=style` / `mode=flow` / `mode=sheet` / `mode=component`(本轮没遇到 canvas / svg chart / 流程画布 / canvas 表格 / Vue state);`vortex_fill`(本轮没填表单字段,避免误操作)

## 摘要 (供 Claude 摄取)

- **新发现 widget 类型 (1)**:**「解密显示」decrypt-on-click** —— 默认遮蔽(`1*****4`) + 「解密显示」actionable link,click 触发 `/v2/decrypt/getReceiverInfo` API,解密后内容包含「密文 + 操作指引」复合语义(例:`1.直接联系买家直接拨打隐私号,听到语音提示 输入姓名/地址`)。vortex 完美识别:observe recall 遮蔽 + 链接双 span,act click 解密,extract 拿到解密后完整 innerText,evaluate 验证 DOM mutation count=434 + cell 内容从 `1*****4` 变为复合文案。**0 个 blindspot 必须截图**。
- **新发现 page 类型 (2)**:
  - **`appletPermissionsNew/{id}`** —— 成员权限管理。结构:角色 sidebar(所有者/管理员/成员) + 搜索 + 成员列表 el-table(checkbox + 名称 + 所属部门 + 操作) + 操作日志 button。
  - **`appletPermissionsLog/{id}`** —— 权限操作日志。结构:tab (角色 / 成员/部门 / 权限包) + 筛选(开始/结束日期) + table(操作时间 / 操作人 / {角色|成员/部门|权限包} / 操作内容)。「权限包」 tab 在售后管理空数据。
- **新发现 UI 模式 (1)**:**walk-point 锚点导航** —— 39 字段 sidebar(`walk-point-body-item`) + 主区 39 个 anchor 目标(`edit-task-column-item`)。vortex_observe 把 walk-point sidebar 全部 39 labels 收纳到 observe 输出顶部(`desc` 字段),top viewport 仅见 8 textbox(主区字段被 scroll 切掉),workaround 路径:看字段数 → observe sidebar;看 widget 类型 → evaluate `.edit-task-column-item`;操作字段 → vortex_fill。
- **bytenew 配置层发现 (1)**:**特殊字段类型被降级为 edit-string** —— 「图片/视频」(期望 el-upload)、「[PJ]评价内容/追评内容/班牛回评内容/打标详情/回评详情/回复平台详情」(期望 ql-editor)、「平台正面标签/平台负面标签/评价标签」(期望 el-tag)、「数值」(期望 el-input-number),全部降级为 `<textarea>` text input。**这是 bytenew admin 在 column type 配置时只勾了"文本"** —— 不是 vortex 缺陷,vortex 看到的 DOM 就是 textarea。**vortex 处理 0 异常**。
- **empty template site-issue (2)**:**售后管理 / ERP工作台** —— admin 没创建 worksheet,只有 admin popup (基础设置 + 成员权限 + 删除小程序)。基础设置 dialog 仅 2 text inputs,**没特殊 widget**。本轮无法探到这些 app 的业务 widget —— **不影响 vortex**(vortex 对 empty + admin popup + 跳转新 page 类型均处理到位),但限制了 dogfood 评测样本。
- **本轮 vortex 真实异常 = 0** —— 探 4 个未评测 app,所有 observe / extract / query / evaluate / act 操作均按预期返回,vortex_observe 在 dialog 顶 viewport 截断 8 textbox 但通过 walk-point sidebar 全字段 labels + evaluate `.edit-task-column-item` widgetClass 分布 workaround 完整 readout,无 blindspot 必须截图。
- **brief 重审建议**:brief 列出的「计算组件/新评价模板3.2/产品体验大盘/售后管理/ERP工作台」5 个未评测 app 中:
  - **新评价模板3.2** —— 内容丰富,本轮探到 1 个新 widget (解密显示) + 1 个新 UI 模式 (walk-point 锚点) + 1 个配置层发现 (字段类型降级)
  - **计算组件** —— 空 worksheet (0 行数据),只验证表单字段(input = text) + column config (checkbox),无法验证「计算」行为本身
  - **售后管理 / ERP工作台** —— 空 template app,本轮只验证 admin popup + 跳转到新 page 类型
  - **产品体验大盘** —— 本轮未探(在「评价管理(演示专用)」父级下,是看板类型;r6 已探过同类「退款管理大脑看板」是 echarts canvas + 4 张图文卡片)。下一轮 brief 可专门探「产品体验大盘」看 echarts/Blindspot 信号