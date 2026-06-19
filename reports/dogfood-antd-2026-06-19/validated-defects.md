# Validated Defects — antd dogfood (Claude 直驱) 2026-06-19

评测方式：Claude Code 直接驱动 vortex MCP（取代 opencode M3，效率原因切换）。
目标站：ant.design Select 组件页（https://ant.design/components/select）。

---

## DEFECT-1 [vortex-defect, P1] observe 截断按 DOM 序无视口优先 → 密集页上刚打开的视口内弹层被截掉

### 现象
ant.design Select 页有 ~782 个交互候选。滚到 Basic Usage demo，点开第一个 Select（下拉打开在 **top=352、视口内**，选项 Jack/Lucy/yiminghe/Disabled）后，`vortex_observe(filter=interactive, frames=main)` 返回的 80 个元素**全是页面顶部的导航/目录链接**（e0–e79），结尾 `# truncated: returned 80 of ~782 candidates`。**刚打开、就在视口里的下拉选项一个都没返回** → agent 无法用 vortex ref 选择选项。

### 纯 vortex 复现序列
1. `vortex_tab_create` → ant.design/components/select；`vortex_wait_for(idle)`
2. （滚动到 #select-demo-basic；用 evaluate 仅做定位/打标记，不替代交互）
3. `vortex_act(click, [基础 Select])` → success，effect.ariaChanged=true、domMutations=60、element.text="Lucy"（下拉确实打开）
4. `vortex_observe(filter=interactive, frames=main)` → 80 项全是顶部导航；无 Jack/Lucy/yiminghe；`# truncated: returned 80 of ~782 candidates`

### DOM 真值（evaluate 取证，仅证据）
打开后非隐藏下拉：`{top:352, inViewport:true, opts:[Jack, Lucy, yiminghe, Disabled]}`——选项真实存在且在视口内，vortex 却未返回。
（candidateCount 从 775 升到 782，证明选项**被 vortex 收集进了 allCandidates**，只是排在 DOM 末尾被 80 上限截掉。）

### 桶归类
**vortex-defect**：纯 vortex 路径（act 开下拉 → observe 找选项）失败，DOM 真值证明本应成功。

### 根因（codegraph 白盒，file:line）
- `packages/extension/src/handlers/observe.ts:2196` — `maxElements = args.maxElements ?? 80`（默认上限 80）
- `packages/extension/src/handlers/observe.ts:1759` — `allCandidates = [...nodeList, ...cursorPointerLeaves, ...iconCtaExtras]`，**纯 DOM 顺序拼接，无视口/可见性优先**
- `packages/extension/src/handlers/observe.ts:1787-1788` — `for (const el of allCandidates) { if (elements.length >= max) break; ... }`，按 DOM 序取前 80 即停
- 后果：Portal 弹层（antd 下拉/菜单/Modal 的 `[role=option]` 等）追加在 `document.body` 末尾，DOM 序排最后。页面交互元素 ≥80 时（真实复杂应用极常见），刚点开的视口内弹层必然落在 80 之外被丢弃。
- 现有逃生舱失效：`scope=viewport` 含 sticky 导航无法隔离；`prevSnapshotId` 只标 `*` 前缀不产出「仅增量」视图（仍受 80 截断）；`# N more below — scroll to reveal` 对 DOM 末尾的 portal 无效（滚动不改变 DOM 序，顶部导航始终占满前 80）。

### 影响面
这是一类「截断顺序盲区」：任何 ≥80 交互元素的真实站，点开 Select/下拉/菜单/Modal 后 observe 看不到内容，是 vortex 在复杂站上的高频致命路径（agent 卡死在"点开了但找不到选项"）。

### 严重度
P1。普遍、致命（阻断核心交互链）、但有部分缓解（短页 <80 不触发；可用 evaluate 旁路读但违背 vortex 原语契约）。

### 修复（2026-06-19，已 ship 验证）
**overlay-priority 候选重排**（`observe.ts` inject func，`allCandidates` 拼接处）：扫描时检测「可见且脱流（position fixed/absolute）的浮层根」——双信号取并集：① ARIA 弹层语义 role `{dialog,alertdialog,listbox,menu,tree,grid,tooltip}` + 脱流；② body 直接子 portal（fixed/absolute + z-index>0 + 含交互后代）。把浮层根的交互后代前置到候选最前，再走既有 maxElements 截断。**无浮层根时候选顺序零改动（baseline 零漂移）**；脱流门把静态在流内的 grid/tree/listbox（ag-grid/侧栏树/常驻列表）排除——实测 antd 侧栏 role=menu(static) 不前置，只前置真正弹出层。

逻辑提取为模块级导出 `OVERLAY_POPUP_ROLES / isOverlayFloating / partitionOverlayFirst`（inject 内联同名副本，sync 注释 + source-lock 守护）。

**验证证据**：
- RED（旧构建）：synth fixture `overlay-truncation-priority` `recall=0/3`，`# truncated: returned 80 of ~93`。
- GREEN（新构建 `mqkub57e`）：同 fixture `recall=3/3 P0=0`；真站 ant.design Select 点开版本下拉，observe 前置出 `6.4.4/5.x…0.9.x` 10 个 option ref。
- 精度：dropdown 开时 `role=listbox floating=absolute` 被前置,两处持久 `role=menu floating=null` 不动（实测）。
- 回归：synth sweep 13/14（唯一 `native-form-baseline 15/17` 经实测 `overlayRootCount=0` 证伪为既有 file/range input 问题，非本次漂移）；50→94 case bench 全量重跑，6 个 PASS→FAIL 经 ×3 clean 重跑全 `pass=1.00` 证伪为环境抖动（含无浮层的 `h-no-js-click`），**零真回归**；ext 单测 1251/1251。
