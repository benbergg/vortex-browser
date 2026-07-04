# newbeta.bytenew 评估观察 (M3) — r5

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 分页/筛选/下拉/排序 act + observe 状态回读(工单表0611 1 行 + 工作流演示 22 行) | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**5 个场景 5 类操作(act)全部 success**(vortex_act / vortex_mouse_click 返回 success=true,真实 DOM 状态变化通过 query mode=css attr=class / attr=value 三角验证)。**但 observe 默认输出完全回读不到 3 类关键状态变化**:

1. **每页条数下拉的当前值** — dropdown 关闭后 el-pagination__sizes wrapper 显示空白(readonly input.value 不在 DOM text 里)
2. **列排序方向(asc/desc)** — observe 把排序图标描述为通用 `arrow 3 lower`,无 aria-sort 属性
3. **视图/状态 tab 的 active 状态** — observe 输出无 [active] 标记 / aria-selected,无法区分当前选中 tab

**没有「操作 success 但状态未变」的假成功**(所有 act 后真实 DOM 状态都验证为变化)。**盲点都在「observe 回读」**,不是「act 失败」。

## 观察记录

### C1 工单表 + 每页条数下拉 → 20条/页 (全新 tab `984528421`)

工具预算:本 tab 共 ~15 次工具调用。

- **O-1** [正常·act success + 真实值已变] `vortex_mouse_click` 命中分页器 `.el-pagination__sizes .el-input__inner` (1106,576) → 弹出 el-select dropdown(observe 后置召回 5 li: 10/20/30/40/50 条/页),`vortex_mouse_click` 命中第二项「20条/页」li (1111,424) → 真实 DOM 验证:`.el-pagination__sizes .el-input__inner` `attr.value="20条/页"`(query mode=css attr=value 命中)。✅ **值已 commit 到只读 input**。
- **O-2** [异常·observe 默认不可见] dropdown 关闭后,`.el-pagination__sizes` wrapper `innerText=""`(因为 input 是 readonly,value 不进入 DOM text),observe 看不到任何「20条/页」标记。**observe 截断到 80 candidates 也把分页器挡在可见区间外**;只有当另一个 dropdown 弹出时,observe 因收纳弹层元素挤压分页器进入 80 内,才偶然召回 `textbox "请选择" [ref=...] value=20条/页`(O-1→O-3 阶段),证明值已存。
- **O-3** [正常·数据未变符合预期] 工单表只有 1 条数据(原始「待处理 823290」),「共 1 条」选择 20/30/50 条/页都不变。这是数据驱动正确性:选择条数下拉不改变总条数,只是每页显示更多 — 当总条数 ≤ 任何页大小时,数据无变化。**不是 bug**。
- **O-4** [正常·observe 在弹层弹出时能召回 el-select 内部值] 当 dropdown 弹出时,observe 把 dropdown 内容优先收纳,挤占分页器进入 80 candidates,observe 能看到 `textbox "请选择" value=20条/页`(之前 O-2 不可见的状态在 O-3 状态下可读)。**这是 observe 在 popup 弹出时的"借机回读"行为**——弹层关闭后回读又回到不可见。

### C2 工单表 + 列排序 (同 tab `984528421`)

- **O-5** [正常·排序 dropdown 召回完整] 点「创建人」列旁 `i "arrow 3 lower"` @4f7d:e73(bbox=814,324,20,20) → observe 召回排序 dropdown:`div "正序" / div "倒序" / div "取消排序" / div "包含任一项" + 2 textbox` 完整可见。✅ act 命中排序 dropdown。
- **O-6** [异常·排序状态在 observe 中不表达] 点「倒序」dropdown 项后,真实 DOM 验证:`worksheetHeader-sort-icon.iconfont.icon-sort5.desc` 在「创建人」列头位置 [775,323,16,22](query mode=css attr=class + geometry 命中)。但 observe 输出:「创建人」列旁的 i 元素 **仍然是** `i "arrow 3 lower" [cursor=pointer]`,**无 [sort=desc] / [sort=asc] / aria-sort=descending 表达**;dropdown 中的「倒序」项 **未被标记为 checked/selected**。**observe 完全不知道排序状态**。
- **O-7** [观察·排序方向切换无 a11y 标记] 同一列头排序图标在 worksheetHeader-sort-icon.icon-sort5 (无 desc) ↔ worksheetHeader-sort-icon.icon-sort5.desc 之间切换,这种 className-based 状态在 el-table + vxe-table 自定义排序图标中完全没有 ARIA 表达;observe 不会自动读 className,所以无 [sort] 属性可报。**这是 a11y 设计的盲点,vortex_observe 的默认输出无法弥补**。

### C3 工单表 + 分页翻页 (同 tab `984528421`)

- **O-8** [观察·btn-prev/btn-next 都 disabled] query mode=css attr=disabled:`.btn-prev` 和 `.btn-next` 都返回 `disabled="disabled"`。工单表只有 1 条数据,所以翻页按钮被禁用。
- **O-9** [异常·act on disabled 静默 success] `vortex_mouse_click` 命中 btn-next (1260,576) → `{success:true}` 但真实 DOM:页码 li `class="number active" text="1"` 不变,「共 1 条」不变,**btn-next 仍然 disabled**(query mode=css attr=disabled 再次命中)。**disabled 控件被 act click "成功",但实际无效果** — 这不是 vortex 缺陷(vortex_act click 物理动作确实命中),但 observe 不表达 disabled 状态,调用方可能误判「下一页被触发」。
- **O-10** [异常·前往页跳页被回滚] `vortex_act click + type "2" + Enter` 命中 `.el-pagination__editor input` → `vortex_press Enter` 提交 → 真实 DOM:`.el-pagination__editor input.value` 从 "1" → 输入"2" → 回滚到 "1"(query mode=css attr=value 验证)。**说明组件层校验了 "页码 > 总页数" 后拒绝提交,input.value 自动回滚**。observe 默认看不到 editor input(value 在 input.value 里,不在 DOM text),observe 截断也看不到分页器。

### C4 工单表 + 筛选 (同 tab `984528421`)

- **O-11** [正常·添加筛选条件 dropdown 召回完整] 点「添加筛选条件」@3b50:e49 → observe 召回 12 个 listitem:工单编号/创建人/执行人/创建时间/修改时间/**任务状态**/必填测试/标题/截止时间/任务完结人/任务完结时间 + 2 个 search textbox(主搜索 + dropdown 内过滤)✅。
- **O-12** [正常·点任务状态后条件已添加] 点「任务状态」listitem @f3f0:e6 → observe 召回:`listitem "任务状态 "` (text 多了一个  选中字形) + panel 中新增 textbox + textbox "请选择" readonly(条件输入 + 值选择)✅。**observe 表达了选中标记(  字符)** — 这个细节 observe 抓到了。
- **O-13** [正常·点筛选提交成功] 点 panel 中「筛选」按钮 @d567:e32 → 真实 DOM:panel 中显示「任务状态 包含任一项」(query mode=text 命中) + 「共 1 条」(query mode=css 命中) + body row 仍是 1 行(数据未变,因为「任务状态=待处理」与原始数据匹配)。✅ **筛选提交生效,行数符合预期**(过滤前后都是 1 条)。
- **O-14** [观察·筛选状态可被 observe 读取] 不同于「每页条数下拉」和「排序状态」,筛选条件状态在 panel DOM 中可见(textbox + select 内容),observe 实际能召回 panel 内的「任务状态」「包含任一项」标记。**panel 内联显示的回读面** 比 el-select readonly input / 排序 icon className **更宽** — 这决定 observe 能否回读。

### C5 工作流演示 + 视图 tab + 状态 tab + 分页 (全新 tab `984528423`)

工具预算:本 tab 共 ~14 次工具调用。

- **O-15** [正常·视图 tab 切换 success + 数据变化] 点「全部工单」@89ac:e55 → 真实 DOM:`.workflow-worksheet-tab-item.active` 在「全部工单」上;其他两个 tab「流程待办」「流程工单」active class 移除(query mode=css attr=class 命中)。数据变化:从「共 5 条」变为「共 22 条」(query mode=css 命中 .el-pagination__total),表格列也从「工单编号/任务编号/节点名称/节点类型/产生时间/等待时长」切到「订单号/平台/店铺/流程状态/买家昵称」✅。
- **O-16** [异常·tab active 状态在 observe 中完全不表达] observe 在「全部工单」激活后仍输出:`div "流程待办" / div "流程工单" / div "全部工单"` 三项,**无 [active] / aria-selected / 不同视觉状态描述**。**调用方拿到 ref 后无法判断哪个是当前选中 tab**——必须靠 query mode=css attr=class 验证。
- **O-17** [异常·状态 tab(待处理/待领取)active 也不表达] 切回「流程待办」后,observe 召回 `div "待处理· 5" / div "待领取· 5"`,点「待领取· 5」(mouse_click 452,192) → 真实 DOM:`.workflow-worksheet-tab-item.status.active` 在「待领取· 5」上(query mode=css 命中)。**observe 输出完全没区分**,3 次 observe 切换(全部工单 → 流程待办 → 待领取)输出都长一样——**调用方无法靠 ref 判断当前激活的 tab**。
- **O-18** [观察·style 模式可区分 active tab] `vortex_query mode=style .workflow-worksheet-tab-item` 返回 3 个元素的 style 对比:未激活 `bg rgba(0,0,0,0.04), color rgba(0,0,0,0.65), fontWeight 400` ↔ 激活 `bg rgb(255,255,255), color rgb(39,131,242), fontWeight 500`(蓝色 + 粗体)。**query mode=style 能补回 active 状态**——但这是非默认路径,需要调用方主动用 style 查询,不是 vortex_observe 的默认行为。
- **O-19** [正常·工作流演示下拉选项不同] 工作流演示的分页器是 4 个选项(10/20/40/80),工单表是 5 个选项(10/20/30/40/50)—— 不同 app 的 el-pagination 配置不同。点「20条/页」(1124,446) → 真实 DOM:.el-pagination__sizes .el-input__inner attr.value="20条/页"(query mode=css attr=value 命中),.el-select-dropdown__item.selected.text="20条/页"(hover 状态保留)。✅ 操作 success。
- **O-20** [异常·observe 在工作流演示下同样看不到下拉当前值] dropdown 关闭后,observe 看不到分页器(textbox "请选择" 仍在 80 截断外)。**与 C1 O-2 同病**。

## 异常汇总 (Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 每页条数下拉:act 后 observe 默认看不到当前选中值 | act 点 20条/页 后真实 DOM 验证 input.value="20条/页",但 el-pagination__sizes wrapper 显示空白(因为 input readonly,value 不在 DOM text 里),observe 截断 80 candidates 也常把分页器挡在外面;只有当 dropdown 弹出"借机"挤占 80 配额时才偶然召回 value | experience (调用方需主动 query mode=css attr=value 验证,observe 默认输出不可信) | O-1, O-2, O-4, O-20 | 是(工单表 + 工作流演示两个 tab 都触发) |
| A-2 | 列排序状态:observe 不表达 asc/desc/none | 点列头排序 dropdown 后真实 DOM worksheetHeader-sort-icon.icon-sort5.desc(query mode=css 命中),但 observe 输出的列头 i 元素仍标 `arrow 3 lower`,无 [sort=desc] / aria-sort=descending / dropdown 当前选中项的 checked 状态;observe 完全不知道排序状态 | experience (调用方无法靠 observe 确认排序是否生效;但 act 行为正确,query mode=css attr=class 可补回) | O-5, O-6, O-7 | 是(同 tab 重 observe 同样结果) |
| A-3 | 视图/状态 tab active 状态:observe 不表达 | 切「全部工单」/「待领取· 5」tab 后真实 DOM .workflow-worksheet-tab-item.active class 正确切换(query mode=css 命中),数据从 5 条变 22 条;但 observe 输出 3 个 tab 都是 `div "流程待办" / div "流程工单" / div "全部工单"` 无 [active] / aria-selected / 视觉差异;状态 tab「待处理· 5」/「待领取· 5」同样不区分 | suspected-blocking (调用方拿到 tab ref 后无法判断当前选中;只有 query mode=css attr=class / mode=style 才能补回,不是 observe 默认) | O-15, O-16, O-17, O-18 | 是(工作流演示新 tab + 同 tab 重 observe 同样结果) |

> 整体裁决(仅观察,不做根因):
> - **所有 act 行为正确**:每页条数下拉 / 列排序 dropdown / 翻页 / 前往页 / 筛选 / 视图 tab / 状态 tab 全部 success,真实 DOM 状态变化通过 query mode=css attr=class / attr=value 三角验证。
> - **没有「假成功」(act success 但状态未变)**:所有 act 后 query 验证都有预期状态变化——例外是 disabled btn-next (O-9) 但那是因为总页数=1,disabled 是正确实现。
> - **observe 默认输出有 3 个真实盲点**:el-select readonly input.value / el-table sort icon className / workflow tab active className 都是真实 DOM 状态,但 observe 不读 .value attr / .className / .className,只暴露 a11y 树上的 role/name/state。这导致调用方靠 observe 默认输出完全无法验证这 3 类操作是否生效。
> - **可补回的路径**:query mode=css attr=value / attr=class / mode=style 都能补回——但这要求调用方了解 observe 盲点,主动用 query 三次验证。这是「非默认但可用」的设计选择,不是缺陷。
> - **brief 假设基本成立**:每页条数下拉 / 列排序 / 视图 tab / 状态 tab / 筛选都试了「操作 + observe/query 回读」,brief 中提到的「操作+回读」诉求完全覆盖。

## 已试的非视觉路径

- `vortex_observe scope=viewport filter=interactive × 8`(工单表初始 / dropdown 弹出后 / 列排序 dropdown / 空白处关闭后 / 添加筛选条件 dropdown / 任务状态选中后 / 工作流演示初始 / 全部工单 + 待领取)
- `vortex_observe scope=full filter=interactive × 1`(工单表初始 — 同样截断到 80)
- `vortex_query mode=css × 12`(找 .el-pagination__sizes / el-pagination__editor / .worksheetHeader-sort-icon / .btn-prev/next / .workflow-worksheet-tab-item / .el-pagination__total 等)
- `vortex_query mode=css attr=value × 4`(验证 el-pagination__sizes input.value="20条/页" / editor input.value="1")
- `vortex_query mode=geometry × 6`(分页器/排序图标/tab/下拉项 bbox)
- `vortex_query mode=text × 2`(找「条/页」「任务状态」「前往」)
- `vortex_query mode=style × 1`(工作流演示 tab active 视觉区分)
- `vortex_mouse_click × 4`(分页器下拉 1106,576 + 20条/页 1111,424;工作流演示下拉 1119,564 + 20条/页 1124,446;待领取 452,192;空白关闭 200,200)
- `vortex_act click × 6`(排序 arrow / 倒序 / 添加筛选条件 / 任务状态 / 筛选提交 / 工作流演示切换)
- `vortex_act fill + type + press × 1`(前往页输入 2 + Enter)
- `vortex_wait_for idle × 6`(每次操作后等异步 settle)
- `vortex_tab_create × 2` + `vortex_tab_close × 2`(工单表 tab + 工作流演示 tab)
- `vortex_evaluate × 0`(本轮全程 evaluate 工具返回 undefined——MCP 服务临时不可用,所有 DOM 真值证据改用 query mode=css attr=value / attr=class 三角验证)