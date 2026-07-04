# M3 评估简报 — newbeta.bytenew dogfood（r5）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`(工单测试表0611);更多行的表:切「工作流演示」卡(10 行)。

## 本轮场景(r5):分页/筛选/下拉/排序 act + observe 状态回读

**主考 vortex 能力**:`vortex_act`(select/click) 对班牛分页器、每页条数下拉、列排序、视图 tab、筛选条件的操作正确性,以及**操作后用 observe/query 回读状态变化**(排序箭头方向、当前页、每页条数、tab 高亮、筛选生效行数)。

### 步骤(每场景尽量新 tab,≤30 次工具调用)

1. **每页条数下拉**:工单表底部「10条/页」下拉(readonly textbox) → `vortex_fill widget=select` 或 `vortex_act` 改成「20条/页」→ observe/query 回读是否变。
2. **列排序**:点某列表头排序箭头(如「创建人」旁 arrow 或点表头)→ observe 回读排序状态(箭头 asc/desc/none、aria-sort)是否表达 + 数据是否重排。
3. **视图/状态 tab**:工作流演示的「待处理·5 / 待领取·5」或「流程待办/流程工单/全部工单」tab → act 点切换 → observe 回读高亮 tab 变化 + 行数变化。
4. **筛选生效**:工单表「筛选」展开 panel → 加一个条件(如任务状态=待处理)→ 点「筛选」→ observe/query 回读结果行数/筛选态。
5. **分页翻页**(若有多页):点下一页 → observe 回读当前页码变化。
6. **异常判定**(≥2 原生路径失败才记):act 对分页/下拉/排序/tab 失败;操作 success 但状态未变(假成功);observe 回读不到状态变化(排序方向/当前页/tab 高亮 aria 缺失)。blindspot:某状态非截图无法确认。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r5.md`(每操作记:操作→success?→observe/query 回读状态→是否符合预期)
2. `anomalies-r5.json`(schema,cycle=`dogfood-newbeta-2026-07-04`,无异常 `anomalies:[]`)

## 完成标志

双产物写完;分页/每页条数/排序/视图 tab/筛选 至少各试一次「操作+回读」;有异常带 ≥2 tried_alternatives;报告:哪些操作+回读正常、有无假成功/状态回读缺失。
