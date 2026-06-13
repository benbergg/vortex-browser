# Ant Design Pro 评估 — Opus 校验确认缺陷清单

- **日期**: 2026-06-13
- **站点**: https://preview.pro.ant.design
- **来源**: `eval-observations.md`(M3 评估,32 条观察,7 条 anomaly!=none)
- **校验方法**: 对每条 anomaly 独立白盒读码 + vortex MCP 真站 live 复现,不锚定 M3 措辞

> 结论:6 类异常 → **2 个确认的 vortex 层缺陷(均 P1)** + 4 项非缺陷(站点行为 / 工具正确行为)。

---

## 确认的 vortex 层缺陷(进迭代)

### A1 — Modal/弹层内 fill 因重复 id 命中背后元素 → OBSCURED

- **现象**: 在 antd Pro "新建规则" Modal 内 `vortex_fill(@ref name/desc)` 连续 `TIMEOUT: OBSCURED`(force=true / wait_for idle 均无效)。
- **复现(live)**:
  - 打开 Modal 后 `document.querySelectorAll('#name').length === 2`(页面 search 表单 + Modal 各一个,均 `id="name"`)。
  - `document.querySelector('#name')` 返回 **nodes[0] = 弹窗背后的 search input**(`closest('.ant-modal')===null`);其中心点 `elementFromPoint` 命中 `DIV.ant-modal-container`(被 mask 遮挡)→ `topIsSelf=false` → OBSCURED。
  - Modal 内真 input = nodes[1](`topIsSelf=true`,本可成功)。
  - 经真 MCP:`vortex_fill(@f939:e51)`(observe 标注的 Modal 内"规则名称")→ `TIMEOUT: OBSCURED`,端到端坐实。
- **白盒**: `packages/extension/src/handlers/observe.ts:902`
  ```js
  if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
  ```
  `buildSelector` 的 **id 分支无唯一性守卫**,直接返回 `#id`。对比同函数路径分支 `observe.ts:958`(`if (document.querySelectorAll(sel).length > 1)` → 戳 `data-vortex-rid`)与 aria-label 分支 `observe.ts:921`(`ariaLabelCount.get(...)===1`)均有唯一性检查 —— **唯独 id(及 testid 分支 905)缺**。observe 给 Modal input 存的 selector=`#name`,`resolveTarget`(`lib/resolve-target.ts:55`)取回 `hit.selector`,actionability `querySelector('#name')` 命中第一个(背后)元素 → OBSCURED。
- **判定**: 真 / vortex 层 / 根因: buildSelector id(及 testid)分支未校验 id 在文档内唯一,重复 id 时 ref 解析到错误元素。
- **严重度**: **P1**。重复 id 是无效 HTML 但真实应用极常见(Modal/Drawer 覆盖同结构表单时,antd Pro / Element Plus 都复用同一 `id`);任何"弹层内表单"场景中招,是高频 dogfood 卡点族。
- **修复方向(留 Task 4 细化)**: id 分支加唯一性守卫 `el.id && valid && document.querySelectorAll('#'+CSS.escape(el.id)).length === 1`,否则 fall through 到路径/rid 分支。testid 分支同理(可顺带)。需补单测(重复 id → 落 rid)+ 真站 / synth fixture 回归。

### A5/A6 — toastHit 命中常驻 `[aria-live]` 包裹 → userFeedback 假阳(0006 V-2 回归)

- **现象**: 点"查询"/Modal"确定"后 `effect.toastHit:["[aria-live='polite']"]` → `userFeedback:"toast"`,但同刻 `.ant-message` textContent 为空(无真 toast)。
- **复现(live)**: **稳态**(无 click、无 toast)下复刻 `collectFeedback` 的 `isVisible` 逻辑枚举 `TOAST_SELECTORS`,`[aria-live='polite']` 命中 **4 个 `.ant-spin` 容器**(1056×1027 / 252×154 等,`isVisible=true`,textContent 为页面内容如"规则名称描述...")。antd `<Spin>` 用 `<div class="ant-spin" aria-live="polite">` 永久包裹表格/抽屉区 → **每次 click 必 toastHit → userFeedback 恒为 "toast"**。
- **白盒**:
  - `packages/shared/src/click-effect.ts:22-23` `TOAST_SELECTORS` 含 `"[aria-live='polite']"` / `"[aria-live='assertive']"`(0006 Task V-2 加入)。
  - `packages/extension/src/page-side/click-effect.ts:168-177` `collectFeedback` 仅 `isVisible(n)` 守卫(`click-effect.ts:135`,要求 `width>0&&height>0`+checkVisibility),**不查 textContent、不判瞬态、不区分 click 前后是否新增**。`.ant-spin` 包裹既可见又有内容,稳过守卫。
- **判定**: 真 / vortex 层 / 根因: `[aria-live]` 选择器过宽,匹配常驻 live-region 内容包裹(spinner / SR 区)而非瞬态 toast,毒化 userFeedback 信号。
- **严重度**: **P1**。V-2 本意是提供可靠 silent-fail 信号;一个"每次必命中"的选择器使 `userFeedback="toast"` 在所有用 antd Spin 的页面(ProTable/ProList/几乎所有可加载区)失去判别力,违背 V-2 设计初衷。
- **修复方向(留 Task 4 细化)**: 二选一/组合 ——(a) 从 TOAST_SELECTORS 去掉裸 `[aria-live]`,只留框架专属 toast 类(`.ant-message`/`.el-message`/...);(b) toast 检测改 delta:仅计 click 后**新增/变化**且 `role=status|alert`、文本非空、尺寸有界的元素。需补单测(`.ant-spin[aria-live]` 稳态不计 toast)+ 真站回归。**注意**:此为 0006 V-2 引入的回归,修复须回看 [[vortex_0006_bangniu_dogfood_attribution]] V-2 设计意图,勿过度收窄漏掉真 ARIA toast。

---

## 附录:非缺陷(不进迭代)

### A2 — setting Drawer 自定义把手 close 图标 OBSCURED(边界,P2)
点 `ant-pro-setting-drawer-handle` 内 `span.anticon-close`(x=1406,y=254)→ OBSCURED。live 诊断:该图标 `pathCount=1`(**非** A1 歧义),但中心点 `elementFromPoint` 命中 `DIV.ant-drawer-body`(把手被抽屉面板覆盖)。vortex OBSCURED 保护**判定正确**。标准 antd `button.ant-drawer-close` 是居中按钮(elementFromPoint 命中自身/子 svg)不受影响 —— M3 恰好点到这个负偏移非典型把手。Escape 是正确兜底。最多可作 P2 优化(若 elementFromPoint 命中可转发点击的覆盖层是否放行),非缺陷。

### A3 — observe viewport scope 含部分视口外元素(非缺陷)
`observe.ts:1751-1756` viewport 门为 `rect.bottom>0`(部分可见即纳入)+ `observe.ts:1730-1750` 文档化的 `visuallyHiddenActionable` 离屏可交互豁免(GitHub/MDN/淘宝族级问题,有意设计)。M3 见的 y=-20 = 行顶略超视口但 bottom 仍 >0 = 正确的部分可见纳入。M3「observe_miss」属推测。

### A4 — ProTable 不读 URL `?current=2`(站点行为)
直接导航 `?current=2` 表格仍显示第 1 页。ProTable 初始化不读 URL search param,纯站点行为。

### A7 — 删除确认是 Modal.confirm 非 Popconfirm(站点实现)
站点用 `Modal.confirm` 实现删除确认(标题"删除任务"),非 antd Popconfirm 气泡。站点实现选择,vortex 正确识别为 dialog。

---

## 迭代输入小结

- **2 个 P1**:A1(observe buildSelector id 唯一性)+ A5/A6(click-effect toast 选择器过宽,V-2 回归)。
- 两者互补且都有干净根因 + 明确修复方向 + 可写回归测试,适合进 Task 4 修复子计划。
- A1 偏 observe 选择器生成;A5/A6 偏 click-effect 反馈检测(且是自家 0006 回归,优先修)。
