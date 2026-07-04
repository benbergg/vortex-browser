# M3 评估简报 — newbeta.bytenew dogfood（r4）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁用 evaluate 完成交互**(evaluate 仅读 DOM 真值作证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`(工单测试表0611)

## 本轮场景(r4):弹窗/浮层 模态作用域 observe

**主考 vortex 能力**:`vortex_observe` 对班牛各类弹层的**模态作用域裁剪**——弹窗打开后 observe 是否只出弹窗内容 + `# modal:` 元信息(裁掉背景),背景元素带 `[behind-modal]`(filter=all 逃生口);嵌套浮层(dialog 内再开 popover/下拉)作用域是否正确;弹窗内控件召回完整性 + act 可用性。

### 步骤(每弹层新 tab 或同 tab 顺序,≤30 次工具调用)

1. 打开工单表 tab → observe。
2. **筛选 dialog**:点「 筛选」按钮 → `vortex_observe {filter:interactive}`:是否只出筛选面板内容 + `# modal:` 行?背景(左侧小程序/表格)是否被裁(filter=interactive)或标 `[behind-modal]`(filter=all)?筛选面板内控件(字段下拉/条件/确定/取消)召回是否完整?试 act 点一个筛选条件。
3. **流程 dialog(多 tab 弹窗)**:点「流程」按钮 → 弹出含「流程设置/流程权限/提醒设置/自动分配/流程参数/流程数据/流程布局」的 dialog → observe:tab 项是否召回?切一个 tab(如 act 点「流程参数」)后 observe 内容是否更新?
4. **列表设置 popover**:点「列表设置」→ observe:popover(含搜索框+列勾选)是否正确作用域?
5. **嵌套浮层**:在某个 dialog 内再触发下拉/popover(如筛选面板里的字段选择下拉)→ observe:内层浮层是否正确处理,还是被外层 dialog 作用域吞掉/漏召回?
6. **关闭恢复**:关闭弹窗后 observe 是否恢复到背景全量(无残留 `# modal:`/`[behind-modal]`)?
7. **异常判定**(≥2 原生路径失败才记):弹窗内控件 observe 漏召回、模态作用域裁错(该裁的背景没裁/该出的弹窗内容没出)、嵌套浮层丢失、act 对弹窗内控件失败、关闭后作用域不恢复。blindspot:某弹层内容非截图无法识别。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r4.md`(每个弹层记:是否有 `# modal:` 行/背景是否裁/内控件召回/act 结果)
2. `anomalies-r4.json`(schema,cycle=`dogfood-newbeta-2026-07-04`,无异常 `anomalies:[]`)

## 完成标志

双产物写完;筛选/流程/列表设置 三类弹层 + 至少一个嵌套浮层都试过 observe 作用域;有异常带 ≥2 tried_alternatives;报告:模态裁剪是否正确、嵌套浮层是否丢、有无异常/blindspot。
