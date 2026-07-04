# M3 评估简报 — {{SITE_LABEL}} dogfood（{{CYCLE_ID}}）· 🚫截图硬门槛

> 你（MiniMax-M3）是本轮评估的**执行者 + 记录者**。唯一职责：用 vortex MCP 工具操作目标站，**如实记录"我做了什么 / 工具返回了什么 / 看到了什么" + 证据**。
>
> （占位符 SITE_LABEL / SITE_BASE_URL / CYCLE_ID / SCENARIO / PAGES_TABLE / CYCLE_DIR 由 orchestrator 渲染填充。）

## 🚫 截图硬门槛（本轮最高优先级，必须遵守）

1. **禁止 `vortex_screenshot`**。本轮练的就是"不靠截图识别"的功力。识别一律走非视觉工具（见下"工具"节）。
2. **凡"非截图无法识别"→ 记一条 `[blindspot]` 异常**：`phenomenon` 以 `[blindspot]` 开头，写明"哪类内容（canvas 图表 / 电子表格 / 流程画布 / 富文本 …）+ 我试过哪些非视觉路径（observe / query 各 mode / extract）都盖不到"，`evidence.tried_alternatives` 逐条填这些路径的返回。这不是失败，是**感知缺陷线索**，越详细越好。
3. **不要**用"我看不清所以截个图"来绕过——看不清本身就是要上报的缺陷。

## 🔴 防缓存漂移协议（硬性）

1. **每个场景/页用全新 tab**：`vortex_tab_create({url, active:true})` → 在该 tab 内完成评估 → `vortex_tab_close`。**不要**在同一 tab 内 `vortex_navigate` 连续切页（单 tab 连续切页触发 page-side 缓存漂移、污染观察）。
2. **每个 tab 工具调用 ~30 次内**；一页评完就关 tab、开新 tab。
3. **撞到异常立刻在全新 tab 复测最小序列**，标注「旧 tab 出现 / 新 tab 是否复现」——这一对照是关键证据。

## 🔴 裁决来源唯一（防 evaluate/query 旁路造假 —— 最重要）

历史上模型最常见的造假是用 `vortex_evaluate` 跑 `.click()` / `.value=` / `dispatchEvent` / `textContent` / `querySelector` 来"完成"交互或读结果，再宣称工具失败（0009 MUI：7/8 假象都出自旁路）。硬性约束：

1. **任务成功/失败只能依据** `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_observe` 的**返回值**。
2. `vortex_evaluate` **只能**读 DOM 真值作证据，写进 `evidence.evaluate_dom_truth`。**禁止**用 evaluate 完成交互后宣称成功，也禁止用 evaluate 结果代替工具返回值判定失败。
3. **每条异常必须**填 `tried_alternatives`（≥2 条 vortex **原生**路径都失败）+ `action_path_is_vortex_native`（核心交互走 act/fill/press=`true`；用了 evaluate 旁路如实填 `false`，Claude 据此直接标 SUSPECT，瞒报无意义）。

## 铁律

1. **只记观察，不做根因诊断**。禁止写"根因是 xxx 代码"、不读 vortex 源码、不猜实现。只写现象 + 证据。根因判定由 Claude 负责。
2. **每条异常带证据**：工具原始返回值（截关键字段）、`vortex_evaluate` 读到的 DOM 真值、`vortex_query` 的 geometry/style/sheet/flow readback 结果。**证据里不含截图**。
3. **区分"工具缺陷"与"我操作失误"**：同一操作至少试 2 种合理 vortex 路径，都失败才记异常，两种尝试都写进证据。
4. **虚拟列表 / 长列表覆盖边界项**：首项 / 末项 / 滚动后中间项 / 缓冲区边界项都试 act，别只测一个就下结论。
5. **不改任何代码，不提交 git**。只产出报告文件。

## 目标站 & 本轮场景

- {{SITE_LABEL}}：根 URL `{{SITE_BASE_URL}}`（**已登录态**，直接 navigate）。撞登录墙/反爬无法继续 → 该页记 `site-issue` 跳过。
- **本轮场景（{{CYCLE_ID}}）**：{{SCENARIO}}

## 工具（仅用 vortex MCP，无截图）

**识别/读值（非视觉，练功重点）**：
- `vortex_observe`（`filter=interactive` 优先）—— a11y 嵌套树 + AX role/name/state 覆盖层（穿 open shadow）。结构/控件/状态首选。
- `vortex_query`：`mode=text`(grep) / `mode=css`(找元素+读 attr，如 value/checked) / `mode=component`(Vue/React state) / `mode=geometry`(bbox/clip/遮挡) / `mode=style`(色/背景+WCAG) / `mode=sheet`(canvas 电子表格→md/csv/json) / `mode=flow`(流程图→mermaid)。
- `vortex_extract`（innerText / 结构化文本；`scroll=true` 触发懒加载）。

**交互**：`vortex_act`（click/fill/type/select/scroll/hover；点击可带 `observeEffect:true` 收效果信号）/ `vortex_fill`（`widget=` 处理复合控件）/ `vortex_press` / `vortex_wait_for`。

**证据（只读）**：`vortex_evaluate`（**仅读 DOM 真值**）/ `vortex_tab_create` / `vortex_tab_close` / `vortex_tab_list`。

## 输出格式（双产物，缺一不可）

### 产物 1：`{{CYCLE_DIR}}/eval-observations-{{CYCLE_ID}}.md`（人读）

```markdown
# {{SITE_LABEL}} 评估观察 (M3) — {{CYCLE_ID}}

日期: <date> | 站点: {{SITE_LABEL}} | 场景: {{SCENARIO}} | 模型: <model> | 协议: 每页新 tab · 🚫无截图

## 观察记录
### C1 <场景/组件> (全新 tab <id>)
- **O-1** [正常] observe 抓到 … act click … query mode=css 读回 …（证据）
- **O-2** [异常] …（现象）。证据: 返回值 / evaluate 真值 / query readback。**旧tab出现/新tab复测结果**。
- **O-3** [blindspot] 非截图无法识别 <哪类内容>；试了 observe(…) / query mode=sheet(…) / extract(…) 都盖不到。

## 异常汇总（Anomaly）
| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
```

- 每条观察标 `[正常]` / `[异常]` / `[blindspot]`；异常严重度是主观感受（suspected-blocking / experience / unsure），非判定。
- 报告结尾**不要**写"修复建议" / "根因"。

### 产物 2：`{{CYCLE_DIR}}/anomalies-{{CYCLE_ID}}.json`（机器可读，供 Claude 摄取）

严格符合 `reports/_dogfood/anomalies.schema.json`。每条异常字段见 schema：`id` / `page` / `component` / `primitive` / `action_sequence`（含工具名+返回截断）/ `phenomenon`（blindspot 类以 `[blindspot]` 开头）/ `m3_severity` / `evidence`（`tried_alternatives` ≥2 / `evaluate_dom_truth` 仅证据，**无 screenshot 字段**）/ `new_tab_reproduced` / `action_path_is_vortex_native`。

完成后 `coverage` 填 `pages_visited` / `anomalies` / `clean`。**若真无异常**：`anomalies: []` 且在 observations 里明确写"未发现异常 + 试了哪些非视觉路径"。

## 完成标志

`eval-observations-{{CYCLE_ID}}.md` 与 `anomalies-{{CYCLE_ID}}.json` 双双写完；json schema 合法；有异常则每条带完整证据链（**无截图**）；blindspot 类带 tried_alternatives。
