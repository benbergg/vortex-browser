# M3 评估简报 — newbeta.bytenew dogfood（r2）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁用 evaluate 完成交互**（evaluate 仅读 DOM 真值作证据）。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站（已登录态）

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`（工单测试表0611）

## 本轮场景（r2）：新建工单 表单填写 fill/fill_form + readback 校验

**主考 vortex 能力**：`vortex_fill` / `vortex_act(fill)` 对班牛表单各类控件（文本框/下拉 select/日期/单选/多选）的写入正确性，以及 **写入后用非视觉手段回读校验值真落地**（`vortex_query mode=css` 读 value/checked、`vortex_query mode=component` 读 Vue state）。

### 步骤（全新 tab，≤30 次工具调用）

1. 打开工单表 tab → `vortex_wait_for {mode:idle}` → `vortex_observe {filter:interactive}`。
2. 点「 新建」按钮（observe 里 name=" 新建" 的 button）打开新建工单表单/弹窗 → observe 表单内所有字段（文本框/下拉/日期/单选多选）。
3. **逐控件 fill + 回读校验**（每个都要"写→读→比对"）：
   - **文本框**：`vortex_fill {target:<ref>, value:"vortex测试工单"}` → `vortex_query mode=css pattern="<该 input 选择器>" attr="value"` 确认回读=写入值。
   - **下拉 select**：`vortex_fill {target:<ref>, value:"<选项>", widget:"select"}`（或 aria-select）→ observe 或 query 确认选中项变化。
   - **日期**（若有）：`vortex_fill {widget:"daterange"/"time", ...}` → 回读。
   - **单选/多选**（若有）：`vortex_act {action:click}` 或 `vortex_fill {widget:"checkbox-group"}` → `query mode=css attr="checked"` 回读。
4. **异常判定**（≥2 条原生路径失败才记）：
   - fill 返回 success 但 **query mode=css 回读值 ≠ 写入值**（写入假成功）——**重点抓这个**。
   - fill 对某 widget 报错 / 定位不到 / NOT_ATTACHED，且换 observe 拿 ref 再 fill 仍失败。
   - 复合控件（cascader/daterange/select）fill 后状态不对。
5. **blindspot**：若某控件 fill 后无法用任何非视觉手段（css value / component state / observe）确认是否成功 → 记 `[blindspot]`。
6. 填完**不要提交**工单（避免脏数据）；若必须点了保存，记录但标注。

## 产出（写到 `reports/_dogfood/newbeta-2026-07-04/`）

1. `eval-observations-r2.md`（每个控件写清"写入值 / css 回读值 / 是否一致"）
2. `anomalies-r2.json`（schema 合法，cycle=`dogfood-newbeta-2026-07-04`，无异常则 `anomalies:[]`）

## 完成标志

双产物写完；每个测过的控件都有"写→读→比对"三元组；有异常带 ≥2 tried_alternatives；完成后报告：测了哪些控件类型、有无 fill 假成功/回读不一致。
