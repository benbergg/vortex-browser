<!-- docs/dogfood-lessons.md -->
# 班牛 / LogicFlow dogfood 经验沉淀(2026-06-13 实测校正)

## 1. 拖拽连线(LogicFlow / AntV X6 / 类 pointer 库)
- ❌ 误区:"CDP 拖拽不触发 PointerEvent,要加 force 模式"——**错**。实测 vortex_mouse_drag
  已触发完整 trusted pointerdown/pointermove/pointerup(buttons=1)。
- ✅ 真因是**坐标定位**:LogicFlow 锚点是 ~20px 的小 SVG 圆,且画布 transform 平移 +
  容器 offset 会让"用内部 graph 坐标算出来的位置"偏几十像素。
- ✅ 正确打法:
  1. 先选中/hover 节点让锚点出现(`lf.selectElementById` 或点击节点)。
  2. **用 DOM `getBoundingClientRect` 取锚点圆真实屏幕中心**(`.lf-node-anchor-hover`),
     不要用 transform 反算坐标。
  3. `vortex_mouse_drag` 从源锚点中心拖到目标节点体,`stepDelay>0` 给连边引擎时间。
  4. 验证:读 `lf.getGraphData().edges` 是否新增,而非看截图。

## 2. 等待视觉变化(toast / 弹窗)—— wait_for 已够用,勿造新原语
- `vortex_wait_for mode=element value='.el-message'` 等 toast 元素出现。
- `vortex_wait_for mode=custom value="document.querySelector('.el-message')?.textContent?.includes('发布成功')"`
  等 toast 文本。
- ❌ 不需要新增 mode=mutation,custom 已覆盖。

## 3. 节点删除 Delete 失效 —— 是班牛缺陷,不是 vortex
- 实测 `lf.options.keyboard.shortcuts` 未注册 Delete/Backspace。keydown 经 CDP 正常
  冒泡到 document/window,vortex 侧无问题。删除请用班牛 Undo 或 lf API,或推动班牛补键绑定。

## 4. 班牛双 state 陷阱
- `lf.addEdge/deleteEdge`(纯 API)**不同步** `taskFlowData`,但**交互式拖拽会**(走 edge:add
  → 班牛 dirty/save 流程)。自动化优先走交互式拖拽路径,而非直接调 lf API。

## 5. silent fail 判读
- click 后 `effect.networkRequests===0` 且 url/focus/aria 全 false = 强阴性(很可能没生效)。
- `domMutations` 高 = 弱阳性(SPA re-render 噪声,≠生效)。
- 流程发布这类"有请求无反馈"是产品 BUG,vortex effect 信号已能提示,勿误判为 vortex 缺陷。
