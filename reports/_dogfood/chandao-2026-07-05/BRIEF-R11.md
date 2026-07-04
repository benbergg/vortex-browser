# M3 评估简报 — 禅道(chandao) dogfood（R11）· 🚫截图硬门槛

> 你（MiniMax-M3）是本轮评估的**执行者 + 记录者**。唯一职责：用 vortex MCP 工具操作目标站，**如实记录"我做了什么 / 工具返回了什么 / 看到了什么" + 证据**。不做根因诊断、不读 vortex 源码、不改代码、不提交 git。

## 🚫 截图硬门槛（本轮最高优先级，必须遵守）

1. **禁止 `vortex_screenshot`**。本轮练的就是"不靠截图识别"的功力。识别一律走非视觉工具（见下"工具"节）。
2. **凡"非截图无法识别"→ 记一条 `[blindspot]` 异常**：`phenomenon` 以 `[blindspot]` 开头，写明"哪类内容 + 我试过哪些非视觉路径（observe / query 各 mode / extract）都盖不到"，`evidence.tried_alternatives` 逐条填这些路径的返回。这是感知缺陷线索，越详细越好。
3. **不要**用"我看不清所以截个图"来绕过——看不清本身就是要上报的缺陷。

## 🔴 防缓存漂移协议（硬性）

1. **每个场景/页用全新 tab**：`vortex_tab_create({url, active:true})` → 在该 tab 内完成评估 → `vortex_tab_close`。**不要**在同一 tab 内 `vortex_navigate` 连续切页。
2. **每个 tab 工具调用 ~30 次内**；一页评完就关 tab、开新 tab。
3. **撞到异常立刻在全新 tab 复测最小序列**，标注「旧 tab 出现 / 新 tab 是否复现」。

## 🔴 裁决来源唯一（防 evaluate/query 旁路造假 —— 最重要）

1. **任务成功/失败只能依据** `vortex_act` / `vortex_fill` / `vortex_press` / `vortex_observe` 的**返回值**。
2. `vortex_evaluate` **只能**读 DOM 真值作证据，写进 `evidence.evaluate_dom_truth`。**禁止**用 evaluate 完成交互后宣称成功/失败。
3. **每条异常必须**填 `tried_alternatives`（≥2 条 vortex 原生路径都失败）+ `action_path_is_vortex_native`（核心交互走 act/fill/press=`true`；用 evaluate 旁路如实填 `false`，Claude 据此直接标 SUSPECT）。

## 铁律

1. **只记观察，不做根因诊断**。只写现象 + 证据。根因判定由 Claude 负责。
2. **每条异常带证据**：工具原始返回值（截关键字段）、evaluate 读到的 DOM 真值、query 的 readback 结果。证据里不含截图。
3. **区分"工具缺陷"与"我操作失误"**：同一操作至少试 2 种合理 vortex 路径，都失败才记异常。
4. **长列表覆盖边界项**：首行 / 末行 / 滚动后中间行 / 翻页后的行 都试 observe/读取，别只测一个。

## 目标站 & 本轮场景

- **禅道**：根 URL `https://chandao.bytenew.com/zentao/`（**已登录态**，用户「青蛙」，直接 navigate）。撞登录墙 → 记 `site-issue` 跳过。
- **本轮场景（R11）：我的任务列表读取（只读评测）**
  - 打开 `https://chandao.bytenew.com/zentao/my-work-task.html`（我的任务，366 条）。
  - **observe（filter=interactive）召回任务表格**：读每行的 任务名 / 状态 / 优先级 / 指派给 / 预计工时 / 截止日期。覆盖**首行、末行、滚动后中间行**。
  - 读**状态徽章语义**（进行中/已完成/已暂停/待办等）——用 observe 的 AX state 或 query mode=css attr=class 读状态 class，判断非截图能否识别状态。
  - 读**优先级标记**（禅道优先级用颜色数字圆点，1-4）——这是**重点 blindspot 候选**：优先级若只靠颜色/背景色表达、无文本/aria，observe 能否识别？试 query mode=style 读背景色 + mode=css 读 class/title。
  - **翻页 / 每页条数**：若有分页器，act 翻到第 2 页，observe 回读新行，确认换页成功（非假成功）。
  - 若任务表是**可排序表头**：act 点击"截止日期"表头排序，query mode=css 回读排序态（class/aria-sort）。
  - 全程**禁截图**。凡某列/某状态"非截图无法识别"→ 记 `[blindspot]`，填 tried_alternatives。

## 工具（仅用 vortex MCP，无截图）

**识别/读值（非视觉，练功重点）**：
- `vortex_observe`（`filter=interactive` 优先）—— a11y 嵌套树 + AX role/name/state。结构/控件/状态首选。
- `vortex_query`：`mode=text`(grep) / `mode=css`(找元素+读 attr 如 value/class/title) / `mode=component`(Vue state) / `mode=geometry`(bbox/遮挡) / `mode=style`(色/背景+WCAG) / `mode=chart`(echarts→数据)。
- `vortex_extract`（innerText / 结构化文本；`scroll=true` 触发懒加载）。

**交互**：`vortex_act`（click/scroll/hover；点击可带 `observeEffect:true`）/ `vortex_press` / `vortex_wait_for`。

**证据（只读）**：`vortex_evaluate`（**仅读 DOM 真值**）/ `vortex_tab_create` / `vortex_tab_close` / `vortex_tab_list`。

## 输出格式（双产物，缺一不可）

### 产物 1：`reports/_dogfood/chandao-2026-07-05/eval-observations-R11.md`（人读）

```markdown
# 禅道 评估观察 (M3) — R11

日期: 2026-07-05 | 站点: 禅道 | 场景: 我的任务列表读取 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图

## 观察记录
### C1 我的任务列表 (全新 tab <id>)
- **O-1** [正常] observe 抓到 … 读回 …（证据）
- **O-2** [异常] …（现象）。证据: 返回值 / evaluate 真值 / query readback。旧tab出现/新tab复测结果。
- **O-3** [blindspot] 非截图无法识别 <哪类内容>；试了 observe(…) / query mode=style(…) / extract(…) 都盖不到。

## 异常汇总（Anomaly）
| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
```

### 产物 2：`reports/_dogfood/chandao-2026-07-05/anomalies-R11.json`（机器可读）

严格符合 `reports/_dogfood/anomalies.schema.json`。每条异常字段：`id` / `page` / `component` / `primitive` / `action_sequence`（含工具名+返回截断）/ `phenomenon`（blindspot 类以 `[blindspot]` 开头）/ `m3_severity` / `evidence`（`tried_alternatives` ≥2 / `evaluate_dom_truth`，无 screenshot 字段）/ `new_tab_reproduced` / `action_path_is_vortex_native`。`coverage` 填 `pages_visited` / `anomalies` / `clean`。**若真无异常**：`anomalies: []` 且 observations 里写明"未发现异常 + 试了哪些非视觉路径"。

## 完成标志

`eval-observations-R11.md` 与 `anomalies-R11.json` 双双写完；json schema 合法；有异常则每条带完整证据链（无截图）；blindspot 类带 tried_alternatives。
