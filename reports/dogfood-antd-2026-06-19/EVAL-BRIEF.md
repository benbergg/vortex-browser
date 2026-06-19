# M3 评估简报 — Ant Design (React) dogfood（dogfood-antd-2026-06-19）

> 你（MiniMax-M3）是本轮评估的**执行者 + 记录者**。唯一职责：用 vortex MCP 工具操作目标站组件演示页，**如实记录"我做了什么 / 工具返回了什么 / 看到了什么" + 证据**。
>
> （本文件是模板；占位符 SITE_LABEL / SITE_BASE_URL / CYCLE_ID / PAGES_TABLE / CYCLE_DIR 由 `dogfood-rotation.mjs` 渲染填充。）

## 🔴 防缓存漂移协议（硬性，必须遵守）

1. **每个组件页用全新 tab**：`vortex_tab_create({url, active:true})` 打开 → 在该 tab 内完成评估 → `vortex_tab_close`。**不要**在同一 tab 内 `vortex_navigate` 连续切到下一个组件页（单 tab 连续切页会触发 page-side 缓存漂移、污染观察 —— 0008 实证）。
2. **每个 tab 工具调用控制在 ~30 次内**；一页评估完就关 tab、开新 tab 评估下一页。
3. **撞到异常时立刻在全新 tab 里复测一遍最小序列**，标注「旧 tab 出现 / 新 tab 是否复现」。这一对照是关键证据。

## 🔴 裁决来源唯一（防 evaluate 旁路造假 —— 最重要）

历史上模型最常见的造假是用 `vortex_evaluate` 跑 `.click()` / `.value=` / `dispatchEvent` / `textContent` / `querySelector` 来"完成"交互或读结果，再宣称工具失败 —— 这会制造大量假缺陷（0009 MUI：7/8 假象都出自旁路）。本轮硬性约束：

1. **任务成功/失败只能依据** `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_observe` 的**返回值**。
2. `vortex_evaluate` **只能**用于读 DOM 真值作证据，写进 `evidence.evaluate_dom_truth`。**禁止**用 evaluate 完成交互动作后宣称成功，也禁止用 evaluate 的结果代替工具返回值来判定失败。
3. **每条异常必须**：
   - 填 `tried_alternatives`：≥2 条 vortex **原生**路径都失败（如「act 文本失败 → observe 拿 ref 再 act 仍失败」）。
   - 填 `action_path_is_vortex_native`：核心交互动作是否走 act/fill/press（`true`）。若你用了 evaluate 旁路，必须如实填 `false`（Claude 会据此直接标 SUSPECT，瞒报无意义）。

## 铁律

1. **只记观察，不做根因诊断**。禁止写"根因是 xxx 代码"。不读 vortex 源码、不猜实现。只写现象 + 证据。根因判定由 Opus（Claude）负责。
2. **每条异常带证据**：工具原始返回值（截关键字段）、`vortex_screenshot`、`vortex_evaluate` 读到的 DOM 真值。
3. **区分"工具缺陷"与"我操作失误"**：同一操作至少试 2 种合理的 vortex 路径，都失败才记异常，两种尝试都写进证据。
4. **虚拟列表 / 长列表必须覆盖边界项**：首项 / 末项 / 滚动后的中间项 / 缓冲区边界项都试 act，不要只测一个就下结论（0008 #38：缓冲项越出 popper overflow 被裁剪是真不可点，别误判）。
5. **不改任何代码，不提交 git**。只产出报告文件。

## 目标站

Ant Design (React)：根 URL `https://ant.design/components/`。演示 demo 内联在各组件页。撞登录墙 / 反爬且无法继续 → 该页记为 `site-issue` 并跳过，不算 vortex 异常。

## 工具（仅用 vortex MCP）

`vortex_tab_create` / `vortex_tab_close` / `vortex_tab_list` / `vortex_observe`（filter=interactive 优先）/ `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_evaluate`（**仅读 DOM 真值作证据**）/ `vortex_screenshot` / `vortex_wait_for`

## 评估范围（每页新 tab；重点选择类 / 浮层 / Portal / 虚拟列表 / 拖拽）

| # | 组件页 URL | 核心交互（逐个试） |
|---|-----------|------------------|
| C1 | https://ant.design/components/select | Select:单选/多选/搜索;Portal popup |
| C2 | https://ant.design/components/cascader | Cascader 级联展开→末级 |
| C3 | https://ant.design/components/date-picker | DatePicker/RangePicker 面板选日期 |
| C4 | https://ant.design/components/modal | Modal 开关 + 内部表单 |
| C5 | https://ant.design/components/table | Table 行选/排序/筛选下拉 |
| C6 | https://ant.design/components/tree-select | TreeSelect 展开选节点 |
| C7 | https://ant.design/components/transfer | Transfer 穿梭框 选项→移动 |

## 输出格式（双产物，缺一不可）

### 产物 1：`reports/dogfood-antd-2026-06-19/eval-observations.md`（人读）

```markdown
# Ant Design (React) 评估观察 (M3)

日期: <date> | 站点: Ant Design (React) | 模型: <model> | 工具: vortex MCP | 协议: 每页新 tab

## 观察记录
### C1 <组件> (全新 tab <id>)
- **O-1** [正常] observe 抓到 … act click … evaluate 读 …（证据）
- **O-2** [异常] …（现象）。证据: 返回值 / 截图 / evaluate 真值。**旧tab出现/新tab复测结果**。

## 异常汇总（Anomaly）
| ID | 组件 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
```

- 每条观察标 `[正常]` / `[异常]`；异常严重度是主观感受（suspected-blocking / experience / unsure），非判定。
- 报告结尾**不要**写"修复建议" / "根因"。

### 产物 2：`reports/dogfood-antd-2026-06-19/anomalies.json`（机器可读，供 Claude 摄取）

严格符合 `reports/_dogfood/anomalies.schema.json`。每条异常字段见 schema：`id` / `page` / `component` / `primitive` / `action_sequence`（完整动作链含工具名+返回截断）/ `phenomenon` / `m3_severity` / `evidence`（`tried_alternatives` ≥2 / `evaluate_dom_truth` 仅证据）/ `new_tab_reproduced` / `action_path_is_vortex_native`。截图存 `reports/dogfood-antd-2026-06-19/screenshots/<id>.png`。

完成后 `coverage` 填 `pages_visited` / `anomalies` / `clean`。**若真无异常**：`anomalies: []` 且在 observations 里明确写"未发现异常 + 试了哪些"。

## 完成标志

`eval-observations.md` 与 `anomalies.json` 双双写完；anomalies.json schema 合法；若有异常则每条带完整证据链。
