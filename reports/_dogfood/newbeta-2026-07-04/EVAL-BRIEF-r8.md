# M3 评估简报 — newbeta.bytenew dogfood（r8）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255` → 切「工作流演示」卡(或直接开 `#/applet/appNew/projectNew/30009/1086546`)。

## 本轮场景(r8):流程布局画布 —— 流程图非截图 readback 边界

**主考 vortex 能力**:工作流「流程」按钮 → 「流程布局」进入 admin 流程设计器(可能是 x6/antv/logic-flow 画布)。**不用截图**,能否读出流程图结构(节点、连线、节点类型、流转关系)?vortex 有 `query mode=flow`(流程图→mermaid)——测它对班牛流程画布是否适用;若不适用,observe 是否给 canvas/flow blindspot 信号(优雅降级)?

### 步骤(新 tab,≤30 次工具调用)

1. 开工作流演示 → observe 找「流程」按钮 → `vortex_act click` → 找「流程布局」→ `vortex_act click` 进入流程设计器。
2. **判断画布类型**:`vortex_query mode=css pattern="canvas"` / `pattern="svg"` / `pattern=".x6-graph, [class*=x6], [class*=antv], [class*=logic-flow], [class*=flow-node], [class*=flow-edge]"` 看画布库。
3. **mode=flow readback**:`vortex_query mode=flow pattern="*"`(或按工具签名)——能否输出 mermaid 流程图(节点+连线)?对比画布真实节点。
4. **observe blindspot 信号**:observe 对流程画布是否给 `[blindspot=canvas]` / `[blindspot=...]` 降级信号,还是静默漏(空树)?节点是否作为 DOM 元素被 observe 召回(若是 DOM 渲染的 flow)?
5. **节点交互**:能否 act 点击/拖拽画布节点?
6. **异常/blindspot 判定**:mode=flow 不适用 + observe 无 blindspot 信号 + 节点非截图读不到 → 记 `[blindspot]`(流程画布 readback 盲区),填 tried_alternatives(mode=flow / mode=css / observe / extract 各返回)。若画布本就是 DOM 节点且 observe 召回良好 → 记为已处理。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r8.md`(画布库类型、mode=flow 输出、observe blindspot 信号、节点召回、非截图 readback 边界)
2. `anomalies-r8.json`(schema,cycle=`dogfood-newbeta-2026-07-04`;blindspot 类 phenomenon 以 `[blindspot]` 开头)

## 完成标志

双产物写完;进入流程布局画布,判断画布库 + 试 mode=flow + 看 observe blindspot 信号;明确流程图非截图 readback 是否可行/是否 blindspot;报告:画布类型、mode=flow 是否适用、observe 降级信号是否给出、是否 blindspot。
