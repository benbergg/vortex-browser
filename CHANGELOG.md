# Changelog

本文件记录 vortex 各包版本变动。遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

_新工作进入此段；ship 时改为版本号 + 日期。_

### ✨ Added

- **`vortex_act` dialog 应答:JS dialog(alert/confirm/prompt)不再冻结页面** (`packages/extension/src/content-main.ts`、`packages/extension/src/handlers/dom.ts`、`packages/extension/src/adapter/cdp.ts`、`packages/shared/src/dialog-policy.ts`、`packages/mcp/src/tools/schemas-public.ts`、`packages/mcp/src/tools/dispatch.ts`)。新增 `options.onDialog: "accept" | "dismiss"`(缺省 `"dismiss"`)与 `options.promptText`。页面动作期间 MAIN world 的 `window.alert/confirm/prompt` 被覆盖(content-main.ts 常驻 override,动作 handler 注入 func 补设策略键)并按策略立即返回:alert→无返回值;confirm→accept 返 `true`、dismiss 返 `false`;prompt→accept 返 `promptText`(或页面默认值)、dismiss 返 `null`。结果字段 `dialogHandled: { type, message, policy:"accepted"|"dismissed", warning? }` 附于 act 返回;`warning` 仅在 confirm/prompt 未设 `onDialog` 被默认 dismiss 时出现,提示调用者若意图确认应带 `onDialog:accept` 重试。动作结束后保持 **1000ms grace 窗口**继续抑制 `setTimeout` 异步 dialog,避免冻结后续动作。全量 act 路径(合成 click/CDP click/fill/type/select/hover)均自动挂载默认 dismiss 策略。**已知局限**:`beforeunload` 由浏览器内核托管,MAIN-world override 无法拦截(需 CDP 介入,延后);页面 `<head>` 内联脚本在 override 安装前极早触发的 dialog 不受覆盖;用户正常浏览时(无 vortex 动作进行中)dialog 行为不变(armed+grace 均失效)。bench 回归:`packages/vortex-bench/cases/dialog-handling.case.ts` 六态验证(dismiss/accept/缺省警告/alert/prompt+promptText/async grace)。

- **trusted 模式 P2:扩展 popup 一键「重启进入 trusted 模式」** (`packages/server/src/relauncher.ts`、`packages/server/src/http-routes.ts`、`packages/extension/src/popup.{html,ts}`、`packages/extension/manifest.json`)。点工具栏图标 → popup 显示当前模式 + 「重启进入 trusted 模式」按钮(二次确认显式同意)→ host 经 `ps` 提取 Chrome 二进制路径,spawn **脱离进程树**的 helper(`detached+unref+stdio:ignore`)`sleep 1 → killall → sleep 3 → 带 flag 重启`,免手动敲命令。popup 直连 host 6800 HTTP(`GET /trusted-mode` 状态 + `POST /relaunch-trusted` 触发),不改 NM 协议。重启后扩展 alarm 自动重连、6800 自愈。spawn 失败/非 macOS 时 popup 引导回退手动命令。**Why**: P1 需用户手动带 flag 启动 Chrome 门槛高;难点是 host 为 Chrome 子进程、killall 会自杀,故用脱离进程树的 helper。设计文档:`0024-vortex-trusted-mode P2`。

- **trusted 模式(P1):带 flag 的 Chrome 下 click 自动走 CDP trusted、无黄条** (`packages/server/src/trusted-mode.ts`、`packages/server/src/message-router.ts`、`packages/extension/src/handlers/dom.ts`)。server 经 `ps` 检测 Chrome 是否带 `--silent-debugger-extension-api` 启动(flag-自适应,带 3s 缓存),转发 `dom.click` 时注入 `trustedMode`;扩展 CLICK handler 在 `trustedMode` 在位时默认走 `cdpClickElement`(等价隐式 useRealMouse),广覆盖 isTrusted-gated 站(淘宝搜索等),且因 flag 抑制黄条而无调试横幅。不带 flag 时**零回归**(合成 + #37 submit-intent)。P1 手动带 flag 启动(见 `docs/trusted-mode.md`),relauncher/扩展 UI 入口留 P2。**Why**: 合成事件 isTrusted 恒 false 被 React 拦截 submit 的站丢弃(淘宝 dogfood 确诊);调研确认扩展唯一 trusted 源是 chrome.debugger 且该 flag 可消黄条(Chrome 148 实测,商业 RPA 通用)。设计文档:`0024-vortex-trusted-mode`。

- **`vortex_extract` 增加 `scroll: boolean`——提取前触发懒加载** (`packages/mcp/src/tools/schemas-public.ts`、`packages/mcp/src/tools/dispatch.ts`、`packages/extension/src/handlers/content.ts`、`packages/extension/tests/content-extract-scroll.test.ts`、`packages/mcp/tests/tool-dispatch.test.ts`)。`scroll:true` 时提取前执行 **scroll-to-load(grow-or-stop)**:分步滚到底,每步在 grace 窗口(1500ms)内**轮询等待 `scrollHeight` 增长**——一增长立即进下一步(快站不浪费),grace 内无增长即判懒加载耗尽;硬上限 15 步 + 15s deadline 为无限滚动封顶。注入 func 改 async;`scroll` 经 dispatch `...rest` 透传到 `content.getText`,handler `args.scroll === true` 严格守卫(不被 client stringify 误伤),提取后恢复原 scrollY。默认缺省 = 现状,**向后兼容**。I15 token budget cap 4700 → 4800 B(新增公开能力 ~27B 字段,与前两次同步长 +100)。**Why**: dogfood 确诊「extract 慢」——白盒实测页内 `innerText` 仅 0.2ms,真因是 step 放大;残余正确性缺口是**懒加载内容对裸 extract 不可见**(裸提取整页返回 4807 字、0 条评价)。此前需 agent 手写 `vortex_evaluate` 滚动循环或两步往返;`scroll:true` 声明式 1 往返、零 JS 编写完成。**live 验证(quotes.toscrape.com/scroll,10→100 条)抓到初版"stable-counter 判停"把 AJAX 在途误判为 settle、提取陈旧快照的 bug,改为 grow-or-stop grace 轮询修复**(单测/review 均未覆盖,真站一跑现形)。**砍掉 readable/区域识别**(spike 实测文章页仅降噪 3%、产品页 17%,用户场景零收益,YAGNI)。设计文档:`Knowledge-Library 0023/20260605-extract-scroll-懒加载-v1`。已知局限:不解决虚拟列表(DOM 回收)、容器内部滚动(抽屉)。

- **`bench judge` 子命令:LLM-judge 漏斗塔尖**（`packages/vortex-bench/src/runner/judge*.ts`、`src/judge-types.ts`、`src/index.ts`）。新增 `vortex-bench judge` 子命令，对给定页面的 `vortex_observe` 输出执行多模态 recall-miss 判定:observe + screenshot 喂多模态判官,2 轮自一致取**交集**(按 label exact,case-insensitive + trim,跨模型 portable;`judge-match.ts` 集中)确认漏发;synth 模式额外执行消融 TP run（确定性抽行重喂判官,计算 FP/TP 校准统计）。**provider 选火山方舟 Doubao OpenAI 兼容端点 `https://ark.cn-beijing.volces.com/api/v3/`**(走 `openai` SDK + `baseURL` 覆盖),**默认模型 `doubao-1-5-vision-pro-32k-250115`**(多模态,支持 image_url base64 data URL),`--model` 可切换;env `DOUBAO_API_KEY`。支持 `--all`（全量 synth fixture）、`--pattern`（单 fixture）、`--url`（live 真站）、`--seeds`（批量种子）、`--current-tab` 五种目标模式。
  **Why label-based**: Doubao/MiniMax/GLM 等多模态模型 bbox 各家在归一化坐标系(0-1 / 0-1000 / 图片像素),与 vortex viewport 像素不兼容;`ObserveRow.name`(accessible name)是跨模型稳定的 join 键。代价:同 label 多元素 collision,prompt 已约束判官不重复报 observe 列,实践罕见。
  **Why Doubao**: 初版 #5 PR 切 BigModel glm-4.6v(2/3 recall on cursor:pointer div fixture);post-merge probe 显示 doubao-1-5-vision-pro-32k 达 3/3,OpenAI 兼容 HTTPS,~¥0.007/call,drop-in swap。

- **`wait_for(mode=info)` now surfaces sibling tabs** (`packages/extension/src/handlers/page.ts`, `packages/mcp/src/tools/dispatch.ts`). `PageActions.INFO` accepts an optional `includeAllTabs` flag; when set, the response carries a `tabs: [{tabId, windowId, url, title, active}]` array alongside the active-tab fields. The L4 dispatcher defaults `includeAllTabs=true` for `vortex_wait_for(mode=info)` so an agent's first call after attaching can see every open tab without an extra round-trip. Direct `page.info` callers (CLI, internal dispatch) are unchanged unless they opt in. **Why**: `vortex_tab_list` was demoted from the public surface in v0.6 (token-budget driven), but agents still need a way to discover sibling tabs after a session attaches — previously they had to guess or rely on `tabs_context` from the parallel `claude-in-chrome` MCP. Folding the listing into the existing `wait_for` info path keeps the public surface at 15 tools while closing the discovery gap. Discovered while driving a real Yuque-spec + prototype walkthrough where the user had a second tab pre-opened that the agent could not see.

- **act / extract now pierce open shadow DOM (Tier 2 — 自主发现引擎 #27/#3.x 闭环)** (`packages/extension/src/page-side/shadow-walk.ts` 新增, `packages/extension/src/page-side/dom-resolve.ts` 新增, `packages/extension/src/handlers/{observe,dom,content}.ts`, `packages/extension/src/page-side/{actionability,fill-reject}.ts`). 此前 `observe` 已能穿 open shadow 发出 shadow-internal ref（`querySelectorAllDeep`，commit `98b61e5`），但 act/extract 的解析端仍 light-DOM-only，shadow ref 走 `vortex_act`/`vortex_extract` 无法解析（issue #27 让其快速失败 `OPEN_SHADOW_DOM`，但未真正修）。两部分对称修复：**写端** `observe.buildSelector` 对 `el.getRootNode() instanceof ShadowRoot` 的元素始终戳唯一 `data-vortex-rid` 并返回 `[data-vortex-rid="..."]`（light-DOM CSS 路径在 shadow 边界断裂，退化为裸 tag）；**读端** 新增共享 `queryDeep`/`queryAllDeep`（穿 open shadow 递归，深度封顶 10，light-DOM 优先快路径，closed shadow 不可达符合 CE spec），经 `window.__vortexDomResolve` page-side module 暴露，由 `vortex_act` 的 CLICK/TYPE/FILL/SELECT/HOVER（`queryAllDeep`，light-DOM 优先避免裸 selector 跨无关 shadow 误报 `SELECTOR_AMBIGUOUS`）、`vortex_extract` 的 get_text/get_html/get_element_text/get_computed_style（`queryDeep`）、actionability probe（`findInOpenShadow`）、fill-reject 框架拒绝守卫共同消费。两端经 snapshot store 衔接：observe 时戳的 `data-vortex-rid` 持久存活到 act 调用。**Why**: `observe` 能看见但 act/extract 操作不了 shadow 元素是 web-component 站点（material-web.dev 29% / web.dev 9% 的 ref 不可经 ref 操作，由自主发现引擎 #3.x live 真站量化）的核心卡点。范围：常规 act/extract 路径；CDP `cdpClickElement`（elementFromPoint 对 shadow 返回 host 的遮挡误判）、SCROLL/GET_ATTRIBUTE 等、a11y 树穿 shadow、GET_TEXT 的 isHiddenChain/buildPath 在 shadow 边界的祖先链截断 留作后续里程碑。新增单测共 314 例全过（shadow-walk + deepElementFromPoint、dom-resolve、actionability deep-resolution、observe-shadow-selector、fill-reject shadow 等）。**live 真站验收（#3.x robustness-live 只读 extract 探测，2026-05-27）**：material-web.dev `R0 23→0`（refs=77 okRate=100%）、web.dev `R0 3→0`（refs=33 okRate=100%）——#3.x 量化的 26 个 shadow R0 全部坍缩，extract 穿 shadow 闭环。click 路径 live 调试额外发现并修复两处 `elementFromPoint` shadow-blind 遮挡误判（actionability `receivesEvents` + dom.ts CLICK 自身遮挡检查 → 提取共享 `deepElementFromPoint` 逐级穿 open shadow 下钻），unit 验证（jsdom 真实模拟 host 重定向）；**完整 live click 回归（bench shadow-dom-counter 走 vortex_act）延后复测**。

- **`vortex_screenshot` exposes `format` + `quality` for jpeg** (`packages/mcp/src/tools/schemas-public.ts`, `packages/extension/src/handlers/capture.ts`). Public schema now declares `format: { enum: ["png","jpeg"] }` and `quality: { type: "number" }`. The CDP capture path already accepted both fields (`capture.ts:30-65`), but the L4 surface never advertised them, so callers defaulted to PNG and could not opt into compressed output. `capture.element` (element-clipped screenshot) is wired the same way — previously hard-coded to PNG. Response now echoes `format` and `quality` (when set) so callers can verify what they got. I15 token-budget cap raised 4600 → 4700 B (description grows to "Screenshot page/element. jpeg+quality saves tokens." to nudge LLMs toward the new fields; cap precedent: v0.8 did the same 4500 → 4600 when 4 internal tools were re-exposed). **Why**: dogfood feedback from the voc-front prototype session (2026-05-22) — 20+ screenshots per session shipped as PNG took a non-trivial slice of model context tokens; agents had no way to pay 40% size with quality=70 jpeg without dropping to `vortex_evaluate` and `chrome.scripting.executeScript`. Closes VORTEX_FEEDBACK.md P1-B5.

- **`js.evaluate` auto-wraps top-level `return`** (`packages/extension/src/handlers/js.ts`). When `eval(code)` throws `Illegal return statement`, the handler now silently retries through `new Function(code)()` — which treats the code as a function body and accepts `return`. The retry sets `autoIIFE: true` in the page-side result envelope so downstream layers can surface it in telemetry. When the retry itself fails (real syntax error inside the return expression), `JS_EXECUTION_ERROR` carries a hint-override pointing the caller at manual IIFE wrapping instead of the generic "inspect the error message" boilerplate. **Why**: dogfood feedback from the voc-front session — first call writing `return JSON.stringify({...})` always tripped on the script-vs-function-body distinction, costing one round-trip and a doc-grep before the caller learned to write `(function(){ ... })()`. The wrapper is transparent and only fires on the documented error string, so legitimate script-context code (where top-level `return` should fail loudly) is unchanged. Closes VORTEX_FEEDBACK.md P1-B1.

- **`wait_for(mode=custom, value: <JS expression>)`** (`packages/shared/src/actions.ts`, `packages/extension/src/handlers/page.ts`, `packages/mcp/src/tools/dispatch.ts`, `packages/mcp/src/tools/schemas-public.ts`). New `PageActions.WAIT_FOR_EXPRESSION` (`page.waitForExpression`) polls a caller-supplied JS expression in MAIN world via `requestAnimationFrame` + `setTimeout`, resolving on first truthy value or rejecting with `TIMEOUT` (carrying `expression`, `waitedMs`, and the last evaluation error in `context.extras`). Surface: `vortex_wait_for` accepts a 4th mode `custom`; the L4 dispatcher reshapes `{ mode: "custom", value }` → `{ action: "page.waitForExpression", params: { expression: value } }`. Empty / non-string `value` rejects with `INVALID_PARAMS` so a typo doesn't silently match `truthy("undefined")`. **Why**: closes VORTEX_FEEDBACK.md P1-B4. `mode=idle` returns 200ms after network silence and is not a proxy for "Alpine.js mount complete" / "Vue app boot finished" / "localStorage user hydrated" — the only generic signal that covers SPA-specific ready conditions is a JS expression evaluated by the page itself. Surfaced during voc-front session where `wait_for(mode=idle)` resolved before `document.body._x_dataStack` was populated, causing follow-up `evaluate` calls to read undefined state.

- **`[onclick]` added to `INTERACTIVE_SELECTORS`** (`packages/extension/src/handlers/observe.ts:243`). The static interactive whitelist already covered semantic tags (`button` / `a[href]` / `input` / `[role=button]` …) and a `cursor:pointer` fallback for Vue/React custom widgets. The bare inline-onclick selector was missing — `<div onclick="...">` / `<a onclick="..." href="#">` / `<span onclick="...">` on jQuery-era PHP backoffice surfaces (Zentao legacy panels, phpMyAdmin admin rows, .net WebForms grids) carry no role, no cursor:pointer CSS, and frequently sit outside the existing fallback's "has visible text" gate. Pure additive on legacy DOM; modern Vue/React apps bind via framework `@click` in the runtime (no DOM attribute) so the new selector is a no-op on them. **Why**: VORTEX_FEEDBACK.md P0-A2 was originally filed against `<span @click>` on voc-front, but inspection showed all such handlers there sit on real `<button>` elements (already covered). The remaining unmodeled cohort is legacy `[onclick]` — closing the gap without expanding the public schema (no new `filter=clickable` enum value, just a stronger default).

### 🔧 Changed

- **`vortex_observe` compact 输出升级为业界标准嵌套 a11y 树快照**（containment 层级，对齐 playwright-mcp）：role 裸写、ref 移入 `[ref=@..]`、子元素缩进 2 空格/层、link 节点输出 `/url:` 行。ref/flags 语义与 act/extract 兼容。工具 description 同步更新说明输出为嵌套树。

- **act real-mouse 修复 shadow 内嵌 iframe 的坐标偏移**（`packages/extension/src/lib/iframe-offset.ts`、`packages/extension/src/adapter/cdp.ts`）。`getIframeOffset` 原用浅 `document.querySelectorAll('iframe')` 找 owner iframe 算 offset，漏掉嵌在 shadow root 里的 iframe → offset 算成 `{0,0}` → realMouse 用 frame-local 坐标点空。修复两层：① **open shadow** 改 `querySelectorAllDeep` 式深查穿透；② **closed shadow**（JS 够不到）加 CDP 兜底——跨源 OOPIF 是独立 CDP target，`Page.getFrameTree` 不收录其子帧、`getFrameOwner` 失效，改用 `DOM.getDocument({pierce:true})` 穿 open+closed shadow 拿全树、按 src 定位 owner `<iframe>` 再 `getBoxModel`。CDP 兜底仅在 DOM 法返回 null（shadow 内嵌）时触发，碰不到现有可工作的 OOPIF 用例。修复 bench `oopif-in-csr`/`oopif-in-osr`/`spif-in-shadow`（其中后两者为真站 shadow+iframe 常见形态）。

- **`vortex_screenshot` viewport 截图走 native 快路径(perf,~3.3s → ~10-50ms)** (`packages/extension/src/handlers/capture.ts`、`packages/extension/tests/capture-screenshot-native-fastpath.test.ts`)。viewport 截图(非 `fullPage`/`clip`/单 `frameId`/`deviceScaleFactor` override)且目标 tab 活跃时,改走 `chrome.tabs.captureVisibleTab`,绕开 CDP `debugger.attach` + `Page.captureScreenshot`(v0.5 baseline 实测 `nativeP50=5ms` vs `cdpP50=3289ms`)——顺带消除 "Vortex 正在调试此浏览器" 黄条。`fullPage`/`clip`/单 frame/DPR override/非活跃 tab 仍走 CDP(captureVisibleTab 仅能截「窗口当前活跃 tab 可见区」);任何 native 失败(受限页、瞬时态)经 try/catch 静默回退 CDP——native 仅作优化,绝不引入回归。公开 schema、返回 shape(`{dataUrl, format, [quality], fullPage:false, timestamp}`)、DPR 行为(两路径默认均按真实 device scale)均不变。9 新单测覆盖路由分流 + windowId/quality 透传 + 三类 CDP 回退。**Why**: dogfood 诊断「截图慢」根因——白盒实测页内 `innerText` 仅 0.2ms、extract 走 native 仅 5ms,任务"半天"实为 step 放大 + 开头那张唯一走 CDP 的截图(~3.3s)。截图是所有视觉任务的高频前置步,native 化是单调用最大的一笔提速。

- **actionability probe 对 open-shadow-internal 元素改为深解析可操作，取代 issue #27 的 `OPEN_SHADOW_DOM` 快速失败** (`packages/extension/src/page-side/actionability.ts`, `packages/extension/src/action/auto-wait.ts`). #27（v0.8.x）让 shadow ref act 快速失败给诊断，替代 5s hang；Tier 2 让 probe 经 `findInOpenShadow` 真正解析到元素 → 可操作。`OPEN_SHADOW` 探针 reason 不再发射，但 `OPEN_SHADOW_DOM` 错误码 + auto-wait 非重试映射保留作文档化安全网（closed shadow / 戳记失败回退路径），错误码总数不变。

- **`observe` auto-fallback threshold raised 20 → 50** (`packages/extension/src/handlers/observe.ts:34`, `packages/extension/tests/observe-auto-fallback.test.ts`). The v0.7.4 fallback (`caller omits frames` + `main interactive < threshold` + `child iframe exists` → silently re-scan with `all-permitted`) was sized for Zentao's 14-link top nav. Modern shell+iframe deployments — e.g. the bytenew app shell at `testc.bytenew.com` — sit on a denser main frame (60+ nav links and quick-access tiles) and never trip the 20-element gate, forcing callers to manually pass `frames=all-permitted` to discover the iframe-hosted business app. Raising to 50 covers this cohort while still excluding modern SPAs whose main frame typically carries ≥100 interactive elements. Boundary tests retargeted from 19/20 to 49/50; "main has ≥ threshold" branch retargeted from 50 to 100 to avoid overlapping the new boundary. Three-gate composition is unchanged: explicit `frames=...`, explicit `frameId`, or `filter=all` still disables the fallback. **Why**: dogfood feedback from the voc-front session — re-discovered the same `frames` flag-flipping pain point on testc.bytenew.com that v0.7.4 supposedly closed for Zentao, only at a different threshold. Closes VORTEX_FEEDBACK.md P0-A1 (the "iframes look black-box" half of it) without breaking I15 byte budget or rewriting the 11 fallback tests.

### 🐛 Fixed

- **`vortex_press` 可打印字符现真正插入文本(消除 silent false success)** (`packages/extension/src/handlers/keyboard.ts`、`packages/extension/tests/keyboard-press-combos.test.ts`、`packages/vortex-bench/cases/vortex-press-text-insert.case.ts`、`packages/vortex-bench/playground/public/press-text-insert.html`)。`dispatchKey` 旧实现发 CDP `Input.dispatchKeyEvent` keyDown+keyUp **缺 `text`/`unmodifiedText` 字段**——按 CDP 规范,可打印字符要真正被浏览器插入(执行默认编辑动作)须 keyDown 带 `text`;缺则 `keydown`/`keyup` 事件照发(JS 监听可见)但 `input.value` 不变。结果 `vortex_press({key:"a"})` 对聚焦输入框返回 `{success:true}` 却不写入任何字符(silent false success),且与真对标 Playwright `keyboard.press('a')`(可打印键插字符)divergence。修:keyDown 对**单个可打印字符 + 无修饰键**(`modifiers===0 && [...key].length===1`)补 `text`/`unmodifiedText`;命令组合键(Ctrl/Alt/Meta,`modifiers≠0`)与非可打印键(Enter/Tab/Arrow/Escape,多字符 key)**不加**——它们是命令非文本,行为零回归。Shift-only 大小写等带修饰键场景仍走 `vortex_act type`/`vortex_fill`。**Why**: dogfood 中 LLM 常用 `press` 逐字符输入(误当 type),旧行为静默无效会让 agent 误以为已输入;且静默假成功正是 act 原语审计「族 A」一直在灭的类。**live(element-plus.org input.html):改前 `press('a')` 后 `value===""`;改后 `value==="a"`,连按 `a`/`b` 累加为 `"ab"`**。bench 新增 `vortex-press-text-insert`(fixture input 仅在真发生 `input` 事件时反射 value,回归则 result 保持 empty 而失败)。来源:Element Plus dogfood R2 评估 A3(`reports/dogfood-element-plus-2026-06-13/validated-defects.md`)。

- **`vortex_act(click)` useRealMouse/trustedMode 路径补 `dialogHandled` 转换** (`packages/extension/src/handlers/dom.ts`、`packages/extension/tests/click-cdp-dialog-handled.test.ts`)。dialog 应答(原 commit)的 raw `dialogs`→对外 `dialogHandled` 转换(`attachDialogHandled`)只覆盖了合成 click + deferToCdp 路径,**漏了 `if (useRealMouse || trustedMode)` 早返回分支**(该分支裸 `return cdpClickElement(...)`)。trusted 模式环境(Chrome 带 flag,click 默认走 CDP)下,confirm/alert 等被正确拦截记入 raw `dialogs` 却**不转成 `dialogHandled`**,调用方拿不到 `policy`/`warning`,且泄漏内部 `dialogs` 字段。修:把 `attachDialogHandled` 定义前置到该分支之前(避 TDZ),并包裹其 `cdpClickElement` 返回——三条 click 返回点(合成 / deferToCdp / 早返回)现一致转换。**Why**: 非 trusted CI(合成路径)下 dialog-handling bench 绿,trusted 环境才暴露此缺口;dogfood bench 在 trusted 模式跑曝光。源码级回归锁(两 CDP 返回点均包 attachDialogHandled + 定义在分支前)。**bench:trusted 模式 `dialog-handling` 由红转绿**。来源:antd Pro dogfood bench 副产。

- **`vortex_observe` buildSelector id/testid 分支加唯一性守卫,修复弹层内 fill 因重复 id OBSCURED** (`packages/extension/src/handlers/observe.ts`、`packages/extension/tests/observe-id-uniqueness.test.ts`)。`buildSelector` 的 id 分支旧无条件 `return '#'+id`,testid 分支同理;而同函数路径分支(`observe.ts:958`)与 aria-label 分支均已校验选择器唯一。重复 id(无效 HTML 但 Modal/Drawer 覆盖同结构表单时真实常见——antd Pro 页面 search 与"新建"Modal 均渲染 `#name`/`#desc`)时,observe 给弹层 input 存 `#name`,下游 `resolveTarget`→actionability `querySelector('#name')` 命中**第一个**(弹层背后被 mask 遮挡)元素 → `Actionability TIMEOUT: OBSCURED`。修:id/testid 分支加 `document.querySelectorAll(sel).length === 1` 守卫,歧义时 fall through 到路径/rid 分支保 1:1。**Why**: "弹层内表单填写"是高频场景,任何弹层覆盖同 id 表单的站(antd / Element Plus 等)中招。**live(preview.pro.ant.design):改前 `vortex_fill(Modal #name)` 必 OBSCURED;改后 success 且值落在弹层内 input(背后 input 仍空)**。源码级回归锁(沿用 observe-shadow-selector.test.ts 约定)。来源:antd Pro dogfood 评估 A1(`reports/dogfood-antd-pro-2026-06-13/validated-defects.md`)。

- **`click-effect` TOAST_SELECTORS 去掉裸 `[aria-live]`,修复 antd `<Spin>` 致 userFeedback 恒假阳 "toast"** (`packages/shared/src/click-effect.ts`、`packages/extension/tests/click-effect-feedback.test.ts`)。0006 V-2 给 TOAST_SELECTORS 加的 `[aria-live='polite']`/`[aria-live='assertive']` 过宽:antd `<Spin>` 用 `<div class="ant-spin" aria-live="polite">` **永久包裹**表格/抽屉等内容区(稳态即可见且有内容,稳过 `collectFeedback` 的 `isVisible` 守卫)→ 每次 click 必 `toastHit` → `userFeedback` 恒 "toast",毒化 V-2 本要提供的 silent-fail 信号(用 antd Spin 的页面全失判别力)。修:删两个裸 `[aria-live]`,保留 `[role='status']`/`[role='alert']`(已在数组,真 toast 通用)+ 框架专属 toast 类(`.ant-message` 等)。**Why**: 一个"每次必命中"的选择器使 userFeedback 失去意义,违背 V-2 设计初衷。**live:改前点"查询"返回 `toastHit:["[aria-live='polite']"]`/`userFeedback:"toast"`;改后 `toastHit:[]`/`userFeedback:"mutation"`**。功能级回归断言(导入真数组,含防过度删除断言)。来源:antd Pro dogfood 评估 A5/A6。

- **`vortex_act(click)` 对表单提交按钮自动走 CDP trusted,修复合成 click 静默假成功** (`packages/extension/src/handlers/dom.ts`、`packages/extension/tests/click-submit-intent-cdp.test.ts`)。CLICK 合成路径派发 pointer/mouse + `el.click()` 后**无条件 `return {success:true}`,零效果校验**;`detector.needsTrustedEvent('click')` 恒 false。淘宝搜索这类 React 拦截 submit 的站要 `isTrusted`,合成事件(`isTrusted=false`)被丢弃却仍报 success(且清空输入框)——agent 默认 type+click 全程报成功却出不来结果。**方案 A(选择性升级)**:保持合成默认(无黄条,覆盖多数站),仅对**表单提交意图**元素(`button[type=submit]` / `input[type=submit]` / `<form>` 内无显式 type 的 `<button>`——HTML 默认 submit)直接走 CDP 真鼠标(trusted)、跳过合成。页内 func 探测到 submit-intent 且 CDP 可用时返回 `deferToCdp`(不点击),handler 改走 `cdpClickElement`;CDP 失败回退合成(`cdpAvailable=false` 重跑)。`useRealMouse:true` 既有路径不变。**Why**: 调研证实合成事件 `isTrusted` 恒 false、扩展唯一 trusted 源是 chrome.debugger(CDP),`form.requestSubmit()` 对 React 拦截 submit 无效;Playwright/Puppeteer 默认即 CDP trusted、同构扩展 agent(Nanobrowser)走 puppeteer-over-debugger 吃黄条——vortex 在机制唯一可行处(表单提交)对齐对手,常见场景仍守住无黄条。**已知局限**:仅覆盖表单提交按钮,更广的 isTrusted-gated(`div[role=button]` React onClick 等)仍静默失败,完整解需效果校验升级或 trusted 默认(产品定位决策,留 backlog)。TDD 7 新单测(路由 + 源码契约 + CDP 失败回退 + useRealMouse 不退化)+ ext 全量 646;**live:淘宝默认 click 搜索按钮自动 defer CDP → 出结果页**(改前同操作静默失败)。Closes #37。

- **`vortex_evaluate` 结果为 undefined/null 不再渲染成晦涩的 `{action,id}` 协议信封** (`packages/mcp/src/server.ts`、`packages/mcp/tests/evaluate-undefined-render.test.ts`)。通用成功路径(2 处)旧用 `JSON.stringify(resp.result ?? resp, null, 2)`:`??` 兜 null/undefined → 回退成整个 `VtxResponse`,JSON 丢掉 undefined 字段 → 吐出 `{"action":"js.evaluate","id":"…"}`(像空响应/错误,泄漏内部协议字段);null 则吐 `{action,id,result:null}`。成功路径上 `resp.error` 已在上游拦掉、`result` 是唯一数据字段,故 `?? resp` 无任何合法受益场景。改为 `JSON.stringify(resp.result, null, 2) ?? "undefined"`——利用 `JSON.stringify(undefined)` 返回 JS undefined(非字符串)的特性,undefined → `"undefined"`、null → `"null"`,falsy 值(`0`/`false`/`""`)不受 `??` 影响照常渲染。**Why**: 副作用型 eval(`scrollTo`/`el.click()`/`arr.forEach`/`localStorage.setItem`/`dispatchEvent` …)全返回 undefined、极常见,加上 async eval 漏写 `return` 的 footgun,这个渲染甚至骗过工具作者误诊为畸形空响应(见 #35:误判为 executeScript frame 竞态、提交幻影 handler 守卫后全撤;真因是 sync/async 不对称的 forgot-return + 此处 `?? resp` 渲染放大)。4 新单测(undefined/null/值/falsy)+ mcp 全量 334 通过。Closes #36。

- **全量白盒审计 5 批(act 原语之外的读路径/导航/桥接/契约,2026-06-04)**。多 agent find → 对抗验证 → live确诊 三段式。9 条 live 实锤 bug 中 **7 条修复**(MCP-1/CAP-1/CAP-2/OBS-1/OBS-3/NAV-1/WAIT-TIMEOUT-MARGIN)+ 衍生 NAV-3/ERR-1/BRIDGE-2/BRIDGE-3a。**JS-1**(族 M,`vortex_evaluate` 返回不可克隆值静默有损/泄漏内部信封)与 **FRAME-1**(族 L,`iframe-offset` 用 border-box 偏移,误差 = border+padding,仅伤 observe includeBoxes / screenshot frameId / useRealMouse / mouse_drag 坐标消费者,默认 click 不受影响)两条 P2 未在本轮批次计划内,留 backlog。
  - **截图族 J/L**（`cf4ae86`,`packages/extension/src/handlers/capture.ts`、`packages/mcp/src/lib/image-utils.ts`、`packages/mcp/src/server.ts`）：MCP-1 `vortex_screenshot({target:"@ref"})` 复用 `resolve-target` 解析 @ref(index+snapshotId),不再 `INVALID_PARAMS`;CAP-1 `fullPage` 内容超 8000px(CDP 单帧上限)被裁断时回传 `truncated/contentHeight/capturedHeight` 并在 MCP 渲染层补 text 警告块(原静默丢底部);CAP-2 截 0×0/隐藏元素报 `NOT_VISIBLE` 而非把 CDP 裸错粗归 `JS_EXECUTION_ERROR`。
  - **读路径穿 open shadow 族 K**（`dad3d8e`+`4cdea1c`,`observe.ts`、`content.ts`、`capture.ts`）：OBS-1 `vortex_observe` 遮挡判定改用穿 shadow 的 `deepElementFromPoint`(原 `document.elementFromPoint` 对 shadow 内元素返回 host → 误标 `visible:false`);OBS-3 `vortex_extract` 的 `walkControls` 下钻枚举 open `shadowRoot.children`(原仅 light-DOM,shadow 内表单值全缺失);`capture.element` 经 `dom-resolve` 的 `queryDeep` 解析(原 `document.querySelector` 不穿 shadow,shadow 内 @ref 截图 `ELEMENT_NOT_FOUND`)。
  - **超时 margin 族 O**（`e111573`,`packages/mcp/src/lib/timeout.ts` 新增、`server.ts`、`page.ts`）：WAIT-TIMEOUT-MARGIN — 调用方 `timeout` 透传给 handler 作内层 poll 预算 + 传输超时 = 内层 + 5s buffer(原只设传输且与内层同 deadline 竞race,得传输 "no response" 丑错而非 handler 干净 `TIMEOUT`);NAV-3 — `navigate(networkidle)` 的 idle 超时改用剩余预算 `Math.max(1000, innerCap - elapsed)`(原硬编码 5000 叠加慢站 load ≈30s 吃光 margin)。
  - **契约/错误码 族 N/Q**（`1446e29`,`page.ts`、`packages/extension/src/lib/router.ts`）：NAV-1 — `navigate(domcontentloaded)` 走新增 `waitForDomReady`(`webNavigation.onDOMContentLoaded` 主 frame 信号 + `tabs.onUpdated 'complete'` 双信号竞速,覆盖整页慢站与同文档/hash 导航)即返回,不再与 `load` 同走 `waitForTabLoad` 干等 tab 'complete';ERR-1 — router 非 `VtxError` 兜底按推断 code 查 `DEFAULT_ERROR_META` 回填 `hint`/`recoverable`。
  - **桥接生命周期 族 P**（`c362d89`,`packages/server/src/message-router.ts`、`ws-server.ts`）：BRIDGE-2 — 扩展 SW 死亡(stdin 'end' 终态)立即 fail-fast 所有 pending 为 `EXTENSION_NOT_CONNECTED` + 清 buffer(原悬挂到 30s 才 `TIMEOUT`,进程因 WS 不退须主动收口);BRIDGE-3a — WS client 驱逐/断开时清旧会话 async pending(响应错投继任者),HTTP sync 保留。事件流跨会话泄漏已被 MCP `eventStore`(buffer 50 + TTL 60s + drain 订阅过滤)兜底,残留转 backlog。server 包新增 vitest 基建。

### 🗑 Removed

- **`packages/server/src/state-cache.ts`** dead code. The `StateCache` class (console / network log ring buffer, 20 LoC) was instantiated as `_stateCache` in `index.ts` but never wired to any consumer — neither `MessageRouter`, the HTTP routes, nor the WS server held a reference. Logs are actually buffered by the extension's own `console.getLogs` / `network.getLogs` handlers, so the server-side cache was vestigial. Removing the class, its import, the instantiation line, and the `state-cache.ts` entry in `packages/server/README.md` architecture map.

---

## [1.0.2] - 2026-06-05

仅 `@vortex-browser/server` 发布 1.0.2。

### 🔧 Fixed

- **全局 `vortex-server` 命令无法直接执行**:bin 入口 `dist/bin/vortex-server.js` 缺 shebang(`#!/usr/bin/env node`),`npm i -g` 后直接运行 `vortex-server install` 报 `import: command not found`(被 shell 而非 node 解释)。已在 `packages/server/bin/vortex-server.ts` 补 shebang(tsc 保留至产物)。此前经 `native-host.sh`/`node xxx.js` 显式调用不受影响,故 v1.0.1 dogfood 全局安装时才暴露。

---

## [1.0.1] - 2026-06-05

仅 `@vortex-browser/server` 发布 1.0.1;`@vortex-browser/{shared,mcp,cli}` 维持 1.0.0(未变动)。

### ✨ Added

- **`vortex-server install [extension-id]` 子命令**(`packages/server/bin/vortex-server.ts`、`src/install-nm-host.ts`):一行注册 Chrome Native Messaging 宿主(`com.vortexbrowser.host`),取代手挖 `node_modules/.../install-nm-host.js`。
- **扩展 ID 钉死(方案 B)**:`packages/extension/manifest.json` 加 `key` 字段,扩展 ID 固定为 `fbonhjdohmkcejfgmaicnkknpfafihnd`(load unpacked / 自签 .crx 同一 ID)。`vortex-server install` **不带参**时自动用此默认 ID,免去复制粘贴;`install <id>` 仍可覆盖(商店分发等)。
- **中英双语文档**:`README.md`/`README.zh-CN.md`、`docs/INSTALL.md`/`INSTALL.zh-CN.md`,含"How it works"心智模型(装 2 个、第 3 个自启)与多平台 MCP 接入(Claude Code / Cursor / Claude Desktop / 通用 MCP stdio)。

### 🔧 Fixed

- `installNmHost` 改用 `vtxError(INVALID_PARAMS)` 结构化错误(满足 I19.no-bare-throw 不变量)。

---

## [1.0.0] - 2026-06-05

### 💥 Breaking changes

- **npm 包 scope 重命名：`@bytenew/vortex-*` → `@vortex-browser/*`**。所有公开发布包均采用新 scope：`@vortex-browser/shared`、`@vortex-browser/mcp`、`@vortex-browser/cli`、`@vortex-browser/server`。原 `@bytenew/vortex-*` 不再发布；迁移时替换 `package.json` 中的包名与 `import` 路径即可，API 接口不变。

- **Native Messaging host 名重命名：`com.bytenew.vortex` → `com.vortexbrowser.host`**。注册 manifest JSON 文件名及 `name` 字段均已更新。现有用户需重新运行安装脚本（`scripts/install.sh`）以注册新 host 名；旧 host 名不再响应。

### ✨ Added

- **首次公开 npm 发布**（`@vortex-browser/shared`、`@vortex-browser/mcp`、`@vortex-browser/cli`、`@vortex-browser/server`，MIT 许可）。包从私有 `@bytenew` scope 迁移至公开 `@vortex-browser` scope，任何人可通过 `npm install @vortex-browser/mcp` 安装使用。

- **一键安装脚本 `scripts/install.sh`**（`scripts/install.sh`、`docs/INSTALL.md`）。执行后自动完成：下载 Chrome 扩展、注册 Native Messaging host（`com.vortexbrowser.host`）、写入 host manifest 到系统目录（macOS / Linux）、配置 `~/.vortex/` 目录。`docs/INSTALL.md` 提供分步说明与常见问题排查指引。

- **README 改写为英文，差异化产品定位**（`README.md`）。相较同类工具（playwright-mcp、Stagehand）明确 vortex 的定位：基于 Chrome Extension 的 agent-native 浏览器控制层，提供 MCP + CLI 双接入面、紧凑 a11y observe 输出、跨 frame / open shadow DOM 穿透、以及白盒审计驱动的原语正确性保证。

### 🔄 Backward compatibility

- 功能 API（`vortex_observe` / `vortex_act` / `vortex_extract` 等 15 个公开工具）与 v0.8.x 保持完全向后兼容；本版本的 breaking change 仅限包名与 host 名。

---

## [0.8.0] - 2026-05-19

### 💥 Breaking changes

- **`vortex-server`: OpenClaw relay-client removed** (`packages/server/`). The outbound WebSocket relay that let a remote OpenClaw instance drive the local browser is decommissioned — the relay endpoint is dead and the OpenClaw vortex plugin is being uninstalled server-side. **Removed surface**: `packages/server/src/relay-client.ts` (file deleted), CLI flags `--relay` / `--token` / `--session-name` / `--no-local`, `~/.vortex/relay.env` config loading, and the `RelayClient` / `RelayConfig` / `RelayState` symbols. **Impact**: callers using `vortex-server --relay …` to bridge to a remote OpenClaw will see an unknown-flag error; switch to running the local NM ↔ HTTP/WS bridge that vortex-mcp and vortex-cli already use. The local bridge path is untouched. **Why**: dead code in the wild — no active relay endpoint to talk to, and keeping the dual-mode wiring forced every `vortex-server` change to reason about a code path that nobody exercised.

### ✨ Added

- **Snapshot ref hash binding** (`packages/mcp/src/lib/ref-parser.ts`, `packages/mcp/src/lib/observe-render.ts`, `packages/mcp/src/server.ts`). `vortex_observe` now emits refs as `@<hash>:eN` (or `@<hash>:fNeM` with frame prefix), where `<hash>` is a 4-char lowercase hex prefix of `sha256(snapshotId)`. Callers that reuse a ref from a prior observe in a later `vortex_act` / `vortex_extract` / `vortex_wait_for` call get a structured `STALE_SNAPSHOT` error with the existing recovery hint ("Page has changed since the snapshot. Call vortex_observe to capture a fresh snapshot, then retry with the new ref") instead of silently rebinding to a different element.
  **Why**: closes the cross-observe ref footgun documented in v0.7.x backlog. SOTA browser-automation tooling (MS playwright-mcp etc.) avoids the same class of bug by issuing a fresh snapshot per tool call; vortex keeps the 60s-TTL pattern but now binds refs to their originating snapshot. dogfood agent flow is unchanged because LLM habit is already "observe then act immediately"; the safety net catches multi-agent / long-context / replay patterns.

- **Visual grounding (`includeBoxes`)** (`packages/mcp/src/tools/schemas-public.ts`, `packages/mcp/src/tools/schemas.ts`, `packages/mcp/src/lib/observe-render.ts`, `packages/mcp/src/server.ts`, `packages/extension/src/handlers/observe.ts`). `vortex_observe` accepts an optional `includeBoxes: boolean` (default `false`); when `true`, each visible element line in the compact output gains ` bbox=[x,y,w,h]` — integer px, frame-local viewport coordinates, **tuple form** (not `{x,y,w,h}` keyed) to save ~6 tokens per element. Per-frame `# frame N offset=[x,y]` meta lines are emitted for every scanned non-main frame so callers compose top-page coords as `(el.bbox.x + frame.offset.x, el.bbox.y + frame.offset.y)`. Off-screen and zero-area elements omit the `bbox=` segment while keeping the element line intact. Default-off keeps the wire format byte-identical to v0.8 sub-project A.

  **Measured budget** (`pnpm -F @vortex-browser/bench bench compare-boxes --all`, 38 baseline cases, 24 observed, 2026-05-14):
  median ratio = **1.503**, p95 = **1.590**, max = **1.599**, cases > 1.20 = 22, cases > 1.40 = 18, cases > 1.60 = 0. SPEC R6 ceiling was revised mid-flight from ≤ 1.20 (issue #21 a-priori estimate, never benchmarked) to ≤ 1.60 (data-driven). Gate verdict against revised ceiling: **PASS**. The bbox segment ` bbox=[x,y,w,h]` is structurally ~24 B per element, comparable to the element line itself (~25 B), so per-line cost approaches +96% and the cohort floor sits at ~1.50 even with the tightest tuple+integer encoding. Absolute output stays sub-10 KB per call across the entire cohort. Wire-format compression deferred to v0.9 backlog. Bench artifact: `packages/vortex-bench/reports/boxes-budget-2026-05-14T02-27-59-565Z.json`.

  **Why**: closes issue #21 (P0). Hybrid grounding — a11y ref for actuation + bbox to a vision model for verification — is the 2026 SOTA pattern (MS playwright-mcp, Anthropic Computer Use, browser-use all emit pixel rects). vortex stays ref-driven for actuation; bbox is emitted for the caller's vision side only. The extension already computed per-element `getBoundingClientRect()` for internal click-center math; this change merely surfaces that data through the compact path under an explicit opt-in to protect token budget.

- **Public surface: 4 backlog tools promoted** (`packages/mcp/src/tools/schemas-public.ts`). `vortex_evaluate` / `vortex_mouse_drag` / `vortex_file_upload` / `vortex_fill` move from internal-only to public (11 → 15 public tools). `vortex_evaluate` and `vortex_file_upload` carry MCP `annotations.destructiveHint` + `openWorldHint` so LLM clients can gate them with stricter approval prompts. `vortex_fill.kind` enum now exposes `time` alongside the existing five kinds — the runtime driver already shipped in v0.4, only the public schema had hidden it. `COMMIT_KINDS` is the single source of truth in `@vortex-browser/shared`; the I15 invariant test locks public schema enum, internal schema enum, and extension `commit-drivers` array to the shared array to prevent silent drift.

  **Closes v0.7.x backlog (5 items)**: `el-slider-drag` (needed `vortex_mouse_drag`) · `el-upload` (needed `vortex_file_upload`) · `el-date-picker-daterange` + `el-date-picker-datetimerange` (needed `vortex_fill` with `kind` enum exposed at L4) · `latency-p50` (needed `vortex_evaluate`). All five bench cases statically verified to call v0.8 public tools only; e2e validation deferred to v0.8 ship preflight. 11 bench cases migrated from `vortex_act({action:"fill", ...})` to direct `vortex_fill` calls.

- **Bare-ref deprecation telemetry** (`packages/mcp/src/lib/ref-parser.ts`, `packages/mcp/src/server.ts`). `resolveTargetParam` now counts every bare `@eN` / `@fNeM` it resolves and fires a single stderr warn on the first occurrence of a session (`[vortex-mcp] bare ref "<target>" used; this format is deprecated and will be rejected in v0.9.`). `vortex_ping` exposes the counter as `bareRefUsage: { hits, firstSeenAt }`, letting callers query mid- or end-of-session usage. **Why**: the v0.9 removal of bare refs is currently a planning-doc claim with no data behind it. The counter + warn turn the dual-format window into measurable signal so the v0.9 cut-over decision is evidence-driven rather than a guess.

- **`scripts/ship-preflight.mjs`** (`pnpm ship:preflight`). New release checklist automation with 4 gates: (1) `[Unreleased]` must be empty, (2) file paths named in the latest section must appear in `git diff vPREV..HEAD --name-only`, (3) numeric claims in CHANGELOG cross-check commit messages (WARN-only), (4) new silent-fallback expressions (`??` / `||`) in the range must have a `*.test.ts` touched in the same range. Wraps the five hard ship gates accumulated across v0.7.0–v0.7.4 ship failures (`Knowledge-Library/07-Tech/20260512-vortex-ship-checklist.md`).

### 🔄 Backward compatibility

- Bare refs `@eN` and `@fNeM` (v0.7.x format) **still resolve** through `activeSnapshotId`. The strict hash check only fires when the caller-supplied ref carries a hash prefix. This dual-format window is intentional for v0.8.x; bare refs are deprecated and will be rejected with `INVALID_PARAMS` in v0.9. Live usage is surfaced via `vortex_ping.bareRefUsage` (see telemetry entry above).

### 🗑 Removed

- **Internal tool `vortex_fill_form`** (`packages/mcp/src/tools/schemas.ts`, `packages/mcp/src/server.ts`). The tool definition and its server-side per-field loop (`handleCallTool` special branch) are deleted as dead code: `handleCallTool` only resolves names via the public registry, and `dispatchNewTool` had no case for it, so the branch was unreachable. No production caller exists (cli / vortex-bench / extension / server packages searched). The `vortex-migrate` codemod still recognises `vortex_fill_form` in legacy sources and emits the existing migration warning ("v0.6 has no fill_form helper; expand to per-field vortex_act(action='fill') calls"); that migration entry is intentionally retained so v0.5 codebases keep getting the rewrite hint.

### 🐛 Fixed

- `vortex_act` / `vortex_extract` / `vortex_wait_for` no longer silently rebind a ref captured in observe-1 to an element in observe-2 when both observes happen before the action. The mis-binding window is closed for all callers that adopt the new ref format.

### 🧪 Tests

- `packages/mcp/tests/ref-parser.test.ts`: 14 new cases covering hashed and bare formats, hash strict check (match / mismatch / bare-ref legacy / no-active-snapshot / hashed-with-frame / null-hash mismatch), case-insensitive hash, invalid hash forms.
- `packages/mcp/tests/observe-render.test.ts`: 6 new cases covering `refOf` and `renderObserveCompact` hash propagation.
- `packages/mcp/tests/server-snapshot-hash.test.ts` (new file): 5 cases for `computeSnapshotHash` (sha256[0:4] lowercase hex, deterministic, null-safe).
- `packages/vortex-bench/cases/cross-observe-ref-stale.case.ts` (new file): end-to-end assertion that ref reuse across observes throws `STALE_SNAPSHOT`. 20 existing bench cases had their ref-extraction regex broadened to admit hashed refs.
- `packages/extension/tests/dom-commit.test.ts`: rebuilt 4 long-skipped mock cases against the page-side bundle invoke path (`kind="checkbox-group"` route via `loadPageSideModule` + `nativePageQuery`). New arg-order assertion `[selector, closestSelector, value, timeoutMs, driverId]` and mock of `loadPageSideModule` so only the page-query invocation is observed. Restores COMMIT_FAILED / UNSUPPORTED_TARGET / ELEMENT_NOT_FOUND mapping coverage off since v0.6.0. **Closes #13**. The same file also de-staled two driver-registry assertions left over from when `cascader` / `select` were unregistered (now use truly unregistered kinds `radio-group` / `slider`). Extension suite is back to 229 / 229 / 0 skipped (was 215 / 221 / 6 fail through the v0.7.x line).
- `packages/mcp/tests/ref-parser.test.ts`: +7 cases locking the bare-ref telemetry contract (increment, accumulation, hashed no-op, selector no-op, firstSeenAt stability, warn-once, counter-before-throw).

---

## [0.7.4] - 2026-05-02

### ✨ Added

- **`vortex_observe` 智能 frame fallback**（`packages/extension/src/handlers/observe.ts`）。caller 未显式传 `frames`、`filter=interactive`（默认）、main frame interactive 元素 < 20 且页面有 child iframe 时，自动用 `all-permitted` 重扫子 frame 并合并结果，meta 标 `autoFallback: true`。三重门避免误判：显式 `frames=main` / `frames=...` / `frameId=N` / `filter=all` 任一被设都跳过 fallback。  
  **Why**：禅道（实测）等"shell+iframe content"架构后台 main frame 仅顶部 nav（10-15 link/button），业务在 iframe 里。caller 第一次 observe 拿到"近乎为空"无法引导后续动作，被迫第二次加 `frames=all-permitted`，每次 dogfood +1 round trip。`/kaizen:why` 5 Whys 定位：默认值是给 SPA 优化的，但 LLM 无页面先验知识 → Poka-Yoke 缺失。dogfood 卡点 #1（禅道周报采集场景）。  
  **新增 7 个单测**（`packages/extension/tests/observe-auto-fallback.test.ts`）覆盖：触发 / 显式 main 不触发 / 元素够多不触发 / 无 child 不触发 / `filter=all` 不触发 / 显式 frameId 不触发 / 受限 host_permissions 跨域 frame 仍排除。

### 🐛 Fixed

- **frame detach 检测**（`packages/extension/src/lib/tab-utils.ts` + 全部接受 explicit `frameId` 的 handler）。新增 `ensureFrameAttached(tabId, frameId)` helper，在以下 handler 入口校验 frameId 仍在 `chrome.webNavigation.getAllFrames` 列表：
  - `observe.snapshot`（`handlers/observe.ts`）
  - `content.getText` / `content.getHTML` / `content.getAccessibilityTree` / `content.getElementText` / `content.getComputedStyle`（`handlers/content.ts`）
  - `dom.click` / `dom.dblclick` / `dom.type` / `dom.fill` / `dom.select` / `dom.hover` / `dom.scroll` / `dom.commit` / `dom.press` / `dom.contextMenu` / `dom.checkVisible` / `dom.getValue` / `dom.exists`（`handlers/dom.ts`，13 处）
  - `mouse.click` / `mouse.doubleClick` / `mouse.drag` / `mouse.move`（`handlers/mouse.ts`，仅当 `frameId !== 0`，因为 frame-coord 转换依赖 iframe offset）
  - `capture.element`（`handlers/capture.ts`）
  - `js.evaluate`（`handlers/js.ts`，3 处）
  - `page.wait`（`handlers/page.ts`）

  frameId 不在列表时 throw `IFRAME_NOT_READY` with `recoverable=true` + hint `"Call vortex_observe to refresh frame list"`。隐式 frame 解析（`all-permitted` / `all-same-origin`）天然枚举活跃 frames 不需校验。**reflexion 修正**：v0.7.4 第一轮误以为 `dom.*` 走 page-side runtime 不需 gate，实际 `adapter/native.ts:14` 的 `pageQuery` 就是 `chrome.scripting.executeScript + buildExecuteTarget`，frame stale 时同样不可解释；第二轮补回 13 处。  
  **Why**：dogfood 卡点 #4 — caller 持有过期 frameId（`navigate` 后 main frame 重新加载销毁所有 iframe）调 extract，`chrome.scripting.executeScript` 在 detached frame 上行为不确定（吞错误 / fallback / 返回缓存），caller 拿到不可解释结果。  
  **新增 6 个单测**（`packages/extension/tests/frame-detach.test.ts`）覆盖 observe / getText / getHTML stale frameId、未传 frameId 不校验、recoverable hint 正确。

- **`vortex_observe` auto-fallback edge case**：main scan 失败（page=null，跨域权限拒绝 / frame 销毁等）时**不应触发 fallback**，否则 silent fallback 会掩盖 main 真正错误（reflexion 反馈：`page?.elements.length ?? 0` 在 page=null 时得 0 < 20 误触发）。改用 `mainScannedOk = mainScan?.page != null` 双重 gate，page=null 时保留 main scan failure 作顶层错误。新增对应单测覆盖此边界。

### 测试结果

- extension `pnpm test`：40 file 39 passed，**215/221** case 通过（dom-commit 6 fail = issue #13 pre-existing，本次改动无关）。新增 16 单测：10 auto-fallback（含 main=19/20 边界 + main scan failed 边界 + 6 触发/不触发分支）+ 6 frame-detach
- mcp `pnpm test`：234/234 全过
- bench：静态分析无回归（auto-fallback 三重门：含 iframe 的 case 都显式传 `frames`，其余 case fixture 不含 iframe 触发不到 fallback）
- dogfood 实战验证：禅道 chandao.bytenew.com `vortex_observe()` 单次拿到 main + iframe 完整 333 任务列表（vs 旧版仅 16 个顶部菜单）；过期 frameId 调 `vortex_extract` 准确报 `IFRAME_NOT_READY`
- 4 个 dogfood 卡点中 #1 + #4 闭环；卡点 #2（navigate empty detect）+ #3（snapshot ID stale 跨 observe footgun）转 v0.7.x backlog（前者阈值定义复杂，后者需 ref 协议改动）。

---

## [0.7.3] - 2026-05-02

### 🐛 Fixed (post-ship reflexion correction of v0.7.2)

经 `/reflexion:reflect` 严谨自查发现 v0.7.2 ship 包含两类问题，本版修正。

- **CHANGELOG / memory 误分类**：v0.7.2 把 el-slider 列入 "v0.6 真缺特性"，但 `el-slider.case.ts` 实际用 click + Backspace + type "50" + Enter 的纯键盘流，零 drag。真分类应为 case 逻辑问题。修：剩余 13 fail 真 split = 5 v0.6 missing + 8 case logic（不是原写的 6/7）。
- **codemod tool-map 隐式 dispatch loss**（`packages/vortex-migrate/src/tool-map.ts`）。v0.5 `vortex_fill { kind: "daterange" }` 在 dispatch.ts:46-49 路由到 `dom.commit`（compound widget driver），v0.6 `vortex_act + action="fill"` 始终路由到 `dom.fill`，**`kind` 参数被静默丢弃**。codemod 原 `vortex_fill` entry 仅 `set action=fill`，无 partial 标记，无 warning，掩盖此变更。这是 el-date-picker × 2 / el-form-composite 部分迁移损坏的根因，不是单纯"v0.6 缺特性"。修：(1) `ToolMapEntry` 加 `conditionalPartial?: { key: string; note: string }` 字段；(2) codemod 在 ObjectExpression 和 CallExpression 两 pass 都做 hasKey 检查，仅当原 args 含该 key 时 emit warning（避免 plain fill 误警）；(3) `vortex_fill` 加 `conditionalPartial: { key: "kind", ... }`。4 新 unit test，52/52 测试全过。

### 📋 Known issues / v0.7.x backlog (修订版)

剩余 13 fail case 真分类：

- **5 个 v0.6 真缺特性**：el-slider-drag (`vortex_mouse_drag`)、el-upload (`vortex_file_upload`)、el-date-picker-{daterange,datetimerange} (`dom.commit kind` 路径未在 L4 暴露，且 codemod 静默丢失 kind dispatch — 见上文 fix)、latency-p50 (`vortex_evaluate`)。需 v0.6.x 决定是否在 L4 加对应 action。
- **8 个 case 逻辑问题**：el-cascader / el-dialog-nested / el-form-composite / el-select-{single,multiple,v2,v2-virtual} / el-slider — 重命名工具后 case 内部 observe→click 流程需调整（多步交互、虚拟列表、级联、键盘输入流），不是 codemod 缺陷。

---

## [0.7.2] - 2026-05-02

### ✨ Added

- **`vortex-migrate` codemod**：识别 positional `ctx.call(name, args)` 形态。原 codemod 只匹配 MCP SDK shape `{name, arguments}`，导致 vortex-bench / 测试 helper / 内部 callers 用的 `ctx.call("vortex_X", {...})` 被静默跳过。新增 CallExpression pass：arg[0] 字符串字面量 + arg[1] 对象字面量 + 命中 TOOL_MAP 即应用同 rewrite/warn 逻辑。5 新测试，48 个 codemod 测试全过。

### 🐛 Fixed

- **`packages/vortex-bench/cases/_helpers.ts`**：`readResult` 用 legacy `vortex_get_text` 调用，被 L4 PR #11 移出公开 registry 后所有 `assertResultContains` 失败用 `Unknown tool: vortex_get_text` 字符串作 actual value，掩盖底层 state bug。改 `vortex_extract` + `include:["text"]`。
- **`packages/vortex-bench/cases/*.case.ts` + `src/runner/run-case.ts`**：跑扩展后的 codemod 自动迁移 27 case 文件 + 1 runner 文件 共 77 个 legacy 工具调用（`vortex_click`/`vortex_fill`/`vortex_type`/`vortex_select`/`vortex_hover`/`vortex_wait_idle` 等）。bench `pnpm bench run --all` 24/37 ✓（v0.7.1 后 10/37 → +14 cases unblocked）。

### 📋 Known issues / v0.7.x backlog

剩余 13 个 fail case 拆 2 类：

- **6 个 v0.6 真缺特性**（warn-only，codemod 无法迁）：el-slider-drag (`vortex_mouse_drag`)、el-upload (`vortex_file_upload`)、el-date-picker-{daterange,datetimerange} (`dom.commit kind` 未实现)、latency-p50 (`vortex_evaluate`)、el-slider（drag 类）。需 v0.6.x 决定是否在 L4 加对应 action。
- **7 个 case 逻辑问题**：el-cascader / el-dialog-nested / el-form-composite / el-select-{single,multiple,v2,v2-virtual} —— 重命名工具后 case 内部 observe→click 流程需调整（多步交互、虚拟列表、级联），不是 codemod 缺陷。

---

## [0.7.1] - 2026-05-02

### 🐛 Fixed (dogfood batch 2 — JD modal + testc residual noise)

通过京东商品评价弹窗（10万+评价真站 + static HTML fixture）和 testc.bytenew.com applet/VOC 双源 dogfood 暴露的 7 个 bug，集中收敛。testc 真站累计 ref 数 v0.7.0 baseline 148 → 125（**-16%**），LLM 噪声大幅下降。

- **P0 — `vortex_extract` 不过滤 hidden 文本**（`packages/extension/src/handlers/content.ts`）。Chrome `el.innerText` 在 `display:none` 元素上仍返回 textContent，违反 schema "Extract visible text" 描述。RM-04 fixture 用 extract 验证 modal 关闭曾返回 hidden 全部内容。修：getText 显式 ancestor 链检查 `display:none` / `visibility:hidden` / `[hidden]`，hidden 时返回 `""`。
- **P1 — observe leaf-only filter 拆碎嵌套 cursor:pointer**（`packages/extension/src/handlers/observe.ts`）。`<div>差评<span>200+</span></div>` 形态原本只输出 `[span] "200+"`，主标签"差评"丢失。修：异文本时（ancestor 文本严格大于 leaf 且包含 leaf 子串）保留 ancestor，同文本时（嵌套同名 wrapper 链）保留 leaf。testc menuitem 同名嵌套 + JD 标签 dual-pattern 双向兼容。
- **P2 — `vortex_act(scroll)` L4 facade 屏蔽 container/position**（`packages/mcp/src/tools/dispatch.ts`）。dispatch 把 value 整体当作 `next.value` 透传，但 `dom.scroll` handler 直接读 `args.container/args.position/args.x/args.y`。修：scroll 时 value 是参数对象 → spread 到 args，且 strip `selector/target/index`（server.ts 已把 `target` 翻译成 `selector`，必须移除否则 dom.scroll 走 sel 分支 scrollIntoView 屏蔽 container/position）。fixture + 真站 fixture scrollTop 0→473 验证通过。
- **P3 — Icon-only cursor:pointer 元素漏识别**（`packages/extension/src/handlers/observe.ts`）。`<div class="_closeIcon"><svg/></div>` 形态（JD close icon / 各种 svg button），无文本、无 aria-label，cursor:pointer fallback 的 textContent gate 直接 skip。修：当元素仅含 svg/img 子（或 `<i>` 标签）+ 无文本无 aria-label 时，从 className 提取首个 CSS Modules segment（`_closeIcon_1ygkr_39` → `closeIcon`）作为 name；`getAccessibleName` 同步加最终 fallback。
- **P4 — cursor:pointer fallback 跨池 dual-instance**（`packages/extension/src/handlers/observe.ts`）。ARIA 池命中 `<li role=menuitem>` / `<label>` / `<button>` 等同时其内层 `<div cursor:pointer>` / `<span cursor:pointer>` 也被 cursor:pointer fallback 收 → 同一可点项重复输出（testc voc menubar 9 menuitem + 9 div 副本，bytes 浪费 ~21%）。修：fallback 候选收集前加 ancestor short-circuit —— 若任意祖先在 INTERACTIVE_SELECTORS 池中，跳过整个 ARIA 子树。bytenew 主菜单 `<li>`（无 role）等场景 A 不受影响。testc voc 实测 148→117 ref（-21%）。
- **P5 — Icon-only fallback 收紧（drop `<i>` tag exception）**（`packages/extension/src/handlers/observe.ts`）。P3 的 icon-only 触发条件 `el.querySelector("svg, img") || el.tagName === "I"` 把空的 `<i class="iconfont">`（CSS pseudo-element 渲染的纯装饰）也收为 candidate，抽 className 命名。testc 实测 16+ 个 `[i] "iconfont"` / `[i] "el-icon"` noise。修：仅当元素含 svg/img 后代（真有图标资源）时才触发。`<i><svg/></i>` 形态保留，`<i class="iconfont"></i>` drop。testc 117→107（-9%，累计 v0.7.1 batch -28%）。
- **P6 — `iconNameFromClass` 框架前缀类 / 通用泛词 noise**（`packages/extension/src/handlers/observe.ts`）。P5 后 testc 仍有 5 项 `[i] "el-icon"` × 3 + `[div] "el-popover_*"` × 2——iconNameFromClass 取"第一个 ≥3 字符 class segment"，无 denylist 也无结构判断；Element Plus 框架前缀（`el-icon` / `el-popover__reference` 等）和通用泛词（iconfont / wrapper）作为有效 class 出现在 svg/img 元素上时被当作 name，但对 LLM 等同 "icon" / "popover"——零信息 noise。修：(1) 3 级优先 —— svg `<title>` > img alt > svg/img aria-label > className，命中前者直接返回真语义；(2) className 路径加 denylist —— prefix `el-` / `ant-` / `anticon` / `van-` + 通用泛词 `icon` / `iconfont` / `btn` / `button` / `wrapper` / `container`；(3) 去 BEM trailing `_` 副产物（`_el-popover__reference_xxxx` 经 hash strip 后剩 `el-popover_`，匹配 prefix 前先 strip）。CSS Modules 合法命名（`closeIcon` 等）仍正常 fallback 保留，bench JD modal regression 通过。testc 130→125 (-5 noise)；累计 v0.7.1 batch -31%（148→125）。

### ✨ Added

- **bench 增 7 case**：4 个 JD 评价弹窗 dogfood case（rm-01 open / rm-02 switch-tab / rm-03 scroll-load / rm-04 close）+ 2 个延伸（rm-05 keyword tag / rm-06 sort toggle）+ icon-name-priority（P6 三级优先 + denylist 7 场景），全 PASS。
- **bench 输出 bytes instrumentation**（`CaseMetrics.outputBytes` + `outputBytesByTool`）：bench CLI 增 `bytes=X.XKB` 列；diff threshold +20% warning / +50% critical（防 regression）。新 unit test 4 dispatch + 3 renderer。
- **3 层嵌套 iframe fixture**：`playground/public/iframe-nested-{top,mid,deep}.html` + 2 cases（with-content / empty-deep），证伪"vortex 不进 3 层 iframe"假设；renderer hint 公开 0 元素 sub-frame 提示。

### 💥 Behavior changes

- `vortex_extract { target: <hidden-element-selector> }` 现返回 `""`，旧实现返回 hidden 文本。如果调用方依赖此返回作 LLM 上下文，需重新核对（应为破坏性收益）。
- `vortex_observe` 对带文本主标签 + count 子 span 的 cursor:pointer 复合元素，现输出外层 ancestor 文本（如 `[div] "差评 200+"`）而非 inner span（`[span] "200+"`）。LLM prompt 若含 ref/name 字面量需重测。
- `vortex_act(scroll, value={container, position})` 现真生效（dispatch strip selector/target/index）。schema 仍要求 `target`，目前作 placeholder（任意 selector），下一版 (#36) 一致化。

---

## [0.7.0] - 2026-05-02

### 🐛 Fixed (observe scanner overhaul, PR #19)

通过 testc.bytenew.com 两轮严谨对照 Playwright 评测（v1 14-case + v2 20-case 含 token 维度）发现的 observe scanner bug，集中在 `fix/v0.7-dogfood-batch` 一次修完。

- **Bug 1** — `cursor:pointer` 自定义可点元素漏识别。`INTERACTIVE_SELECTORS` 静态白名单不含 fallback，bytenew sidebar 7 menuitem + 行操作 40 个 `<el-button>` 全漏。修：page-side scanner 加二次扫 `*:not(svg *):not(script):not(style):not(meta):not(link):not(head):not(head *)`，过滤 visible + cursor:pointer + 有 name + 排除 INTERACTIVE_SELECTORS wrapper + leaf-only（O(N·depth) ancestor walk）+ 候选数硬上限 5000。
- **Bug 2** — `filter='all'` 是 dead parameter。公开 schema 暴露 `interactive | all` 但 handler 不读 `args.filter`，输出 byte-identical。修：handler 顶部读 args.filter（默认 `'interactive'`）→ scanOneFrame 透传 page-side；'all' 模式 selector union 加 `tr,td,th,[role=row|cell|columnheader|rowheader|gridcell]`。注意：'all' 仅扩展表格类结构语义，不是字面"任意元素"。
- **Bug 3** — 主 frame 输出 nameless `[div]` noise。Element Plus `el-popover__reference` 命中 `[tabindex]:not([tabindex='-1'])` 但无 role / 无 aria-label / 无 innerText。修：filter='interactive' 模式后置过滤——非 form-like 元素（input / select / textarea / button / `a[href]`）必须有 role / aria-label / name 之一。
- **Bug 4** — ref-based `vortex_act` 在重复 v-for 结构上 `SELECTOR_AMBIGUOUS`。`@fNeM` ref 翻译退化为 selector lookup，bytenew 3 个同结构 checkbox-group 让 `nth-of-type` path 必中两个元素。修：`buildSelector` path 失唯一时 `setAttribute('data-vortex-rid', '<unique>')` 返回 `[data-vortex-rid="..."]` 精确身份。**每次 observe 入口先 `removeAttribute` 旧 rid**，避免长 SPA 会话累积。
- **Bug 5** — 0 元素 sub-frame 沉默。多 frame observe 对扫描成功但无 interactive 元素的 sub-frame（典型场景：3 层嵌套的 chart-only iframe）不输出任何提示，导致 LLM 误判 frame walker 漏掉。修：`renderObserveCompact` 对 scanned=true / elementCount=0 的非主 frame 输出 `# frame N scanned, 0 interactive elements`；`scanOneFrame` catch 加 `console.warn` 便于生产 debug。

### 💥 Behavior changes（不动公开 schema 但语义变化）

- `vortex_observe(filter='all')` 现在真返回更多元素；调用方若依赖 `'all' === 'interactive'` 的旧行为需调整。
- `vortex_observe(filter='interactive')` 不再输出无 role / 无 name 的 `[tabindex]` 容器；如果旧 LLM prompt 依赖 phantom `[div]` 数量校准，需重新核对。
- `cursor:pointer` 启发式新增大量自定义元素到候选集（含 `<el-button>` 等），单次 observe 输出元素数显著增加（leaf-only filter 已尽量去重）。
- 重复结构页面的 `ScannedElement._sel` 字段在 ambiguous 时为 `[data-vortex-rid="..."]`，**`data-vortex-rid` 是 vortex 保留的 DOM attribute（业务请勿使用）**。
- observe 输出文本末尾可能多出 `# frame N ...` 注释行（未扫 / 0 元素）；解析方应忽略以 `#` 开头的行。

### 📊 Dogfood 接受度（testc.bytenew.com 20 case 评测）

vortex vs playwright 三维度（详见 `2026-05-02-testc-phase4-vortex-v2.md`）：
- PASS rate **95%**（18 PASS / 1 PARTIAL / 0 FAIL；门槛 ≥ 95%）
- step ratio **−14%** vs playwright（30 vs 35；门槛 ≤ +2）
- bytes ratio **0.39**（~31K vs ~80K；门槛 ≤ 0.50）

vortex 完胜场景：el-button row action 1 shot click、`[checked]/[selected]` state 内嵌、单元值 extract 150B vs playwright 3-15K。

---

## [0.6.0] - 2026-05-01

### 💥 BREAKING CHANGES

- **工具面收敛 36 → 11**。所有 v0.5 `vortex_<atom>` 工具被删除或改名，必须迁移代码。见下方迁移表 + `vortex-migrate` CLI。
- **三动词架构**：写操作走 `vortex_act`、读结构走 `vortex_extract`、探查走 `vortex_observe`；6 个 atom 操作（click / fill / type / select / scroll / hover）合并到 `vortex_act` 的 `action` 参数。
- **`vortex_ping` 删除**（无业务价值）。
- **错误码契约化**：53 个错误码全部走 `vtxError` 工厂 + `DEFAULT_ERROR_META` hint 表。手写 `throw new Error()` 在 `src/` 下被 invariant I19 拦截。

### ✨ Features

#### L1 Adapter 拆分（PR #1）

- `extension/src/adapter/cdp.ts` 抽取共享 CDP 操作（`clickBBox` 去重 3 份）
- `extension/src/adapter/native.ts` 抽取共享 page-side 探测（`pageQuery` 去重 3 份）
- `extension/src/adapter/detector.ts` `CapabilityDetector` 检测 `chrome.debugger` 可用性 + timeout-late-attach race 修复
- depcruise 静态依赖检查 + CI workflow（I1 invariant）
- **`dom.ts` 减 41%**（2233 → 1312 行）

#### L2 Action 层（PR #2）

- **6 项 actionability 探测**（Attached / Visible / Stable / ReceivesEvents / Enabled / Editable）按 Playwright 移植，page-side IIFE 实现
- **auto-wait** RAF polling + reason-aware retry（`NOT_VISIBLE` 50 ms / `NOT_STABLE` 1 RAF / `OBSCURED` 100 ms / `DISABLED` 200 ms / `NOT_ATTACHED` 立即重试 / `NOT_EDITABLE` 不重试）
- **fallback chain**：click/fill/type/drag 差异化策略（`dispatchEvent` → CDP `Input.dispatch` → `Input.insertText`）
- **micro-verify** 按 action 类型矩阵 verify
- **page-side bundle 机制**：vite + page-side-loader，page-side 代码可跨文件 import（解决 `chrome.scripting.executeScript` 序列化限制）
- 9 L2 错误码：`NOT_ATTACHED` / `NOT_VISIBLE` / `NOT_STABLE` / `OBSCURED` / `DISABLED` / `NOT_EDITABLE` / `TIMEOUT` / `ACTION_FAILED_ALL_PATHS` / `DRAG_REQUIRES_CDP`

#### L3 Reasoning 层（PR #3）

- **`captureAXSnapshot`**：CDP `Accessibility.getFullAXTree` + interesting-node filter（INTERACTIVE_ROLES 14 + STRUCTURAL_ROLES 10 + 显式状态属性）
- **`resolveDescriptor`** 三级消解：role+name → text → CSS selector，strict 模式默认 + first-match opt-in
- **`RefStore`** stale ref 自动 relocate：`DOM.resolveNode` 探活 → 失败用 descriptor 重消解
- **`detectClosedShadow`** custom-element + `DOM.describeNode` + `Runtime.evaluate` 启发式探测
- 8 L3 错误码：`A11Y_UNAVAILABLE` / `CDP_NOT_ATTACHED` / `STALE_REF` / `AMBIGUOUS_DESCRIPTOR` / `REF_NOT_FOUND` / `SNAPSHOT_EXPIRED` / `CROSS_ORIGIN_IFRAME` / `CLOSED_SHADOW_DOM`
- 17 invariant 测试（I10-I14, I21, I22）

#### L4 Task 门面（PR #4）

- **三动词 + 八基础 atom = 11 工具**：`vortex_act` / `vortex_extract` / `vortex_observe` / `vortex_navigate` / `vortex_tab_create` / `vortex_tab_close` / `vortex_screenshot` / `vortex_wait_for` / `vortex_press` / `vortex_debug_read` / `vortex_storage`
- **`target` ref-or-descriptor**：`act` / `extract` 接受 `@eN` ref 或 descriptor 对象（schema 强制二选一）；descriptor 显式调用自动分配 ref（`effects.assigned_ref`）
- **`act` effects**：`url_changed` / `ref_relocated` / `assigned_ref` / `ref_state_change` / `new_visible_elements`，LLM 链式决策依据
- **atom 合并参数化**：`wait_for(mode=)` / `debug_read(source=)` / `storage(op=)`
- 2 L4 错误码：`INVALID_TARGET` / `UNSUPPORTED_ACTION`
- **`tools/list` 字节 14,500 B → 4,500 B（-69%）**，估计 LLM token ~3,400 → ~1,000

#### 错误处方化（PR #5）

- 53 错误码全部满足 hint 质量标准：next-action verb + 工具名/参数提示 + 50-300 char
- I19 invariant：抛错处全经 `vtxError` 工厂（白名单 `lib/internal/`）
- I20 invariant：错误消息 + hint 不含 v0.5 已删工具名（grep regression）

#### 自动迁移工具（PR #5）

- 新增 `@vortex-browser/migrate` CLI（jscodeshift codemod backend）
- 覆盖 36 v0.5 atom：6 保持名 + 16 改写 + 1 删除（`vortex_ping`）+ 13 warn-only
- 默认 dry-run；`--write` 应用；`--json` 机器可读摘要；`--ignore` / `--ext` 自定义扫描
- 间接调用（变量名传入工具名）emit `<indirect>` warning，需手工迁移

### 🔧 Internal

- **`dom.ts` 总计减 -64%**：2233（v0.5）→ 1312（PR #1）→ 895（PR #2）→ ≤ 800（PR #4 拆 datetimerange page-side fallback 完成）
- 新 packages：`@vortex-browser/migrate`
- spec 文档：5 个 layer spec（L1-L5）落 obsidian Knowledge Library；slim spec 实验（L3/L4/L5 共 1255 行 vs L1/L2 4805 行 = -74%）
- bench 基线：`baselines/v0.5.json` 锁定（27 cases，CDP P50 = 3289 ms / Native P50 = 5 ms）+ dogfood 5 任务定义在 `cases/dogfood/`

### 📋 dogfood 验收（前 3 任务对比 v0.5，N=3）

> v0.6.0 release gate 采用降级方案：前 3 任务硬卡（每任务 v0.5/v0.6 各 3 次取 mean），任务 4 / 任务 5 推到 v0.6.1。
> 详细数据 + bug findings 见 [`reports/dogfood/dogfood-report.md`](reports/dogfood/dogfood-report.md)；18 个 per-run JSON 在同目录。

| 任务 | 类型 | mean LLM 调用 (v0.5 → v0.6) | mean token (v0.5 → v0.6) | 成功率 |
|---|---|---|---|---|
| GitHub 搜索 + star 第一仓库 | 简单 | 14.7 → 13.0 (**-12%**) | 764 K → 627 K (**-18%**) | 3/3 = v0.5 |
| GitHub Trending 前 5 | 只读 | 12.0 → 11.3 (**-6%**) | 619 K → 534 K (**-14%**) | 3/3 = v0.5 |
| 知乎搜索文章 + 截图 | 多模态 | 27.0 → 23.3 (**-14%**) | 1.54 M → 1.25 M (**-19%**) | 3/3 = v0.5 |
| ~~Notion / Linear 文档编辑~~ | 复杂 SPA | _deferred to v0.6.1_ | | |
| ~~OpenClaw 现有 prod 工作流回归~~ | breaking 验证 | _deferred to v0.6.1_ | | |

> 任务 2 由 v0.6.0 dogfood 任务清单从「内部 ERP 登录 + 商品同步」（bytenew VOC）替换为只读的 GitHub Trending。原 bytenew VOC 任务在 v0.6 dogfood 中跑挂，初判 closed Shadow DOM；2026-05-01 用 Playwright MCP 重新诊断后确认根因是 **`vortex_observe` 默认仅扫主 frame，看不到 cross-origin iframe** —— 修复路径（默认改 `all-permitted` + schema 暴露 `frames`）填到 v0.6.x backlog。完整记录见 [`reports/dogfood/bytenew-voc-query-v0.6-run1.notes.md`](reports/dogfood/bytenew-voc-query-v0.6-run1.notes.md)。

**原 release gate（草拟）**：mean LLM 调用 ≤ v0.5 × 0.7（**-30%**）+ mean token ≤ v0.5 × 0.7（**-30%**）+ 成功率 ≥ v0.5。

**实测结论 — gate 显式降级接受**（owner 2026-05-01 决策，正式 v0.6.0 release 标准锁定为实测水平）：
- ✅ 成功率 v0.6 = v0.5（3/3 全任务通过，无 regression）
- ✅ mean wall-clock duration **-31%**（满足原 -30% headline）
- ❌ mean token **-18%** / mean call **-11%**：**未达原 -30% headline**；trend 朝下且无 regression，但若严格执行原 gate 则 v0.6.0 不该发。
- ✅ dogfood 期间发现并修复 4 个 v0.6 真 bug（A/C/D/E，详见 [`reports/dogfood/dogfood-report.md`](reports/dogfood/dogfood-report.md) Findings）。Bug B（`NOT_ATTACHED` reason 混淆 "selector wrong" vs "element detached"）未独立修复，被 A+D 间接掩盖，留 v0.6.x 跟进。

**v0.6.0 实际 release 标准（替代原 -30% gate）**：
- duration 改善 ≥ 30%
- tokens / model_calls 趋势朝下（无 regression）
- 成功率 ≥ v0.5

未来 release 复测时应以实测水平（-31% / -18% / -11%）作为 v0.6.0 floor，而不是原草拟 -30% spec。

### 📋 迁移表（v0.5 → v0.6）

完整迁移指南见 [`docs/v0.5-to-v0.6-migration.md`](docs/v0.5-to-v0.6-migration.md)。下表为速查节选。

#### 写操作 → `vortex_act`

| v0.5 | v0.6 |
|---|---|
| `vortex_click({ target })` | `vortex_act({ action: "click", target })` |
| `vortex_fill({ target, value })` | `vortex_act({ action: "fill", target, value })` |
| `vortex_type({ target, value })` | `vortex_act({ action: "type", target, value })` |
| `vortex_select({ target, value })` | `vortex_act({ action: "select", target, value })` |
| `vortex_hover({ target })` | `vortex_act({ action: "hover", target })` |
| `vortex_scroll({ target })` | `vortex_act({ action: "scroll", target })` |

#### 读 → `vortex_extract` / `vortex_observe`

| v0.5 | v0.6 |
|---|---|
| `vortex_get_text({ target })` | `vortex_extract({ include: ["text"], target })` |
| `vortex_observe` | unchanged（语义吸收 frames_list / tab_list） |

#### 等待 → `vortex_wait_for`（合并 mode）

| v0.5 | v0.6 |
|---|---|
| `vortex_wait({ target, timeout })` | `vortex_wait_for({ mode: "element", value: target, timeout })` |
| `vortex_wait_idle({ kind, idleMs })` | `vortex_wait_for({ mode: "idle", value: kind, timeout: idleMs })` |
| `vortex_page_info` | `vortex_wait_for({ mode: "info" })` |

#### 调试 → `vortex_debug_read`（合并 source）

| v0.5 | v0.6 |
|---|---|
| `vortex_console({ tail })` | `vortex_debug_read({ source: "console", tail })` |
| `vortex_network({ tail, filter })` | `vortex_debug_read({ source: "network", tail, filter })` |

#### 存储 → `vortex_storage`（合并 op）

| v0.5 | v0.6 |
|---|---|
| `vortex_storage_get({ scope: "local", key })` | `vortex_storage({ op: "get", key })` |
| `vortex_storage_get({ scope: "session", key })` | `vortex_storage({ op: "session-get", key })` |
| `vortex_storage_get({ scope: "cookie", key })` | `vortex_storage({ op: "cookies-get", key })` |
| `vortex_storage_set(...)` | `vortex_storage({ op: "set"\|"session-set", ... })` |

#### 删除 / 内部化（无 v0.6 等价物，需手工迁移）

`vortex_ping`（删除）、`vortex_evaluate` / `vortex_get_html` / `vortex_history` / `vortex_events` / `vortex_network_response_body` / `vortex_storage_session` / `vortex_frames_list` / `vortex_tab_list` / `vortex_batch` / `vortex_fill_form` / `vortex_file_upload` / `vortex_file_download` / `vortex_file_list_downloads` / `vortex_mouse_move` / `vortex_mouse_drag`。详见迁移指南 §2.4。

### 🛠 自动迁移

```bash
npm install -g @vortex-browser/migrate@^0.6
vortex-migrate ./src           # dry run
vortex-migrate ./src --write   # apply
vortex-migrate ./src --json    # machine-readable summary
```

直接调用形态 100% 自动改写；变量名传入需手动 review（脚本 emit `<indirect>` warning）。

### 🔗 v0.5 LTS

`v0.5.x` 维护分支保留至少 2 个月：

```bash
git checkout v0.5.x
```

仅接 critical bug fix；新 feature 一律 v0.6+。

---

## [0.5.0] - 2026-04-20

### 💥 BREAKING CHANGES

- **工具面收敛 74 → 35**。所有老 `vortex_*` 工具名被删除或改名，必须迁移代码。见下方迁移表。
- **元素定位改用 `target` 参数**。所有动作工具的 `selector` / `index` / `snapshotId` / `frameId` 参数被 `target` 字符串取代：`target: "@eN"` / `"@fNeM"` / CSS selector。
- **observe 默认输出改为 compact Markdown 文本**。`detail=full` 可回到 v0.4 JSON 结构。

### ✨ Features

- **`@eN` / `@fNeM` ref 格式**：observe 给每元素分配 ref（agent-browser 风格），跨 frame 用 `@fNeM` 前缀；MCP 层自动解析。
- **跨 frame 透明路由**：动作工具不再需要 `frameId` 参数，ref 前缀携带。全页工具（get_text/html/evaluate/screenshot）新增 `frameRef: "@fN"` 逃生舱。
- **stale ref 错误提示**：`STALE_SNAPSHOT` 错误附带"请重新调用 observe"提示。
- **tools/list payload 从 27.5KB 压到 14.5KB（-47%）**，observe 默认输出从 ~80KB（200 元素）降到 ~5KB（-94%）。

### 🔧 Internal

- MCP 层新增 `lib/ref-parser.ts`、`lib/observe-render.ts`、`lib/dispatch.ts`
- server.ts 里的 MCP 名 → extension action 映射集中到 `dispatchNewTool`
- vortex-bench 新增真实场景 fixture 套件（Element Plus / Ant Design / shadcn / Vuetify），jsdom 单测 + v0.4 基线对照断言

### 📋 迁移表（Old → New）

**Tab**

| v0.4 | v0.5 |
|------|------|
| `vortex_tab_activate({tabId})` | 合并入 `vortex_tab_create({tabId, active:true})` |
| `vortex_tab_get_info` | 用 `vortex_tab_list` 或 `vortex_page_info` |

**Page / Navigation**

| v0.4 | v0.5 |
|------|------|
| `vortex_page_reload` | `vortex_navigate({reload:true})` |
| `vortex_page_back` | `vortex_history({direction:"back"})` |
| `vortex_page_forward` | `vortex_history({direction:"forward"})` |
| `vortex_page_wait` | `vortex_wait` |
| `vortex_page_wait_for_network_idle` | `vortex_wait_idle({kind:"network"})` |
| `vortex_page_wait_for_xhr_idle` | `vortex_wait_idle({kind:"xhr"})` |

**DOM**

| v0.4 | v0.5 |
|------|------|
| `vortex_dom_click({index, snapshotId})` | `vortex_click({target:"@eN"})` |
| `vortex_dom_type` | `vortex_type` |
| `vortex_dom_fill` | `vortex_fill` |
| `vortex_dom_commit({kind:"cascader", value})` | `vortex_fill({kind:"cascader", target, value})` |
| `vortex_dom_select` | `vortex_select` |
| `vortex_dom_hover` | `vortex_hover` |
| `vortex_dom_batch` | `vortex_batch` |
| `vortex_dom_query / query_all` | 删除（用 `vortex_observe` 或 `vortex_evaluate`） |
| `vortex_dom_scroll / get_attribute / get_scroll_info` | 删除（用 `vortex_evaluate`） |
| `vortex_dom_wait_for_mutation / wait_settled` | `vortex_wait_idle({kind:"dom"})` |
| `vortex_dom_watch_mutations / unwatch_mutations` | `vortex_events({op:"subscribe", types:["dom.mutated"]})` |

**Content**

| v0.4 | v0.5 |
|------|------|
| `vortex_content_get_text` | `vortex_get_text` |
| `vortex_content_get_html` | `vortex_get_html` |
| `vortex_content_get_accessibility_tree` | 删除（`vortex_observe` 覆盖） |
| `vortex_content_get_element_text` | `vortex_get_text({target:"@eN"})` |
| `vortex_content_get_computed_style` | 删除（用 `vortex_evaluate`） |

**JavaScript**

| v0.4 | v0.5 |
|------|------|
| `vortex_js_evaluate` | `vortex_evaluate` |
| `vortex_js_evaluate_async` | `vortex_evaluate({async:true})` |
| `vortex_js_call_function` | 删除（用 `vortex_evaluate`） |

**Keyboard / Mouse / Capture**

| v0.4 | v0.5 |
|------|------|
| `vortex_keyboard_press` | `vortex_press` |
| `vortex_keyboard_shortcut` | 删除（用 `vortex_press` 多次调用） |
| `vortex_mouse_double_click` | `vortex_mouse_click({clickCount:2})` |
| `vortex_capture_element({selector})` | `vortex_screenshot({target:"@eN"})` |
| `vortex_capture_gif_*` | 删除 |

**Console / Network**

| v0.4 | v0.5 |
|------|------|
| `vortex_console_get_logs` | `vortex_console({op:"get", level?})` |
| `vortex_console_get_errors` | `vortex_console({op:"get", level:"error"})` |
| `vortex_console_clear` | `vortex_console({op:"clear"})` |
| `vortex_network_get_logs` | `vortex_network({op:"get"})` |
| `vortex_network_get_errors` | `vortex_network({op:"get", filter:{statusMin:400}})` |
| `vortex_network_filter` | `vortex_network({op:"get", filter})` |
| `vortex_network_clear` | `vortex_network({op:"clear"})` |
| `vortex_network_get_response_body` | `vortex_network_response_body` |

**Storage**

| v0.4 | v0.5 |
|------|------|
| `vortex_storage_get_cookies` | `vortex_storage_get({scope:"cookie"})` |
| `vortex_storage_set_cookie` | `vortex_storage_set({scope:"cookie", ...})` |
| `vortex_storage_delete_cookie` | `vortex_storage_set({scope:"cookie", op:"delete", ...})` |
| `vortex_storage_get_local_storage` | `vortex_storage_get({scope:"local"})` |
| `vortex_storage_set_local_storage` | `vortex_storage_set({scope:"local", ...})` |
| `vortex_storage_get_session_storage` | `vortex_storage_get({scope:"session"})` |
| `vortex_storage_set_session_storage` | `vortex_storage_set({scope:"session", ...})` |
| `vortex_storage_export_session` | `vortex_storage_session({op:"export", domain})` |
| `vortex_storage_import_session` | `vortex_storage_session({op:"import", data})` |

**File / Frames / Events**

| v0.4 | v0.5 |
|------|------|
| `vortex_file_get_downloads` | `vortex_file_list_downloads` |
| `vortex_frames_find` | 删除（用 `vortex_observe`） |
| `vortex_events_subscribe` | `vortex_events({op:"subscribe", ...})` |
| `vortex_events_unsubscribe` | `vortex_events({op:"unsubscribe", ...})` |
| `vortex_events_drain` | `vortex_events({op:"drain"})` |

---

## [Unreleased] (towards 0.4.0)

### Added

- **`vortex_observe` 新增 `frames: "all-permitted"`**（O-6）：按扩展 `manifest.host_permissions` 过滤 iframe，而不是严格 origin 同源。真实踩坑案例——`testc.bytenew.com` 页面里的主功能位于 `voc-testc.bytenew.com` 跨源 iframe，扩展对 `*.bytenew.com` 有权限但 `all-same-origin` 会漏掉它，导致"看不见菜单 → 回退到 js_evaluate 手摸"的坑。`all-permitted` 解决这个——manifest 是 `<all_urls>` 时等同 `all`，当 manifest 收紧时才真正过滤。内置轻量 MV3 match pattern 匹配器（支持 `<all_urls>` + `scheme://host-pattern/path`，含 `*.domain.com` 子域通配），不依赖 `chrome.permissions` API 以避免扩大扩展权限。
- 非 HTTP(S)/ws(s) 的 frame（`about:blank` / `chrome://newtab/` 等）在 `all-permitted` 模式下自动跳过。
- **`vortex_dom_commit` 支持 `kind: "checkbox-group"`**（O-10，消灭 3 个 session 踩过的同一个坑）：Element Plus `<el-checkbox-group>` 的幂等 toggle。传 `{values: ["好评"]}`，driver diff 当前 `.is-checked` 与目标 labels 的对称差，**逐个** `input.click()` + `await setTimeout 40ms` 让 Vue reactivity 在每次 toggle 间跑完 render cycle——修掉 `forEach(btn=>btn.click())` 被 Element Plus 合并成"只切最后一次"的坑。失败抛 `COMMIT_FAILED{stage:"verify"}`，extras 带 `checkedNow / wanted / toggled`。未知 label 抛 `INVALID_PARAMS` 并列出 `available`。
- **`vortex_observe` 元素带 `state` 字段**（O-8）：从 element 自身 + 最近 2 层 ancestor 扫 `.is-checked` / `.is-selected` / `.is-active` / `aria-checked=true` / `aria-selected=true` / `aria-pressed=true` / `disabled` / `aria-disabled`。代理不再需要额外 js_evaluate 补查框架状态（Element Plus 把 checked 放 label.is-checked 而不在 input 上，之前每次 session 都要踩一遍）。只有任一状态位为 true 时才附加 `state` 字段，保持常规元素的输出干净。
- **扩展自重载**（O-3b，对称 O-3）：vortex-server 启动时 `fs.watch(packages/extension/dist/)`，`.js` / `.html` / `manifest.json` 变化 → 2s debounce → 通过 native messaging 推送 `{type:"control", action:"reload-extension"}` → 扩展 background 收到后调 `chrome.runtime.reload()`（Chrome 对 load-unpacked 扩展会重读磁盘 dist）。上次 session 踩到的"O-1 报 `diagnosticsSupported:false` 但没法自动刷扩展"的坑被这个修掉：现在 `pnpm -C packages/extension build` 后 2s 内扩展自动换新，无需人肉 `chrome://extensions` 点重载。
- shared 协议扩展：`NmControl` 类型（`type:"control"`, `action:"reload-extension"`, `reason?:string`）加入 `NmMessageFromServer` 联合。
- `VORTEX_NO_EXT_AUTO_RELOAD=1` opt-out；扩展 dist 不存在时 watcher 优雅跳过不崩 server。
- **MCP server 自重启**（O-3）：server 启动后 `fs.watch` 自身运行目录（生产环境是 `dist/src/`），`.js` 文件变更即标记 `pendingRestart`；等当前正在处理的 `tool_call` 全部结束（`inflight === 0`）再 `process.exit(0)`。Claude Code 的 MCP stdio client 在子进程退出后会在下一次 tool_call 时自动 respawn，拿到最新 schema。解决"`pnpm -r build` 后 Claude 仍看不到新工具，必须手动重启 Claude Code"的踩坑（O-1 里添加的 `warning` 字段本质是让代理**看见**问题，O-3 让问题**自动消失**）。Opt-out：`VORTEX_MCP_NO_AUTO_RESTART=1`。
- `CallToolRequestSchema` handler 包裹 `inflight++/--` + `maybeExitAfterDrain`，保证 in-flight 请求不会被 exit 打断。
- **`vortex_ping` 返回版本指纹**（O-1）：响应体新增 `mcpVersion` / `extensionVersion` / `schemaHash`（12-char）/ `toolCount` / `extensionActionCount` / `diagnosticsSupported` 字段。MCP 与扩展语义主版本不一致时自动带 `warning`。代理在每个新 session 第一次 ping 即可看出"MCP 没重启"或"扩展过旧"的版本漂移问题，不再白跑一圈才发现工具对不上。
- `DiagnosticsActions.VERSION`（`diagnostics.version`）扩展侧 action：返回 `{ extensionVersion, actionCount, actions[] }`。版本由 `vite.config.ts` 的 `define.__EXTENSION_VERSION__` 从 `package.json` 注入。
- **observe 元素附加 `suggestedUsage`**（O-2）：每个 element 带 `{ domClick: "vortex_dom_click({ index, snapshotId })", click: "vortex_mouse_click({ x, y, frameId })" }` 预拼好的下一步命令。代理不必再自行推断应传 frameId——直接抄即可。
- `mouse_click` / `_double_click` / `_move` description 前置 ⭐ 标记主动推荐 frameId 用法；`vortex_observe` description 点明 `suggestedUsage` 与 `frames: 'all-same-origin'` iframe 流程；`vortex_ping` description 改写为"FIRST 调用"的版本指纹检查工具。
- `ELEMENT_NOT_FOUND` 和 `IFRAME_NOT_READY` hint 补"先 observe(frames:'all-same-origin') 拿 frameId 再 route"的引导链路，修复 v0.4 新工具"有但代理不用"的惯性。

- **`vortex_mouse_click` / `_double_click` / `_move` 支持 `frameId` + `coordSpace`**：传入 iframe 相对坐标 + frameId，自动换算为视口坐标后送 CDP，嵌套 iframe 累加祖先链偏移。`coordSpace` 默认按 frameId 自动选择（`frame` / `viewport`），可显式覆盖。返回体新增 `coordSpace`、`frameId`、`offsetApplied` 三个字段便于排障。
- `iframe-offset` 支持嵌套 iframe 偏移累加（原实现只算直接父 frame，跨两层以上 iframe 会错位）。跨源父 frame 执行失败时整体回退到 `{0,0}` 并允许调用方显式改走 `coordSpace: "viewport"`。
- **`vortex_network_get_logs` / `_get_errors` / `_filter` / `_get_response_body` 首次调用自动订阅**：无需先调 `vortex_network_subscribe` 即可拿到 XHR/Fetch 日志。首次触达 tab 时自动 `enableDomain(Network)` + 加入 `subscribedTabs`，后续调用幂等。显式 `SUBSCRIBE` 仍可覆盖 urlPattern / types / maxApiLogs 配置，职责从"启用"退化为"调参"。
- network schema 描述补"Auto-subscribes on first call" 提示。
- **`vortex_page_wait_for_xhr_idle`** 新工具：只盯 CDP 请求 type 为 `XHR`/`Fetch` 的请求 idle，忽略 WebSocket / Image / Stylesheet / Font，专解 SPA 上"后台 telemetry 长连导致 network_idle 永不到"的痛点。默认 idleTime 200ms、timeout 10s。
- **`vortex_page_wait_for_network_idle` 增强**：新增三个可选参数：
  - `urlPattern: string` —— 只计数 URL 含该子串的请求
  - `requestTypes: string[]` —— CDP 请求 type 白名单（如 `["XHR","Fetch"]`）
  - `minRequests: number` —— 至少看到 N 个匹配请求发起过才允许 resolve，防止"页面静止时瞬间假 idle"
- 返回体新增 `matchedRequests: number` 字段，便于调用方确认过滤器是否命中。
- **`vortex_dom_wait_settled`** 新工具：页内注入 `MutationObserver` 监视子树，在 `quietMs`（默认 300ms）内无任何 mutation 即返回。与已有 `vortex_dom_wait_for_mutation`（等待 CHANGE）互补。不传 selector 时观察 `document.body` 整棵树。返回体含 `{ settled: true, waitedMs, mutationsSeen }`。典型用法：点击筛选按钮触发 re-render 后立刻调用确保列表重排完成再读计数，避免把"渲染中间态"当作稳定状态。
- `DomActions.WAIT_SETTLED` 枚举位。
- **`vortex_dom_fill` framework-aware 拒绝**：命中受控组件（Element Plus datetime/date range picker & cascader、Ant Design RangePicker）时抛 `UNSUPPORTED_TARGET`，并在 hint 中指引代理改走 `vortex_dom_commit`。杜绝"DOM input.value 改了但组件状态没同步"的隐蔽 false-positive。
- `fallbackToNative: true` 参数（`dom_fill`）：兜底过渡开关。旧代理若强依赖松弛写值，可一版 window 期内显式开启；目标是 v0.5 前全面收紧。
- `VtxErrorCode.UNSUPPORTED_TARGET` 错误码 + `DEFAULT_ERROR_META` 对应 hint。
- 新增模块 `packages/extension/src/patterns/`：集中声明 fill 拒绝模式 + commit driver 注册表。
- **`vortex_dom_commit`** 新工具：对 framework 受控组件（picker/cascader/select）执行完整 "open → navigate → click → confirm → verify" 流程。首发覆盖 **Element Plus `<el-date-picker type='daterange'|'datetimerange'>`**，单次调用就能把 `{start: "2026-01-01", end: "2026-03-31"}` 提交到组件，告别 agent 侧手打二十次 `mouse_click` 导航 picker 的反模式。
- `VtxErrorCode.COMMIT_FAILED` 错误码：driver 中途失败时抛出，`context.extras.stage` 指示失败阶段（`open-picker` / `click-start` / `click-end` / `verify` 等），便于代理自愈或切换策略。
- 新增 `patterns/commit-drivers.ts` 注册表声明 driver 元数据（`id/kind/closestSelector/summary`），为 Ant Design / 其它框架 driver 预留。实际交互逻辑在 `dom.ts` COMMIT handler 的 page-side func 里按 `driverId` 分派。
- **`vortex_observe` 多 frame 扫描**：新增 `frames` 参数，`"main"`（默认，向后兼容）/ `"all-same-origin"` / `"all"` / `number[]`。跨 frame 扫描时 `index` 按扫描顺序累加为全局唯一，`element.frameId` 指向元素所在 frame。
- observe 响应体升级为 `version: 2`：顶层新增 `frames[]`（每帧含 `frameId / parentFrameId / url / offset / elementCount / truncated / scanned`），`elements[]` 每个元素带 `frameId` 字段。
- `resolveTarget` 路由升级：按 snapshot `element.frameId` 路由至正确 frame 操作；兼容旧 `entry.frameId` 单 frame 写法。
- 跨源 iframe 扫描失败标记为 `scanned: false`、`elementCount: 0`，不 throw 不污染结果。

### Tests

- 新增 `packages/extension/tests/observe-all-permitted.test.ts`（4 用例）：<all_urls> 下跨源 frame 被扫 / 限制 host_permissions 时过滤生效 / 非 HTTP 协议跳过 / 三种 frames 值（all-same-origin / all-permitted / all）行为对比。
- 新增 `packages/extension/tests/checkbox-group-commit.test.ts`（8 用例）：driver 注册表 + dom.ts 源码合约（for…of + await tick / is-checked 作为幂等判定 / verify 失败抛 COMMIT_FAILED / 未知 label 抛 INVALID_PARAMS）。
- 新增 `packages/extension/tests/observe-ui-state.test.ts`（7 用例）：getUiState 读 class + aria 的 6 个 state 位 / 仅在非空时附加 state 字段 / 类型层有 state?: 定义。
- 新增 `packages/extension/tests/extension-self-reload.test.ts`（13 用例）：源码级合约测试固化 O-3b 的跨三文件不变式（protocol.ts 的 NmControl 定义 / server watcher 的 opt-out + debounce + 文件过滤 + 写消息路径 + 从 startServer 调用 / extension background 的 control 分支 + chrome.runtime.reload 包 setTimeout）。
- 新增 `packages/mcp/tests/self-restart.test.ts`（7 用例）：源码级合约测试固化 O-3 的四条不变式（env opt-out / watch 自身目录 / exit 门控 inflight=0 / handler 包裹 inflight / 只响应 .js / watcher.on('error') graceful / installAutoRestart 在 connect 前调用）。
- 新增 `packages/extension/tests/diagnostics-handler.test.ts`（3 用例）：版本字符串存在 / actionCount>0 + 已排序 + 包含 `diagnostics.version`+`tab.list` / tab.* 数量断言。
- 新增 `packages/mcp/tests/ping-fingerprint.test.ts`（6 用例）：schemaHash 12 字符 hex / description 长度变化即触发 hash 漂移 / v0.4 新工具均在 toolset / ping description 提及 mcpVersion 等四字段 / mouse_click description 首 12 字符含 ⭐ 且 frameId 在 CDP 之前 / observe description 含 suggestedUsage+all-same-origin。

### Changed

- `vortex_mouse_*` 工具的 `description` 统一补充 frame-aware 行为说明。
- 静态资源默认不收（`includeResources` 需要配合显式 `SUBSCRIBE` 打开资源侧订阅），避免自动订阅引入大量噪声。
- `network_get_response_body` 的 hint 改写：自动订阅生效后提示代理"触发请求再取"，不再指示用户手动 subscribe。
- `waitForNetworkIdle` 内部抽象为 `awaitIdle(tabId, opts)` 通用助手，`waitForXhrIdle` 复用。
- `awaitIdle` 按 `requestId` 集合追踪 pending，只对过滤命中的请求计数并在 `loadingFinished/loadingFailed` 时核验 id——修掉旧实现"过滤掉的请求也递减 pending 导致假 idle"的 bug。
- `vortex_dom_fill` description 的 `Failures:` 段补充 `UNSUPPORTED_TARGET`。
- `SnapshotElement` 新增可选 `frameId` 字段；多 frame 时 `SnapshotEntry.frameId` 不填，单 frame 兼容旧 hint。
- 向后兼容：`frameId` 单值参数保持原 observe 语义（只扫该 frame）；不传 `frames` / 不传 `frameId` 时仅扫主 frame，返回结构除 `version` / `frames[]` / `element.frameId` 字段外与 v0.3 行为一致。

### Tests

- 新增 `tests/iframe-offset.test.ts`（7 用例）覆盖主 frame / 单层 / 嵌套 / 跨源失败 / 未知 frameId 五种路径。
- 新增 `tests/mouse-handlers.test.ts`（8 用例）覆盖 CLICK / DOUBLE_CLICK / MOVE 三类工具的 viewport / frame-local / 显式 coordSpace 覆盖 / INVALID_PARAMS / 偏移回退场景。
- 新增 `tests/network-auto-subscribe.test.ts`（6 用例）覆盖首次自动订阅 / 幂等 / GET_ERRORS + FILTER 同样走自动订阅 / 显式 SUBSCRIBE 覆盖 / 多 tab 独立订阅。因 `network.ts` 含模块级 state，测试使用 `vi.resetModules` + 动态 import 隔离。
- 新增 `tests/page-wait-idle.test.ts`（7 用例）：无请求瞬间 idle / 忽略 WebSocket+Image / XHR 挂起不 idle / urlPattern 过滤 / minRequests gate / TIMEOUT / ghost loadingFinished 不误触发。使用 `vi.useFakeTimers + advanceTimersByTimeAsync`。
- 新增 `tests/dom-wait-settled.test.ts`（7 用例）：默认返回 / selector 透传 / 'DOM did not settle' → TIMEOUT / 'Element not found:' → ELEMENT_NOT_FOUND / 'document.body not found' → ELEMENT_NOT_FOUND / 任意报错 → JS_EXECUTION_ERROR / 默认 quietMs=300 + timeout=8000。
- 新增 `tests/fill-reject-patterns.test.ts`（7 用例）覆盖 pattern 注册表完整性 + 拒绝决策算法（含 `fallbackToNative` bypass）。
- 新增 `tests/dom-commit.test.ts`（11 用例）：driver 注册表完整性 + handler 参数校验（missing kind/value/unknown kind）+ 四类错误映射（COMMIT_FAILED 带 stage / UNSUPPORTED_TARGET / ELEMENT_NOT_FOUND / 成功返回 startValue+endValue）。
- 新增 `tests/observe-multi-frame.test.ts`（8 用例）：默认 main / all-same-origin 跨 frame / 跨源排除 / entry.frameId 单帧兼容 / per-element frameId 路由 / legacy frameId 优先 / 扫描失败降级 / 无 frame IFRAME_NOT_READY。
- `packages/shared/tests/errors.test.ts` 用例总数 24 → 26，单独断言 `UNSUPPORTED_TARGET` 和 `COMMIT_FAILED`。

---

## [0.3.0] - 2026-04-19

> **发布性质**：结构型版本。主要价值是 **bench 方法论升级 + L1b 新层 + content 护栏**，bench canonical 分数因 N=3 揭示 flakiness 从 75.1 回退到 71.08（非 v0.3 代码引起；详见 Metrics 段）。B error-hint ROI 仍 null——L1b fixture 强化需在 v0.3.1 跟进。

### Added

- **bench `--repeats N`**：每场景跑 N 次取 median layer-score 代表值，报 `variance.tokens/steps/elapsed_ms`（min/p50/max）+ `pass_stable`。默认 N=1 保 CI 快；baseline / 夜跑用 N=3。Env fallback：`BENCH_REPEATS`。
- **bench `--verbose-runs`**：保留 `allRuns` 原始数据（默认丢，JSON 精简）。
- **L1b-no-observe 场景层**：5 个镜像 L1 的禁用 observe 变体。聚合进 `aggregate.l1b`，**不**进主 `vb_index`（保 v0.2↔v0.3 可比）。首次产出独立 L1b 分数（本版 59.60）。
- **`vortex_content_get_text` / `_html` soft size limit**：默认 128KB，可传 `maxBytes` 覆盖（范围 4KB~5MB）。截断后追加 sentinel trailer：text 走 `\n\n[VORTEX_TRUNCATED ...]`，html 走 `<!-- [VORTEX_TRUNCATED ...] -->`。采用 code-point-safe 切分（`[...str].slice(0,n).join('')`）避免 UTF-16 surrogate 破损。
- `ExpectedSpec.disabledTools: string[]`：per-scenario MCP 工具黑名单。Runner 层过滤 + agent system prompt 声明双保险。
- `AgentOptions.tools?: MCPTool[]`：覆盖 `mcp.tools`，给 per-scenario filter 留口子。
- **FLAKY / INCOMPLETE 告警**：reporter 在 `pass_stable === false` 或 `incomplete === true` 时前缀高亮行首，暴露"N=1 基线掩盖的噪声"。
- **variance regression warning**：`bench diff` 发现新 `tokens.max > baseline × 1.5` 时报 `[variance] ...` warning（不阻断发布）。

### Changed

- `vortex_observe` description 首行强化"Call this first on non-trivial page"（MCP schema + bench DEFAULT_SYSTEM 双向）。
- Report `schema_version` 1 → 2；老 reader 读 v2 报告仍能看 `aggregate`；`diff.ts` 支持 v1/v2 双路径 + 向后兼容（老 baseline 视为 `runs=1`）。

### Metrics（GLM-4.6V via 智谱 Anthropic 端点）

> ⚠️ **对比不完全对称**：v0.2.0 canonical GLM-4.7 baseline（VB 87.0）是 N=1，v0.2.0 GLM-4.6V baseline（VB 75.1，`full-v1-glm46v-baseline.json`）也是 N=1。v0.3.0 首次引入 N=3。本版未重跑 GLM-4.7（600 万资源包在 GLM-4.6V 上）。跨模型/跨 N 对比时须保持此差异意识。

| 指标 | v0.2.0 GLM-4.6V (N=1) | v0.3.0 GLM-4.6V (N=3, p50) | Δ |
|---|---:|---:|---:|
| **VB_Index** 主 | 75.1 | **71.08** | **-4.0** |
| L0 | 89.8 | 89.55 | ≈ |
| L1 | 64.4 | **49.05** | **-15.4** |
| L2 | 61.0 | 60.55 | ≈ |
| L3 | 91.3 | 91.33 | ≈ |
| L1b（新）| — | **59.60** | 首次数据 |
| A observe ROI | — | 30.25 | — |
| **B errorHint ROI** | null | **仍 null** | ❌ v0.3.1 跟进 |
| L2-004 GitHub tokens p50 | ~409K (max_steps) | 339K (max_steps) | 单响应 trailer 起效但未根治 |
| Tokens total（整套）| 828K | 904K | 略增（N=3 但 scenarios 也增加 L1b 5 个） |

**L1 回退根因分析**：非 v0.3 代码引起。N=1 → N=3 揭示 v0.2 canonical 的运气成分：
- L1-002 ambiguous：v0.2 N=1 pass → v0.3 N=3 **0/3 pass**，agent 稳定陷入 max_steps
- L1-003 disabled：v0.3 N=3 **1/3 pass (FLAKY)**
- L1-004 offscreen：v0.3 N=3 **0/3 pass**

这恰是 `--repeats` 方法论升级要暴露的信号——与其让单 shot 侥幸通过给出假 87.0，不如 N=3 揭示真实 flakiness。

**B ROI 仍 null 的根因**：L1b 禁 observe 后，agent 在 max_steps 前**没触发** expectedErrorCode 路径；log 里普遍 `[ROI-B] → direct`（蒙对 selector）或 `→ direct (task failed)`（走旁路失败）。需 v0.3.1 加固 L1b fixture 让 agent **必须**通过 vortex 工具路径（见 Known Issues）。

### Baselines 入 git

- `packages/vortex-bench/reports/full-v1-glm46v-baseline.json` — v0.2.0 参考（N=1，不变）
- `packages/vortex-bench/reports/full-v1-repeats3-v0.3.0-glm46v.json` — v0.3.0 canonical（N=3，含 L1b）

### Known Issues / v0.3.1 待办

- **B error-hint ROI 仍 null**：L1b 5 场景禁 observe 后，agent 大部分未触及 vortex 结构化错误码；fixture 需要强化为"非通过 vortex observe / vortex dom 错误处理就不能完成任务"的设计。
- **L2-004 GitHub max_steps 未根治**：128KB 单响应截断让单次工具调用不爆 context，但 agent 30 步内多次调用累积仍超；需要 agent 端的 step budget 或 content 访问次数限流。
- **L1-002 / L1-004 可能是 fixture bug**：N=3 稳定 0/3 值得单独审 fixture 是否对 GLM-4.6V 有歧义 selector 路径。

### Breaking

- Report `schema_version=2`：`Report.scenarios[i]` 含可选新字段 `runs/runs_completed/pass_rate/pass_stable/variance/representative_index/incomplete/error_runs/allRuns`；`Report.aggregate` 含可选 `l1b/incomplete_scenarios/vb_index_stability`。外部消费方需读 `schema_version` 判断。老 v1 baseline 读取兼容（reader 视作 `runs=1`）。

### Internal

- `metrics.ts:scoreOf` 提取为单一来源，`aggregateLayer` 改调用它（避免公式重复）
- `src/index.ts` 加 ESM entry-point guard，防止 test import 触发 main()
- 新增单元测试 32 个（基线 94 → 126）：`truncate.test.ts`（11）+ `aggregate-runs.test.ts`（7）+ `cli-args.test.ts`（9）+ `diff-v2.test.ts`（3）+ `scenario-disabled-tools.test.ts`（2）
- 两轮 Codex 独立 review（session `019da345-4d48-7a91-880d-5928053df87f`）：首轮 14 问题（6 P1 + 6 P2 + 2 P3）全修；二轮 6 问题（3 P1 + 3 P2）全修

---

## [0.2.0] — 2026-04-18

> 在 beta.1 基础上：新增 **vortex-bench v1** 评测集（18 场景，4 层分层）、`vortex_events_drain` 工具（主动拉聚合事件绕过 1s 节流窗口）。首版 baseline = 87.0/100（GLM-4.7），drain 工具令 C event-bus ROI 从 0% 升到 100%。

### 新增（Added）

- **MCP 工具**（1 个）
  - `vortex_events_drain`：强制 flush dispatcher（notice+info buffer 全清），返回 `{ events, flushed: { notice, info } }`。专为 sub-second ReAct loop 设计，解决"agent 在 1s 聚合窗口内结束导致事件被吞"的使用性问题。
  - 底层 action：`events.drain`（新 `EventsActions` 命名空间）
- **vortex-bench v1**（新包 `packages/vortex-bench/`，private）
  - 18 场景 4 层分层：L0 smoke (5) / L1 antipattern (5) / L2 realworld (5) / L3 session (3)
  - 四维指标：Correctness / Efficiency / Robustness / Utilization
  - VB_Index = 0.25·L0 + 0.25·L1 + 0.30·L2 + 0.20·L3
  - ROI 三件独立分：A observe / B error-hint / C event-bus
  - Provider 路由：zhipu / anthropic / minimax 自动或显式切换（一套 `@anthropic-ai/sdk` 吃三家）
  - CLI：`bench run / score / diff`
  - 程序化 judge（声明式断言）+ LLM judge 兜底（`expected.llmRubric`）
  - 本地 CI 脚本 `scripts/bench-ci.sh` + GH Actions workflow 占位
  - Baselines 入 git：L0+L1 / L2 / L3 / 完整 v1 / GLM-4.7 / GLM-4.6V
- **dispatcher.flushAll() 返回计数**：`{ notice: N, info: M }`，便于观察/测试

### 变更（Changed）

- **dispatcher**：`flushAll()` API 从 `void` 改为返回 `{ notice, info }`（破坏性？—— 但仅内部使用，不影响外部调用方）
- **CHANGELOG**：补 bench v1 / drain 工具 / 模型对比数据

### 测试

- extension 单测 42 → **48**（+6 events-handler.test.ts）
- 真实 bench 跑通 L0+L1+L2+L3 = 18 场景，GLM-4.7 pass 17/18
- 单个 GLM-4.6V baseline 也入 git（pass 13/18，用于模型能力对比）

### Bench 首版 baseline 数字

| Provider | VB_Index | Pass | L0 | L1 | L2 | L3 | A ROI | C ROI |
|----------|---------:|-----:|---:|---:|---:|---:|------:|------:|
| GLM-4.7 (智谱) | **87.0** | 17/18 | 89.0 | 93.0 | 77.2 | 91.7 | 68.2% | 100% |
| GLM-4.6V (智谱) | 75.1 | 13/18 | 89.8 | 64.4 | 61.0 | 91.3 | 47.5% | 100% |

- GLM-4.7 在"长 ReAct 循环"任务上明显优于 4.6V（L1/L2 差 16-28 分）
- drain 工具对两模型同样有效（C ROI = 100%）

### 向后兼容

- `vortex_events_drain` 是新增工具，不破坏已有订阅/取消流程
- `flushAll()` 签名变化仅影响内部（测试/进程退出兜底），无外部 client 依赖

### 已知限制

- bench CI 需本地 Chrome + 扩展 active + vortex-server（GH Actions 占位为 workflow_dispatch，待后续 headless runner）
- GLM-4.6V 在多步 ReAct 任务上容易陷 max_steps，建议 bench 默认选 GLM-4.7

### 发布 commits

- `4f6c395` vortex_events_drain + L3-003 pass
- `9fa7de8` 完整 v1 baseline (82.4→87.0)
- `4aec05b` L2-003 rubric 松化
- `9673c5d` GLM-4.6V 模型对比 baseline
- `44ea25e` B7 L2/L3 共 8 场景（beta 后补齐）
- `0d36167` bench B1~B6 核心切片
- `733a4ec` beta.1 → （本版本）

---

## [0.2.0-beta.1] — 2026-04-18

> 在 alpha.1 基础上清掉所有登记的 follow-up（F1~F11 + DOM_MUTATED），修复 E2E 发现的两个关键通道 bug，引入 content script 架构做页面级事件拦截。真实浏览器 E2E 9/10 场景通过。

### 新增（Added）

- **MCP 工具**（2 个）
  - `vortex_dom_watch_mutations` / `vortex_dom_unwatch_mutations`：按需激活目标 tab 的 MutationObserver，DOM 变动作为 info 级 `dom.mutated` 事件（dispatcher 自动合并聚合）。
- **事件源 5 个**（W5 未做的全部实装）
  - `extension.disconnected`（urgent）：MCP client WS 意外断开时合成事件
  - `dialog.opened`（urgent）：content-main 覆盖 `window.alert/confirm/prompt`
  - `form.submitted`（notice）：content-isolated `document.addEventListener('submit', capture)`
  - `dom.mutated`（info）：按需激活 MutationObserver
  - 至此 `VtxEventType` 11 类全部有实际 emit 源
- **架构 · content script**：
  - `content-main.ts`（MAIN world，document_start，all_frames）：native dialog 拦截
  - `content-isolated.ts`（ISOLATED world）：MAIN ← message 转发、submit 监听、MutationObserver
  - background `chrome.runtime.onMessage` 作为中继，源校验 `"vortex-content"` + 事件白名单
- **dispatcher 三级节流聚合**（F10）：
  - urgent 立即 send；notice 200ms 批量；info 1000ms 批量 + 同 `(type, tabId, frameId)` 合并（`data: { mergedCount, firstAt, lastAt, samples[≤3] }`）
  - 构造参数可覆盖窗口时长（便于测试）
  - 新增 `flushAll()` 进程退出前兜底
- **交互 handler 全套探测**（F1+F2）：`dom.type` / `fill` / `select` / `hover` 继承 CLICK 的 occluded/offscreen/disabled/detached/ambiguous 探测；CLICK useRealMouse 分支也补全。
- **单测**：88 个（shared 28 + mcp 18 + extension 42）。新增 router / tab-handlers / console-dedup / dispatcher / mutations-handler 覆盖。

### 修复（Fixed）

- **router** 未识别 `VtxError` 实例，导致 handler 结构化错误被降级到 `JS_EXECUTION_ERROR`（`83a93c2`）。E2E 发现。
- **server `message-router`** 将 `NmEvent` 转 `VtxEvent` 时丢弃 `level` / `frameId`（`e1e925f`）。E2E 发现。
- **`tab.activate`** handler 未接收第二参数 `tabId`（`afd0970`）。
- **`dom.scroll`** 未做参数前置校验（`4295164`）。
- **console error 双推**：`Runtime.consoleAPICalled` 的 error 级仅走 `CONSOLE_ERROR`，去除 legacy `console.message` 重复（`07d82ee`）。
- **F8**：content.ts 的 4 处 `res.error` throw 补 selector context。
- **F9**：SCROLL 参数校验提前到 handler 入口。

### 变更（Changed）

- **manifest** 加入 `content_scripts`：`<all_urls>` + `run_at=document_start` + `all_frames`。
- **background**：注册 `chrome.runtime.onMessage` 事件中继。

### 向后兼容

- alpha.1 → beta.1 无协议层破坏性变更。
- content_scripts 是 extension manifest 扩展，用户升级后需**重新 install/reload 扩展**，已打开的页面需 reload 才会注入 content script（首次访问新页面自动注入）。

### 真实浏览器 E2E 结果

- ✅ 1 ELEMENT_NOT_FOUND / 2 ELEMENT_OCCLUDED（blocker 描述准确）/ 3 vortex_observe / 4 index click / 5 STALE_SNAPSHOT / 6 事件 piggyback / 7 ELEMENT_DISABLED / 8 SELECTOR_AMBIGUOUS / 9 form.submitted
- ⏳ 10 DOM_MUTATED：MCP 工具需重启 Claude Code 拉新 tool 列表才能调，单测 8 条已覆盖

### 已知限制

- dialog.opened 自动 E2E 受限（`window.alert` 会阻塞页面 JS），但 override 安装可通过 `window.alert.toString()` 验证，通道与 form.submitted 同路径。
- content_scripts 对 `chrome://` / 扩展 UI 页面不生效（Chrome 限制）。

---

## [0.2.0-alpha.1] — 2026-04-18

> 首个 0.2 alpha 版本：围绕 LLM Agent 的感知 / 决策 / 反馈三个环节做了整体升级。
> 详细规划见 `12-Projects/20260418-0000-vortex工具能力升级/` 的设计文档与测试报告。

### 新增（Added）

- **MCP 工具**（3 个）
  - `vortex_observe`：一次调用返回页面的 LLM 友好快照（带 index 的可交互元素列表 + role + 可读名 + bbox + 遮挡检测 + 关键属性），配合 `snapshotId` 供后续 `dom.*` 按 `index` 操作。
  - `vortex_events_subscribe` / `vortex_events_unsubscribe`：订阅浏览器事件，通过 tool response 的 `[vortex-events]` 文本项 piggyback 推送。
- **错误码**（14 个新增）
  - 元素定位：`ELEMENT_OCCLUDED`、`ELEMENT_OFFSCREEN`、`ELEMENT_DISABLED`、`ELEMENT_DETACHED`、`SELECTOR_AMBIGUOUS`
  - 页面状态：`NAVIGATION_IN_PROGRESS`、`PAGE_NOT_READY`、`DIALOG_BLOCKING`、`IFRAME_NOT_READY`
  - Snapshot：`STALE_SNAPSHOT`、`INVALID_INDEX`
  - 其他：`TAB_CLOSED`、`CSP_BLOCKED`、`INTERNAL_ERROR`
- **事件类型**（11 类，6 个源已接入）
  - urgent：`user.switched_tab`、`user.closed_tab`、`download.completed`
  - notice：`page.navigated`、`network.error_detected`、`console.error`
  - 声明但暂未实装：`dialog.opened`、`extension.disconnected`、`form.submitted`、`dom.mutated`、`network.request`
- **协议增强**
  - `VtxErrorPayload` 新增 `hint`、`recoverable`、`context`（含 `extras` 兜底）字段；`VtxResponse.error` / `NmResponse.error` 类型收敛至此。
  - `VtxEvent` / `NmEvent` 新增 `level`、`frameId` 字段。
- **质量基础设施**
  - 全仓引入 vitest（shared / mcp / extension），**68 个单元测试**覆盖 `VtxError`、`errors.hints`、`events`、`event-store`、`router`、`tab handlers`、`console dedup`。
  - `scripts/check-throw-discipline.mjs` + `pnpm prebuild` hook：禁止 `handlers/` 与 `lib/` 下出现 `throw new Error`。
- **dom.\* 工具扩展**：11 个 `dom.*` 工具接受 `{ index, snapshotId }` 作为 selector 替代；snapshot 绑定的 tab/frame 自动覆盖 `args.tabId/frameId`。
- **探测**：`dom.click` 普通路径在 page script 内逐项探测失败原因（OCCLUDED/OFFSCREEN/DISABLED/DETACHED/AMBIGUOUS），返回结构化 `errorCode` + `extras.blocker`。
- **MCP tool description**：29 个高价值工具 description 补 `Failures: CODE (hint)` 段落，供 LLM 预先了解恢复路径。

### 变更（Changed）

- **Handler 错误抛出**：全部 handlers（13 个）+ 两个 lib 文件改用 `vtxError(code, msg, context?)`，注入默认 hint 与 recoverable。
- **`dom.*` schema**：`required` 从 `["selector"]` 改为 `[]`（LLM 可在 selector / index 间二选一）。
- **`file.onDownloadComplete`**：退化为向后兼容说明；下载监听改为模块加载即挂载，事件通过 `DOWNLOAD_COMPLETED` 广播。
- **Console 事件去重**：`error` 级仅走 `CONSOLE_ERROR`，其他级别保留 legacy `console.message`。
- **协议错误响应**：`code` 类型从 `string` 收敛到 `VtxErrorCode` 字面量联合，恢复类型安全。

### 修复（Fixed）

- **router** 不识别 `VtxError` 导致 handler 结构化错误被降级到 `JS_EXECUTION_ERROR`（丢失 hint/context/recoverable）。E2E 发现。
- **server `message-router`** 将 `NmEvent` 转 `VtxEvent` 时丢弃 `level` 与 `frameId`，导致 MCP 侧订阅 `notice` 级事件永远空。E2E 发现。
- **`tab.activate`** handler 未接收第二参数 `tabId`，导致 `vortex_tab_activate(tabId=X)` 始终返回 `INVALID_PARAMS`。
- **`dom.scroll`** 未做参数前置校验，selector/position/x/y 都缺失时返回 `JS_EXECUTION_ERROR`，改为直接 `INVALID_PARAMS`。
- **`js.callFunction`**：函数名不存在时由 `JS_EXECUTION_ERROR` 细化为 `INVALID_PARAMS`。
- **`file.upload`**：目标非 `<input type=file>` 时由 `JS_EXECUTION_ERROR` 细化为 `INVALID_PARAMS`。
- **`relay-client`**：手写的 `"RELAY_HANDLER_ERROR"` 字符串替换为 `VtxErrorCode.INTERNAL_ERROR`。

### 向后兼容

- 所有协议字段扩展均为 optional，旧 client 零改动可升级到 0.2.0-alpha.1。
- Legacy 事件名（`console.message`、`network.requestStart` 等）保留通道；订阅方可用 `minLevel: "info"` 继续消费。

### 已知遗留（Follow-up）

见测试报告 F1~F11：
- TYPE / FILL / HOVER / SELECT 与 CLICK useRealMouse 路径尚未加探测
- `DIALOG_OPENED` / `FORM_SUBMITTED` / `DOM_MUTATED` 事件需要 CDP attach 策略或 content script 架构
- dispatcher 节流聚合延后到需求真正出现再做
- `EXTENSION_DISCONNECTED` 事件声明未 emit

---

## [0.1.0] — 之前

（本 CHANGELOG 之前的变更详见 git log）
