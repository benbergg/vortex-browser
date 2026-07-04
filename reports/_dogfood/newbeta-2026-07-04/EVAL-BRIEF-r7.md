# M3 评估简报 — newbeta.bytenew dogfood（r7）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255` → observe 左侧小程序卡,点开**未探过**的:优先「计算组件」「新评价模板3.2」「产品体验大盘」(在评价管理演示专用子项里)/「售后管理」/「ERP工作台」。

## 本轮场景(r7):探未知 template app 组件 —— 自适应发现新控件类型

**主考 vortex 能力**:对班牛尚未评测过的小程序,`vortex_observe`/`extract`/`query` 能否正确识别其中的**新组件类型**(特殊控件/图表/富文本/公式/树/穿梭框等),act 能否操作。**开放探索**:哪种控件是 observe 召回不到 / act 操作不了 / 只能截图识别的?

### 步骤(每 app 新 tab,≤30 次工具调用,探 3-4 个 app)

1. 逐个点开未探 app → `vortex_observe {filter:interactive}` 看主组件构成。
2. 遇到**非普通表格/表单**的控件(图表/公式编辑器/树控件/穿梭框/富文本/日历/评分/开关组/标签云等):
   - observe 是否召回?role/name 是否合理?
   - act 能否操作(click/fill/select)?
   - 若是图表(echarts/G2 canvas):observe 是否给 blindspot 信号?数据能否非截图读(query/extract)?
3. **产品体验大盘**(评价管理演示专用子项,名字像图表):重点看有无真图表 + observe 的 chart blindspot 信号 + 非截图数据 readback 边界。
4. **异常判定**(≥2 原生路径失败才记):某新控件 observe 漏召回 / act 操作失败 / 状态读不到。blindspot:某控件只能截图识别→记 `[blindspot]` + tried_alternatives。
5. 撞登录墙/无权限/空 app → 记 site-issue 跳过,不算 vortex 异常。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r7.md`(每 app 记:主组件类型、有无新控件、observe/act 表现、有无 blindspot)
2. `anomalies-r7.json`(schema,cycle=`dogfood-newbeta-2026-07-04`;blindspot 类 phenomenon 以 `[blindspot]` 开头)

## 完成标志

双产物写完;探了 ≥3 个未评测 app;列出发现的新控件类型及 observe/act 表现;有异常带 ≥2 tried_alternatives;报告:发现哪些新控件、哪些 vortex 处理好/处理不了/blindspot。
