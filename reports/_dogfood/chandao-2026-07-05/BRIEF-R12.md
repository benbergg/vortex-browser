# M3 评估简报 — 禅道(chandao) dogfood（R12）· 🚫截图硬门槛

> 你（MiniMax-M3）是本轮评估的**执行者 + 记录者**。唯一职责：用 vortex MCP 工具操作目标站,如实记录"我做了什么 / 工具返回了什么 / 看到了什么" + 证据。不做根因诊断、不读 vortex 源码、不改代码、不提交 git。

## 🚫 截图硬门槛（最高优先级）
1. **禁止 `vortex_screenshot`**。识别一律走非视觉工具(observe / query 各 mode / extract)。
2. 凡"非截图无法识别"→ 记 `[blindspot]` 异常,phenomenon 以 `[blindspot]` 开头,填 `evidence.tried_alternatives`(≥2 条非视觉路径的返回)。
3. 看不清本身就是要上报的缺陷,不要截图绕过。

## 🔴 防缓存漂移
1. 每个详情页用**全新 tab**(`vortex_tab_create`),评完 `vortex_tab_close`,不在单 tab 内连续 navigate。
2. 每 tab ~30 调用内。撞异常立刻新 tab 复测最小序列,标注旧/新 tab 是否复现。

## 🔴 裁决来源唯一（防造假）
1. 成功/失败只依据 `vortex_act`/`vortex_fill`/`vortex_press`/`vortex_observe` 返回值。
2. `vortex_evaluate` 只读 DOM 真值作证据(填 `evidence.evaluate_dom_truth`),禁止用它完成交互或代替工具判定。
3. 每条异常填 `tried_alternatives`(≥2 条原生路径失败) + `action_path_is_vortex_native`。

## 铁律
1. 只记观察不做根因。2. 每条异常带证据(工具返回+evaluate真值+query readback,无截图)。3. 区分"工具缺陷"与"操作失误"(至少试 2 种路径)。4. 覆盖详情页多个区域(字段区/工时表/评论/操作栏)。

## 目标站 & 本轮场景

- **禅道**:根 URL `https://chandao.bytenew.com/zentao/`(已登录态用户青蛙)。
- **本轮场景（R12）:任务详情字段读取（只读评测）**
  - 打开任务详情 `https://chandao.bytenew.com/zentao/task-view-44929.html`(未开始任务,备选:先开 /zentao/my-work-task.html 从列表点一个任务名 link 进详情)。
  - **核心考查:label-value 字段配对的非截图识别**。禅道详情页字段常是 `<th>标签</th><td>值</td>` 或 `<div class="detail-title">标签</div><div class="detail-content">值</div>` 分离结构。读出并配对:所属项目 / 所属执行 / 优先级 / 状态 / 指派给 / 截止日期 / 预计工时 / 已消耗 / 剩余 / 由谁创建 / 抄送给。
    - 试 observe(能否给出 label 与 value 的关联) / query mode=css(定位 .detail-* 或 th/td) / extract(整块文本能否保留 label:value 顺序)。
    - **重点判定**:若 label 和 value 在 DOM 上分离,observe/extract 输出能否让 agent 正确配对(哪个值属于哪个字段)?配不上=记 `[blindspot]` 或异常。
  - **富文本描述**:任务描述可能含 HTML(列表/加粗/链接)。extract 读描述正文,判断格式是否丢失语义。
  - **工时记录**:详情页若有"工时"表(estimate/consumed/left 记录),读表格行。
  - **操作栏**:observe 召回详情页操作按钮(开始/完成/编辑/关闭/评论),判断可交互元素召回是否完整。
  - **详情页承载方式**:用 evaluate 读 `document.querySelectorAll('iframe').length` + `document.body.className`,记录详情是整页还是 iframe 内(影响 frameId 需求)。
  - 全程禁截图。

## 工具（仅 vortex MCP,无截图）
- 识别/读值:`vortex_observe`(filter=interactive 优先,frames=all-permitted 穿 iframe) / `vortex_query`(mode=text/css/component/geometry/style;**attr 读多属性可用逗号或竖线分隔,如 attr="class,title"**) / `vortex_extract`(scroll=true 懒加载)。
- 交互:`vortex_act` / `vortex_press` / `vortex_wait_for`。
- 证据(只读):`vortex_evaluate` / `vortex_tab_create` / `vortex_tab_close` / `vortex_tab_list`。

## 输出（双产物,缺一不可）
1. `reports/_dogfood/chandao-2026-07-05/eval-observations-R12.md`(人读):观察记录每条标 [正常]/[异常]/[blindspot],带证据;结尾不写根因/建议。
2. `reports/_dogfood/chandao-2026-07-05/anomalies-R12.json`:严格符合 `reports/_dogfood/anomalies.schema.json`;字段 id/page/component/primitive/action_sequence/phenomenon/m3_severity/evidence(tried_alternatives≥2,无 screenshot)/new_tab_reproduced/action_path_is_vortex_native;coverage 填 pages_visited/anomalies/clean;无异常则 anomalies:[] 且 observations 写明试过哪些非视觉路径。

## 完成标志
双产物写完;json schema 合法;异常带完整证据链(无截图);blindspot 类带 tried_alternatives。
