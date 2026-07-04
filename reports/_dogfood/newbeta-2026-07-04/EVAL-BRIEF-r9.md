# M3 评估简报 — newbeta.bytenew dogfood（r9）· 🚫截图硬门槛

> 执行者+记录者。**禁 screenshot、禁改代码、禁提交、禁 evaluate 完成交互**(evaluate 仅读 DOM 真值证据)。先读 `reports/_dogfood/EVAL-BRIEF-noshot.template.md`。

## 目标站(已登录态)

`https://newbeta.bytenew.com/app.html#/applet/appNew/projectNew/58860/1838255`

## 本轮场景(r9):拖拽 drag + observeEffect

**主考 vortex 能力**:`vortex_drag` / `vortex_mouse_drag` 对班牛拖拽面的操作正确性,以及 observe 对拖拽源/投放区的信号(`[draggable]` / `[dropzone]`)。班牛拖拽面主要是**左侧小程序菜单 dragItem 排序**(HTML5 draggable 或鼠标拖拽);看板「添加图表→拖入」是 admin 配置。

### 步骤(≤30 次工具调用)

1. `vortex_observe {filter:interactive}` 左侧小程序菜单区:observe 是否给小程序卡 `[draggable]`(拖拽源)/ `[dropzone]`(投放区)信号?dragItem 是 HTML5 `draggable=true` 还是 mousedown 拖拽?(`vortex_query mode=css pattern="[draggable=true]"` 看数量)。
2. **拖拽排序**:选两个相邻小程序卡(如「计算组件」「活动返现」)→ `vortex_drag {startRef, endRef}`(或 `vortex_mouse_drag` 坐标)交换顺序 → observe 回读顺序是否变。**注意别拖坏重要配置**,拖完可拖回。
3. **observeEffect**:拖拽动作能否带效果信号(DOM mutation/顺序变化)?
4. **看板卡拖拽**(若可达且安全):看板「添加图表」拖入面板 —— admin 操作,谨慎;不可达则跳过记 site-issue。
5. **异常判定**(≥2 原生路径失败才记):drag 对 draggable 元素失败;observe 漏 `[draggable]`/`[dropzone]` 信号(该有拖拽语义却没标);drag success 但顺序未变(假成功)。blindspot:拖拽结果非截图无法确认。
6. 若班牛拖拽需 HTML5 dragstart/dragover/drop 事件序列而 vortex_drag 用鼠标事件不触发 → 这是真实拖拽机制不匹配,重点记录(tried_alternatives 写清 drag/mouse_drag 各自返回 + 顺序回读)。

## 产出(写到 `reports/_dogfood/newbeta-2026-07-04/`)

1. `eval-observations-r9.md`(拖拽机制 HTML5 vs mouse、observe draggable/dropzone 信号、drag 是否生效、顺序回读)
2. `anomalies-r9.json`(schema,cycle=`dogfood-newbeta-2026-07-04`)

## 完成标志

双产物写完;至少试一次小程序卡拖拽排序 + observe draggable/dropzone 信号核对;有异常带 ≥2 tried_alternatives;报告:拖拽机制、observe 信号是否给、drag 是否生效/假成功、有无异常。
