# Vortex 工具能力评估 — 观察报告

- **日期**: 2026-06-13
- **站点**: https://preview.pro.ant.design
- **目的**: 记录 vortex MCP 工具在 antd Pro 各典型组件/交互场景下的观察
- **原则**: 只记录观察 + 证据,不做根因诊断,不判断是 vortex 还是站点问题

## 观察记录

| # | task | action | call | raw | expected | actual | evidence | anomaly |
|---|------|--------|------|-----|----------|--------|----------|---------|
| 1a | 1-列表 | observe 列表页 ProTable 初始状态 | vortex_observe(scope=viewport, filter=interactive) | URL=https://preview.pro.ant.design/list/table-list/; 视口 2019x1325; 列表显示 20 行 checkbox(TradeCode 80-99) + 订阅警报 link,行末有"配置 订阅警报"操作,底部 li 1/2/3/4/5 + 下一页 + "20条/页" combobox; columns: 规则名称/描述/服务调用次数/状态/上次调度时间/操作;服务调用次数与上次调度时间 th 有 cursor=pointer | 看到完整列表 + 分页控件 | 看到列表 + 分页,但未直接显示 20 行行内文字(只显示 checkbox+订阅警报 link),需 extract/截图才能拿全量文本 | shots/01-list-initial.png | none |
| 1b | 1-列表 | 点 "服务调用次数" th 尝试排序 | vortex_act(target=@d17f:e30, action=click, observeEffect=true) | success=true; element=th 服务调用次数; effect={ariaChanged:true, domMutations:416, networkRequests:1, networkSample:["pro-api.ant-design-demo.workers.dev/api/rule"], toastHit:["[aria-live='polite']"], userFeedback:"toast"} | 触发排序,数据按调用次数升/降序 | observe 后 th 上加了 `sort:asc` 属性,网络请求已发;但 vortex_extract(tbody) 拿到的调用次数值为 666,317,361,393,332,514,196,41,797,545,377,266,471,592,287,887,688,843,225,26 万,看起来并非升序 | 见 raw(调用次数顺序) | none(仅记录 th 状态与数据值,未做归因) |
| 1c | 1-列表 | 滚动到分页 + 点 li "2" 翻页 | vortex_evaluate(window.scrollTo 底部) → vortex_observe → vortex_act(target=@ed99:e53 li"2", action=click, observeEffect=true) | click 成功; effect={ariaChanged:true, domMutations:256, networkRequests:1, networkSample:["pro-api.ant-design-demo.workers.dev/api/rule"], userFeedback:"toast"}; vortex_extract(tbody) 拉到 TradeCode 60-79(共 20 行) | 翻页到第 2 页,数据更新 | 翻页生效,行号 60-79 正确;x=1161, y=654 命中 li | shots/01-list-page2.png | none |
| 1d | 1-列表 | (副观察)同一浏览器两次 observe,视口从 2019x1325 变 1440x788;首次 observe 看到 20 行,后续 observe 看到约 10 行(部分行 y 出现负值) | vortex_observe scope=viewport | 第二次 observe scrollY=697/1485 状态下,vortex_observe ref=@ed99:e23 行 checkbox 标了 `y=-20`,说明视口外元素被列在快照里 | 视口固定,只报视口内 | 视口会变化,部分行 y 落在视口外但仍出现在 observe 树中 | (observe 片段,见 raw) | observe_miss(行 y 落在视口外仍被纳入 snapshot,无 scrollY 过滤) |
| 1e | 1-列表 | (副观察)在第二个浏览器实例上,直接 URL `?current=2` 不能进入第二页,需要点击 li 才会真正换页 | playwright_browser_navigate(url=...?current=2) | URL 变成 ?current=2,但表格仍显示第 1 页(80-99) | URL 参数应能初始化分页 | URL 参数未生效,只能通过点击 li 翻页 | shots/01-list-page2.png | other(可能 ProTable 初始化不读 URL search param) |
| 2a | 2-搜索 | fill 2 个字段(name, desc)并 submit | vortex_fill(@4008:e24, "TradeCode 0") + vortex_fill(@4008:e25, "desc0") | success=true focused=true; vortex_evaluate 读到 name="TradeCode 0", desc="desc0" | 字段填上 | 两个 input 都填上,值在 DOM 中 | shots/02-search-result.png | none |
| 2b | 2-搜索 | 点 查询 按钮 | vortex_act(@4008:e27, click, observeEffect=true) | effect={ariaChanged:false, domMutations:267, networkRequests:1, networkSample:["pro-api.ant-design-demo.workers.dev/api/rule"], toastHit:["[aria-live='polite']"], userFeedback:"toast"}; 之后 vortex_evaluate 拉到 .ant-message 当前 textContent=null,toast 已消失 | 触发查询,可能显示 toast 通知 | 触发查询,网络请求已发,行首变为 TradeCode 0(命中);toastHit 报告命中但查询瞬间 .ant-message 节点 textContent 为 null | shots/02-search-result.png | other(toastHit 报 `[aria-live='polite']` 但当时 .ant-message textContent=null,可能是 antd 内部 loading 状态,未确认是用户可读的 toast) |
| 2c | 2-搜索 | (副观察)查询按钮被点击后,按钮内出现 spinner,看起来是带 loading 态的查询;该 loading 节点本身是 aria-live=polite | vortex_observe + 视觉观察 | 按钮 text=查 询 且 Effect 触发 | 点击后立即出 loading toast | 查询按钮内出现 spinner,不是独立 .ant-message 提示 | shots/02-search-result.png | none |
| 3a | 3-弹窗 | 点 新建 按钮打开 Modal | vortex_act(@4008:e28, click, observeEffect=true) | dialogHit=[".ant-modal", "[role='dialog']"];vortex_evaluate 拿到 title="新建规则",body 含 3 个 input(1 隐藏 + name input + desc textarea),header=新建规则 | 打开 Modal 弹窗 | 成功打开;但 observe 时 hidden 那 1 个 input(无 id/placeholder,w=0,h=0)未出现在 interactive 过滤中(可能因为 visible=false 被过滤) | shots/03-modal-opened.png | none |
| 3b | 3-弹窗 | fill 弹窗内 name + desc 字段 | vortex_fill(@67ad:e45, "TestRule_001") + vortex_fill(@67ad:e46, "modal desc test") | Error [TIMEOUT]: Actionability timeout after 2000ms; last reason: OBSCURED;增加 force=true 仍 OBSCURED;再 wait_for idle 也 OBSCURED | 字段填上 | vortex_fill 在 Modal #name/#desc 上连续 OBSCURED;ref 解析后目标 selector 解析为 #name,DOM 中同时存在 2 个 #name(页面+弹窗) | (见 raw 错误) | ref_or_coord_fail(obs:Actionability OBSCURED;ref 翻译后 selector `#name` 在 DOM 中匹配 2 个元素,click 中心点 hit 的是 ant-modal-container,不是 input) |
| 3c | 3-弹窗 | 用 vortex_evaluate 通过 React 受控 setValue 注入 | vortex_evaluate(setter + dispatchEvent input/change) | 返回 {value:"TestRule_001"} / {value:"modal desc test"} | 字段填上 | 绕开 OBSCURED,值成功注入 | (evaluate 返回值) | none(workaround,主路径未走通) |
| 3d | 3-弹窗 | 点 确定 提交 | vortex_act(@67ad:e48, click, observeEffect=true) | effect={dialogHit:[], networkRequests:2, networkSample:["pro-api.ant-design-demo.workers.dev/api/rule"], toastHit:[".ant-message","[aria-live='polite']"]};vortex_evaluate 之后 modals 1 个但 visible=false(wrapper 加了 .ant-drawer-content-wrapper-hidden);desc 字段 className 多了 `ant-input-status-success` | 提交并关闭 | submit 网络请求已发(2 个,1 POST + 1 GET 列表),模态容器被标记为 hidden(desc 校验成功);toastHit 报 .ant-message,但同 frame 内 .ant-message textContent 为空 | (见 raw) | other(toastHit 命中但 .ant-message 节点 textContent 为空,可能是 success 静默提示) |
| 3e | 3-弹窗 | (副观察)Modal 关闭后,modal 元素仍留在 DOM 中但加了 hidden 类,querySelectorAll('.ant-modal') 仍返回 1 条 | vortex_evaluate | {modalCount:1, visibleModals:0} | DOM 清理 | Modal 节点被复用/未卸载,只是 hidden | (见 raw) | none |
| 4a | 4-抽屉 | 找 Drawer:在 admin/sub-page 右上角点 setting 齿轮 | vortex_act(@50eb:e45 img setting, click) | effect={dialogHit:[".ant-drawer", "[role='dialog']"]} | 打开 Drawer | 打开右侧 Drawer(ant-pro-setting-drawer),含 8 个 switch + combobox + "拷贝设置" 按钮 + 主题色 radio | shots/04-drawer-opened.png | none |
| 4b | 4-抽屉 | Drawer 内部交互:点一个 switch | vortex_act(@20c6:e32 switch, click) | effect={ariaChanged:true, dialogHit:[".ant-drawer", "[role='dialog']"]} | switch 切换 | 切了;vortex_evaluate 前后比对:第一个 switch 从 unchecked 变 checked | shots/04-drawer-opened.png | none |
| 4c | 4-抽屉 | 关闭 Drawer:点 close img(X) | vortex_act(@20c6:e43 img close, click) | Error [TIMEOUT]: Actionability timeout after 2000ms; last reason: OBSCURED | X 关闭 | 同样 OBSCURED;改用 vortex_press(Escape) 后 .ant-drawer-content-wrapper 加了 hidden class,Drawer 关闭动画开始 | (见 raw 错误) | ref_or_coord_fail(X img 触发 OBSCURED;Escape 路径可关) |
| 5a | 5-浮层 | DatePicker:基础表单上"起止日期"打开面板 → 选 15 → 选 21 → Esc | vortex_act(@5ba5:e24, click) → vortex_evaluate(.ant-picker-cell-in-view[14].click) → vortex_evaluate(cells[20].click) → vortex_press(Escape) | 面板出现 61 cells(双月),选完后 basic_date="2026-06-15",另一 input="2026-06-21",panelVisible=false | 选择区间 | 区间被写入,面板关闭 | (evaluate 读到的 input value) | none |
| 5b | 5-浮层 | Select:高级表单"仓库管理员"打开下拉 → 选"付晓晓" | vortex_act(@4451:e25 combobox 仓库管理员, click) → observe → vortex_act(@9446:e50 div 付晓晓, click) | click 成功;vortex_evaluate 显示该 .ant-select 节点加了 `ant-select-status-success`,contentValue="付晓晓" | 选中 | 选中成功,类名带 status-success | (evaluate 读到的 .ant-select-content-value) | none |
| 5c | 5-浮层 | 状态 Select:查询表格展开后"状态" combobox 打开 → 选"已上线" | vortex_evaluate(点 a 展开) → vortex_act(@f3bd:e27 combobox 状态, click) → vortex_evaluate(点 .ant-select-item "已上线") | 下拉 4 个 item(关闭/运行中/已上线/异常);选中后 .ant-select-selection-item[0]="已上线" | 选中 | 选中成功 | (evaluate 读到的 selectedText) | none |
| 5d | 5-浮层 | TreeSelect / Cascader:在下列页面均未发现 .ant-tree-select 或 .ant-cascader-picker | vortex_evaluate 在 /form/basic-form、/form/step-form、/form/advanced-form、/list/search/articles、/list/search/projects、/list/search/applications、/list/table-list、/list/basic-list、/account/settings、/account/center、/profile/basic、/profile/advanced、/welcome、/result/success、/exception/403、/admin/sub-page 多次查询 | cascader=0, treeSelect=0 全部 0 | 应能找到一个 Cascader / TreeSelect | 全部页面 0 个 ant-cascader-picker 和 0 个 ant-tree-select | (evaluate 输出) | none(覆盖项缺失,作为观察记录) |
| 6a | 6-行内 | 点行"更多"打开 dropdown → 点"删除" | vortex_act(@5de2:e56 a 更多, click) → vortex_act(@7ea1:e55 li 删除, click) | 更多点击后 effect={ariaChanged:true};删除点击后 effect={dialogHit:[".ant-modal", "[role='dialog']"]} | Popconfirm 弹气泡 | 弹的是 ant-modal,标题"删除任务",body="确定删除该任务吗?",按钮 取 消/确 认(非 Popconfirm 弹泡) | shots/06-delete-confirm.png | none(但不是 Popconfirm) |
| 6b | 6-行内 | (副观察)此处确认是 Modal 实现,无 .ant-popover 出现 | vortex_evaluate | {isPopconfirm: false, modal title:"删除任务"} | 期望 Popconfirm | 实际 Modal | shots/06-delete-confirm.png | other(站点实现是 Modal.confirm,非 antd Popconfirm) |
| 6c | 6-行内 | 取消息消 → 行被保留 | vortex_press(Escape) | modal hidden | 取消删除 | modalVisible 变 false | (见 raw) | none |
| 7a | 7-分步 | 步骤 1(填写转账信息)→ 点 下一步 | vortex_act(@4f8e:e33 button 下一步, click) | 步骤状态:填写转账信息=finish,确认转账信息=process,完成=wait;formItems 切换为 [付款账户, 收款人姓名, 转账金额, 支付密码] | 步骤推进 | 步骤推进到第 2 步 | shots/07-step1.png | none |
| 7b | 7-分步 | 步骤 2:fill 支付密码 → 点 下一步 | vortex_fill(@4970:e24 支付密码, "testpwd") → vortex_act(@4970:e26 下一步, click) | 步骤状态变为 [finish, finish, process];页面文案 "操作成功 预计两小时内到账";按钮变为 "再转一笔" / "查看账单" | 步骤推进 | 步骤推进到第 3 步(完成) | (evaluate 读到的 steps + mainText) | none |
| 7c | 7-分步 | (副观察)步骤切换时 formItems 完全替换;步骤 1 不需要填表也能 下一步(因默认有值) | vortex_evaluate 步骤切换前后 | formItems 数组从 [付款账户, 收款账户, test@example.com, 收款人姓名, 转账金额] 变为 [付款账户, 收款人姓名, 转账金额, 支付密码] | 步骤独立表单 | 步骤独立,各步骤 form 数据独立 | (见 raw) | none |
| 8a | 8-杂项 | Radio:基础表单"目标公开" Radio.Group | vortex_act(@50eb:e35 label 不公开, click) | ariaChanged=true;vortex_evaluate 读 [.ant-radio-wrapper] 3 项,checked 状态 [false, false, true] | 选 radio | 选 不公开 成功 | (evaluate) | none |
| 8b | 8-杂项 | Switch:账户设置/新消息通知 标签 → 3 个 switch | vortex_act(@8f45:e24 li 新消息通知, click) → vortex_act(@8f45:e25 switch 1, click) | ariaChanged=true;vortex_evaluate 读到 [false, true, true](原 [true, true, true]) | 切 switch | 第一个 switch 从 on 切到 off | (evaluate) | none |
| 8c | 8-杂项 | Switch(另一处):admin 右上角 setting 抽屉中 8 个 switch | vortex_act(@50eb:e45, click 打开 Drawer) → vortex_act(@81ce:e26 switch, click) | ariaChanged=true | 切 switch | 切了 | shots/04-drawer-opened.png | none |
| 8d | 8-杂项 | Upload:账户设置"更换头像" 按钮 | vortex_act(@8b0e:e39 button 更换头像, click) | effect={ariaChanged:false, domMutations:11, focusChanged:true};vortex_evaluate 拿到 1 个 input[type=file] (name=file, multiple=false, accept="") | 触发 file input | 触发成功,DOM 中出现 file input | (evaluate) | none |
| 8e | 8-杂项 | Checkbox:查询表格表头 "Select all" + 20 行 checkbox | vortex_evaluate(点 Select all input.click) | selectAllChecked=true;rowsChecked=20/20 | 全选 | 20 行 checkbox 全部 checked | (evaluate) | none |
| 8f | 8-杂项 | Checkbox group:站点各页未发现 .ant-checkbox-group / .ant-checkbox-group-wrapper | vortex_evaluate 全站扫 | checkbox=0 在所有标准页 | 找到 checkbox group | 未发现 form-style checkbox group(只有 table row checkbox) | (evaluate) | none(覆盖项缺失,作为观察记录) |

## 覆盖 & 异常概览

- 覆盖 8 项清单中每一项(其中 5d/8f 注明 TreeSelect / Cascader / Checkbox group 在该 antd pro 演示站的所有标准页均未发现对应组件,作为覆盖项缺失的观察)。
- 实际写入报告的观察行共 32 条;anomaly 分布:
  - `none`:25 条
  - `ref_or_coord_fail`:2 条(3b Modal 内的 #name/#desc vortex_fill OBSCURED;4c Drawer close X 同样 OBSCURED)
  - `observe_miss`:1 条(1d observe 树包含 y 落在视口外的元素)
  - `other`:4 条(1e URL `?current=2` 不能让 ProTable 初始化到第 2 页;2b / 3d toastHit 命中但 .ant-message textContent 为空;6b 删除是 Modal 而非 Popconfirm)
  - 另有 2 条 5d/8f 用 `none` 标注,作为"覆盖项缺失"的观察,不是工具异常

## 证据文件

所有截图均落在 `reports/dogfood-antd-pro-2026-06-13/shots/`:

- `01-list-initial.png` — ProTable 首页(20 行 + 分页)
- `01-list-page2.png` — 翻到第 2 页(60-79)
- `02-search-result.png` — 搜索/筛选结果(1 条 TradeCode 0)
- `03-modal-opened.png` — 新建规则 Modal
- `04-drawer-opened.png` — 设置 Drawer(switches + 主题色 + 导航模式)
- `06-delete-confirm.png` — 删除任务确认(Modal 而非 Popconfirm)
- `07-step1.png` — 分步表单第 1 步
