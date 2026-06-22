# Ralph Dogfood Loop — 进度账本

> 由 `ralph-loop:ralph-loop` 驱动，目标 30 轮。每轮：真站 dogfood → 发现问题先**确诊**（复杂用 **spike** 实机验证根因）→ 确诊后修一个 → 记录。
> 起始：2026-06-21 · 起始 HEAD：`fa788df`（main）

## 铁律（每轮必守）
1. **先确诊后动手**：根因未实机证实前，禁止改代码。报告/直觉根因默认不可信。
2. **复杂问题用 spike**：活浏览器最小可复现 → 注入诊断 → 看真实信号，再下结论。
3. **一次一个**：单轮只修一个已确诊问题，避免混淆归因。
4. **修完验证**：相关 unit + bench 不回归；能 live 验证的 live 验证。
5. **诚实记录**：证伪也是产出（报告误诊 = 有价值结论）。

## 站点轮换池（避免重复，参考既有 report）
已覆盖：arco / element-plus / naive-ui / 班牛 / Semi / MUI / antd Pro / ag-grid / Excalidraw
候选：Ant Design 官网 · Vuetify · Chakra · Mantine · Radix · Carbon · PrimeVue · shadcn · Fluent UI · Polaris · 真实电商/后台站

## 轮次记录

### Iteration 1 — 环境校准 + 选站
- 状态：完成
- 动作：设 max_iterations；建账本；验证 MCP↔扩展连通（tab_list OK，M3 无残留 tab）。

### Iteration 2 — Mantine (React) Select · 真缺陷 #65：sr-only announcer 误判 toast
- 站点：mantine.dev/core/select/（选 fresh 库，避开 element-plus 0008 已深测）
- 现象：`vortex_act click` Select(开/选两次点击)均回 `userFeedback:"toast"` / `toastHit:["[role='alert']"]`，但页面无任何 toast。
- 确诊（活浏览器 spike）：命中元素 = `<p id="__next-route-announcer__" role="alert" aria-live="assertive">` —— **Next.js 路由播报器**，存在于每个 Next.js 页面。sr-only 模式：`position:absolute; clip:rect(0,0,0,0); width/height:1px; overflow:hidden`，`visibility:visible`+`display:block`+空文本。→ `checkVisibility()=true`、rect 1×1 非 0 → click-effect.ts `isVisible` 误判 visible → toast 选择器命中。
- 影响面：**每个 Next.js 站点的每次 click** 都会误报 toast 反馈，污染 agent silent-fail 判断（与 0006/N0062 networkRequests/userFeedback 误信号同族）。
- 桶：**vortex-defect**（纯 vortex 路径复现，DOM 真值证明本不该命中）。
- 根因 file:line：`packages/extension/src/page-side/click-effect.ts:135` `isVisible`（toast/dialog 反馈检测专用副本）。
- 修复：`isVisible` 增 `r.width<=1||r.height<=1 → false`（sr-only 标准恒收缩 1×1；clip 计算样式判别在 JSDOM 默认即 rect(0,0,0,0)、真浏览器为 auto 不可靠，故用尺寸判别）。
- 验证：RED→GREEN 新增 2 单测（announcer 不误判 + 真 toast 仍检测）；扩展全量 1293/1293 通过；**live 验证**同一 click 修后 `toastHit:[]` / `userFeedback:"mutation"`（正确）。
- 残留边际：仅经 `left:-9999px` 离屏定位（rect 非 1px）隐藏的 announcer 不被尺寸判别捕获（罕见，非主流 sr-only），记为理论 edge。
- bench：本轮未跑（变更隔离于 toast/dialog 可见性判别，click-effect-signal case 只测 domMutations/network，不受影响）；ship 前建议 rerun。

### Iteration 3 — PrimeVue (Vue3, Nuxt) Select + MultiSelect · 0 真缺陷（証伪）
- 站点：primevue.org/select + /multiselect（fresh Vue 库，架构异于 Mantine；Nuxt 避开 Next.js announcer 重叠）
- 覆盖：Select basic/filter（act+fill 提交值核验 ✓）、MultiSelect basic/chips（数组 fill → chips + aria-selected 核验 ✓）、Virtual Scroll（100k 虚拟）。
- 结论：**所有 intended vortex 路径正常**，0 shippable 缺陷。
  - Virtual Scroll：选远端未渲染项 `vortex_fill aria-select` **loud 失败**（INVALID_PARAMS 列出可用项）+ `observe` 顶部正确发 `# blindspots: listbox virtual(~100000/12)`（A2-fb scrollHeight 回退命中 `.p-virtualscroller` ratio~19388）→ 无静默盲区，graceful。
  - **PR #68 交叉验证**：Nuxt `<NuxtRouteAnnouncer>`(role=alert sr-only) 在 fresh app 上 click → `toastHit:[]` / `userFeedback:"mutation"`，修复有效。
  - 桶=already-graceful-degradation：`vortex_act click` 直接点 MultiSelect 的 `[role=combobox]` → OBSCURED。spike 实证该 combobox 是 `.p-hidden-accessible`(rect 1×1 + clip:rect(0,0,0,0)) 包裹的 sr-only 隐藏 input，pointer-events:none，可见层是无 role 的 `.p-multiselect-label`。vortex 拒绝点击真隐藏元素=正确；intended 路径 `vortex_fill aria-select` 工作正常。（若让 observe 丢弃该 sr-only combobox 会使整个 widget 失去唯一 ref，更糟 → 不改。）
  - 桶=m3-error（自证伪）：首次 chips fill 报 COMMIT_FAILED + 二次报 success 但 0 chip → **均为我自身状态污染**（multi-select 重复 fill 会 toggle 反选 + 传了歧义 ref）。clean reload 后单次 fill → "RomeLondon" + 2 chips + aria-selected[Rome,London] 正常。**教训重申**：多选类必须 clean state 单次操作，否则 toggle 假象误判（对齐 0008 page-side 缓存漂移教训）。
- 代码改动：无（本轮纯 dogfood 証伪）。

### Iteration 4 — Radix UI Primitives (React) Slider / Dialog / DropdownMenu · 0 真缺陷（証伪）
- 站点：radix-ui.com/primitives（fresh primitives 库，shadcn 底座；测不同交互类:键盘/焦点陷阱/portal 菜单）
- 覆盖与结论（全 intended 路径正常）：
  - **Slider**：click 聚焦 thumb（值不变=正确）→ `vortex_press ArrowRight` → aria-valuenow 50→51 ✓（press+focus 链路）
  - **Dialog**（Portal+FocusScope 焦点陷阱+DismissableLayer）：open → `userFeedback:"dialog"` + `dialogHit:[role=dialog]` 正确；portal 内 fill Name="Vortex Test" 核验 ✓；Close → dialogHit 清空 + 焦点回 trigger ✓
  - **DropdownMenu**（Portal+roving）：observe 正确呈现全部项类型+状态（menuitem/menuitemcheckbox[checked]/menuitemradio[checked]/disabled/submenu haspopup）；toggle "Show Full URLs" → 重开核验 aria-checked false→true ✓（无静默成功）
  - 全程 toastHit:[] —— PR #68 再次在 React/Radix 上无 FP。
- 代码改动：无（纯 dogfood 証伪）。
- **策略调整（重要）**：连续 3 个 fresh 现代无障碍组件库（Mantine React/Next、PrimeVue Vue/Nuxt、Radix primitives）均 0 缺陷，印证 [[vortex_whitebox_audit_act_primitives]]「主流复杂库零缺陷」。组件文档站happy-path 边际收益递减。**后续 iteration 转向高产区**：canvas（Excalidraw/tldraw/figma-like）、拖拽（dnd-kit/排序看板）、真实业务后台（班牛已授权）、legacy/非无障碍站、closed-shadow、跨域 iframe ——历史缺陷多出于此（见 memory 感知层盲区族 A1-A5 + drag）。

### Iteration 5 — 拖拽 + canvas 高产区探测（SortableJS / 原生 HTML5 DnD / tldraw）· 0 真缺陷（証伪）
- 目标：按策略转高产区，验证 drag 原语 + canvas 感知。
- 覆盖与结论（全正常）：
  - **SortableJS（pointer-based 排序）**：`vortex_mouse_drag` 拖 Item1→pos4，DOM 顺序核验 [2,3,4,1,5,6] ✓
  - **原生 HTML5 DnD（注入受控部件 draggable+dropzone）**：**关键 myth 验证**——怀疑 CDP 合成鼠标无法触发原生 dragstart/drop，**实测反被证伪**:`vortex_mouse_drag` 触发 dragstart:1 / dragover:3 / drop:1 / dataTransfer payload 正确传递。**CDP 拖拽对 pointer-based 与原生 HTML5 DnD 两路皆有效**（记录此结论，免未来重复怀疑）。
  - **tldraw（canvas 白板 app）**：observe 完整呈现工具栏（颜色/工具/操作含 active/checked/disabled 状态）✓；选矩形工具→`vortex_mouse_drag` 画矩形→创建 geo shape + undo 启用 ✓；shape 是 DOM（data-shape-type）可被感知；overlay canvas（tl-canvas-overlays 1440×732）**未误报** canvas blindspot（正确——tldraw 内容在 DOM 非 canvas，flag 会是 FP）。
- 代码改动：无（纯 dogfood 証伪）。
- **观察**：策略转向后高产区（drag/canvas）在精良 app 上亦 0 缺陷，drag 原语对两种 DnD 模型均 robust。真缺陷现需更脏目标：legacy/jQuery 站、closed-shadow web components、富文本编辑器（TinyMCE/CKEditor）、复杂网格（AG-Grid）、真实业务后台（班牛需登录·自驱不可达）。下轮优先富文本/复杂网格/legacy。

### Iteration 6 — TinyMCE 富文本编辑器（tiny.cloud）· 真缺陷 PR #69：all-permitted 漏扫 srcdoc 编辑器帧
- 站点：tiny.cloud full-featured demo（富文本编辑器=高产区命中）
- 现象：TinyMCE 把 contenteditable 体放在 `iframe.tox-edit-area__iframe`（about:srcdoc 同源继承）。用文档推荐的 `frames=all-permitted` observe 时**编辑器内容静默漏报**（输出仅主帧 UI + 跨域 YouTube 帧，独缺编辑器帧）。
- 确诊（spike + 白盒）：`frames=all` 能完整扫到编辑器帧 `body "Rich Text Area" [f82]`（证明扫描机制能处理 srcdoc）；`all-permitted` 独缺它 → all-permitted **不是** all-same-origin 超集。根因 `observe.ts resolveTargetFrames`：all-permitted 走 `isFrameInPermissions(f.url)`，该函数对非 http(s)/ws protocol 直接拒（`observe.ts:70`），`about:srcdoc`(protocol `about:`)被拒；而 all-same-origin 走 `inheritedOrigin` 已正确解析 srcdoc 继承源（Issue #15）。两路不一致 = 缺陷。
- 桶：**vortex-defect**。根因 file:line：`packages/extension/src/handlers/observe.ts:220-224`（all-permitted 分支）。
- 修复（PR #69, branch fix/observe-all-permitted-srcdoc-frame）：all-permitted 对 about:srcdoc 子框按继承源（复用 inheritedOrigin）判 host_permissions，与 all-same-origin 对齐；about:blank 保持排除（非作者刻意内容）。
- 验证：TDD RED→GREEN 新增 4 单测；扩展全量 1295 通过；**live 验证**修后 all-permitted 正确呈现编辑器 body + 全部内容（SW 已加载新代码，尽管 dev_reload 因 C1 戳比对 bug 报 timeout）。
- 影响面：凡把可编辑/沙箱内容置于 about:srcdoc iframe 的富文本编辑器（TinyMCE iframe 模式等）+ srcdoc 沙箱小部件，用推荐 all-permitted observe 不再漏报。
- **教训**：「all-permitted 应是 all-same-origin 超集」是 load-bearing 不变式；srcdoc 同源逻辑此前只覆盖 all-same-origin（Issue #15）留下 all-permitted 缺口。高产区策略首轮即命中真缺陷，验证转向正确。
- dev_reload 备注：本轮改 SW 代码（observe.ts），dev_reload 仍报 RELOAD_TIMEOUT（fromStamp==targetStamp，C1 路径错配老问题），但直接 observe 实测证明 SW 已运行新代码 → dev_reload 的戳比对逻辑本身可能有 bug，候选未来 iteration 排查。

### Iteration 7 — Quill 富文本编辑器（quilljs.com）· 真缺陷 PR #70：无名 contenteditable 被 require-name 门漏报
- 站点：Quill（前置 ag-grid CloudFront 拦截 + CKEditor demo 懒加载未初始化两次撞墙，pivot 到 Quill；避坑「rabbit hole」铁律）
- 现象：observe 完整呈现 Quill 工具栏，但**编辑器可编辑体 `.ql-editor` 本身未surface** → agent 拿不到输入目标 ref。
- 确诊（spike + 白盒）：`.ql-editor` = 无 role/aria-label/cursor:auto 的 `div[contenteditable=true]`，视口内非隐藏。spike 临时加 `role=textbox`+`aria-label` → observe 立即surface 为 textbox；移除即消失 → 门是 require-name。白盒定位 `observe.ts:2092-2102` BUG-3 噪声门:`if (!formLike && !hasExplicitRole && !name) continue;`，无名 contenteditable div 非 formLike、无 role/label/name → 丢弃。
- 桶：**vortex-defect**。根因 file:line：`packages/extension/src/handlers/observe.ts:2092`（BUG-3 formLike 门）。
- 修复（PR #70, branch fix/observe-nameless-contenteditable）：显式 contenteditable 宿主(attr 非 "false")纳入 formLike 豁免（等同 textarea），仅认显式 attribute 防继承子节点误豁免。
- 验证：源码锁单测（-inlined 模式）+ 扩展全量 1292 通过；**live** 修后 3 个无名 .ql-editor 均以 `div value="..."` 呈现（带 ref）。
- 影响面：Quill 及任何无 a11y 标注的裸 contenteditable + 自定义 contenteditable 区，observe 不再漏报。
- 跟进：bench 功能 fixture（现有 contenteditable-prosemirror-like fixture 编辑器带 role/label，未覆盖无名场景）—— 加无名 contenteditable + observe 发现断言，ship 前 bench rerun 一并验。
- **教训**：① 高产区策略连续命中真缺陷（PR#69 srcdoc / PR#70 contenteditable），富文本编辑器是观测层缺陷富矿。② 撞 3 个目标墙（ag-grid×2/CKEditor）果断 pivot 守住「避免 rabbit hole」。③ require-name 噪声门对「无 a11y 标注但真可交互」的控件族（contenteditable 编辑器）需逐类豁免，同 textarea/label/[contenteditable] 已有先例。

### Iteration 8 — react-datepicker（reactdatepicker.com）· 0 新缺陷（証伪 + PR#68 再验证）
- 站点：react-datepicker（日期选择器=新组件类，复杂日历弹层 + 键盘日期录入；distinct driver path）
- 覆盖与结论（功能全正常）：
  - **点选日期**：observe 呈现 gridcell（可访问名「Choose Tuesday, June 23rd, 2026」+ selected/current 态）→ `vortex_act click` June 23 → input 值核验 06/23/2026 ✓
  - **键盘录入**：`vortex_fill [data-spike=dp1]` = "07/04/2026" → blur + body click 后值保持 07/04/2026 → react-datepicker 受控态**已接受**（受控组件若未同步会在 blur 重渲染回滚到 06/22/2026，未回滚=已接受）✓
  - 多实例陷阱：页面 **106 个** datepicker wrapper；首次跨实例读 `.react-datepicker__day--selected` 命中别的实例（June 22）险误判，clean reload + data-spike 精确锁定单实例后证伪（重申 0008 多实例/缓存漂移教训）。
- **toast FP 复现 = PR#68 未合并**：click 日期触发 `userFeedback:"toast"` / `toastHit:["[role='alert']"]`，命中 7 个 `react-datepicker__aria-live`（1×1 + clipPath:circle(0px) sr-only announcer）。**实测当前 main/dist 不含 PR#68**（grep `r.width<=1` 计数 0）→ PR#68 的 1×1 尺寸判别**正可捕获**这些 announcer。**非新缺陷**，反而在第二个主流库（react-datepicker）上再验证 PR#68 正确且必要。
- 代码改动：无（纯 dogfood 証伪）。
- **⚠️ 重要 meta 问题（branch 工作流保真度）**：3 个修复（PR#68/#69/#70）各在独立分支、均**未合并 main**。每轮 dogfood 用「最后一次 build 的分支」dist，**修复不累积** → ① 已修缺陷（如 toast FP）每轮在 sr-only 重站重复出现成噪声；② 跨修复回归无法被 live 验证；③ live 验证仅代表当前分支单一修复。**建议用户合并 pending PR（#68/#69/#70）以恢复 dogfood 保真**；或后续 iteration 从 stack 全部修复的分支 build。不自行合并（遵守授权边界）。

### Iteration 9 — 恢复 dogfood 保真（集成分支）+ Monaco 编辑器 · 0 缺陷
- **保真修复**：建本地集成分支 `dogfood/integration-all-fixes`，octopus 合并 main + PR#68/#69/#70，build → SW 现运行**全部 3 修复**。扩展全量 **1298 通过**（1291 base + 2+4+1），三修复 compose 无冲突无回归。dist 确认含 click-effect 1×1 判别 + about:srcdoc + isEditableHost。此后 dogfood 不再受单分支割裂噪声。（非合并 main，仅本地 build-for-test。）
- **站点：Monaco 编辑器**（microsoft.github.io/monaco-editor）—— 极难自动化目标(隐藏 textarea/EditContext + 虚拟渲染行)。
  - observe 干净呈现:语言/主题 combobox + 编辑输入(focused 时 `div[role=textbox] "Editor content"`)。
  - **readonly 检测验证**(注入 spike):observe 正确标 readonly textarea `[readonly]`、不标可编辑的 → 检测正确。
  - act 全通(proper flow):mouse click 聚焦+置光标 → `vortex_press "X"` 插入 → view-line 变 "/* GXame of Life" ✓。**Monaco v0.52 用 EditContext API**(.native-edit-context,role=textbox),vortex_press CDP 键事件正确路由插入。
  - 早期 NOT_EDITABLE 系**未聚焦 + Monaco 动态 textarea churn**(选择器解析到 readonly ime-text-area),非 vortex 缺陷;proper focus→type 流程正常。
- 桶:全 already-correct / m3-error(我未聚焦先 type)。代码改动:无（dogfood 证伪 + 保真基建）。
- **教训**:① 多分支割裂修复会污染 dogfood 保真,集成分支 build 是低成本解(octopus merge + 1 build)。② Monaco/EditContext 前沿编辑器 vortex 经 role=textbox + CDP 键事件已支持,proper flow 须先聚焦(同所有自动化工具)。

### Iteration 10 — GitHub 真实生产站（github.com/microsoft/playwright）· 0 缺陷
- 站点：GitHub repo 页(真实复杂生产站,大量 custom elements:modal-dialog/details-menu/tool-tip/qbsearch-input/react-partial 等;native <dialog>)——脱离组件库 demo,测真实世界站。
- 覆盖与结论（全正常）：
  - **observe**：干净呈现 header/repo nav/文件树/commit 行 + 各 haspopup(menu/dialog)按钮，custom elements 不阻碍感知。
  - **Code 下拉(clone 面板)**：click 开 → observe overlay-priority 前置面板内容(Local/Codespaces tab + Clone HTTPS/SSH/CLI + clone URL textbox 正确标 `[readonly]` + Copy + Download ZIP)；toastHit:[] 无 FP ✓。
  - **Go to file 模糊查找(search-as-you-type)**：click combobox → `vortex_act type "playwright-test"` → 6 条结果实时出现(tests/packages/playwright-test…) ✓。
- 桶：全 already-correct。代码改动:无（真实站证伪）。
- **教训**：真实复杂生产站(GitHub,custom-element + native dialog + 模糊查找)vortex 全路径(observe/overlay-priority/readonly/act type/search)工作良好 → 印证 act/observe 原语成熟度;真缺陷现需更冷门结构边(closed-shadow/跨域 iframe 深层/canvas 内部/受限业务站)。

### Iteration 11 — YouTube(shadow/光 DOM)+ 闭合 shadow A3 优雅降级验证 · 0 缺陷
- **YouTube**(youtube.com,90 个 yt-* 自定义元素但 **0 shadow root** = Polymer shady/light DOM):observe 干净;`vortex_act type "playwright testing"` → 5 条搜索联想实时出现 ✓。非 shadow 测试(YT 是 light DOM)。
- **闭合 shadow A3 优雅降级 spike**(注入受控 closed-shadow 自定义元素):
  - host **有 role/aria-label**(a11y 正确做法)→ observe 收集 host `button "Closed Shadow Action" [blindspot=shadow?]` + 顶部 `# blindspots: ... shadow?` → **优雅降级**:告知 agent「可交互但闭合 shadow 内部不可见」✓。A3 **已 wired**(非完全 defer),对 a11y 正确的闭合组件正常发信号。
  - host **无 role/name**(a11y 反模式)→ 不收集不发信号 → 与屏幕阅读器同盲,可接受(站点本身 a11y 坏)。
- 桶:全 already-correct / already-graceful-degradation。代码改动:无。
- **教训**:闭合 shadow 对「a11y 正确(host 带 role)」组件优雅降级(blindspot=shadow? 信号),对 a11y 反模式同 SR 同盲——符合产品标准「失败优雅降级」。真缺陷在更冷门处。

### Iteration 12 — 跨域/iframe 表单字段命名（httpbin via 注入 iframe）· **1 真缺陷修复 → PR #71**
- 目标：跨域 iframe 深度交互（backlog 最冷结构边）。先 CodeSandbox（预览=真跨域 `new.csb.app`）证 **vortex 确实注入并扫描跨域子框**（"frame N scanned"），但 nodebox 异质渲染（service-worker shell 文档，`Viewport 0x0`）令预览内容 0 元素——**判为 CodeSandbox 特有,非 vortex 缺陷**（避免误判，未据此下结论）。
- **受控 spike（隔离变量）**：example.com 注入指向 `httpbin.org/forms/post` 的 iframe。
  - 跨域版（SecurityError 确认真跨域）：`observe(frames=all)` 提取到表单**结构**（3 文本框/尺寸·配料 label/时间/说明框/Submit），但 text/email/tel/time 控件**全无名**，Submit 有名。
  - 顶层文档版：同表单**全部正确命名**（`textbox "Customer name:"` / `InputTime "..."`）。
  - **再隔离**：注入**同源** iframe（无 SecurityError）→ 同样丢名。**∴ 根因不是跨域，是「任何 iframe 子框内」。**
- **根因（白盒，observe.ts:2487）**：AX 语义覆盖层（`captureAXNodeMap`+`applyOverlay`，供准确 role/name/state）**仅施加于主 frame 0**。子框只靠 page-side `getAccessibleName` 启发式，而其「包裹 label」分支此前**只覆盖 radio/checkbox**；`<label>Customer name: <input></label>`（无 id/无 label[for]）的 text/email/tel/textarea/time 全落到 `placeholder||title||""` → 空名。Submit 因名取自自身 value 不受影响。影响面：**所有 iframe 内手写表单字段对 agent 不可辨**（支付字段/嵌入表单/富文本工具）。
- **修复（PR #71，`fix/observe-iframe-wrapping-label-name`）**：`getAccessibleName` 增通用「包裹 label」兜底——克隆 label、剥除嵌套表单控件（规避 textarea 当前文本/select option 文本污染）、取其余文本为名。radio/checkbox 仍上方专支早返，submit/button/image 仍 value 早返，主框 AX 覆盖照常覆写——均无回归。
- **验证**：TDD（source-lock RED→GREEN）；全量 **1301 通过**（+3 新 `observe-wrapping-label-name.test.ts`）；**真站 live**（重载扩展后 httpbin 跨域 iframe）5 字段全部正确命名，命名后跨域字段 `fill` `success:true`（跨域 act 闭环）；同源 iframe 同复。
- 桶：1 真缺陷（perception 命名层）。集成分支已并入（now 4 修复）+ 重建 dist。
- **已知遗留（backlog）**：子框内 `<input type=time>` 仍报 `textbox` 而非 `InputTime`（role 同源于仅限主框的 AX 覆盖）。本轮只补 name（load-bearing）；子框 role 覆盖是更大架构项（per-frame AX overlay/OOPIF），另开。
- **教训**：① 异质 app（CodeSandbox nodebox）易制造假缺陷——`Viewport 0x0` 是信号，必须用**正常布局的受控样本**隔离再判。② 「跨域」与「在 iframe 内」是两个变量，注入同源 iframe 一步证伪「跨域特有」假设——隔离纪律省下一条错误根因。③ AX 覆盖层主框独享是观测层的系统性子框降级源，name 已补、role 待续。

### Iteration 13 — SVG 图表(ApexCharts/Highcharts)+ Wikipedia 可排序表 · 0 新缺陷(証伪)
- **目标**：交互式 SVG 数据可视化(冷结构边)。
- **SVG 图表(ApexCharts basic)**：整 SVG `role="img"`(a11y 规范:图表作单一不透明 img,内部数据点不单独暴露,同 canvas 的有意降级)→ observe 正确把图表当 img、周边页面 nav/链接/按钮全召回 ✓。**非缺陷,优雅**。Highcharts demo 返回占位页(bot 拦/路径变)、ApexCharts 多 demo 在本环境 svg 懒加载不稳定 → 撞站点加载墙,**按防陷阱纪律(>2-3 次失败)果断停图表 hunting**,非 vortex 问题。
- **Wikipedia 可排序表(List of countries by population,可靠真站实证)**：
  - observe:5 个可排序表头全召回 `columnheader "Population" [cursor=pointer] [listener] desc="Sort ascending"`——role/排序提示/可点信号俱全,agent 可辨可点 ✓。
  - act:`click` Population 表头 → `success` + effect `userFeedback:"mutation"` + `domMutations:248` + `ariaChanged:true`;白盒核验**真实升序排序**(首行 India→Pitcairn Islands/Cocos/Vatican 最小人口,表头 +`headerSortUp`)✓。注:Wikipedia 用 CSS class 不设 aria-sort,effect 的 ariaChanged 系 248 变更附带 aria 属性变动,非假成功(排序确实发生)。
- **iter-12 backlog 可行性核实**:子框 role 降级(AX 覆盖仅主框)——`captureAXNodeMap` 已支持 frameId 参,但扩到子框需重做跨框 index→backendNodeId 映射,且**跨域 OOPIF `getFullAXTree` 直接拒**(需独立 debugger session)。属**架构级特性**,非一轮低风险「一次一修」,应单独 brainstorm,本轮不碰(name 已补=load-bearing 已解,role 次要)。
- 桶:全 already-correct / already-graceful-degradation。代码改动:无。
- **教训**:① SVG 图表(role=img)与 canvas 同属有意不透明,observe 当 img + 召回周边交互=正确。② demo 站懒加载/bot 拦不稳,撞墙即 pivot 到可靠真站(Wikipedia)取实证,别在 flaky demo 上耗。③ 可排序表是观测+交互+effect 三合一的优质实证面,vortex 全通。④ 确诊的 backlog 缺陷若属架构级,诚实判「非一轮可修」转 brainstorm,不强行塞进一次一修。

### Iteration 14 — 拖放(react-dnd HTML5 + 受控 spike)· **1 真缺陷修复:observe 不暴露投放区(drop target)**
- **目标**:拖放(冷结构边)。HTML5 原生拖放(`draggable=true`+dragstart/drop)与 vortex_drag 的 CDP trusted 指针拖放协议不同,经典自动化难点。
- **证伪(vortex_drag 原语正确)**:
  - react-dnd sortable simple:`vortex_drag` 拖 PROFIT→首位,白盒核验 React 渲染顺序真变(PROFIT 移到首)✓——CDP trusted 鼠标拖放在 headful Chrome 对 draggable 元素正确触发原生 dragstart/drop。
  - **受控最小 spike**(注入标准 HTML5 drop 区:dragover preventDefault + drop 改文本):`vortex_drag` 触发完整序列 `src:dragstart→zone:drop:payload→src:dragend`,dataTransfer payload 正确传递,`zoneText=DROPPED:payload`,快返无卡顿 ✓。**∴ vortex_drag 正确实现 HTML5 原生拖放(含 dataTransfer+drop)。**
  - react-dnd dustbin 不记录 drop(探针实测 `DUST:drop` 已触发但 react-dnd 内部 dataTransfer 校验拒)= **react-dnd 特有,非 vortex 缺陷**;探针版卡顿系 react-dnd 拖影/监视器 + 我的重型 document 捕获探针所致,干净最小用例无此问题(防陷阱纪律收束 >3 次混杂实验)。
- **真缺陷(白盒确诊)**:**observe 不发现/暴露投放区**。受控最小用例钉死:可拖源因 `draggable=true` 召回为 group,而 drop 区(仅 drop/dragover 监听、无 role、非 draggable、有文本)**即便 `filter:all`+`scope:full` 也完全不出现**。根因 `observe-js-listener.ts:57`:listener discovery 的 `CLICK_EVENT_TYPES` 只含点击类(click/mousedown/mouseup/pointerdown/pointerup),**不含 `drop`/`dragenter`/`dragover`** → drop 区永不入池 → ref-based vortex_drag 无合法 endRef 投放。与盲区降级哲学相悖(应发信号非静默漏)。
- **修复**:扩展 discovery 同一次 `getEventListeners` 结果分两类——点击类打 `data-vtx-listener`(不变)、投放区(drop/dragenter/dragover)打新 `data-vtx-dropzone`;observe scan 把后者当入池信号 + 渲染独立 `[dropzone]` 信号(与 `[listener]` 正交,不暗示可点击)。**body/html 排除**防全局 file-drop 把整页当 drop 区。召回零回退:纯加性,CDP 失败→0 标记退回启发式。
- **验证**:TDD(marker 模块 9 真行为测 + render [dropzone] 3 测 + observe.ts 接线 6 source-lock);extension **1317**通过 + mcp **508**通过(+16);**live 三连**:① drop 区从不可见→`div "Drag a box here" [dropzone]` 带 ref ② `vortex_drag` 用其 endRef 投放→`DROPPED:payload` ③ body+document 绑全局 drop 监听后 body **不**被标 [dropzone](守卫生效无过收)。
- 桶:1 真缺陷(perception 投放区可观测层)。
- **教训**:① 拖放分「拖源(draggable 召回)」与「投放区(drop 监听)」两侧,后者此前是观测盲区——drag 原语可用但 endRef 无处指。② 受控最小 spike 是隔离库特有行为(react-dnd dustbin)vs vortex 原语缺陷的关键,别在库的复杂内部(拖影/监视器/dataTransfer 校验)上耗。③ discovery 加新事件类应走独立信号(`[dropzone]`≠`[listener]`),语义不混(drop 区非点击目标)。④ 全局 file-drop(body/document)是过收高发点,加事件类发现必带根节点守卫。

### Iteration 15 — DuckDuckGo 搜索结果页 · **1 真缺陷修复:observe 把高熵随机类名当可访问名**
- **靶站轮换**:先 Reddit(`shreddit-*` web components)→ **被网络安全拦截**(bot 检测),observe 正确召回拦截页 2 真链接,非 vortex 问题,按防陷阱纪律 pivot。换 **DuckDuckGo**(自动化友好真实搜索引擎)。
- **证伪**:observe 干净召回搜索 combobox `[haspopup:listbox]`;`type "playwright testing"` → listbox 7 建议实时出现(compound 元数据齐 + `*` diff 标新);点选项 → 搜索执行(networkRequests 含 searchbox_submit,22 条结果)。combobox 自动补全全链路 ✓。
- **真缺陷(白盒确诊)**:结果页 observe 出现 `button "UHLDCRqne5hmHzSLIjwY"`、**4× `link "w0GlwvoHJHjX9o0DVIaL"`**、`button "YZxymVMEkIDA0nZSt_Pm"` ——随机哈希串当可访问名。白盒核实:`<a class="w0GlwvoHJHjX9o0DVIaL">` 无文本/aria-label/title,内含 `<img alt="">`(空 alt 装饰图)→ 无合法名 → `iconNameFromClass`(observe.ts:627)className 兜底返回了哈希类名。根因:既有 denylist 只否决 `css-`/`sc-` 前缀哈希,**无框架前缀的裸随机哈希漏网**(CSS-modules 默认 [hash]/各家构建产物)。零语义,当名比无名更糟(噪声 + 假名击败 require-name 过滤,正是 getAccessibleName:950 注释 AJ 所忧)。
- **修复(`iconNameFromClass` 加按段高熵否决)**:按 `-`/`_` 切段,任一段长 ≥8 且大小写混合 + 含数字 = 机器生成哈希 → 否决回退无名。**两版迭代**:v1「无分隔符 + 大小写 + 数字 + 长≥8」live 验证去掉 `w0Glwvo*` 但漏 `YZxymVMEkIDA0nZSt_Pm`(内嵌 `_` 被无分隔符子句豁免)→ v2 升级为**按段检测**,覆盖含 `_`/`-` 的哈希段。语义名不误伤:kebab/snake 段纯小写、camelCase 无数字(`closeIcon` 保留)。
- **验证**:TDD(7 测:谓词复刻 5 含真站哈希+语义名保留+短段+纯小写 + source-lock 2 守接线);extension **1308**通过;**live**:v1 已实证 DuckDuckGo 结果页 `w0Glwvo*` 哈希名消失(链接降级为干净无名,iconNameFromClass 路径端到端接线 live 证);bench **94/94** 无回归。(v2 段升级:谓词由 7 单测精确复刻验证 `YZxymVMEkIDA0nZSt_Pm`→否决;live 复验受会话 MCP 断连阻,接线已由 v1 live + source-lock 双重保。)
- 桶:1 真缺陷(perception 命名兜底层)。
- **教训**:① CSS-modules/styled 等生成式哈希类名分两类——有框架前缀(css-/sc-,已防)与裸随机哈希(本轮补);裸哈希长且大小写+数字混合是高精度判据。② 哈希可内嵌 `_`(`YZxymVMEkIDA0nZSt_Pm`),「无分隔符」判据漏网 → 按段检测才稳(段为单位判高熵,kebab/snake 段纯小写自然放行)。③ 真站轮换撞 bot 墙(Reddit)即 pivot,别耗;observe 在拦截页仍正确召回是 vortex 行为正确的旁证。④ build 重连 MCP 不稳时,bench(独立 MCP 进程)不受影响可照跑;会话工具断连不阻断单测/bench/source-lock 验证闭环。

### Iteration 16 — MDN Web Docs · **1 真缺陷修复:虚拟列表盲区误报(false positive)**
- **靶站轮换**:连撞 4 个 bot 墙——ag-grid.com(CloudFront)、eBay(错误页)、Reddit(网络安全拦截)、npm(Cloudflare 挑战)。本环境 IP 似被多站 bot 检测,按防陷阱纪律逐个 pivot,最终 **MDN Web Docs**(reliable、含虚拟侧栏 + 跨域 mdnplay.dev iframe 交互示例)。
- **证伪**:observe 干净召回 MDN 主结构;虚拟盲区信号机制工作;多个 mdnplay.dev 跨域 iframe 被扫描(0 交互元素=正确,内含渲染示例非控件)。
- **真缺陷(白盒+spike 确诊)**:observe 顶部 meta 报 `# blindspots: ol virtual(~303/6)`,但 spike 实测**所有 `<ol>` 全渲染**(`inDom===laidOut`:174/174 等)、`scrollHeight===clientHeight`(无内部滚动,整页滚动非列表虚拟化)→ **误报**。复刻启发式定位触发元素:侧栏一个 **6 项工具列表**(rowH=32),其滚动祖先 `<aside class="layout__left-sidebar">`(scrollH=9692/clientH=634,**实含整片 CSS 参考共 1249 个 li**),`est=9692/32=303`。根因 `detectVirtualByScroll`(blindspot-detect.ts):用滚动**祖先**的 scrollHeight ÷ 本候选 rowH 估算 total,**假设「祖先只装本列表」**;当祖先是含多列表的导航区,scrollHeight 来自其它真实内容 → est 暴涨误报。
- **修复**:`detectVirtualByScroll` 加 `scrollerRowCount` 参数 + 误报闸——真虚拟列表的滚动祖先只含视口窗口的行(`scrollerRowCount ≈ renderedRows`);若 `scrollerRowCount > renderedRows × 2`(祖先含远多于本列表的行,内容全在 DOM)→ 返回 null。canonical(blindspot-detect.ts)+ 内联副本(observe.ts,新增 `__scrollerRows = __scroller.querySelectorAll("[role=row],tr,li").length` 测量)双源同步。
- **验证**:TDD(canonical 加 2 测:MDN 精确输入 9692/634/6/32/**1249**→null 误报闸 + 显式 scrollerRowCount≈rendered 真虚拟仍报;source-lock 加 2 断言守内联闸);盲区单测 **19** 通过;extension **1303** 通过;bench **94/94** 无回归。(live 复验受会话 MCP 本轮断连阻;但 spike 已在 live MDN 测得精确输入,单测用该精确组喂 canonical 证 null,内联经 source-lock 同步双重保。)
- 桶:1 真缺陷(perception 盲区信号假阳)。
- **教训**:① 盲区信号「假阳」与「漏报」同等有害——假阳让 agent 误以为内容被隐藏而徒劳滚动/distrust 快照。② scrollHeight 估算虚拟化的隐藏前提是「滚动容器只装目标列表」,小列表嵌在大导航区时前提崩;判真假虚拟的关键判据=滚动祖先 DOM 行数 vs 渲染数(真虚拟≈相等,假阳远超)。③ spike 复刻启发式逐元素定位触发源(找到 6项列表+1249项aside)是确诊误报的决定性手段,胜过盯输出猜。④ 连撞 bot 墙不是 vortex 问题,果断逐站 pivot 到 reliable 站(MDN)。

### Iteration 17 — PrimeReact 组件库(TreeTable/VirtualScroller)· **1 真缺陷修复:纯 div 虚拟列表整类盲区漏检**
- **靶站轮换**:PrimeReact 官网 demo(primereact.org,组件密集、bot 友好)。先测 TreeTable——展开/折叠节点(observe 正确捕获 `Collapse`+新子行)、内联单元格编辑(点 cell→`textbox value=100kb`,observe 正确表示编辑态输入框)全 ✓ **证伪**。
- **真缺陷(白盒 spike 确诊)**:VirtualScroller demo——10 万项虚拟滚动器仅渲染 8 项,observe 输出为**一个普通 div** `"Item #0...Item #7"`,**零盲区信号**(无 `[virtual:N/M]`、无 `# blindspots` meta)→ agent 误以为只有 8 条数据。spike 实测钉死根因:
  - `.p-virtualscroller` 是 `DIV`,`matches("table,[role=grid],[role=listbox],[role=tree],ul,ol")===false` → A2-fb 候选选择器(observe.ts:2281)**整类漏**;
  - 8 个列表项也是纯 `div`,`querySelectorAll("[role=row],tr,li").length===0` → 行选择器**整类漏**;
  - 实测 `isScroller:true`/`scrollH 5000000`/`clientH 198`(ratio 25253,强滚动)/8 项等高(50px)/estTotal 100000——按理该报却完全没进检测。
  - 根因:A2-fb pass 只认**语义容器(table/ul/ol/role)+ 语义行(role=row/tr/li)**,而 **react-window / react-virtuoso / PrimeReact VirtualScroller 这类最主流的现代虚拟列表用纯 div 容器 + 纯 div 行**,被整类静默漏检。是 iter-16(误报)的对偶——本轮是**漏报**。
- **修复**:新增纯函数 `detectDivVirtualScroller(scroller)`(blindspot-detect.ts)+ observe.ts 内联镜像(`[inline detectDivVirtualScroller]`)。判据:① 强滚动(overflowY auto/scroll 且 scrollH≥clientH×4,**廉价 scrollHeight 门先于 getComputedStyle**,可在全 div 遍历调用不爆开销)② 渲染窗口(内部某 div 有 ≥3 等高±2px 重复子项且等高占比≥70%,排除异构布局)③ estTotal>>渲染数(**复用 detectVirtualByScroll 同一判定门**;全量渲染等高列表 estTotal≈渲染 不触发,误报防线)。共享 `__seenScrollers` 与语义路径去重。
- **验证**:TDD(纯函数 6 行为测:PrimeReact 式正例 5000000/198/8/50→virtual~100000 + 5 负例[overflow visible/弱滚动/全量渲染/异构高度/项<3] 全 null;source-lock 1 断言守内联接线);blindspot 单测 **23** 通过;extension **1307** 通过;全包 build ✓。
- **live-verify + bench(提交前 MCP 重连后补全)**:build 重建 dist 一度致会话 MCP 断连,等待中 SW 已从新 dist 自重载(`vortex_dev_reload` 报 fromStamp==targetStamp==mqomnl7u=新构建已 live);**live**:VirtualScroller demo observe 顶部由「零信号」→ `# blindspots: list virtual(~100000/8)` × 8,白盒核实页面恰有 8 个 `.p-virtualscroller` 真实例(7× sh=5000000→100000、1× sh=50000→1000,数字精确对应),`__seenScrollers` 去重无重复计数;**bench 94/94** 全通过、observeMissed=0、零回归(纯加性 div 路径未误伤 synth/fuzz fixture)。
- 桶:1 真缺陷(perception 盲区信号漏报)。
- **教训**:① 盲区检测的语义选择器(table/ul/[role])对**纯 div 虚拟列表**整类失效,而 react-window/virtuoso/PrimeReact 正是这类——现代虚拟化的主流恰恰无语义标签,须按「强滚动容器+等高重复 div 子项」结构识别。② iter-16(误报)与 iter-17(漏报)是同一估算启发式的对偶缺陷,两侧都要堵。③ 廉价属性门(scrollHeight/clientHeight)先于 getComputedStyle,使「遍历全 div」的开销可控(虚拟列表 DOM 节点本就少=虚拟化本质)。④ 复用既有判定门(estTotal 公式)避免双份阈值漂移,新代码只加「找行」DOM 遍历。⑤ build 断连 MCP 时,扩展未 reload 则 bench 测旧码=无效验证;本轮 MCP 重连后 `dev_reload` 报 fromStamp==targetStamp 证 SW 已在等待中自重载(buildStamp 是判据),据此补全 live+bench,避免引用误导性「94/94 ✓」;若始终无法重连,诚实标注顺延胜过假验证。

### Iteration 18 — W3C ARIA APG(多滑块 slider 参考实现)· **1 真缺陷修复:合成 click 对 SVG 元素整类崩溃**
- **靶站轮换**:W3C ARIA Authoring Practices Guide(www.w3.org/WAI/ARIA/apg)——每个 ARIA 模式的权威参考实现,真实可靠,检验 observe/act 在规范无障碍控件上的正确性。测**多滑块 slider**(SVG `<g role=slider>` 拇指,键盘/拖拽值控件)。
- **证伪(observe 正确)**:两个 SVG slider 经 observe 正确表示为 `slider "Hotel Minimum Price..." value=100` / `slider "...Maximum..." value=250`,role/name/value 全召回 ✓(印证 SVG role 经白名单召回,非整类盲区)。
- **真缺陷(白盒 spike 确诊)**:`vortex_act click` 该 SVG slider → `JS_EXECUTION_ERROR: G.click is not a function`。spike 实测钉死:`SVGElement.prototype.click === undefined`(此 Chrome SVG 元素无原生 click 方法,`HTMLElement.prototype.click` 才有;`g.focus` 倒是有)。根因 `dom.ts:504`:合成 click 路径派发 pointerdown→mouseup 后**裸调 `el.click()`**(补触发表单提交/锚点跳转默认动作),对 SVG(`<g>/<rect>` 实现的 slider/button/checkbox)、MathML 等无 `.click()` 方法的元素整类抛错。
  - 路径辨析:`useRealMouse||trustedMode` 走全程 CDP(SVG-safe);本环境非 trusted,走合成路径,其中仅 submit-intent/reactClickable 元素 deferToCdp。SVG slider 二者皆非 → 留合成路径触达 504 崩溃。即**非 reactClickable 的 SVG 交互元素**是受害面。
- **修复**:`dom.ts:504` 加守卫——`typeof el.click === "function"` 则调原生(保表单/锚点默认动作),否则 `el.dispatchEvent(new MouseEvent("click", mouseUp))`(非 HTML 元素无默认 click 动作,合成事件已触发监听器)。纯防御性,HTML 路径不变。
- **验证**:TDD(复用 `click-synthetic-inline-scope.test.ts` 的 `new Function` 剥离作用域真执行夹具,加 SVG `<g>` 用例 click 强制 undefined:**RED** `el.click is not a function` → **GREEN** 无错+click 监听触发);extension **1302** 通过。
- **live + bench(MCP 重连后补全)**:会话 MCP 断连久未自动重连,提交时以高保真 TDD 为据先行(`click-synthetic-inline-scope.test.ts` 经 `new Function` 剥离作用域**真执行 dom.ts 实际 inline func**,RED 精确复现 `el.click is not a function`、GREEN 验证)。重连后补 live+bench,**踩到一个波折并修正**:首次 live 仍报 `H.click is not a function`(变量名 G→H)——排查发现 `git checkout main`(切回主干等下轮)还原了 dom.ts,**playground/vite 相关 watch 在文件还原后用无守卫的 main 源重建了 dist**(buildStamp 漂移、变量重 minify 即 G→H),部署的是无修复版。切回 `fix/act-synthetic-click-svg-guard` 分支重新 `npm run build`(确认 dist 背景 bundle 含 `typeof q.click=="function"?q.click():q.dispatchEvent(...)`)+ dev_reload(fromStamp==targetStamp==mqoo01a1=守卫已 live)后:**live 全通过**——SVG slider click 由崩溃 → `success:true`+`focusChanged:true`,续 press ArrowRight → `aria-valuenow` 100→101(click→focus→键盘 完整链路恢复);**bench 94/94** 零回归。
- 桶:1 真缺陷(act 合成点击路径 SVG 健壮性)。
- **教训**:① `.click()` 是 HTMLElement 专有,SVGElement/MathML 无——任何 `el.click()` 裸调对非 HTML 交互元素(SVG 图表/slider/自定义图标按钮)是整类崩溃点,须 typeof 守卫 + 合成 click 事件兜底。② SVG 交互元素 observe 召回正确(role 白名单)但 act 合成路径崩溃——观测层与执行层须分别验证,召回 ≠ 可操作。③ trusted Chrome(CDP 路径)掩盖此 bug,非 trusted 合成路径才暴露,与 isTransient 回归(`click-synthetic-inline-scope`)同源教训:合成路径须独立测。④ **dist 是 git-ignored,`git checkout` 切分支不还原 dist,但若有 vite/watch 进程在跑,切分支还原 src 文件会触发它用新分支的源重建 dist**——live-verify 前务必确认 dist 来自目标分支(buildStamp/变量名漂移是信号),否则验的是错分支的码。修复分支验证应在该分支上 build+reload,勿在 main 上误验。

### Iteration 19 — GitHub(自定义元素)+ SVG 交互元素 · **1 真缺陷修复:observe 漏召回带交互信号的 SVG 内部元素**
- **靶站轮换**:GitHub(microsoft/vscode,大量 web components)+ SVG 交互(延续 iter-18 SVG 线索)。
- **证伪(GitHub 主流真站全通)**:observe 干净召回 nav/文件树/commit 链;`<details>` Code 下拉点开 → tabs(Local/Codespaces)/clone 链接/readonly textbox/copy 按钮全现 + 状态(selected/expanded/current)正确;`<clipboard-copy>` 点击 → ariaChanged 真、toastHit:[] 无 FP;自定义元素(details-menu/clipboard-copy)整体正常。recharts demo 柱子本环境未稳定渲染(站点问题非 vortex,按防陷阱纪律停)。
- **真缺陷(对照 spike 钉死)**:注入受控 SVG 部件(`<rect>`/`<circle>` 各带 addEventListener('click')、无 role/name、cursor:auto)→ observe **完全不召回**;同容器注入**同条件 HTML div**(click 监听、无 role、cursor:auto)→ **正常召回 `[listener]`**。隔离出「SVG 特有」。进一步:手动给 svg rect 打 `data-vtx-listener="1"` 标记后 observe **仍不召回** → 确诊 bug 在 **scan 收集**(非 T3 discovery)。根因 `observe.ts:1531` fallbackPool 选择器 `*:not(svg *):...` —— **`:not(svg *)` 把所有 svg 后代整类排除**,带交互信号(role/onclick/直绑 listener/可聚焦)的 svg 子元素(recharts/d3 可点 rect·circle、draw.io 形状、地图区域)被整类漏。APG slider(`<g role=slider>` 有 tabindex=0)经主 INTERACTIVE 路径召回故未暴露此洞;纯 listener/cursor 信号的 svg 元素走 fallbackPool 才中招。是 iter-18(act 侧 SVG click 崩溃)的 **observe 侧对偶**。
- **修复**:补 `svgInteractivePool = querySelectorAllDeep("svg [role],svg [onclick],svg [data-vtx-listener],svg [tabindex]:not([tabindex='-1'])")` 仅选带信号的 svg 后代,并入 fallbackPool 收集循环(第 1 个;第 2 个 iconCtaExtras 是 DIV 专属不涉);仍走同一入池门(cursor/framework/listener + require-name)过滤装饰。尺寸门对无 offsetWidth 的 SVG 退回 getBoundingClientRect。主 fallbackPool `:not(svg *)` 保留,补集纯加性。
- **验证**:source-lock 4 测(补集查询/接线/尺寸门/主池保留)+ extension **1305** 通过 + build dist 确认背景 bundle 含 `svg [role]`。**live + bench(MCP 重连后补全)**:reload 新构建(SW 戳 mqoou72o,dist 背景 bundle 确含 `svg [role]`)后,example.com 注入带 click 监听/onclick + aria-label 的 SVG `<rect>`/`<circle>` → observe 由「整类漏」→ 全召回:`graphics-symbol "蓝色方块按钮" [listener]`(rect addEventListener)/`graphics-symbol "红色圆形按钮" [cursor=pointer] [listener]`(circle onclick)/`button "SVG分组按钮"`(g role);**bench 94/94** observeMissed=0 零回归。注:同 rect 的 `vortex_act click` 仍报 `G.click is not a function`——因本分支不含 iter-18 的 click 守卫(PR #76 在独立未合并分支),属预期,合 #76 后即解(SVG 观测/执行对偶各自分支)。
- 桶:1 真缺陷(observe SVG 交互元素召回盲区)。
- **教训**:① observe 的噪声治理排除(`:not(svg *)` 防装饰 path 刷屏)过宽,把带真信号的 svg 控件一并误杀——排除应配「但带交互信号者补回」的对偶逻辑。② SVG 交互缺陷成对:观测(召回)与执行(act click)两侧独立,iter-18 修 act 崩溃、iter-19 修 observe 漏召回,合起来才让 svg 控件可用。③ 对照 spike(SVG vs 同条件 HTML)是隔离「元素类型特有」缺陷的利器;再「手动打标记仍不召回」二分出 discovery vs collection,精确定位到选择器。

### Iteration 20 — flatpickr 日期选择器 + 原生 Popover API · **1 真缺陷修复:原生 popover 打开被 observeEffect 误判无反馈**
- **靶站轮换**:flatpickr(vanilla JS 日历,网格控件)+ 原生 Popover API spike(较新 web 平台特性,GitHub/shadcn 渐广)。
- **证伪(flatpickr 全通)**:observe 完整召回日历(Month combobox/Year spinbutton/prev-next/全部日 cell + June 22 标 `[current]`);`vortex_act click` 选 June 15 → 输入框 value=2026-06-15(observe+act 端到端)。
- **证伪(Popover API 观测/执行正确)**:注入 `<button popovertarget>` + `<div popover>`,observe 关闭态正确隐藏弹层;click 触发 → 原生 popover 打开(`:popover-open` true、display block),observe 次轮正确显触发按钮 `[expanded]`(白盒证:按钮**无 aria-expanded 属性**,observe 从 popover 隐式状态推断)+ 召回弹层内按钮。**vortex 对 Popover API 的感知/操作正确**。
- **真缺陷(白盒确诊)**:popover 打开后 `observeEffect` 报 `domMutations:0 / ariaChanged:false / toastHit:[] / dialogHit:[] / userFeedback:"none"`。根因:原生 Popover API(showPopover)把元素移入 **top-layer**,无 DOM mutation、无属性变化,框架 dialog/toast 选择器也不匹配 → click-effect 三信号全 0 → userFeedback 误报 "none",agent 误判点击无反馈(silent-fail 假阳,与 iter-2 announcer toast FP / GAP-G 同族:effect 信号质量)。click-effect 已检测 dialog/toast 瞬态浮层,Popover API 是同类瞬态浮层却漏检。
- **修复**:① shared `DIALOG_SELECTORS` 加 `:popover-open`(仅匹配带 popover 属性的打开态,精确不误伤 flatpickr/antd 等非原生浮层;只有 click-effect 一个消费者)② `collectFeedback` 逐选择器 try 包裹(`hitAny` helper)——`:popover-open` 在不支持 Popover API 的浏览器抛 SyntaxError,原**单 try** 会让整批 toast/dialog 检测退化为 none(catch 里 `classifyFeedback(false,false,..)` 丢掉已采集命中),逐选择器 guard 只跳过抛错项。打开 popover → userFeedback "dialog"、dialogHit 含 `:popover-open`。
- **验证**:TDD —— click-effect-feedback 加 shared 选择器锁定;helper 加 2 行为测(mock `:popover-open` 命中 → dialog;mock `:popover-open` 抛 SyntaxError → toast 仍检测,锁逐选择器 guard);extension **1304** 通过。**live + bench(MCP 重连后补全)**:reload 新构建(SW 戳 mqosbgl7)后,example.com 注入 popover,`vortex_act click` 触发 → `effect` 由 `userFeedback:"none"` → **`userFeedback:"dialog"` + `dialogHit:[":popover-open"]`**(domMutations 仍 0,证 popover 确无 DOM 变化、信号纯靠 :popover-open 状态选择器补);**bench 94/94** 零回归。(踩坑:shared src 改后 vitest 解析到编译 dist,须先 `npm run build` shared 包才被拾取——见教训③。)
- 桶:1 真缺陷(observeEffect 反馈信号对 Popover API 漏检)。
- **教训**:① 原生 Popover API(及 `<dialog>` top-layer 类)的状态切换无 DOM mutation/属性变化——基于 MutationObserver 的 effect 检测天然盲,须用 `:popover-open` 等状态选择器补;observe(真值)次轮能反映,但 effect 旁证须同步否则 silent-fail 假阳。② 批量 querySelectorAll 含可能不支持的新选择器(`:popover-open`/`:has` 等)必须逐选择器 try,否则一个 SyntaxError 拖垮整批——单 try 是脆弱点。③ vitest 对 monorepo 内 `@vortex-browser/shared` 解析到 **dist**(非 src),改 shared 源后须先 build shared 包,否则单测读旧常量假绿/假红(本轮 feedback 选择器断言一度假红)。④ observe 从 popover 隐式状态推断 `[expanded]`(按钮无 aria-expanded)是已有的正确行为,印证感知层成熟。

### Iteration 21 — Shoelace(Lit Web Components,大量 shadow DOM)· **1 真缺陷修复:裸 ARIA role 选择器把常驻正文内容块误判为 toast 反馈**
- **靶站轮换**:shoelace.style/components/select(Lit-based Web Components 库,大量 open shadow DOM,检验 observe 穿透 + effect 信号在 web component 上的正确性)。测 `sl-select`(shadow DOM 内渲染 listbox/option 的自定义下拉,页面 23 个实例)。
- **证伪(observe 穿透 shadow DOM 正确)**:首个 sl-select 经 observe 表示为 `combobox [haspopup:listbox]`;点击打开后次轮 observe 正确召回 shadow DOM 内 `option "Option 1"`~`"Option 6"` 全部选项 + combobox 标 `[expanded]`。**observe 对 Lit web component 的 open shadow listbox 穿透召回完全正确**(印证 querySelectorAllDeep 成熟)。顶部 blindspot 元数据正确标注页面虚拟列表(`ul virtual(~114/7)`/`table virtual(~241/8)`)。
- **真缺陷(白盒 spike 确诊)**:点击 sl-select 打开下拉 → `observeEffect` 报 `userFeedback:"toast"` + `toastHit:["[role='alert']"]`。开下拉≠toast 反馈,高度可疑。深度遍历(含 shadow)所有 `[role="alert"]` 钉死:命中的 3 个元素全是**文档说明框** `div.callout--tip`/`callout--warning`(760×106px 完全可见正文内容块,文案 "This component works with standard forms…"、`position:relative` 在正常文档流),用了语义错误的 `role="alert"`(真实世界普遍存在)。根因 `page-side/click-effect.ts` `collectFeedback`:**裸 ARIA role 选择器**(`[role='alert']`/`[role='status']`/`[role='dialog']`/`[role='alertdialog']`)既被瞬态 toast/对话框用,也被常驻正文内容块误用;现有 sr-only 尺寸滤(≤1px,iter-2 Next.js route announcer 修复)对这类**大尺寸完全可见**内容块拦不住 → 每次 click 误报 toast(silent-fail 假阳反面:无反馈误报有反馈,与 announcer toast FP 同族但新变体)。
- **修复**:`collectFeedback` 对裸 role 选择器(`sel.startsWith("[role=")`)的命中额外要求**定位浮层**——新增 `isOverlayPositioned(el)` 沿 `parentElement` 上溯,命中任一 `position ∈ {fixed,absolute,sticky}` 祖先即判浮层(真 toast/对话框恒为定位浮层,脱离正常流或固定视口;文档内容块在正常流 static/relative)。框架专属 `.class` 选择器**不经此门**(bootstrap `.toast` item 自身常 static、容器才 fixed,加位置门会漏报),仅裸 role 选择器受约束。toast 与 dialog 两族统一加门(同一根因一处修)。
- **验证**:TDD —— helper 加 4 测(in-flow role=alert 内容块 position:relative → toastHit 空/userFeedback != toast;position:fixed 真 toast → toast;自身 static 但祖先 fixed → toast;`.toast` 类 static 不受门约束 → 仍 toast);**RED**(in-flow 内容块被判 toast)→ **GREEN**;extension **1305** 通过。踩坑:`isOverlayPositioned` 初用裸 `getComputedStyle` 在 vitest(node 环境,无全局 getComputedStyle)被 catch 吞,改 `window.getComputedStyle`(测试 `globalThis.window=dom.window`、真实页面 window 同样有效)后通过。**live + bench**:只 build extension 包(不碰 mcp/dist → MCP 不断连),reload shoelace 页强制全新 page-side 注入(version 守卫致旧 v3 模块不被覆盖,须 reload 页面)后,同一 sl-select click → `effect` 由 `userFeedback:"toast"`/`toastHit:["[role='alert']"]` → **`userFeedback:"mutation"`/`toastHit:[]`**(domMutations:15 开下拉正确归为 mutation);**bench 94/94** 零回归。
- 桶:1 真缺陷(observeEffect toast 反馈假阳,裸 role 选择器误匹配常驻内容)。
- **教训**:① ARIA `role="alert"`/`status` 语义上同时服务瞬态 toast 与常驻重要内容,真实站点(文档/营销页)大量把说明框标 role=alert——裸 role 选择器作 toast 信号必须配「定位浮层」区分门,否则常驻内容块每次 click 假阳。② sr-only 尺寸滤(≤1px)只挡视觉隐藏 announcer,挡不住大尺寸**可见**的误用内容块——同一假阳族有「不可见 announcer」与「可见内容块」两个变体,需不同判别(尺寸 vs 定位)。③ 定位门只加给裸 role 选择器、放过框架 `.class`——因 toast 库布局多样(bootstrap toast item 自身 static、容器 fixed),对精确类选择器加位置门反致漏报;「泛化 role 选择器收紧、专属类选择器放行」是正确粒度。④ page-side 模块有 version 守卫,改 page-side 后 dev_reload 不足以让已加载页生效,须 reload 页面强制全新注入;只 build 单包(extension)可避免 MCP 断连。⑤ page-side 取计算样式用 `window.getComputedStyle`(非裸 `getComputedStyle`),兼容 node 测试环境(globalThis.window 桥接 JSDOM)与真实页面。

### Iteration 22 — FullCalendar(日历网格 + 事件渲染 + "+more" 浮层)· **1 真缺陷修复:observe 把单一复合控件(<a.fc-event>)误判多 CTA 容器拆成碎片**
- **靶站轮换**:fullcalendar.io/demos(日历网格,池外、本 session 未碰,富感知:日期 cell / 事件 div / "+N more" 浮层 / 拖拽)。
- **证伪(observe 主体正确)**:日期 cell(link + desc="Go to June X")、全天事件、tabs、nav 按钮全召回;点 "+2 more" → 浮层打开(domMutations:9、`[expanded]`、`userFeedback:"mutation"` 无 toast 假阳)+ 浮层内隐藏事件召回(候选 117→128);月/周/日/list 视图按钮状态(`[active]`/`[disabled]`)正确。
- **真缺陷(白盒 spike 确诊)**:定时事件经 observe 碎成**两个分离 ref**(`div "4p"` + `div "Repeating Event"`),而非单一事件节点。spike 钉死 DOM:FullCalendar 定时事件是 `<a class="fc-event">`(cursor:pointer、**无 href/role**,vanilla JS 驱动)含 `.fc-daygrid-event-dot`(空)+ `.fc-event-time` "4p" + `.fc-event-title`,三者皆 cursor:pointer。time/title 两个有文本 cursor:pointer 子进 cursorPointerExtras → `isMultiCtaContainer`(observe.ts ~1770:kids≥2 + withText≥2 + `!isClickableContentCard`)**误判 `<a>` 为多 CTA 布局容器** → drop `<a>`、保两子 → 一个事件碎成两 ref、"4p" 成误导性局部动作(agent 困惑该点哪个)。根因:多 CTA 拆分(#42 班牛 createBox 三独立按钮)本为「非交互布局层 div 含多个独立 cursor:pointer 子按钮」设计;原生 `<a>`/`<button>`/`<summary>`/交互 role 是**单一复合控件**,其 cursor:pointer 子是视觉部件非独立动作,不该拆分。(vanilla JS 故 hasFrameworkClick=false → isClickableContentCard=false → 误判路径打通。)
- **修复**:新增导出 `isCompoundControlSelf(el)`(tag A/BUTTON/SUMMARY 或交互 role ∈ SINGLE_CONTROL_ROLES)+ inject func 内联副本(源码锁),在 `isMultiCtaContainer` 的 `kids<2` 检查后前置否决——原生交互祖先不拆分,保留祖先(文本含各子)、drop 视觉部件子。多 CTA 真容器(div/span/li 无交互 role,如 createBox `.box`)不受影响。
- **验证**:TDD —— `observe-compound-control.test.ts` 13 测(导出函数行为:`<a>`无href/`<button>`/`<summary>`/交互 role → true,div/span/li/`[role=group|toolbar]` → false,多 token role 取首;源码锁:内联定义 + SINGLE_CONTROL_ROLES 不漂移 + isMultiCtaContainer 接入);extension **1314** 全通过。synth fixture `compound-control-event`(忠实复刻裸 `<a.fc-event>` + time/title 子,oracle 打 `<a>`:碎片化时 geometry join 命中首子 "4p" → name-mismatch)scan **recall=1/1 P0=0 findings=0**;全量 synth scan 15 fixture 无新增失败(`native-form-baseline` 15/17 P0=2 经 **stash observe.ts 复扫确认预存失败**——input[type=file]cursor:pointer/[type=range] 召回漏,非本轮回归,留未来轮)。**live**:reload FullCalendar 后定时事件由 `div "4p"`+`div "Repeating Event"` 两碎片 → 单一 `a "4pRepeating Event"`(e45/e46),"10:30aMeeting"/"12pLunch"/"2:30pMeeting"/"7aBirthday Party" 全合并,候选 117→109;全天事件(All Day/Long/Conference)保持单 div 不变;**bench 94/94** 零回归。
- 桶:1 真缺陷(observe 嵌套 cursor:pointer 单一复合控件碎片化)。
- **教训**:① 多 CTA 容器拆分(为布局 div 含多独立按钮设计)与单一复合控件(原生 `<a>`/`<button>` 含 time/title 视觉部件)是镜像场景——拆分启发须先否决「祖先自身是原生交互元素」,否则 FullCalendar/日历类 time+title 事件、icon+label 按钮全碎片化。② 裸 `<a>`(无 href)+ cursor:pointer 是 vanilla JS 单一控件的常见形态(fc-event),`a[href]` 选择器漏它,需按 tagName 判定。③ 承重墙(嵌套 cursor:pointer 择叶)改动严守「导出纯函数 + 内联副本 + 源码锁 + synth fixture + 全量 bench/scan 回归」,且任何 scan 新失败必 stash 复扫区分回归 vs 预存(本轮 native-form-baseline 即预存)。④ synth fixture name 受布局影响(inline-block 子间空格 → "4p Repeating Event",真站紧排 → "4pRepeating Event"),expectedName 须按 fixture 实测渲染设,不可照搬真站。

### Iteration 23 — native-form-baseline(原生表单控件)· **1 真缺陷修复:bench observe-parser 漏解析 compound=(...) 行致 file/range input 假 recall-miss**
- **线索来源**:iter-22 全量 scan 发现 `native-form-baseline` 15/17 P0=2(c8 file input / c16 range input recall-miss),当轮 stash 复扫确认非 compound-control 回归、留作本轮目标。
- **确诊(实机白盒,辨明缺陷归属)**:① live `vortex_observe scope=full` **两者都正确召回** —— `button "File input" [e8]` + `slider "Example range" [e16]`,role/name 正确;② `includeBoxes=true` 的 **bbox 也完全正确**(e8=[512,228,416,38]、e16=[952,230,416,24],与真实 getBoundingClientRect 一致)。**observe 扩展零缺陷**。③ 缺陷在 **bench 测试谐架**:`scan` 报 recall-miss。spike 钉死:e8/e16 是全页**唯二带 `compound=(...)` 注解**的行(`compound=(file-input file=None)` / `compound=(range-input min=0 max=10 step=1)`)。bench `observe-parser.ts` 的 `TREE_ROW_RE` 只容忍 `value=` 与 `bbox=` 两段,遇 `compound=(...)` 整行正则失配 → 行被静默丢 → `parsed1.rows` 无此两行 → `joinByGeometry` 无行可匹配 oracle → 假 recall-miss。对照 observe-render.ts:458 字段顺序,value= 与 bbox= 间还有 `compound=`/`error=`/`controls=`/`desc=`/`[offscreen]`/`[virtual:..]`/`[blindspot=..]` 全部不被解析器容忍——任一出现即丢行。
- **修复**:`TREE_ROW_RE` 与 `FLAT_ROW_RE` 把 flag 段与 `bbox=` 间的固定 `(?:\s+value=...)?` 替换为惰性 `.*?`,整体跳过所有中间段(value/compound/error/controls/desc/offscreen/blindspot);`bbox=` 恒为末尾数据段(后仅跟可选 children 冒号),由 `.*? + 末尾捕获` 经正则回溯稳妥提取。flag 段(状态如 disabled/checked/cursor=pointer 全在 value= 前)与 bbox 捕获组下标不变。
- **验证**:TDD —— observe-parser.test.ts 加 5 测(compound=(file-input)/compound=(range-input)/desc=·[offscreen]·[virtual:]·[blindspot] 中间段/无 bbox 仅 compound/compound+children 冒号),**RED**(5 行全丢)→ **GREEN**;vortex-bench 单测 **302** 全通过。**scan**:`native-form-baseline` 由 15/17 P0=2 → **17/17 P0=0 findings=0**;全量 `scan --all` 14 fixture 全 P0=0 无回归(nameless-control findings=1 / overlay-truncation findings=29 为既存 P1/P2,与 iter-22 同)。94-case `run` bench 经 grep 确认 `eval.ts` 不引用 parseObserveSnapshot(parser 仅 scan/judge/snapshot 用),不受影响、无需重跑。
- 桶:1 真缺陷(bench 测试谐架 observe-parser 解析盲区,**非 vortex 产品缺陷**)。
- **教训**:① 缺陷归属须实机辨明 —— bench scan 的 recall-miss 不等于 observe 漏报;先 live observe(文本 + includeBoxes 的 bbox)确认产品层正确,再定位到测试谐架解析层。observe 输出正确但 bench 解析器跟不上其字段演进(compound= 是较新 compound-widget 注解),导致**回归门对 compound 控件(file/range/date/number/combobox)的召回失去监控**——真实 observe 回归会被静默掩盖。② 解析器与被解析格式(observe-render.ts:458 字段链)是契约,渲染端加字段(compound/error/controls/desc/blindspot)解析端须同步;脆弱点=正则枚举固定字段,改用「flag 段精确 + 中间段惰性跳过 + bbox 末尾捕获」更耐字段演进。③ 此类「测试谐架假阴性」修复价值=恢复回归门覆盖,优先级等同产品缺陷(否则未来真缺陷漏网)。

### Iteration 24 — tiptap.dev(文档站,lucide svg 图标库)· **1 真缺陷修复:observe iconNameFromClass 漏读 lucide svg 类致图标按钮被 Tailwind 布局类误命名**
- **靶站轮换**:tiptap.dev/docs(富文本编辑器文档站,大量 lucide svg 图标 + Tailwind)。原拟测 TipTap 编辑器 contenteditable,该文档页无嵌入编辑器,转测文档站本身控件。
- **证伪(observe 主体正确)**:nav/sidebar/TOC 链接全召回,role/name/url 正确;`[haspopup:menu]` 触发器标注正确。
- **真缺陷(白盒 spike 确诊)**:侧栏 6 个展开/折叠按钮经 observe 命名为 `button "p-0"`(无意义 Tailwind 布局类)。spike 钉死 DOM:`<button class="p-0.5 rounded hover:bg-grayAlpha-100">`(无 aria-label/title/text)含 `<svg class="lucide lucide-chevron-right">`(chevron 图标,无 `<title>`)。根因 `observe.ts:614 iconNameFromClass`:svg 无 `<title>`/aria-label → 落到**按钮 className 兜底**,正则 `^_?([a-zA-Z][a-zA-Z0-9_-]{2,})` 把 Tailwind 类 `p-0.5` 截成噪声名 "p-0"(且 "p-0.5"→"p-0" 被截);**它从不读 svg 自身的 `lucide-chevron-right` 类**(图标语义真源)。lucide 是 shadcn/ui 等广用的 svg 图标库,svg 类是图标语义的标准载体。
- **修复**:`iconNameFromClass` 在 className 兜底**之前**,新增读 inner svg 的 class:命中 `lucide-<name>` / `feather-<name>`(feather 是 lucide 前身,同约定)即返回 `<name>`(hyphen→空格)。guard 在 `inner.tagName === "svg"` 分支(不误伤 img alt 路径)。
- **验证**:源码锁 3 测(lucide/feather 正则存在 / 在 className 兜底前 / svg 分支内 guard);extension **1304** 全通过。synth fixture `lucide-icon-button`(lucide chevron 按钮,oracle expectedName="chevron right")scan **recall=1/1 P0=0 findings=0**;全量 `scan --all` 15 fixture 无新增失败(`icon-name-priority` 2/2 不回归;`native-form-baseline` 15/17 是 iter-23 parser 修复未合并 main 所致,非本轮)。**live**:reload tiptap 后 6 个侧栏按钮由 `button "p-0"` → `button "chevron right"`;**附带改善** TOC 锚点链接由 `link "text-grayAlpha-600"`(className 泄漏)→ `link "hash"`(lucide-hash 图标),证修复对 lucide chevron + hash 等全生效;**bench 94/94** 零回归。
- 桶:1 真缺陷(observe 图标按钮命名质量:漏读 svg 图标库类、误取 Tailwind 布局类)。
- **教训**:① svg 图标库(lucide/feather)的图标语义在 **svg 自身 class**(`lucide-<name>`),非按钮 className 或 svg `<title>`——iconNameFromClass 须优先读 svg 类,否则无 aria-label 的图标按钮(海量,shadcn/ui 生态)命名退化到按钮的 Tailwind 布局类(`p-0.5`/`gap-2`/`mt-4`),正则截断成噪声名(p-0)误导 agent。② className 兜底正则 `[a-zA-Z0-9_-]{2,}` 不识别 Tailwind 工具类,会把布局类当语义名——根治是「先读已知图标库语义源」而非「枚举否决无穷 Tailwind 类」。③ 一个命名源修复常连带改善多处(chevron 按钮 + hash 锚点链接同走 lucide 路径)。

### Iteration 25 — Lexical playground(証伪)+ swiperjs.com · **1 真缺陷修复:observe iconNameFromClass 把 Tailwind 布局/变体工具类当图标名泄漏**
- **靶站轮换**:① playground.lexical.dev(Meta 生产级富文本编辑器,contenteditable + 工具栏 + 下拉 + @-mention typeahead)② swiperjs.com/demos(Tailwind 站)。
- **证伪(Lexical 全干净)**:observe 召回编辑器 `textbox` 含完整 value + 嵌套链接;工具栏全命名;文本样式下拉点开 → 9 菜单项(Normal/Heading/List/Quote/Code)召回**且 overlay-priority 前置顶部**;`compound=(number-input min=8 max=72)` 正确;**act**:文本样式下拉 click effect 正确(mutation 无假阳)、contenteditable `type` "VORTEXTEST" 经 cdp-insertText 正确插入、**@-mention typeahead** 输入 "@Luk" → `option "Luke Skywalker" [selected][active]` 召回+overlay 前置。零 vortex 缺陷。(e37 `editor-dev-button` 无名=Lexical 自身无 aria-label/text/svg 的 CSS 背景图标按钮,无可提取名源,observe 报无名可点是正确处理。)
- **真缺陷(Swiper 白盒 spike 确诊)**:observe 把 `link "mb-4"`(e1)、`link "block"`/`link "hover"`(e47)等命名为 Tailwind 工具类。spike 钉死:`<a class="mb-4"><img class="size-12" alt=""></a>`(装饰 img 空 alt)、`<a class="-mt-4 block duration-300 hover:opacity-75"><img></a>`(无 aria-label/title/alt)落到 `iconNameFromClass` 的 className 兜底,正则 `^_?([a-zA-Z][a-zA-Z0-9_-]{2,})` 把 Tailwind 布局类(mb-4/block/size-12)及变体类冒号前段(hover:opacity-75 → "hover")当语义名返回 → agent 收到噪声误导名。是 iter-24 lucide 修复推迟的广义 Tailwind 泄漏(iter-24 只覆盖含 lucide svg 的;无 lucide 的图标元素仍泄漏)。
- **修复**:新增导出 `isTailwindUtilityClass(token)`(关键字集 block/flex/grid/hidden/absolute… + 前缀正则 m-/p-/w-/h-/size-/gap-/text-/bg-/border-/z-… + **变体冒号判定** `t.includes(":")`)+ inject func 内联副本(源码锁)。`iconNameFromClass` className 兜底里对**原始 token** 早检测(变体类冒号在正则裁剪前才在)`continue` 跳过。真语义图标类(icon-search/close/chevron-down/arrow-left)不命中,正常保留。
- **验证**:TDD —— `observe-tailwind-utility-name.test.ts` 12 测(间距/尺寸/显示关键字/颜色前缀/变体冒号 → true;真图标类/menu/media/play → false;大小写无关;源码锁:内联定义 + 原始 token 早检测 + 冒号判定双副本);extension **1313** 全通过。**live**:reload swiper 后 `link "mb-4"` → 无名(装饰 img 链接)、e45 paneflow 链接(全 Tailwind 类)由 "block"/"hover" → **完全无名**(诚实带 href);无新泄漏;全量 `scan --all` 14 fixture 无新增失败(`icon-name-priority` 2/2 + `roleless-close-icon` 1/1 证未误伤真图标名;`native-form-baseline` 15/17 是 iter-23 parser 修复未合并 main);**bench 94/94** 零回归。
- 桶:1 真缺陷(observe 图标命名质量:Tailwind 布局/变体工具类泄漏)+ 1 大类証伪(Lexical 富文本全栈)。
- **教训**:① className 命名兜底的正则 `[a-zA-Z0-9_-]{2,}` 不识别 Tailwind 工具类,在原子 CSS 站(Tailwind/UnoCSS,占现代前端大半)会把 mb-4/block/size-12/hover:* 当语义名——根治是关键字集 + 前缀族 + 冒号变体三管齐下,而非枚举。② 修复须对**原始 token** 检测变体冒号(正则裁剪后冒号已丢,只剩 "hover"),即「检测位置决定能否命中」。③ live 复验抓到首轮修复后的残留泄漏(block→hover 同元素换 token),证 live 是承重墙改动的必要关——单测/scan 用我自造样本可能漏真站的类组合。④ iter-24(lucide svg 类)+ iter-25(Tailwind 类否决)合起来才完整治理图标元素命名:前者补真语义、后者去噪声泄漏,互补。
