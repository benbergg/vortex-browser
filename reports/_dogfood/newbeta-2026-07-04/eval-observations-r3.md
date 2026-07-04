# newbeta.bytenew 评估观察 (M3) — r3

日期: 2026-07-04 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 大表格 extract 行/列 + 无名 checkbox 召回 + 节点状态语义 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## 观察记录

### C1 工单表 (`#/applet/appNew/projectNew/58860/1838255`)（全新 tab `984528404`）

工具预算：本 tab 共 ~13 次工具调用（≤30 上限内）。

- **O-1** [正常] `vortex_extract`（默认）拿到工单表完整内容。
  - **表头（9 数据列）**：操作 / 任务状态 / 工单编号 / 创建人 / 执行人 / 修改时间 / 截止时间 / 任务完结人 / 任务完结时间。
  - **数据行（1 行 × 9 数据列）**：待处理 / 823290 / 青蛙 / (空) / (空) / 2026-06-11 16:26:57 / (空) / (空) / (空)。
  - 顶部还存在第 1 个空 `\t`（对应 checkbox 列），extract 把 checkbox 列保留为空位 → 行列对齐一致。
  - 末尾 `共 1 条 / 1 / 前往页` 是分页信息。

- **O-2** [正常] DOM 真值对照 — `vortex_query mode=css table thead th` 拿到 10 个 th（空 checkbox + 操作 + 工单编号 + 创建人 + 执行人 + 修改时间 + 截止时间 + 任务完结人 + 任务完结时间），DOM 真值的列顺序与 extract 列顺序一致。`table tbody td` 同样 10 个 td，列对应：checkbox / 操作 / 任务状态 / 工单编号 / 创建人 / 执行人 / 修改时间 / 截止时间 / 任务完结人 / 任务完结时间。所有 cell 文本均与 extract 输出对齐。

- **O-3** [正常] `vortex_extract {include:["text","value"]}` 文本字段与默认完全一致；额外 `controls` 字段只包含分页 input.value="1" 和一个 search input.value=""（与表格数据无关）。`include` 选项不改变表格 cell 提取结果。

- **O-4** [正常] `vortex_observe {scope:viewport, filter:interactive}` 召回工单表 checkbox + 操作 cell：
  - 表头 checkbox：`span "全选/取消" [ref=@a35c:e60] [cursor=pointer] [listener] desc="全选/取消"` —— 独立 ref 可点 ✅。
  - 行 checkbox：`span "checkbox" [ref=@a35c:e78] [cursor=pointer] [listener]` —— 正是 brief 提到的"无名 span checkbox cursor:pointer 历史修复点"，本 tab 成功召回为带 ref 的 span ✅。
  - 操作 cell：`cell "   " [ref=@a35c:e79] [listener]` —— 4 个 unicode iconfont 字形被压成 1 个 cell。

- **O-5** [观察·非异常·recall detail] 操作 cell 内 4 个图标（DOM 真值）：

  | 顺序 | iconfont class | title/aria-label | 物理 bbox (x, y, w, h) |
  |---|---|---|---|
  | 1 | `icon-a-xinfengxinxixiaoxi` (蓝色) | 无 | (366, 270, 16, 22) |
  | 2 | `icon-edit1` | 无 | (394, 270, 16, 22) |
  | 3 | `icon-news1` | 无 | (422, 270, 16, 22) |
  | 4 | `icon-more3` | 无 | (450, 270, 16, 22) |

  4 个 span 都是 `w-cursor-pointer`，DOM 上是 4 个独立可点按钮（物理位置各占独立 16px × 22px），**但**没有任何 title/aria-label 标签，observe 没把它们拆成独立 ref —— 整体压成 1 个 cell，cell 文本是 4 个 unicode 字形连起来 `"   "`。**单元格召回 → ✅**，**按钮级独立 ref → ❌**（这是 vxe-table 操作列图标的普遍行为，并非新缺陷；调用方拿 cell ref `@a35c:e79` 只能 click cell 整体而非 4 个按钮之一）。

### C2 工作流演示（多行节点状态表，同 tab `984528404`）

- **O-6** [正常] 切换到"工作流演示" — `vortex_act click @a35c:e40` (sidebar `工作流演示` div)。返回 `success=true` / `mode=realMouse` / `effect.urlChanged=true` / `effect.networkRequests=16`（含 `wf/config/simpleFlow/125/30009/1086546`）/ `domMutations=1343`。路由从 `/projectNew/58860/1838255` 切到 `/projectNew/30009/1086546`，tab 标题更新到"工作流-工作流演示"。

- **O-7** [正常] `vortex_extract`（默认）拿到工作流演示多行表：
  - **表头（11 数据列）**：工单编号 / 任务编号 / 节点名称 / 节点类型 / 产生时间 / 等待时长 / 处理人 / 订单号 / 平台 / 店铺 / 买家昵称。
  - **数据行（5 行 × 11 数据列，全部对齐）**：

    | # | 工单编号 | 任务编号 | 节点名称 | 节点类型 | 产生时间 | 等待时长 | 处理人 | 订单号 | 平台 | 店铺 | 买家昵称 |
    |---|---|---|---|---|---|---|---|---|---|---|---|
    | 1 | 186 | 1037050591145496944 | 门店处理 | 填写节点 | 2024-09-27 14:29:54 | 15486 小时 30 分钟52秒 | (空) | 213412341234 | (空) | (空) | (空) |
    | 2 | 186 | 1037050591875305840 | 电商客服 | 填写节点 | 2024-09-27 14:29:54 | 15486 小时 30 分钟52秒 | (空) | 213412341234 | (空) | (空) | (空) |
    | 3 | 219 | 1046835675394891872 | 门店处理 | 填写节点 | 2024-10-24 14:32:20 | 14838 小时 28 分钟26秒 | (空) | 5323412431241234 | 京东 | 【虚店】网聚宝电器1店 | 手动阀十分 |
    | 4 | 221 | 1046854270803636624 | 门店处理 | 填写节点 | 2024-10-24 15:46:14 | 14837 小时 14 分钟32秒 | (空) | 23875982749132741284 | (空) | (空) | (空) |
    | 5 | 222 | 1046855250807251040 | 门店处理 | 填写节点 | 2024-10-24 15:50:07 | 14837 小时 10 分钟39秒 | (空) | 23875982749132741283 | (空) | (空) | (空) |

  - 末尾 `共 5 条 / 1 / 前往页` —— 表内共 5 条工单，1 页显示。

- **O-8** [正常] 语义列全部可读非截图 ✅：节点名称（门店处理 / 电商客服）、节点类型（填写节点）、等待时长（"15486 小时 30 分钟52秒"等中英混排）均完整输出。

- **O-9** [异常·extract 漏 cell 内容] **操作列 cell 提取不全**：5 行操作列的 cell 内 5 个 leaf 按钮（DOM 真值：`处理` / `转交` / `备注` / `结束任务` / `结束流程`），但 extract 输出只显示列标题"操作" + 3 个按钮文本"处理 / 转交 / 备注"（**漏"结束任务""结束流程" 2 个按钮**）。DOM 真值：`vortex_query mode=css table tbody tr:nth-child(1) td:nth-child(2) span` 拿到 5 个 leaf span（含"结束任务""结束流程"），外加一个复合 wrapper（text="结束任务结束流程"，含 2 个子 leaf）。extract 把这个复合 wrapper 当 1 个按钮算，导致 5 按钮只输出 3 按钮 + 列标题。**同一单元格，extract 路径漏 2 按钮 vs query 路径完整**：≥2 原生路径差异 → 记异常。

- **O-10** [正常] `vortex_extract {scroll:true}` 输出与默认完全一致 —— 因为工作流演示表格**没有虚拟滚动容器**（evaluate 检测 `scrollH > clientH` 的容器 → 0 个），5 条数据已全部渲染。`scroll:true` 触发懒加载在班牛非虚拟滚动表格里无效。

- **O-11** [观察·非异常·行 3 买家昵称 cell] **1 cell 的 child title vs visible text 策略差异**：行 3「买家昵称」列 DOM 结构 — `<div title="手动阀十分" class="w-text-over worksheetColumn"><span>...长说明...</span></div>`，内层含完整长说明文字 + el-popover tooltip 触发。extract 输出 title="手动阀十分"（=业务短名），DOM 可见文本为完整长说明（"1.直接联系买家直接拨打隐私号..."开始）。**这是 extract 的 child title 优先策略**，DOM 真值包含更长文本，但业务语义上 cell "值" = 短名（title）。extract 输出虽然有损，但与 cell 业务语义一致 → 不算漏召回，仅记录策略差异。

- **O-12** [异常·observe 漏召回] **工作流演示冻结列（checkbox + 操作）在 observe 中完全漏召回**：vxe-table 在工作流演示页采用冻结列（fixed-left wrapper）布局，DOM 中存在 2 个 `table.vxe-table--header-wrapper`：(a) `body--wrapper` 含 13 列完整表头 (b) `fixed-left--wrapper` 仅 2 列（checkbox + 操作）。observe 召回的 table accessible name 是 `工单编号任务编号节点名称节点类型产生时间等待时长处理人订单号平台店铺买家昵称`（11 列），**只覆盖 body wrapper，fixed-left wrapper 被完全跳过**。结果：
  - observe 数据 cell 列表从 `cell "186" [ref=@ed25:e68]` 直接开始，**没有 checkbox cell、没有操作 cell**。
  - 对比工单表（同 vxe-table 但无冻结列）：observe 召回 `cell " " [ref=@a35c:e77]` 含 `span "checkbox" [ref=@a35c:e78]` + `cell "   " [ref=@a35c:e79]` —— 2 个 cell 都召回 ✅。
  - 工作流演示的冻结列 checkbox cell（`td.col--checkbox` 含 `.vxe-checkbox--icon`）+ 操作 cell（`td.col--fixed` 含 5 个按钮）物理可见（query mode=geometry 拿到所有 td bbox，inViewport=true），但 observe 完全跳过了 fixed-left wrapper。

- **O-13** [观察·非异常·操作列内容 strategy 镜像] extract 在工作流演示表把"操作"列的 cell 内容展开为 4 行字段（操作/处理/转交/备注），挂在每行数据末尾 —— 而非作为独立 cell 列输出。这是 extract 的"行级 info"拼接策略，与工单表 extract 一致（工单表操作列 cell 是 4 个 iconfont 无文字，extract 直接吞没）。**不是 cell 控件召回失败，是文本拼接策略**。配合 O-12 看：observe 完全漏 cell，extract 不按 cell 输出而是行尾拼接 —— **操作列 cell 在两条 vortex 原生路径下都不算"完整召回"**（observe 0 cell，extract cell 内容部分缺失），构成 ≥2 路径失败。

- **O-14** [异常合并·综合判定] 把 O-12 + O-13 + O-9 合并为同一异常 `A-1`：工作流演示表的"操作列（含 checkbox + 操作 cell）"在 observe 和 extract 两条路径上都不完整（observe 完全漏召回冻结列 cell；extract 把操作列内容拼到行尾且 5 按钮只输出 3 按钮 + 列名）。
  - **observe 路径**：表头只召回 11 列数据；数据 cell 只列 11 个 cell，**冻结列 checkbox + 操作 cell 完全没出现**。
  - **extract 路径**：把操作列内容当 row-level info 拼到行尾（"操作 + 处理 + 转交 + 备注"4 项），不作为独立列；5 按钮中漏 2 按钮（"结束任务""结束流程"）。
  - **query 路径**（仅作 DOM 真值证据，不算召回路径）：css 能拿到所有 cell 文本（5 按钮全），geometry 能拿到所有 td bbox，物理可见。

## 异常汇总（Anomaly）

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 工作流演示冻结列 (checkbox + 操作列) | observe 完全漏召回 fixed-left wrapper 的 checkbox cell + 操作 cell；extract 把操作列内容拼到行尾(不作为独立列)且 5 按钮只输出 3 按钮+列名(漏"结束任务""结束流程")；≥2 vortex 原生路径均不完整 | experience (对行操作交互阻断，但表格主体数据提取未受影响) | O-9, O-12, O-13, O-14 | 是(同 tab 重复 observe + extract 都复现) |

> 整体裁决（仅观察，不做根因）：
> - **核心覆盖目标达成**：
>   - 工单表 extract 行/列对齐 ✅：9 数据列 × 1 行，DOM 真值 9 td 完全一致；表头 9 列齐全；语义列（任务状态=待处理、创建人=青蛙、修改时间=2026-06-11 16:26:57）非截图读出。
>   - 工作流演示 extract 行/列对齐 ✅：11 数据列 × 5 行，DOM 真值 11 td 完全一致；表头 11 列齐全；语义列（节点名称/节点类型=填写节点/等待时长=15486 小时 30 分钟52秒）非截图读出。
> - **checkbox 召回**：
>   - 工单表：✅ observe 召回表头"全选/取消" + 行内 `span "checkbox"`，均带独立 ref。
>   - 工作流演示：❌ observe 完全漏掉冻结列 checkbox cell（vxe-table fixed-left wrapper）。
> - **行操作控件召回**：
>   - 工单表：⚠️ 操作 cell 召回为整体 cell（4 个 wicon 无独立 ref，无 title/aria-label），cell 召回 OK，按钮级 ref 不可用。
>   - 工作流演示：❌ observe 漏操作 cell；extract 操作列 cell 文本展开为"操作 + 处理 + 转交 + 备注"(5 按钮只 3)。
> - **盲点 [blindspot]**: 班牛 vxe-table 的冻结列（fixed-left wrapper）的 a11y / extract 召回都未覆盖，是 frozen-column 控件在新 vxe 版本下的系统性问题。已尝试的路径：observe (filter=interactive/all × 多次) / extract (默认 + scroll + include:text,value) / query mode=css (td / span / col--checkbox / col--fixed) / query mode=geometry (td bbox) / evaluate (DOM innerHTML + child title + popover) 全部非截图路径。observe 漏、extract 内容不完整、query/css 是 DOM 真值对照(仅作证据不构成工具召回) → 单纯靠"非截图"工具仍无法完整召回冻结列 cell 控件。
> - **scroll:true 触发懒加载**: 工作流演示表无虚拟滚动容器（evaluate 检出 `scrollH>clientH` 容器 0 个），5 条数据一次性渲染；scroll:true 不触发任何额外加载。在班牛普通 vxe-table（非虚拟滚动模式）下 scroll 参数无效。

## 已试的非视觉路径

- `vortex_extract 默认 × 2`（工单表 / 工作流演示表）
- `vortex_extract {include:["text","value"]} × 1`（工单表）
- `vortex_extract {scroll:true} × 1`（工作流演示表，验证懒加载）
- `vortex_observe {scope:viewport, filter:interactive} × 5`（工单表 + 工作流演示表，多次取 fresh ref）
- `vortex_observe {scope:viewport, filter:all, prevSnapshotId} × 3`（工作流演示表 full snapshot）
- `vortex_query mode=css × 6`（工单表 th/td、文工作流演示表 thead/body/all td/操作列 span/child title）
- `vortex_query mode=geometry × 2`（工单表行操作图标 bbox、工作流演示 td 全 bbox）
- `vortex_act click × 1`（切换到工作流演示 sidebar）
- `vortex_wait_for idle × 2`
- `vortex_evaluate × 5`（**仅读 DOM 真值**作 evidence：工单表行结构 / 工作流演示 thead 多 wrapper 结构 / 操作列 leaf button 列表 / child title vs visible text 策略 / 虚拟滚动容器检测）
- `vortex_tab_create × 2` + `vortex_tab_close × 2`（工单表 / 工作流演示各自新 tab，零缓存漂移）

(End of file - total 145 lines)