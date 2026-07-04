# newbeta.bytenew 评估观察 (M3) — r4

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 弹窗/浮层 模态作用域 observe — 筛选/流程/列表设置 dialog + 嵌套浮层 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**模态作用域裁剪仅在 1 个场景出现,且有缺陷**:
- **工单测试表 → 点「流程设置」tab → 跳转触发真 dialog** 时,observe 输出顶部出现 `# modal: dialog "dialog" (suppressed 112 background elements)`,**背景被裁掉 112 元素** ✅。
- **但其他所有弹层场景(筛选面板/流程 dropdown/列表设置 popover)都**:
  1. **完全没有 `# modal:` / `# popover:` 元信息行**
  2. **背景全部泄露**(返回 80/700+ 候选,背景完整)
  3. **弹层被 observe 误分类为 `tooltip`**(应识别为 dialog/menu/popover)
  4. **没有 `[behind-modal]` / `[behind-popover]` 逃生口标记**
  5. **弹层控件与背景 ref 混在同一个 namespace**,无法从 ref 看出作用域归属

**最严重盲点 (A-3)**: 跳转后页面同时存在多个 dialog(「帮助」+ 「工作流配置引导」+ 多个 drawer),**observe 只召回 1 个 dialog =「帮助」(且只召回 close 按钮,漏了"知道了"按钮)**;**真正可见的主 dialog「工作流配置引导」(820×770)完全漏掉**。

## 观察记录

### C1 工单表 + 筛选 panel (全新 tab `984528415`)

工具预算:本 tab 共 ~14 次工具调用。

- **O-1** [异常·brief 假设错误] **「筛选」按钮实际打开的不是 modal dialog,而是工具栏内联展开面板**(`worksheet-main-content-search-main-bottom` div,与「保存/重置/收起」同级,无 modal overlay / 无 z-index >= 100 容器 / 无 aria-modal=true)。
  - **observe 召回**:点筛选按钮后 `ariaChanged:true, domMutations:62, dialogHit:[]`,observe 看到内联 panel 内容:
    ```
    div "fixed2" [ref=@16dd:e45]
    div "范围" [ref=@16dd:e46] desc="请输入 范围 为空 不为空"
    textbox "开始日期" [ref=@16dd:e47]
    textbox "结束日期" [ref=@16dd:e48]
    button " 添加筛选条件" [ref=@16dd:e49] [haspopup:menu] controls=#dropdown-menu-2471
    button "筛选" [ref=@16dd:e50]
    button "保存" [ref=@16dd:e51]
    button "重置" [ref=@16dd:e52]
    button "收起 " [ref=@16dd:e53]
    ```
  - **真实 DOM**:`vortex_evaluate` 搜索"开始日期"+"筛选" — 0 命中。query CSS `.fixed2` 0 命中。**observe 召回的 `div "fixed2"` 在真实 DOM 中找不到对应物** — 这是 ghost ref!
  - 真实结构是 `worksheet-main-content-search-main-bottom-left` 容器,「筛选」「保存」「重置」「收起」四个按钮是兄弟节点,**根本没有"内联展开 panel"容器 — 控件是直接挂载在工具栏 DOM 上的**(vortex_observe 把它们组织成 panel 树)。
  - **关键判定**:brief 假设「筛选」是 modal dialog,期望 observe 显示 `# modal:` 裁剪 — **实际筛选是工具栏内联展开,observe 不需要 modal scope 标记**。这是 brief 假设与实现不一致,**不算 vortex 缺陷,记为观察·非异常**。

- **O-2** [正常·无异常场景] 既然筛选 panel 不是 modal,**observe 没做模态裁剪是正确的**(返回 80/719 候选,背景完整是预期行为)。没有 `# modal:` 行是因为确实没模态。

- **O-3** [异常·observe 召回 ghost ref] **`div "fixed2"` 是 ghost ref**:
  - 真实 DOM 不存在 class="fixed2" 元素
  - query css `.fixed2` 0 命中
  - 但 observe 多次稳定返回 `div "fixed2" [ref=...]`
  - 推测:observe 把内联 panel 的多控件(范围/开始日期/结束日期/添加筛选条件/筛选/保存/重置/收起)逻辑上组织在一个虚拟 wrapper 里(命名 "fixed2"),但该 wrapper 在真实 DOM 中不存在。
  - **影响**:调用方拿 ref @16dd:e45 想 act 点击是无效的 — 真实 DOM 没有这个元素;只能拿到子项 ref 操作。**observe 输出了不可用的 ghost ref**。

### C2 嵌套浮层 — 筛选 panel 内「添加筛选条件」下拉 (同 tab `984528415`)

- **O-4** [正常·召回完整] 点「添加筛选条件」(@16dd:e49) → `ariaChanged:true, domMutations:92` → observe 召回 **完整 dropdown 内容**:
  ```
  textbox "输入名称搜索" [ref=@dcb2:e0]
  listitem "工单编号" [ref=@dcb2:e1]
  listitem "创建人" [ref=@dcb2:e2]
  ... (11 个 listitem)
  listitem "任务完结时间" [ref=@dcb2:e11]
  textbox "输入名称搜索" [ref=@dcb2:e12]
  ```
  11 个字段名 listitem 全部召回 + 2 个搜索框(主搜索 + dropdown 内过滤) ✅。

- **O-5** [异常·嵌套浮层作用域丢失] **dropdown 内容 ref (@dcb2:e0..e11) 与背景工具栏/筛选 panel/表格 ref 完全混在同一个 @dcb2 namespace,无任何作用域标记**:
  - dropdown listitem (e1-e11) 和 toolbar 按钮 (e13-e26) 和 filter panel 控件 (e27-e33) 在同一 namespace
  - **无 `# popover:` 元信息行**
  - **无 `[behind-popover]` 标记**
  - **背景全部泄露**(左侧导航/工具栏/筛选 panel/表格/分页 全部可见)
  - 调用方拿到 `ref=@dcb2:e1`(工单编号)时,**无法从 ref 看出它是 dropdown 内的 listitem 还是其他** — 必须靠内文理解推断。

- **O-6** [正常·act 在嵌套浮层可用] 点 `ref=@dcb2:e1`(工单编号 listitem) → `success:true, domMutations:64, focusChanged:true`,observe 后续召回新 textbox "请输入" + div "范围"+"等于"(筛选条件已添加到 panel)✅。**act 在嵌套浮层内可用**,但只证明"能点击",不证明"作用域正确"。

### C3 流程 dropdown (同 tab `984528415`,点「流程」按钮)

- **O-7** [异常·role 误判 + tab 分类错误] 点「流程」按钮(@30e2:e19) → `domMutations:109, dialogHit:[]`,observe 召回:
  ```
  tooltip " 流程设置  流程权限  提醒设置  自动分配  流程参数  流程数据 流程布局 " [ref=@cdda:e1] [listener]:
    switch [ref=@cdda:e0] [checked] [disabled]
    div "流程设置" [ref=@cdda:e2] [cursor=pointer]
    div "流程权限" [ref=@cdda:e3]
    div "提醒设置" [ref=@cdda:e4]
    div "自动分配" [ref=@cdda:e5]
    div "流程参数" [ref=@cdda:e6]
    div "流程数据" [ref=@cdda:e7]
    i "questionmark" [ref=@cdda:e8]
  ```
  **3 个问题**:
  1. **observe 把它标为 `tooltip`,不是 dialog/menu/button-dropdown** — role 误判 ❌
  2. **「流程布局」被识别为 `i "questionmark"`**(iconfont 字形被误归类为 icon),实际它是一个 tab item,class `workflow-dropdown-item.top.disabled`
  3. **disabled 状态完全未表达** — DOM 真值显示 7 个 tab 中 6 个都是 `.workflow-dropdown-item.disabled`(cursor:not-allowed),**只有「流程设置」可点**;observe 召回的 7 项都看起来"可点"。

- **O-8** [异常·切 tab 不刷新] 点「流程参数」(@cdda:e6) → `domMutations:57, dialogHit:[]` → 再次 observe,**tooltip 内容完全不变**(还是同样的 7 项)。**observe 没刷新 dropdown 内容**(可能因为 dropdown 还显示着同样 tab 项;也可能因为 disabled tab 被 click 后无变化)。不能判定 act 在 disabled tab 上是 success 还是 noop — vortex_act 仍返回 success=true 但实际可能未触发任何 handler。

- **O-9** [异常·dropdown 物理结构] DOM 真值:7 个 `.workflow-dropdown-item` 物理位置在 (1138, 103) ~ (1138, 355),大小 128×36,**整个 dropdown panel 是 128×252**。**没有任何 role=dialog/aria-modal=true/fixed/absolute/z-index>=100 的容器** — 实际上 dropdown 是普通文档流的 positioned div,不在 modal scope。

### C4 流程 dialog 跳转 (同 tab `984528415`,点「流程设置」)

- **O-10** [正常·模态裁剪生效] 点「流程设置」(@f2bf:e2) → `dialogHit:[".el-dialog__wrapper", "[role='dialog']"], userFeedback:"dialog", urlChanged:true, networkRequests:15, domMutations:319` → URL 跳转 `workflowMixConfig/workflowMixSetting/...` → observe 返回:
  ```
  # modal: dialog "dialog" (suppressed 112 background elements)

  - dialog "dialog" [ref=@d6dc:e0]:
    - div "close" [ref=@d6dc:e1] [cursor=pointer] [listener]
  ```
  **🎯 命中 brief 期望**: `# modal:` 元信息出现 + 112 背景元素被裁掉 + dialog 作为唯一根节点 ✅。**这是全 r4 评测中唯一一次 observe 正确输出模态作用域裁剪的场景**。

- **O-11** [异常·dialog 内容召回严重不完整] **observe 只召回 dialog 内的 `div "close"` 按钮**,但真实 DOM 同时存在**多个 dialog/drawer**:
  - dialog "帮助" (ariaLabel=帮助, innerText="帮助知道了", 2 button)
  - el-drawer "搜索节点&连接线" (空)
  - el-drawer "drawer-setting" (空)
  - **dialog "dialog" `workflow-new-guide-modal` (820×770 @ 305,110, opacity=1, visible, innerText="工作流配置引导 | 配置流程中需要执行的节点 | 拖拽到面板即可添加节点 | 跳过 (1/3) | 下一步")**
  - 等等多个 dialog/drawer
  - observe **只抓取"帮助"dialog 的 close 按钮**,**漏掉了真正可见的主 dialog「工作流配置引导」**(820×770, 内含 25 个 leaf + 1 个 button"下一步" + "跳过"按钮)。

- **O-12** [异常·dialog 内部召回也漏] 「帮助」dialog evaluate 显示 `interactiveCount=2, leafCount=8`(2 个 button:close icon + "知道了"),observe 只召回 `div "close"` 1 项 → **漏 "知道了" 按钮**。**"知道了"按钮 visible=false(bbox=0,0,0,0)**,可能被 observe 过滤掉,但它是 dialog 内的"主操作按钮"(业务语义上应该是重点)。

- **O-13** [观察·dialog 切换失败] 在 dialog open 后再点 "流程参数" 切换 tab:**observe 内容不变**;等待 2 秒后重 observe:仍然只返回 close 按钮 + 112 背景裁剪。说明 observe 在 dialog 内**没有刷新机制** — dialog 一旦被识别为 modal,observe 只看 dialog 顶层 accessibility tree,不会主动进入 dialog 内容查找。

### C5 列表设置 popover (全新 tab `984528416`)

- **O-14** [异常·role 误判] 点「列表设置」(@9ac8:e44) → `domMutations:125, dialogHit:[]` → observe 召回:
  ```
  tooltip "请输入搜索关键字  工单编号 创建人 执行人 创建时间 修改时间 任务状态 必填测试 截止时间 任务完结人 任务完结时间 全部 确定" [ref=@fcca:e24]
    textbox "请输入搜索关键字" [ref=@fcca:e0]
    checkbox "工单编号" [ref=@fcca:e1] [checked]
    ... (11 checkbox)
    checkbox "全部" [ref=@fcca:e11]
    button "确定" [ref=@fcca:e12]
  ```
  **问题**:
  1. **observe 把它标为 `tooltip`,不是 popover/dropdown/menu** — role 误判 ❌
  2. **无 `# popover:` 元信息行**
  3. **无 `[behind-popover]` 标记**
  4. **背景全部泄露**(导航/工具栏/筛选 panel/表格 全部,ref @fcca:e25+)

- **O-15** [正常·召回完整 + 状态正确] popover 内容召回完整 ✅:
  - 11 列 checkbox 全部召回(工单编号/创建人/执行人/创建时间/修改时间/任务状态/必填测试/截止时间/任务完结人/任务完结时间/全部)
  - checked 状态正确(与表格实际显示列匹配:工单编号/创建人/执行人/修改时间/任务状态/截止时间/任务完结人/任务完结时间 = checked;创建时间/必填测试 = unchecked)
  - "全部" checkbox = unchecked(因为不是全选状态)
  - 1 个 textbox 搜索框 + 1 个 "确定" button

- **O-16** [正常·关闭恢复] 点 "确定"(@fcca:e12) → `domMutations:311, networkRequests:3(updateShowTaskListColumn/.../queryV3)` → 再次 observe:**popover 完全消失**,背景恢复到完整全量(导航/工具栏/筛选 panel/表格/分页),**没有残留 tooltip 节点或 `[behind-popover]` 标记** ✅。
  - 但因为整轮观察都没出现过 popover scope 标记,**无法验证 scope 是否"正确撤销"** — 只能验证 popover 节点从输出中移除。

## 异常汇总 (Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 流程 dropdown/列表设置 popover: role 误判 + scope 缺失 | observe 把流程 dropdown 和列表设置 popover 都标记为 `tooltip`(非 menu/dropdown/popover);无 `# popover:` 元信息;无 `[behind-popover]` 标记;背景全部泄露;弹层 ref 与背景 ref 混在同一 namespace;无法从 ref 看出作用域归属 | experience (调用方需靠内文理解推断作用域,不可靠) | O-7, O-14 | 是(同 tab 重复 + 新 tab 复现) |
| A-2 | 流程 dropdown: tab 项目分类错误 + disabled 未表达 | 「流程布局」tab 被识别为 `i "questionmark"`(iconfont 字形误归类);7 个 tab 中 6 个都是 disabled,但 observe 没表达 disabled 状态,ref 全标 `[cursor=pointer]` 或无标记 | experience (act 在 disabled tab 上 success 但实际不触发,可能导致调用方误判) | O-7, O-8 | 是(同 tab) |
| A-3 | 跳转工作流配置 dialog: 召回严重不完整 + 主 dialog 漏掉 | 跳转触发 dialog 后 observe 出现 `# modal: dialog "dialog" (suppressed 112)` 但 dialog 内容只召回 1 个 close 按钮;真实 DOM 同时存在「帮助」dialog + 「工作流配置引导」820×770 主 dialog + 多个 drawer,observe 只识别第一个 dialog,漏掉主 dialog;「帮助」dialog 内"知道了"按钮也漏召回 | suspected-blocking (dialog 内容不可用,observe 在 dialog 内完全没有召回能力) | O-10, O-11, O-12 | 是(同 tab 重复 observe 都同样结果) |

> 整体裁决(仅观察,不做根因):
> - **模态作用域裁剪 `# modal:` 仅 1 个场景出现**:点「流程设置」tab 跳转触发真 dialog 时(vortex_act 返回 `dialogHit:[".el-dialog__wrapper", "[role='dialog']"]`),observe 输出顶部出现 `# modal: dialog "dialog" (suppressed 112 background elements)` —— 这是 vortex_observe 在「识别到 el-dialog 容器 + aria-modal=true + URL 跳转」三重条件下的裁剪行为。
> - **其他所有弹层场景(筛选 panel / 流程 dropdown / 列表设置 popover)** observe 都**没有 modal/popover scope 标记**,**背景全部泄露**,**弹层被误标为 `tooltip`**。
> - **observe 在 dialog 内的召回能力极弱**:即使 `# modal:` 标记出现,dialog 内容只召回最浅层 1 个按钮;真正有业务价值的 dialog「工作流配置引导」完全漏掉。
> - **嵌套浮层召回完整,但作用域丢失**:「添加筛选条件」dropdown 召回 11 listitem + 搜索框 ✅;但 ref 与背景混在同一个 namespace,无 popover scope。
> - **关闭恢复正确**:列表设置 popover 点「确定」后,observe 恢复背景全量 ✅;但因为整轮没观察到 popover scope 标记,只能验证 popover 节点从输出中移除,无法验证 scope 是否正确撤销。
> - **disabled 状态在 dropdown tab 上完全未表达**:真实 DOM 中 6/7 tab 都是 `.disabled cursor:not-allowed`,但 observe ref 全部标 `[cursor=pointer]` 或无,act 在 disabled tab 上返回 success 但可能未触发。
> - **brief 假设错误**:brief 假设「筛选」是 modal dialog,期望 observe 显示 `# modal:` 行 —— 实际筛选是工具栏内联展开 panel,无 modal overlay,observe 不需要做模态裁剪(返回 80/719 候选,背景完整是预期行为)。**这不是 vortex 缺陷,是 brief 与实现不一致**。

## 已试的非视觉路径

- `vortex_observe scope=viewport filter=interactive × 8`(工单表 / 筛选 panel / 嵌套 dropdown / 流程 dropdown / 跳转后 dialog / 列表设置 popover / 关闭后 / 多次重 observe)
- `vortex_observe scope=viewport filter=all × 1`(筛选 panel 状态下,验证是否有 `[behind-modal]` 标记)
- `vortex_query mode=geometry × 2`(找 dialog / drawer 容器;全部 bbox=0,0,0,0 occludedBy div.applet-left;此 mode 在本场景无信息)
- `vortex_query mode=css × 1`(找 `.filter-dialog / .el-dialog / [role=dialog]`;命中 63 个空 element)
- `vortex_evaluate × 11`(仅读 DOM 真值作 evidence:筛选真实 DOM / el-dialog 列表 / flow dropdown 真实结构 / modal 物理位置 / disabled 状态 / workflow-new-guide-modal 内容 / 嵌套浮层真实结构)
- `vortex_act click × 5`(筛选 / 嵌套 dropdown listitem / 流程 / 流程参数 tab / 流程设置 tab / 列表设置 / 确定)
- `vortex_wait_for idle × 2`(等待 dialog 内容加载)
- `vortex_tab_create × 2` + `vortex_tab_close × 2`(工单表 tab / 列表设置 popover tab,各自新 tab 零缓存漂移)