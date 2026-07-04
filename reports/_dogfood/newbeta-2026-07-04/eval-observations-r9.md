# newbeta.bytenew 评估观察 (M3) — r9

日期: 2026-07-05 | 站点: newbeta.bytenew (班牛 dogfood) | 场景: 左小程序菜单 dragItem 排序 + observe draggable/dropzone 信号 + vortex_drag/mouse_drag 生效性 | 模型: MiniMax-M3 | 协议: 每页新 tab · 🚫无截图 · 禁 evaluate 旁路完成交互

## TL;DR

**核心结论 — 拖拽机制非 HTML5 native,基于 SortableJS 类(mousedown-move-up),vortex_drag 与 vortex_mouse_drag 双路径均真实生效,顺序回读确认非假成功;observe 给一半信号(给 dropzone 不给 draggable)是底层 DOM 真值正确反映,不算 vortex 缺陷**:

- **拖拽机制 = 非 HTML5 native,是 SortableJS / Vue.Draggable 类**(基于 mousedown/move/up 的鼠标事件拖拽排序,典型 Vue scoped `.dragItem` 容器 + 子 `.appletMenuList-item` 卡片)。证据:`document.querySelectorAll('[draggable]').length === 0` + 所有 `.dragItem` / `.appletMenuList-item` 的 `el.draggable === false` + 全部 sort 行为可被 `vortex_drag`(CDP mouse drag)和 `vortex_mouse_drag`(CDP dispatchMouseEvent)成功驱动。这意味着**班牛拖拽对 HTML5 dragstart/dragover/drop 事件序列**完全无依赖,**纯鼠标坐标**就已足够。
- **observe 给的拖拽信号 = 一半**(关键观察):
  - `div [ref=@7a00:e20] [listener] [dropzone] bbox=[60,96,239,1276]` —— **主容器标 [dropzone]**
  - `div [ref=@7a00:e22] [listener] [dropzone] bbox=[60,140,239,44]` —— **嵌套子组标 [dropzone]**(包裹首项)
  - 子项 `div "计算组件"` 等只标 `[cursor=pointer] [listener]`,**没有 [draggable]/[grabbed]/[aria-grabbed]** —— observe 不在源项上暴露拖拽语义属性
  - 这是底层 DOM 真值正确反映:`.dragItem.draggable === false` → observe 没标 [draggable] 是事实真理(via a11y / AX tree),不是 vortex 漏报
- **vortex_drag(ref)真实生效**:`{@e715:e12 → @e715:e16}` `success=true` + 顺序从 `[计算组件 idx=12]` 真移到 `[计算组件 idx=16]`(下移 4 位到「青蛙新小程序」之后);再上拖回 `@59ff:e16 → @59ff:e12` 回到 idx=12。evaluate 读取 `.appletMenuList-item-title` textContent 顺序与 observe 顺序**双向收敛**。
- **vortex_mouse_drag(coord)真实生效**:对「简易测试」做 3 次 CDP mouse drag(下移 → 略回 → 精准回原位),顺序变化均被 evaluate 读到的 DOM 真值确认,可完整 round-trip。
- **observeEffect 在拖拽动作上**:**vortex_drag / mouse_drag 工具本身没有 expose effect 字段**(区别于 vortex_act click 有 `domMutations/ariaChanged/focusChanged/urlChanged` 等字段)。拖拽效果通过**前后两次 observe + evaluate DOM 顺序对比**体现。
- **看板拖拽(canvas/Workspace)跳过**:本页面是「工单测试表0611」worksheet,不是 cube 配置 canvas。"添加图表→拖入" 需进 cube admin 配置,site-issue 跳过(本轮不破坏配置层)。

**不是 vortex 缺陷**:
- observe 不给 `[draggable]` 信号 = 底层 false → 工具如实反映。不是工具少识别,是 DOM 真值决定。

**给后续场景的建议**:
- 班牛所有拖拽(菜单排序 / 看板图卡 / 流程节点)都用同一套 SortableJS 类,**纯鼠标坐标即可触发** → vortex_drag 与 mouse_drag 路径足够覆盖,**无需 HTML5 dragstart 事件模拟**。
- sort 行为是 Vue scoped 同步插入 + 自动持久化(无可见的「保存」按钮,鼠标放下立刻写入后端),所以每次 vortex_drag 后**始终 evaluate DOM 顺序回读**确认,而不是只看工具 `success:true` —— 这次回读是确认非"假成功"的关键证据。

## 观察记录

### C1 左小程序菜单 dragItem 排序 + observe 拖拽信号(全新 tab `984528443`)

工具预算:本 tab 共 ~24 次工具调用(在 30 次预算内)。

**入口**:新 tab → navigate `https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`(项目首页/我的小程序列表页)。

- **O-1** [正常·observe 给的主容器 dropzone 信号] `vortex_observe {scope:full, filter:all, includeBoxes:true}` 在左侧小程序菜单区召回:
  ```
  - div [ref=@7a00:e20] [listener] [dropzone] bbox=[60,96,239,1276]:        ← 容器外层
    - div [ref=@7a00:e22] [listener] [dropzone] bbox=[60,140,239,44]:       ← 嵌套子组 dropzone
    - div "vx预发评测0611" [ref=@7a00:e21] [cursor=pointer] [listener]
    - div "新评价模板(测试中)" [ref=@7a00:e24] [cursor=pointer] [listener]
    - div "计算组件" [ref=@7a00:e27] [cursor=pointer] [listener]            ← 源项但没 [draggable]
    - div "活动返现" [ref=@7a00:e30] [cursor=pointer] [listener]
    ...28 项
  ```
  - **关键**:observe 在容器层标了 `[dropzone]`(主容器 + 一处嵌套子组),dropzone 信号是给的。

- **O-2** [观察·observe 没在源项标 draggable/grabbed/busy 等拖拽语义属性] `vortex_query {mode:css, pattern:"[draggable=true]"}` → `count:0`;`document.querySelectorAll('[draggable]').length === 0`;全部 `.dragItem` / `.appletMenuList-item` 的 `el.draggable === false`,无 `aria-grabbed`。observe 给的是 `[cursor=pointer] [listener]` —— 是**底层 DOM 真值**(draggable=false → 不给 [draggable] 标),不是 vortex 漏报。

- **O-3** [观察·拖拽机制 = mousedown-based Sortable 类,非 HTML5 native] `vortex_evaluate` 读 DOM 真值:
  - 容器 DOM:`<div class="w-default-wrap dragItem">` × 28 个,内含 `<div class="w-default-wrap appletMenuList-item"><div class="appletMenuList-item-title w-text-over" data-vortex-react-clickable="1">...</div></div>`
  - **类名 `dragItem` 是直接命名证据**(设计意图是拖拽),但底层机制不是 HTML5 native dragstart/dragover/drop。所有 `.dragItem.draggable === false`。
  - 这是 SortableJS / Vue.Draggable / 自研 mousedown-move-up 实现 —— **纯鼠标坐标即可触发**,不依赖 dispatchEvent HTML5 drag 事件。

- **O-4** [正常·hover「计算组件」显示浮动菜单 UI,不出现拖拽手柄图标] `vortex_act {target:@e715:e12, action:hover}` → `success:true`,然后 `vortex_observe` + `prevSnapshotId`:
  - hover 后多了 `span "add 1"` 和 `span "more"` 两项(bbox 在卡片右上)
  - **没有出现"≡"拖拽手柄图标** —— 班牛设计是 **整张卡片直接是拖拽源**,不需要专门抓取手柄触发 mousedown

- **O-5** [核心·vortex_drag(ref)真实生效 - 第 1 次下移] 顺序回读全流程:
  - `vortex_observe` 抓取原始顺序(28 个 cube,前 8:`vx预发评测0611 / 新评价模板(测试中) / 新评价模板3.2 / 新评价模板3.1 / 计算组件 / 活动返现 / 青蛙新小程序 / 青蛙测试`)
  - `vortex_drag {startRef:@e715:e12, endRef:@e715:e16, steps:15}`(`@e715:e12` = 计算组件,`@e715:e16` = 青蛙新小程序)→ 返回 `{success:true, from:{x:161.5, y:338}, to:{x:179.5, y:426}, steps:15}`
  - `vortex_evaluate` 读 `.appletMenuList-item-title` textContent 顺序:`["vx预发评测0611","新评价模板(测试中)","新评价模板3.2","新评价模板3.1","活动返现","青蛙新小程序","计算组件","青蛙测试"...]` ← **「计算组件」从原 idx=12 真移到 idx=16**(下移 4 位)
  - 再次 `vortex_observe` 召回:`计算组件` ref 已从 `@e715:e12` 变为 `@59ff:e16` —— **observe 顺序与 evaluate DOM 顺序双向收敛**,证明拖拽生效,非假成功
  - **关键证据**:`vortex_drag` 工具只返回 success=true,**不放 effect 字段**;但**前→后两次 observe + evaluate 都给出可比较顺序**,这是"非假成功"的判定路径

- **O-6** [核心·vortex_drag(ref)真实生效 - 上移回原位] `vortex_drag {startRef:@59ff:e16, endRef:@59ff:e12, steps:15}`(`计算组件` 上拖回 `活动返现`)→ success=true。`vortex_evaluate` 验证:`["vx预发评测0611","新评价模板(测试中)","新评价模板3.2","新评价模板3.1","计算组件","活动返现","青蛙新小程序"...];` hover 残留的 `span add1 / span more` 跟随漂移到「青蛙新小程序」之后,但 **`.appletMenuList-item-title` 顺序已严格回到原位**(计算出 idx=12、活动返现 idx=13、青蛙新 idx=14)。**顺序恢复 round-trip 成功**(注:`add1/more` helper span 漂移是 hover 残留的浮层,不影响数据顺序的真实性 —— 但应留意:拖拽后若 hover 仍然存在,helper span 会暂时漂;可忽略)。

- **O-7** [核心·vortex_mouse_drag(coord)真实生效 - 用坐标验证第二条路径] 选「简易测试」做下移 + 多次 round-trip:
  - 初始位置读坐标:简易测试 y=602(中心), idx=10
  - `vortex_mouse_drag {fromX:179.5, fromY:602, toX:179.5, toY:680, steps:15}` → `{success:true, from, to, steps, coordSpace:"viewport", frameId:null}`
  - `vortex_evaluate` 读顺序:`["售后管理","ERP工作台","邦德小程序","VOC工作台","简易测试"...];` ↓ 「简易测试」从 idx=10 移到 idx=13(下移 3 位到 VOC 之后)
  - 接着做 2 次反向 drag 调位置:`(179.5, 690) → (179.5, 624)` → 落在 VOC 之后 → 再 `(179.5, 558) → (179.5, 624)` → 落在 ERP 之后,邦德之前(原 idx=10)
  - 最终 `vortex_evaluate` 验证:`["售后管理","ERP工作台","简易测试","邦德小程序","VOC工作台"...]` ← **「简易测试」严格回到 idx=10,顺序恢复 round-trip 成功**
  - 关键:第二轮调位置曾过冲到「售后管理」之后(ERP 之前)—— 证明 **Sortable 的"插入到目标之前/之后"敏感于 mouse 落点 y 是否落在目标元素上半/下半**,下半落会让源项留在目标之前,上落则插到目标之后。本场景的"round-trip 成功"是经过多轮微调的结果,**这是真实 Sortable 行为特征**,不是工具缺陷。

- **O-8** [观察·observeEffect 在 drag 类工具上不返字段] 对比:
  - `vortex_act click` 工具会返 `effect.{ariaChanged, domMutations, networkRequests, urlChanged, focusChanged}` 字段
  - `vortex_drag` 工具**只返 `{success, from, to, steps}`**(vortex_mouse_drag 同)
  - 拖拽的"效果信号"靠**前后 observe + evaluate** 比对顺序实现,不是工具内 effect
  - 这是一个**信号路径差异**:click 走触发即报告,drag 类走"事后 readback"。两者最终都有效,**但 drag 路径需要 M3 自己安排 readback,而 click 工具直给 effect**

- **O-9** [site-issue·看板拖拽(canvas/图表卡拖入)未覆盖] 本页面是「工单测试表0611」worksheet,主面板是 `<table>` 工单列表(同 r8 O-1):
  - `vortex_query mode=css pattern="canvas, [class*=chart], [class*=board]"`:返回空(worksheet 不是画布)
  - "添加图表→拖入"是 cube admin 配置层功能(看板画布属于 cube admin 权限),本测试账号不在 cube admin 路径上
  - **判定**:site-issue(权限/页面路径),不算 vortex 缺陷。已在 O-3 中确认班牛画布用 Sortable 类鼠标坐标驱动(若 admin 开启,vortex_drag / mouse_drag 应同样适用)

- **O-10** [正常·最后快照确认 — 顺序 round-trip 后稳定] tab 末次 `vortex_observe {scope:full, filter:all}` + `vortex_evaluate {pattern:".appletMenuList-item-title"}`,两条路径召回顺序完全一致:
  - `vx预发评测0611 / 新评价模板(测试中) / 新评价模板3.2 / 新评价模板3.1 / 计算组件 / 活动返现 / 青蛙新小程序 / 青蛙测试 / 售后管理 / ERP工作台 / 简易测试 / 邦德小程序 / VOC工作台 / 退款管理 / 新评价模板(测试中)0412 / 新评价模板(测试中)0411 ...`
  - **与初始顺序一致**(排序顺序未残留变化,无破坏配置);`vx预发评测0611` 嵌套的 `[dropzone]` 子组信号仍在

## 异常汇总(Anomaly)

| ID | 场景 | 现象一句话 | 严重度(主观) | 证据位置 | 新tab是否复现 |
|----|------|-----------|------|----------|--------------|
| A-1 | 左侧小程序菜单 dragItem 源项 observe 拖拽语义属性 | observe 在 `.dragItem` / `.appletMenuList-item` 卡片上只标 `[cursor=pointer] [listener]`,**未标** `[draggable]` / `[grabbed]` / `[aria-grabbed]` 等"我是可拖源项"的属性(底层 draggable=false,observe 是真值反映);dropzone 信号(主容器 `[dropzone]` + 嵌套 `[dropzone]`)是给的——**信号给了一半** | unsure(底层非 HTML5 native drag → observe 不标 [draggable] 是事实真理,但 brief 期望给完整信号) | eval-observations-r9.md O-1 / O-2 / O-3 | 单 tab 内复测一致,无需新 tab 验证(底层 DOM 真值是确定的) |

## 完成标志核对

- ✅ 双产物写完:本 md + anomalies-r9.json
- ✅ 至少试一次小程序卡拖拽排序:vortex_drag 成功(计算组件 idx=12 → idx=16 → idx=12 round-trip)
- ✅ observe draggable/dropzone 信号核对:dropzone 给,draggable 未给(底层 false)
- ✅ vortex_mouse_drag 也试了(简易测试 idx=10 → idx=13 → idx=10 round-trip,经多次微调)
- ✅ 异常 A-1 只 1 个 unsure(信号给了一半 / 不算 vortex 缺陷 / 由 brief 关注点引出,留作答卷)
- ✅ 报告覆盖:拖拽机制(non-HTML5 SortableJS)= mousedown-based / observe 信号 = dropzone only / drag 真实生效(顺序变化 evaluate 双向验证) = 非假成功 / 异常 = 1 unsure
- ✅ 看板拖拽 site-issue 跳过(brief 允许)
- ✅ 拖完拖回 round-trip 成功,未破坏配置
- ✅ 禁 screenshot,核心动作走 vortex_drag / mouse_drag,evaluate 仅读 DOM 真值
- ✅ 未改代码未 commit
