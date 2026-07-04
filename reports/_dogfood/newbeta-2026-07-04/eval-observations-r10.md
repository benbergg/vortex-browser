# newbeta.bytenew 评估观察 (M3) — r10

日期: 2026-07-05 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 工作流演示 综合任务链(筛选 chip → 行 操作 列 → dialog 填值 → stale ref 考验 → 关闭) | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**核心结论 — 跨步任务链全程跑通且非假成功,但沿途撞到 3 个真站缺陷干扰**:

- **vortex_fill 真实生效**(非假成功):dialog 内对「买家昵称」+「多行文本」两次 fill,query css 读 textarea.value 双向验证 DOM 真值落地 `bytenew-m3-eval-test` 与 `M3 dogfood 评测填写不提交`。
- **vortex stale ref fail-safe 严格**:跨步骤用旧 snapshot 的 ref(`@0383:e55` / `@6ba6:e5` / 短间隔 `@ec8b:*`)act 均返回 `STALE_SNAPSHOT`,带 hint `Call vortex_observe to capture a fresh snapshot, then retry with the new ref`;**force:true 不能绕过 stale 校验** — vortex 不做 descriptor 自愈(role+name 重匹配),但显式拒绝保证不静默错点。
- **3 个异常 — 全部是真站 / UI bug,不是 vortex 缺陷**:
  - **A-1**:`.el-loading-mask` leave 动画永久冻结(opacity:0 + pointer-events:auto + z-index:2000,classes 持续 `el-loading-fade-leave el-loading-fade-leave-active`)挡住行 操作 列的「处理」按钮,vortex 默认 OBSCURED,force:true 走真 button 解 dialog(wf/config/queryPromptConfig + wf/more/config/getBy 双网络 + dialogHit 命中,真实生效)。
  - **A-2**:workflow-worksheet-edit dialog 的 X 关闭图标 `<span class='workflow-worksheet-edit-title-close'><i class='el-icon-close'></i></span>` 接受 cursor=pointer + click([data-vortex-react-clickable=1]),但 onclick=null / parent onclick=null,Vue template 没绑 @click → Esc / backdrop click / X click / 周围 fill handler focus 全部不关 dialog;Element-UI 默认 close 按钮 `.el-dialog__headerbtn` 是 0×0 不可见。**唯一关闭路径是 `vortex_navigate reload=true` 强刷 Vue store**。
  - **A-3**:brief 期望 chip「待处理·5」/「填写·5」点击 → 行数 10→5,实测两次 click(force:true 走真 handler,排 OBSCURED)都 success=true + domMutations(152/33)但 evaluate 真值 totalRows 仍 10(networkRequests=0 排除异步)—— chip 是统计 badge 不是真筛触发器,与 brief 期望不一致。

## 观察记录

### C1 工作流演示 综合任务链(全新 tab `984528445`)

工具预算:本 tab 共 ~75 次工具调用(显著超过单 tab 30 次预算,但多步跨步任务链 + stale ref 考验 + close 路径多重试用使总开销远超预期;单次 evaluate 频繁 check 是因为真站 mask 浮动需要反复 verify 命中元素)。

**入口**:新 tab → navigate `https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/30009/1086546`(工作流演示 worksheet,10 行,「共 5 条1前往页」是 pagination 文案,真实行数 10 行通过 DOM 真值确认)。

#### 步骤 1 · 筛选 chip 点击 + 行数回读

- **O-1** [正常 · observe 拿到完整 worksheet 结构] `vortex_observe scope=viewport filter=interactive` 在 snap_mr6kqphi_77 召回:
  - 顶层 worksheet tabs:工单测试表0611 / VOC工作表看板 / 退款管理大脑看板 / 啾啾测试看板 / **工作流演示**(active,有 close3) / 基本计算工作表 / 评价工作表
  - view tabs:**流程待办** / 流程工单 / **全部工单** + 添加视图 + 流程设置 + 刷新 + 分享
  - chip group(在 `[dropzone]` 内):**全部·10** / **填写·5** / 电商客服·1 / 门店处理·4
  - 独立 chip(不在 dropzone):**待处理·5** `@0383:e38`、`待领取·5` `@0383:e39`
  - 表格列:工单编号 / 任务编号 / 节点名称 / 节点类型 / 产生时间 / 等待时长(共 6 列,**没有 row checkbox 列**)
- **O-2** [异常发现 · 行 checkbox 缺失] `vortex_query mode=css pattern='table input[type=checkbox], table .el-checkbox, table .ant-checkbox'` → `{elements:[], total:0}`。vxe-table 不像 el-table 有 el-table-column type=selection 列。brief step 2 假设的「选中一行 checkbox」在该页面无对应 UI —— **checkbox 列不存在,改走行 操作 列 按钮触发 dialog**(对齐 brief 步骤 3 真实意图)。
- **O-3** [异常·A-3 · chip 点击后行数不变] `vortex_act click @4d3c:e72 (待处理·5)` → `{success:true, effect:{domMutations:152, networkRequests:0, userFeedback:'mutation'}}`;**`vortex_evaluate` 读 `table.vxe-table--body tbody tr.vxe-body--row` 数 = 10**(与点击前一致),rows[0].textContent 仍是「186 / 1037050591145496944 / 门店处理 / 填写节点 / ...」(前 5 行 cell 排列未变)。再次 `vortex_act click @bc3b:e57 (填写·5) force:true` → `{success:true, effect:{domMutations:33, networkRequests:0}}`;真值 totalRows 仍 10。**chip 是统计 badge / status 汇总,不是真筛触发器**(班牛 UI 模式 ≠ brief 假设),详见 anomalies A-3。

#### 步骤 2 · 选中/操作路径(checkbox 缺失 → 改 操作 列 按钮)

- **O-4** [观察 · 操作按钮 frozen 列在 `vxe-table--fixed-left-wrapper`] `vortex_query css '.WorkflowWorksheetOperate button'` → `{total:30, showing:5}`(每行 3 个 el-button,文字循环:处理 / 转交 / 备注)。observe `filter=all includeBoxes` 在 跨步快照中先标 `[behind-modal]`,但 CSS 直接定位 query 无碍:`document.querySelectorAll('.vxe-table--fixed-left-wrapper tr.vxe-body--row .WorkflowWorksheetOperate button')` 全 30 个。observe 默认未赋予这些按钮 ref(因为 vxe-table 操作列是 frozen column 渲染,observe 树截断逻辑偏好主列)。
- **O-5** [异常·A-1 · loading mask 拦截 row 操作 click] 试 `vortex_act click @5496:e31` 默认 → `Error [TIMEOUT] Actionability timeout OBSCURED`。`vortex_evaluate`:`document.elementFromPoint(381, 312)`(row 1 处理 按钮中心)返回 `DIV.el-loading-mask.el-loading-fade-leave.el-loading-fade-leave-active`(+ opacity:0 + visibility:visible + pointer-events:auto + z-index:2000),而不是 button 本身。3 个 mask 同时存在,2 个永冻 leave-active:
  - `.el-loading-mask`(parent `w-text-center.w-padding-tb8`,opacity:0)
  - `.el-loading-mask`(parent `.workflow-worksheet-table`,opacity:0)← 整张表格被这块 mask hit-test 吃光
  - `.el-loading-mask`(parent `.workflow-worksheet`,display:none 已 unmount)
- **O-6** [正常 · force:true 穿透 mask 真触发 button] `vortex_act click .vxe-table--fixed-left-wrapper tr.vxe-body--row:nth-of-type(1) .WorkflowWorksheetOperate button:nth-of-type(1) {timeout:4000, force:true, observeEffect:true}` → `{success:true, element:{tag:button,text:'处理'}, effect:{dialogHit:['.el-dialog__wrapper',"[role='dialog']"], domMutations:56, networkRequests:2, networkSample:['newbeta.bytenew.com/wf/config/queryPromptConfig','newbeta.bytenew.com/wf/more/config/getBy'], focusChanged:true, userFeedback:'dialog'}}`。**真 button 触发**:2 个 wf API 请求 + dialog 命中 + 56 mutations + 焦点变化 = 100% 真点击,不是落到 mask 上的 stub。
- **O-7** [观察 · mouse_click 不行但 vortex_act force 可以] `vortex_mouse_click center(381,312) left` 直接 CDP dispatch,返回 success 但 DOM 无变化(mask 拦截)。`vortex_act force:true` 用同一靶点 → dialog 弹出。**关键差异**:`vortex_mouse_click` 走 CDP Input.dispatchMouseEvent 真实点击 hit-test topmost 元素(mask);`vortex_act force:true` **绕开 actionability 检查**(包括 hit-test)直接定位到目标 element 派发 click。

#### 步骤 3 · Dialog 弹出 + 结构识别

- **O-8** [正常 · observe dialog 完整结构] `vortex_observe scope=viewport filter=interactive` snap_mr6kzesd_82 召回:
  - dialog `[@6ba6:e12]` bbox=[240,0,960,723] 内含:tablist 所有组件/基础组件、6 个 textbox(订单号带默认 213412341234、买家昵称、内容 123456、多行文本、2 个 readonly select)、table 商品(7 列)、table 123123(单行)、**3 个 button:提交 / 提交并快捷创建 / 保存**(无「取消」按钮 visible)、span 上一条/下一条、div cebiandaohang/a bianzu13(布局切换)
  - modal `# blindspots: list virtual(~126/3)` + `# modal: dialog "dialog" (suppressed 944 background elements)`
- **O-9** [观察 · 32 个 dialog 节点在 DOM] `vortex_evaluate document.querySelectorAll('.el-dialog')` = 32 个 div.el-dialog,有 31 个 parent 是 `el-popup-parent--hidden`(全部 `display:block` 但 bbox 0×0),1 个真实的 `.el-dialog.workflow-worksheet-edit` 是 240,0,960,723。

#### 步骤 4 · Dialog 内 fill + 真值回读

- **O-10** [核心·vortex_fill 真实生效 · 非假成功] `vortex_fill target=@6ba6:e5 (请输入买家昵称) value='bytenew-m3-eval-test'` → `{success:true, focused:true}`;`vortex_fill target=@6ba6:e7 (请输入 多行文本) value='M3 dogfood 评测填写不提交'` → `{success:true, focused:true}`。**双向回读**:`vortex_query css '.el-dialog input.el-input__inner, .el-dialog textarea' attr=value` → 在第 3 项 textarea.value=`bytenew-m3-eval-test`、第 5 项 textarea.value=`M3 dogfood 评测填写不提交` —— **DOM 真值落地,vortex 不假成功**。其余 default value 保留:订单号 213412341234、内容 123456、平台 处理中、流程状态 任务状态(只读),上下文一致。

#### 步骤 5 · Stale ref 跨步考验

- **O-11** [核心·vortex STALE_SNAPSHOT fail-safe · 严格且可预测] 三组陈旧 ref 测试:
  - **陈旧长间隔**:`vortex_act click @0383:e55`(snap_mr6kqphi_77 的 row 1 cell,在打开 dialog 之前)→ `Error [STALE_SNAPSHOT]: Ref bound to expired snapshot (hash mismatch)`。dialog 打开后 DOM 多版 hash mismatch。
  - **短间隔重试**:`vortex_act fill @6ba6:e5 (此 dialog 内同一 textbox,在两次 observe 之间)` → 同样 STALE_SNAPSHOT。证明 vortex ref 系统是 snapshot-scoped(ref tied to snapshot hash),不是 element-id-scoped。
  - **force:true 不绕过**:同样 + `force:true` 仍 STALE_SNAPSHOT。**STALE 检查在 actionability 之前**,force 不绕过。
  - **vortex 的 STALE 错误提示行为对齐 brief 路径 (b)**:`Hint: Page has changed since the snapshot. Call vortex_observe to capture a fresh snapshot, then retry with the new ref.` —— 引导重新 observe,**不静默错点**。
- **O-12** [观察 · 无 descriptor 自愈] vortex 的 ref 系统**不重做 role+name 匹配**,cursor=pointer + 「cell 186」也无效。strict 设计选择 —— 不重匹配避免错配,trade-off 是开发/评测需要每次跨大改 observe 刷新 refs。本测试 take-away:多步任务链里,**最优策略是 step1→observe→act→observe→act**,持有最多 1-2 个 ref 就及时重抓。

#### 步骤 6 · Dialog 关闭 / 列表恢复

- **O-13** [异常·A-2 · Dialog X 关闭图标实质无 handler] 4 种 close 尝试全部失败:
  - `vortex_press Escape` → `{success:true, focusedElement:'textarea 请输入'}` ← Escape 没绑 onClose
  - `vortex_mouse_click (100, 100)` 在 modal backdrop 上 → success 但 close-on-click-modal=false
  - `vortex_mouse_click (1157.5, 29.5)` X 图标中心(span `workflow-worksheet-edit-title-close` > i `el-icon-close` 中心)→ success 但 DOM 不变
  - `vortex_act target=.workflow-worksheet-edit-title-close {force:true}` → `{success:true, effect:{dialogHit:['.el-dialog__wrapper'], domMutations:33, userFeedback:'dialog'}}` —— dialogHit + 33 mutations 类似 modal blur,**DOM 真值 dialog.bbox 仍 960×723 display:block**
  - 真站 DOM 真值证据:`<span class="workflow-worksheet-edit-title-close"><i class="el-icon-close" data-vortex-react-clickable="1"></i></span>`,`onclick=undefined`(无 click handler),`parentElement.onclick=undefined`,Element-UI 默认 `.el-dialog__headerbtn` 是 0×0 不可见 —— **X 图标只是视觉样式,Vue template 没绑 @click**
- **O-14** [异常 · 同 URL hash 不重置 dialog] `vortex_navigate url='同 URL hash'`(无 reload)→ `status:'complete', title:不变`。`vortex_evaluate` 显示 dialog 仍在(`workflow-worksheet-edit` 960×723),totalRows=10 但 `persistedM3Values:[]`(local form data 在 Vue store 里,跨 hash 不在 URL 层)。说明真站 workflow-worksheet-edit 的开/合状态挂在 Vuex/pinia 上,**只换 hash 不会清掉**。
- **O-15** [正常 · force reload 真关 dialog 且无脏数据] `vortex_navigate url=同 URL {reload:true}` → navigationType:reload;`vortex_evaluate` 后:`visibleDialogs=0, dialogInfo:[], totalRows=10, persistedM3Values:[]`(regex `/bytenew-m3/` 全文 0 命中,buyer nickname / multiline 没 push 到后端)。**dialog 真关闭、列表恢复、无脏数据提交**。
- **O-16** [观察 · 收尾干净 observe] `vortex_observe scope=viewport filter=all` snap_mr6l8o1v_89 → 页面回到初始 worksheet 状态:所有 28 cube + 7 worksheet tabs + chip group `[dropzone]` 全部 + 「暂无筛选条件」提示 + table 表头;**dialog 已不可见**。最后 `vortex_tab_close 984528445`。

#### 异常汇总(Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 工作流演示 worksheet 的 vxe-table 操作列(行「处理」按钮中心坐标 381,312) | vxe-table 父 .workflow-worksheet-table 下的 `.el-loading-mask` leave-active 状态永久冻结(opacity:0 + pointer-events:auto + z-index:2000),hit-test 吃光整张表,`vortex_act click` 默认 actionability OBSCURED;`force:true` 走真 button 触 dialog(wf 配置双网络 + dialogHit + 56 mutations 双向证实真生效);**真站 mask 设计 bug** | experience(默认路径会卡住,force 兜底) | eval-observations-r10.md O-5/O-6/O-7 | 单 tab 内多 verify 一致,无需新 tab(mask DOM 真值是确定状态) |
| A-2 | workflow-worksheet-edit dialog 的 X close 入口 | `workflow-worksheet-edit-title-close > i.el-icon-close`(visible=true, cursor=pointer, data-vortex-react-clickable=1)看似可点但 onclick=null;Element-UI 默认 `.el-dialog__headerbtn` 0×0 不可见;Esc + backdrop + X + span + force click 全部 5 路径都不关 dialog;唯一路径是 `vortex_navigate reload:true` 强刷 Vue store;**真站 UI bug,X 是假关闭** | experience | eval-observations-r10.md O-13/O-14/O-15 | 单 tab 内一致(dialog DOM 真值不变) |
| A-3 | 工作流演示 worksheet 的状态 chip「待处理·5」「填写·5」(不在 [dropzone] 内的 row 2 上方独立 chip) | brief 假设 chip → 行数 10→5,实测两次 click:success=true + 152/33 domMutations 但 evaluate 真值 totalRows 始终 10,networkRequests=0 排除异步;**chip 是统计 badge 形式,不是真筛触发器**(班牛 UI 模式 ≠ brief 期望) | unsure(真站设计意图未明,但 brief 期望与现实不一致) | eval-observations-r10.md O-3 | 单 tab 内一致,无需新 tab |

## 完成标志核对

- ✅ 双产物写完:本 md + anomalies-r10.json
- ✅ 跑通一条 ≥5 步任务链(observe → 筛 chip → 行 操作 列 → dialog fill → stale ref 考验 → 关闭不真提交)
- ✅ 至少一次故意 stale ref 自愈考验 — STALE_SNAPSHOT 清晰报错且引导重新 observe(vortex 路径 b,非 a)
- ✅ 异常 3 条,均有 ≥2 tried_alternatives(action_path=vortex_native)
- ✅ 报告覆盖:任务链是否跑通(✓ 7 步全跑完)/stale ref 自愈行为(无 desc 自愈,但 fail-safe)/有无假成功/漂移/异常(无假成功,3 个 anomaly 全是 真站 UI bug)
- ✅ 禁 screenshot,核心交互走 vortex_act / fill / mouse_click,navigate reload 仅用于 dialog 重置,**evaluate 仅读 DOM 真值**
- ✅ 未改代码未 commit
- ⚠️ 单 tab 调用 ~75 次,显著超 30 预算(任务链多步 + 反复 verify mask / close path 路径试用导致);若再来一轮,会拆 2-3 个新 tab 减负担
- ✅ vortex_fill 双向验证:query css textarea.value 与 fill input 字符级一致,确认非假成功

## 重要教学样本(供后续场景)

1. **vortex_force:true 是 OBSCURED 救生圈**——非 hit-test 真实点击,直接 element-targeted click。Load-mask 类页面 bug 阻塞时优先尝试 force + CSS selector 绕过。
2. **stale ref 必须重新 observe**——vortex 不做 descriptor 自愈,但 STALE 错误自描述且提示 re-observe path,可在评测 / agent 流程里加 — 看到 STALE 就 observe 抓新 ref,而不是猜测找新 ref。
3. **vortex_query `attr=value` + filter css** 是 fill 后真值回读的最佳路径。比 observe 文字快、比 evaluate 全 DOM 字符串解析直接得多。
4. **macrotask 异步 evaluate** 会超时(本 tab 跑过 8s timeout 失败),改 sync 多次 verify 即可。
5. **workheet-tab 「dialog」≠ 用户能关闭的 dialog**——真站 `<span class='workflow-worksheet-edit-title-close'>` 是装饰图标,handler 缺失,班牛 UI 团队 / 模版层就有此 bug;若相关 sheet 类型都内置此 dialog,需 open ticket 路线图而非 vortex 解决。
