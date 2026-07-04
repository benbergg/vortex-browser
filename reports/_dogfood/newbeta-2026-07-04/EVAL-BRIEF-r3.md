# M3 评估简报 — newbeta.bytenew dogfood（r3）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁用 evaluate 完成交互**（evaluate 仅读 DOM 真值作证据）。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站（已登录态）

- 工单表：`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`（1 行工单，9 列）
- 工作流演示（更丰富的节点状态表，多行多列）：先开工单表 tab，observe 左侧点 `工作流演示` 卡切换，或直接 observe 找它。

## 本轮场景（r3）：大表格 extract 行/列 + 无名 checkbox 召回 + 节点状态语义

**主考 vortex 能力**：`vortex_extract` 对班牛 DOM 表格（工单表 / 工作流演示 vxe/普通 table）的**结构化提取**——行列对齐、单元格内容、表头；`vortex_observe` 对表格内**无名 checkbox**（`span "checkbox"` cursor:pointer，历史修复点）与行操作按钮的召回；语义列（任务状态/等待时长/节点类型）能否非截图读出。

### 步骤（每表新 tab，≤30 次工具调用）

1. 工单表 tab → `vortex_extract`（默认 + `include:["text","value"]`）：能否拿到表头 9 列名 + 那 1 行数据（工单编号 823290/创建人 青蛙/时间）？行列是否对齐可解析？
2. `vortex_observe {filter:interactive}` 表格区：表头「全选/取消」checkbox + 行首 `span "checkbox"` 是否召回（带 role/name）？行内操作图标（edit1/news1 等）是否召回？
3. 切到**工作流演示**（多行节点状态表）→ `vortex_extract`：多行时行列是否仍对齐？「节点名称/节点类型/等待时长(如 15485 小时)/处理人」等语义列能否读出？滚动加载更多行（`scroll:true`）是否生效？
4. **异常判定**（≥2 原生路径失败才记）：
   - extract 拿不到表格内容 / 行列错乱串行 / 丢单元格 / 表头与数据错位。
   - observe 漏召回 checkbox 或行操作控件（无名控件召回缺陷）。
   - 语义列内容 extract/query 都读不到 → `[blindspot]`。
5. **对照**：同一表用 `vortex_query mode=css` 读 `td`/`.vxe-cell` 作 DOM 真值对照 extract 结果（仅作证据）。

## 产出（写到 `reports/_dogfood/newbeta-2026-07-04/`）

1. `eval-observations-r3.md`（extract 结果贴关键片段 + 行列是否对齐判断）
2. `anomalies-r3.json`（schema，cycle=`dogfood-newbeta-2026-07-04`，无异常 `anomalies:[]`）

## 完成标志

双产物写完；工单表 + 工作流演示两表都试过 extract；checkbox/行操作召回核对；有异常带 ≥2 tried_alternatives；报告：extract 行列是否对齐、有无漏召回/blindspot。
