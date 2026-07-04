# M3 评估简报 — newbeta.bytenew dogfood（r10）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/30009/1086546`(工作流演示,10 行,有行操作 处理/转交/备注)。或工单表。

## 本轮场景(r10):综合任务链 多步 act —— descriptor 自愈 / stale ref 跨步稳态

**主考 vortex 能力**:一条**真实多步任务链**串起来跑,考 `vortex_act`/`fill`/`press` 的**跨步稳态**:每步后 DOM 变化导致上一步的 ref 失效(stale ref),vortex 能否 descriptor 自愈(observe 存的 role+name 重匹配)或引导重新 observe;多步链路里有无累积漂移/假成功。

### 任务链(工作流演示或工单表,≤35 次工具调用)

1. observe 工作流演示 → **筛选/切视图 tab**(如「待处理·5」)→ observe 回读行数变化。
2. **选中一行 checkbox**(表头「全选/取消」或行 checkbox)→ observe/query 回读选中态(checkedIcons 变化)。
3. **触发行操作**:点某行「处理」或「备注」按钮 → 弹出处理 dialog。
4. **dialog 内填写**:在处理 dialog 里 fill 文本框/select(如备注内容、处理结果)→ query mode=css 回读值落地。
5. **跨步 stale ref 考验**:故意用**第 1 步 observe 的旧 ref** 在第 3 步后再 act(此时 DOM 已变)→ vortex 是否报 stale + descriptor 自愈重匹配,还是静默错点?记录自愈行为。
6. **取消/关闭**(避免脏数据,不真提交)→ observe 回读 dialog 关闭 + 列表恢复。
7. **异常判定**(≥2 原生路径失败才记):多步链中某步 act 失败无法自愈、stale ref 静默错点(点到错元素)、累积状态漂移、fill 假成功、descriptor 自愈失败。blindspot:某中间态非截图无法确认。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r10.md`(逐步记:操作→ref→success?→回读→跨步 ref 是否 stale/自愈)
2. `anomalies-r10.json`(schema,cycle=`dogfood-newbeta-2026-07-04`)

## 完成标志

双产物写完;跑通一条 ≥5 步任务链(筛选/选中/行操作/dialog 填写/关闭)+ 至少一次故意 stale ref 自愈考验;有异常带 ≥2 tried_alternatives;报告:任务链是否跑通、stale ref 自愈行为、有无假成功/漂移/异常。不真提交避免脏数据。
