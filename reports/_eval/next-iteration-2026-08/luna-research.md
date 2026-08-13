# vortex 下一步高价值迭代候选面：证据调研

调研日期：2026-08-13

## 口径

- [实查] 本文只做证据整理，不做候选线排序、路线推荐或实施计划。
- [实查] 本轮只读了仓内文档、源码和官方资料；没有使用 `vortex_*` / `playwright_*`，没有启动浏览器，没有运行 bench，也没有修改源码。
- [实查] 仓内断言均附绝对路径和行号；外部断言均附 URL 与版本号或查阅日期。`[推测]` 只表示由已查事实推导出的待证假设，不表示已经实测。

## 线 1：可验证确定性重放 Phase 2（序列重放）

### 仓内现状

- [实查] Phase 1 的设计边界明确把多步轨迹录制、跨 session 落盘缓存、`vortex_replay` 工具和跳过 observe 的成本杠杆列为不做项；Phase 2 只留下“按顺序 verify、任一步 drift 后 re-observe、跨 session JSON”的方向性指针。`/Users/lg/workspace/vortex/docs/superpowers/specs/2026-06-18-verifiable-replay-design.md:23-35,101-114,154-156`
- [实查] 共享层的 `EffectFingerprint` 类型虽然列出了 `click`、`fill`、`type`、`select`、`scroll`，但当前归一化函数是 `normalizeClickFingerprint`，实际字段是 click 的 URL 和副作用类别。`/Users/lg/workspace/vortex/packages/shared/src/effect-fingerprint.ts:15-47`
- [实查] MCP 侧 `applyFingerprint` 当前只接受 `action === "click"` 且有 effect；非 click 或缺少 effect 返回空对象，`@ref` 解析不到稳定身份时返回 `fingerprintSkipped`，而不是伪造指纹。`/Users/lg/workspace/vortex/packages/mcp/src/lib/fingerprint-apply.ts:19-45`
- [实查] `vortex_act` 只有在带 `options.fingerprint` 且逻辑动作是 click 时才强制补 `observeEffect:true`；因此当前公开的 record/verify 闭环仍是 click-only。`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:781-792`; `/Users/lg/workspace/vortex/packages/mcp/src/tools/schemas-public.ts:51-93`
- [实查] verify 的 `autoRecover` 只在显式 `autoRecover:true` 且出现 drift 时触发一次 `vortex_observe`；它不重新执行原 click，也没有撤销动作。`/Users/lg/workspace/vortex/packages/mcp/src/lib/fingerprint-apply.ts:48-54`; `/Users/lg/workspace/vortex/packages/mcp/src/server.ts:917-958`
- [实查] 当前渲染快照缓存是进程内 `Map`，只保存 `role::name::frameId` 身份键和 index 映射，TTL 为 5 分钟、容量上限为 20 条；过期或 index 未命中时 `lookupIdentity` 返回 `null`。`/Users/lg/workspace/vortex/packages/mcp/src/lib/observe-render.ts:160-229,232-243`
- [实查] `VORTEX_SESSION_ID` 以及由 `ppid + cwd + VORTEX_SESSION_NAME` 派生的 session ID 用来维持 MCP client 与 hub/browser 的绑定；该模块没有 replay artifact 的落盘逻辑。`/Users/lg/workspace/vortex/packages/mcp/src/lib/session-id.ts:10-29`
- [实查] stale ref 与指纹 drift 已经是两条分开的信号：`RefStore` 会先尝试旧 `backendDOMNodeId`，失败后用 descriptor 重抓 AX snapshot 并重定位，最终报告 `STALE_REF`；指纹逻辑在动作成功拿到 effect 后才运行。`/Users/lg/workspace/vortex/packages/extension/src/reasoning/ref-store.ts:51-85`; `/Users/lg/workspace/vortex/packages/mcp/src/server.ts:917-934`

### 外部同类怎么做

- [实查] Stagehand v4.0 的 Browserbase cache 可缓存 `act()`、`observe()` 和 `extract()`；cache key 使用 instruction、页面内容和调用选项，响应带 `HIT`、`MISS`、`DISABLED`，miss 还带 `missReason`。页面 URL、页面内容或结构变化会导致 miss，缓存服务不可达时回退普通 inference。来源：<https://docs.stagehand.dev/v4/best-practices/caching>（Stagehand v4 文档，2026-08-13 查阅）；版本锚点：<https://raw.githubusercontent.com/browserbase/stagehand/main/package.json>（`4.0.0`，2026-08-13 查阅）。
- [实查] Stagehand v4 对缓存 replay 的处理是“页面变化时不命中旧结果并重新 inference”，不是把旧 selector 强行执行到底；locator/ignoreLocators 作用域的调用当前直接绕过服务端缓存并标为 `DISABLED`。来源：<https://docs.stagehand.dev/v4/best-practices/caching>（v4，2026-08-13 查阅）。
- [实查] Stagehand v4 把 `act()` 定义为单动作；`observe()` 返回的 `Action` 可以交给 `act()` 做无 inference 的确定性执行，但文档明确多步 instruction 不可靠，应由调用方串联多个单步 action。来源：<https://docs.stagehand.dev/v4/basics/act>（v4，2026-08-13 查阅）。
- [实查] Skyvern 当前文档标注 `v1.0.22 (latest)`；code caching 首次由 agent 生成可执行代码，后续 `run_with="code"` 跳过截图和 LLM。Task 缓存完整 action sequence，Agent 按 block 缓存，并用 progressive caching 覆盖不同分支；条件、wait、code block 始终实时执行。来源：<https://skyvern.com/docs/llms.txt>（`v1.0.22`，2026-08-13 查阅）；<https://skyvern.com/docs/developers/features/code-caching.md>（当前文档，2026-08-13 查阅）。
- [实查] Skyvern 的缓存代码在 layout change、new field 或 missing element 时回退完整 agent 并重新生成缓存；公开文档描述的失效检测主要是“缓存代码执行失败后回退”，没有给出类似 Stagehand 的运行前 DOM fingerprint safety threshold。来源：<https://skyvern.com/docs/developers/features/code-caching.md>（当前文档，2026-08-13 查阅）。
- [实查] HyperAgent 的 `@hyperbrowser/agent` 当前 package 版本为 `1.1.2`；`page.ai()` 自动返回 action cache，`runFromActionCache()` 先按缓存 XPath 执行，失败后按 `maxXPathRetries` 重试，再以原 instruction 触发 LLM fallback，结果包含 `usedXPath`、`fallbackUsed` 和 `success`，默认首个失败即停止。来源：<https://raw.githubusercontent.com/hyperbrowserai/HyperAgent/main/package.json>（`1.1.2`，2026-08-13 查阅）；<https://www.hyperbrowser.ai/docs/hyperagent/action-cache>（当前文档，2026-08-13 查阅）。
- [实查] HyperAgent 的 action cache 可 JSON 序列化后由调用方重新加载；公开 replay 契约暴露的是路径是否命中和 fallback 是否发生，没有与仓内 `Drift.classes/details` 同等级的动作后置效果证据。来源：<https://www.hyperbrowser.ai/docs/hyperagent/action-cache>（当前文档，2026-08-13 查阅）。

### 代价与可行性

- [实查] 现有分层已经把页面采集和 MCP 编排分开：设计文档规定 extension 负责 effect/targetIdentity 等 page-side 采集，MCP 负责指纹存储、drift 比对、`autoRecover` 编排；Phase 2 的跨 session JSON 需要落在 MCP/Node 侧，而不是依赖 MV3 service worker 的内存。`/Users/lg/workspace/vortex/docs/superpowers/specs/2026-06-18-verifiable-replay-design.md:108-114`
- [实查] 现有 `role::name::frameId` 身份并不等于唯一业务实体：渲染缓存只按该字符串建立 key，ref descriptor 在 role+name 多命中时严格抛 `AMBIGUOUS_DESCRIPTOR`。`/Users/lg/workspace/vortex/packages/mcp/src/lib/observe-render.ts:186-204`; `/Users/lg/workspace/vortex/packages/extension/src/reasoning/descriptor.ts:61-80`
- [推测] 跨 session replay artifact 至少需要携带浏览器/页面/ frame 语境、artifact 版本、动作前置条件、每步 postcondition、失效时间和隐私边界；否则它会把当前“snapshot stale”和“effect drift”两类信号重新混成静默错误。该推测基于现有 stale/drift 分离实现和仅进程内的快照缓存：`/Users/lg/workspace/vortex/packages/extension/src/reasoning/ref-store.ts:51-85`; `/Users/lg/workspace/vortex/packages/mcp/src/lib/observe-render.ts:160-229`
- [实查] 当前 click fingerprint 只证明 target identity、URL 变化以及 DOM/network/focus/ARIA/user-feedback 类别是否匹配；它没有证明业务状态、服务端最终结果或页面上某个领域实体已经改变。`/Users/lg/workspace/vortex/packages/shared/src/effect-fingerprint.ts:33-47,61-102`
- [推测] 因而“fingerprint matched”与“业务动作完成”之间仍存在可被页面实现暴露的 gap；如果 Phase 2 只把 selector/XPath 成功或类别签名匹配当作序列继续条件，仍可能保留 silent-false-success。
- [实查] 若把序列 replay 暴露成新的 public MCP tool，会触及现行 tools/list 预算：I15 当前按 `getToolDefs()` 序列化 payload，硬上限为 10300 B，公开工具数量断言为 23。`/Users/lg/workspace/vortex/packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:129-157`
- [实查] 若序列步骤继续复用 page-side 注入函数，仓内现有约束是注入会丢模块作用域，函数必须自包含；结构化回读还同时维护可 import 的真源和 `query.ts` 内联副本。`/Users/lg/workspace/vortex/docs/structured-readback-approach.md:47-67`; `/Users/lg/workspace/vortex/packages/extension/src/page-side/schema-readback.ts:1-13`

### 什么证据能证伪它

- [推测] 在固定 URL、viewport、locale、账号状态和页面数据的跨 session 重复任务中，如果命中率低、miss 主要来自无业务意义的动态噪声，且命中后节省的 observe/LLM 时间小于指纹采集与 drift 校验开销，则“跨 session 序列缓存有可观成本杠杆”的假设会被证伪。对照的外部失效口径：<https://docs.stagehand.dev/v4/best-practices/caching>（Stagehand v4，2026-08-13 查阅）。
- [推测] 如果出现 `drift === null` 但业务结果错误，或旧轨迹在同 role/name/frame 的重名元素上命中错误目标，则会直接证伪“当前身份键与类别指纹足以保护序列 replay”的假设。相关仓内身份与指纹边界：`/Users/lg/workspace/vortex/packages/mcp/src/lib/observe-render.ts:186-204`; `/Users/lg/workspace/vortex/packages/shared/src/effect-fingerprint.ts:33-47,61-102`
- [推测] 如果同一轨迹在页面轻微结构变化后大面积 false miss，或者页面实质变化后仍大量 false hit，应分别记录 miss/hit 混淆矩阵；任一类达到不可接受比例，都是否定当前失效策略的证据。外部缓存的页面变化失效描述：<https://docs.stagehand.dev/v4/best-practices/caching>（Stagehand v4，2026-08-13 查阅）；<https://skyvern.com/docs/developers/features/code-caching.md>（当前文档，2026-08-13 查阅）。
- [推测] 如果自动 re-observe 后新 snapshot 无法稳定映射到剩余步骤，或者非幂等 click 在响应丢失后重试造成重复副作用，则会证伪“drift 后单纯继续/重试可以安全恢复”的假设。现有恢复边界：`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:935-958`

## 线 2：批处理 / 循环原语

### 仓内现状

- [实查] 公开 `vortex_act` 的 action 是单值枚举，没有动作数组；`vortex_evaluate` 只映射到一次 `js.evaluate` 或 `js.evaluateAsync`。`/Users/lg/workspace/vortex/packages/mcp/src/tools/schemas-public.ts:51-93`; `/Users/lg/workspace/vortex/packages/mcp/src/tools/dispatch.ts:86-89,136-198`
- [实查] 当前唯一显式批处理工具是 `vortex_fill_form`：它按 fields 顺序串行执行，字段解析或执行失败后继续下一字段，最终只返回每字段的 `index/target/ok/error` 与计数，不返回底层每步完整 postcondition。`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:587-703`
- [实查] `vortex_fill_form` 没有 rollback、事务提交或批次内自动 re-observe 分支；它复用当前 active snapshot 的 target 翻译。`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:610-689`
- [实查] 单动作已有前置 actionability 轮询，按 visible、stable、obscured、disabled、editable 等原因区分可重试和不可重试失败。`/Users/lg/workspace/vortex/packages/extension/src/action/auto-wait.ts:47-111`
- [实查] 单动作已有分动作 micro-verify：click 做一帧 DOM/URL 差异，fill/type/select 回读值，scroll 回读位置，hover/drag 返回 `effects:null` 而不声称有强成功状态。`/Users/lg/workspace/vortex/packages/extension/src/action/micro-verify.ts:27-50,54-166`
- [实查] `vortex_evaluate` 的 MV3 `executeScript` 超时只取消客户端等待，不会停止已经运行的 page-side 函数；CDP Runtime.evaluate 的 native timeout 能杀同步死循环，但 `awaitPromise` 异步等待仍由客户端超时兜底。`/Users/lg/workspace/vortex/packages/extension/src/handlers/js.ts:6-29,101-114`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/js.ts:127-169,291-294`
- [实查] 当前可验证 replay 仍只在单个 click 成功响应上附加 fingerprint/drift/recovered，批量路径没有逐步 fingerprint 轨迹。`/Users/lg/workspace/vortex/packages/mcp/src/lib/fingerprint-apply.ts:19-45`; `/Users/lg/workspace/vortex/packages/mcp/src/server.ts:917-958`

### 外部同类怎么做

- [实查] Playwright Locator 在 click/fill/select 等动作前自动等待 actionability，断言也自动重试；多个元素执行单元素动作会触发 strictness，而 `first/last/nth` 是调用方显式选择。`locator.all()` 不等待动态列表，`evaluateAll()` 是一次页面函数调用并返回一次结果。来源：<https://playwright.dev/docs/actionability>、<https://playwright.dev/docs/locators>（当前文档，2026-08-13 查阅）；补充源码锚点：<https://github.com/microsoft/playwright/blob/v1.58.2/docs/src/api/class-locator.md>（v1.58.2，2026-08-13 查阅）。
- [实查] Stagehand v4 把多步流程拆成多个单步 `act()`；`observe()` 得到的 Action 可以逐项 replay，避免每一步再次 inference，但官方没有把 `act()` 定义成事务，也没有 `rollback` 或批次 continuation 字段。来源：<https://docs.stagehand.dev/v4/basics/act>、<https://docs.stagehand.dev/v4/basics/observe>（v4，2026-08-13 查阅）。
- [实查] Skyvern workflow 原语提供 `for_loop`、`continue_on_failure`、`next_loop_on_failure`、`complete_if_empty` 和 block 级 `max_retries`；validation block 用 complete/terminate criterion 作为阶段性断言。官方批量下载示例明确允许某一项失败后继续下一项。来源：<https://www.skyvern.com/docs/cookbooks/bulk-invoice-downloader>（当前文档，2026-08-13 查阅）；API schema 版本 `1.0.0`：<https://www.skyvern.com/docs/api-reference/agents/update-an-agent>（2026-08-13 查阅）。
- [实查] Skyvern 将 `failed`、`terminated`、`timed_out`、`canceled` 等状态分开；官方说明基础设施失败可能适合 retry，而目标不可达时无变化重试不会解决问题。来源：<https://www.skyvern.com/docs/developers/going-to-production/error-handling>（当前文档，2026-08-13 查阅）。
- [实查] Puppeteer `25.6.0` Locator 会等待元素存在、可见、enabled 和稳定 bounding box，并在 locator action 事件中允许观察重试；低层 `waitForSelector` 不会替后续 action 自动重试。来源：<https://pptr.dev/guides/page-interactions>（Puppeteer `25.6.0`，2026-08-13 查阅）。
- [实查] Chrome DevTools MCP 的官方工具参考提供 `fill_form` 一次填多个 inputs/selects/checkboxes/radios，也提供 `evaluate_script` 执行任意 JSON 可序列化函数；其 `fill_form` 参数是 `elements` 与可选 `includeSnapshot`，没有 per-field continuation、事务 ID 或 rollback 字段。来源：<https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md>（main，2026-08-13 查阅；外部基线记录版本为 `1.7.0`：`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/README.md:3-5`）。
- [实查] Playwright Test 的 retry 是重新运行失败测试，并会丢弃失败 worker/browser；serial 测试组失败时后续步骤跳过或整体重跑，这不是浏览器动作的 rollback 语义。来源：<https://playwright.dev/docs/test-retries>（当前文档，2026-08-13 查阅）。

### 代价与可行性

- [实查] 现有批量行为落点在 MCP server/dispatch，实际动作前置检查和 postcondition 落点在 extension action 层；因此一次批量调用若要保留“每步自证”，不能只把循环包进 `vortex_evaluate`，还要让每步穿过现有 actionability/micro-verify 链。`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:587-703`; `/Users/lg/workspace/vortex/packages/extension/src/action/auto-wait.ts:47-111`; `/Users/lg/workspace/vortex/packages/extension/src/action/micro-verify.ts:27-50`
- [推测] 批处理最直接的收益是减少 MCP/模型往返，最直接的正确性代价是扩大单次调用内的不可见区间：若只在批次末尾返回结果，中间 DOM mutation、网络副作用、页面导航和部分失败原因会丢失。
- [实查] 当前 `fill_form` 已选择“部分成功、不中断后续”而非 atomic；当前 evaluate 超时也可能留下继续运行的 page-side 函数。因此“批量”与“事务”在现有架构中不是同一个语义。`/Users/lg/workspace/vortex/packages/mcp/src/server.ts:587-703`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/js.ts:6-29,291-294`
- [推测] 对 click、提交、下载等非幂等动作，响应丢失后重试存在重复副作用；当前 transport 重试只按瞬态错误白名单处理，未携带业务 idempotency key，因此继续/重试边界不能由“请求返回 success”单独决定。`/Users/lg/workspace/vortex/packages/mcp/src/client.ts:17-27,149-177`
- [实查] 若新增 public batch/loop 工具或给现有工具增加动作序列字段，会受 I15 tools/list 字节硬上限 10300 B 和 23 个公开工具数量断言约束。`/Users/lg/workspace/vortex/packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:129-157`
- [实查] page-side 批处理函数同样受注入丢模块作用域和双源同步约束；结构化回读的现有形态是可 import 真源加 `executeScript({func})` 自包含内联副本，且用 parity 测试防止两份逻辑漂移。`/Users/lg/workspace/vortex/docs/structured-readback-approach.md:47-67`; `/Users/lg/workspace/vortex/packages/extension/src/page-side/schema-readback.ts:1-13`

### 什么证据能证伪它

- [推测] 如果相同任务的批量调用在端到端 p50/p95 上没有显著少于 N 次单动作调用，或者每步自证的采集开销抵消了往返收益，则“批处理能解决日志中的工具层缺口”的假设会被证伪。
- [推测] 如果批处理的 partial-failure 结果无法让调用方区分“未执行”“已执行但响应丢失”“执行后 postcondition 失败”，或重试会产生重复提交/重复下载，则该原语不具备可接受的安全边界。
- [推测] 如果实际循环 workload 中列表在每步之间频繁重排、导航或跨 frame，导致目标 stale/ambiguous 率高于单步调用，批处理的减少往返反而不能转化为可靠性收益。
- [推测] 如果真实日志中大多数 evaluate 循环都只做纯读、且单次脚本的耗时和失败率低于 action-level 批处理，说明“新增通用循环工具”并非必要；相反，若纯读之外的写动作占主导且逐步 postcondition 缺失，才会否定 evaluate 足够覆盖的假设。

## 线 3：a11y 可指认性 / 消歧

### 仓内现状

- [实查] Vortex 的 target 契约是 CSS selector 或 `@ref`；MCP 入口主动拒绝 `text=`, `role=`, `label=`, `>>`, `:has-text()` 等 Playwright locator 语法。`/Users/lg/workspace/vortex/packages/mcp/src/lib/ref-parser.ts:36-67,105-150`
- [实查] observe 将原生 `<select>` 推断为 `combobox`，把显式 `[role]` 和原生表单控件放入候选池，`combobox` 位于召回角色集合。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:1227-1281,1295-1321`
- [实查] 页面侧 `getAccessibleName` 是启发式路径：先处理 `aria-label`、`aria-labelledby`、label 关联、placeholder/title，再根据可见文本、图标、控件 class 等兜底；名称统一截断到 80 字。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:1613-1654,1712-1799,1885-1918`
- [实查] 该启发式顺序不等于 AccName 规范顺序，而且自定义 `div[role=combobox]` 的显示文本可能同时成为页面侧名称和值：名称路径在 `text && !isContainer`，值路径由 `__ariaComboboxValue` 生成。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:1888-1901`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:2327-2374`
- [实查] CDP AX overlay 当前只覆盖主 frame；AX 返回非空 name 时覆盖启发式 name，AX 失败或超时则保留 heuristic role/name 并标记降级。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:4361-4395`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/observe-ax-overlay.ts:51-80,205-228`
- [实查] combobox/listbox 的 AX 子树会提取 option 样本和数量；原生 select 的当前选项、非原生 combobox 的显示文本分别走不同 value 逻辑。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:2327-2404`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/observe-ax-overlay.ts:260-307`
- [实查] ref 生成优先使用唯一 id、test id、唯一 aria-label；路径有多命中时写入 `data-vortex-rid`，运行时多命中会报 `SELECTOR_AMBIGUOUS`。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:1943-2048`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/dom.ts:701-710`
- [实查] 同 role+name 的重名元素只在祖先文本能够区分时补 `ctx`；空 name 的 snapshot 不生成 descriptor，descriptor 的 role+name 多命中会抛 `AMBIGUOUS_DESCRIPTOR`。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:3690-3773`; `/Users/lg/workspace/vortex/packages/extension/src/lib/resolve-target.ts:48-67`; `/Users/lg/workspace/vortex/packages/extension/src/reasoning/descriptor.ts:61-80`
- [实查] observe 的扫描预算为 20 秒，AX overlay 单独有 6 秒上限；AX overlay 超时会显式走 heuristic role/name，而不是让整次 observe 无界等待。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:4105-4125,4361-4395`

### 外部同类怎么做

- [实查] Playwright 官方推荐 `getByRole()`、`getByLabel()`、`getByPlaceholder()`、`getByAltText()`、`getByTitle()` 和 `getByTestId()`；role locator 通常带 accessible name，CSS/XPath 被放在脆弱的后备位置。每次 action 会重新按当前 DOM 定位，而不是长期持有旧节点。来源：<https://playwright.dev/docs/locators>（当前文档，2026-08-13 查阅）。
- [实查] Playwright locator 默认 strict：单元素操作匹配多个元素会报错；`first/last/nth` 可以显式选择位置，但官方提醒页面变化可能令位置指向错误元素。来源：<https://playwright.dev/docs/locators#strictness>（当前文档，2026-08-13 查阅）。
- [实查] Playwright `v1.62.1` 的 role engine 使用计算出的 accessible role/name；它把单选 `<select>` 映射为 `combobox`，多选或 `size>1` 映射为 `listbox`，并规范化空白后匹配 name。来源：<https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/injected/src/roleUtils.ts>、<https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/injected/src/roleSelectorEngine.ts>（v1.62.1，2026-07-30；2026-08-13 查阅）。
- [实查] 同一版本的 Playwright `allowsNameFromContent` 列表不包含 `combobox`；因此没有 author label/name 的自定义 `div[role=combobox]`，其普通可见后代文本不会按 button/link 那样自动成为 role locator 的 accessible name。来源：<https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/injected/src/roleUtils.ts>（v1.62.1，2026-07-30；2026-08-13 查阅）。
- [实查] WAI-ARIA 1.2 Recommendation 将 `combobox` 定义为 named input，`Name From: author`，且 `Accessible Name Required: True`；`aria-controls`、`aria-expanded` 和 value 是独立语义。来源：<https://www.w3.org/TR/2023/REC-wai-aria-1.2-20230606/#combobox>（WAI-ARIA 1.2，2023-06-06；2026-08-13 查阅）。
- [实查] AccName 1.2 的 2026-08-05 Working Draft 将 name computation 分为 `aria-labelledby`、`aria-label`、宿主语言 label、允许 name-from-content 的 role、tooltip/title 等步骤；如果没有有效来源，结果可以是空字符串。来源：<https://www.w3.org/TR/2026/WD-accname-1.2-20260805/>（W3C Working Draft，2026-08-05；2026-08-13 查阅）。
- [实查] HTML-AAM 2026-07-29 Editor's Draft 规定 labelable HTML 控件通过 label 关联映射；autonomous custom element 没有作者显式 conforming role 时通常映射为 generic。来源：<https://w3c.github.io/html-aam/>（W3C Editor's Draft，2026-07-29；2026-08-13 查阅）。
- [实查] Chromium 的 AX 数据模型把 role、name、value 和 `NameFrom` 分开保存；当前源码注释说明 nameless controls 通常不可访问，同时保留显式置空名称以表达合法去重或测试语义。来源：<https://chromium.googlesource.com/chromium/src/+/7251eb02edffe43c7ed9a65d578fdca307ba8c0f/ui/accessibility/ax_node_data.h>、<https://chromium.googlesource.com/chromium/src/+/7251eb02edffe43c7ed9a65d578fdca307ba8c0f/ui/accessibility/ax_enums.mojom>（Chromium commit `7251eb02edffe43c7ed9a65d578fdca307ba8c0f`，2026-08-13）。
- [实查] NVDA `2026.1.1` 的 IAccessible/UIA 适配器主要读取平台暴露的 `accName` / `UIA_NamePropertyId`，空值保持为空；组合框编辑子控件在父组合框已有 name 时会去重重复 label。来源：<https://github.com/nvaccess/nvda/releases/tag/release-2026.1.1>、<https://raw.githubusercontent.com/nvaccess/nvda/master/source/NVDAObjects/IAccessible/__init__.py>、<https://raw.githubusercontent.com/nvaccess/nvda/master/source/NVDAObjects/UIA/__init__.py>（NVDA `2026.1.1`，2026-05-20；源码 2026-08-13 查阅）。

### 代价与可行性

- [实查] Vortex 现在并不是单一命名源：页面注入层产生 heuristic name，主 frame 再叠加 CDP AX name；AX overlay 超时、子 frame 和某些 shadow 场景会走不同路径。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:1712-1918,4361-4395`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/observe-ax-overlay.ts:205-228`
- [推测] 若把页面侧 heuristic name 当成规范 accessible name，可能提高空名元素召回，但会制造与 Playwright role engine、Chrome AX tree 和 AT 平台 name 不一致的定位结果；若完全遵循 `combobox` 的 author-name requirement，custom combobox 的可指认性可能下降。对照依据：<https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/injected/src/roleUtils.ts>（v1.62.1，2026-07-30；2026-08-13 查阅）；<https://www.w3.org/TR/2023/REC-wai-aria-1.2-20230606/#combobox>（WAI-ARIA 1.2，2023-06-06；2026-08-13 查阅）；<https://www.w3.org/TR/2026/WD-accname-1.2-20260805/>（Working Draft，2026-08-05；2026-08-13 查阅）。
- [实查] `@ref` 在 name 为空时仍可直接寻址，但 snapshot 不能为它生成 descriptor；因此“当前快照能点到”与“重渲染后可按语义自愈”不是同一能力。`/Users/lg/workspace/vortex/packages/extension/src/lib/resolve-target.ts:48-67`; `/Users/lg/workspace/vortex/packages/extension/src/reasoning/descriptor.ts:61-80`
- [实查] open shadow 有专门的穿透扫描/解析路径，closed shadow 不在可见范围；定位体系还需要同时维护 light DOM selector、shadow resolver、AX overlay 和 descriptor heal。`/Users/lg/workspace/vortex/packages/extension/src/handlers/observe.ts:2479-2502`; `/Users/lg/workspace/vortex/packages/extension/src/page-side/shadow-walk.ts:1-50`; `/Users/lg/workspace/vortex/packages/extension/src/page-side/dom-resolve.ts:24-34`
- [推测] 消歧产物如果加入 `ctx`、nameSource、candidate count 或新的 locator 形态，会增加 observe 响应或 public schema 字节；当前 I15 上限为 10300 B，且仓内惯例是新增公开能力后测量并调整 cap，而不是默认压缩已有 description。`/Users/lg/workspace/vortex/packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:63-68,118-157`
- [实查] 如果在 page-side query/回读链路加入新的命名探针，还必须遵守“可 import 真源 + `executeScript({func})` 自包含内联副本”的双源约定；现有 schema query 已把这条约定写入源码。`/Users/lg/workspace/vortex/packages/extension/src/page-side/schema-readback.ts:1-13`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/query.ts:1646-1685`

### 什么证据能证伪它

- [推测] 在包含无名 native select、无 label 的 custom combobox、重复 role/name、跨 frame、open/closed shadow 的 fixture 矩阵中，如果现有 `@ref + ctx + valueNow` 已达到目标可定位率和错误目标率门槛，则继续扩大命名/消歧层的收益假设会被证伪。
- [推测] 如果补充的语义名提高了 recall，却显著增加 wrong-target、selector 多命中、descriptor 多命中或与 Chrome AX/Playwright 的 name disagreement，则会证伪“合成名称是净收益”的假设。外部计算口径：<https://raw.githubusercontent.com/microsoft/playwright/v1.62.1/packages/injected/src/roleUtils.ts>（v1.62.1，2026-07-30；2026-08-13 查阅）；<https://www.w3.org/TR/2026/WD-accname-1.2-20260805/>（2026-08-05；2026-08-13 查阅）。
- [推测] 如果 Playwright/Chrome AX 在无 author name 的 custom combobox 上实际给出稳定且一致的非空 name，将证伪“普通后代文本不能作为该控件 accessible name”的版本化判断；该判断当前只由 v1.62.1 源码和规范推导，尚未做浏览器运行时验证。
- [推测] 如果 AX overlay 的 6 秒预算、子 frame heuristic fallback 和 closed shadow 缺口在真实调用中不是主要的定位失败来源，而失败集中在页面业务状态或 stale ref，则单纯投入 a11y 命名不会解释主要错误样本。

## 线 4：WebMCP / Page.getAnnotatedPageContent

### 仓内现状

- [实查] 扩展是 MV3，声明了 `debugger`、`scripting` 等权限；后台创建单例 `DebuggerManager` 并注册 page/js/dom/observe/query handlers。`/Users/lg/workspace/vortex/packages/extension/manifest.json:1-19`; `/Users/lg/workspace/vortex/packages/extension/src/background.ts:29-47`
- [实查] `DebuggerManager` 用 `chrome.debugger.attach(..., "1.3")`，`sendCommand` 接受任意方法字符串并直接调用 `chrome.debugger.sendCommand`；但仓内 `.enable` 白名单只有 Accessibility、DOM、Network、Page、Runtime，不含 WebMCP。`/Users/lg/workspace/vortex/packages/extension/src/lib/debugger-manager.ts:79-110,113-170`; `/Users/lg/workspace/vortex/packages/extension/src/lib/cdp-domains.ts:12-31`
- [实查] 当前 `vortex_query mode=schema` 走 `chrome.scripting.executeScript` 读取 JSON-LD、Microdata、OGP，不走 APC 或 WebMCP。`/Users/lg/workspace/vortex/packages/extension/src/handlers/query.ts:1646-1685`; `/Users/lg/workspace/vortex/packages/extension/src/page-side/schema-readback.ts:69-86,136-185,224-250`
- [实查] 2026-08-13 的现有 spike 使用 Chrome `151.0.7922.110`、protocol 1.3 和裸 WebSocket CDP，明确不是 `chrome.debugger`。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:1-5`
- [实查] 该 spike 在裸 CDP 上观察到 `WebMCP.enable` 和 APC 命令可接受；空白页没有 WebMCP 事件，无法区分“没有页面工具”和“域没有功能”。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:20-38`
- [实查] 同一 spike 记录 APC base64 长度 57752、解码后 43314 B，约为 vortex observe 10248 B 的 4.2 倍；本轮还记录了没有 Chromium 内部 proto 解析入口这一限制。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:40-76`
- [实查] spike 的限制明确写出：裸 CDP 可调用不等于 `chrome.debugger` 可调用，WebMCP 实际功能和扩展通道两项都未验证。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:78-91`

### 外部同类怎么做

- [实查] CDP tip-of-tree 的 `Page.getAnnotatedPageContent` 是 Experimental，只针对 main frame，返回 base64 编码 protobuf；官方方法文档直接指出格式由 Chromium 的 `AnnotatedPageContent` message 定义，`includeActionableInformation` 默认 true。来源：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>（CDP tot，2026-08-13 查阅）。稳定 CDP 1.3 的 Page 方法列表没有该命令：<https://chromedevtools.github.io/devtools-protocol/1-3/Page/>（Stable 1.3，2026-08-13 查阅）。
- [实查] Chromium 当前公开源码中存在 `common_quality_data.proto` 的 `AnnotatedPageContent`、`ContentNode`、`Geometry`、`InteractionInfo` 等消息定义；因此“没有公开 proto 定义”已经不是当前事实，但“没有现成 TypeScript 解码 API”仍未由该源码自动推出。来源：<https://chromium.googlesource.com/chromium/src/+/main/components/optimization_guide/proto/features/common_quality_data.proto>（Chromium main，2026-08-13 查阅）；对应 CDP 文档：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>。
- [实查] CDP `WebMCP` domain 当前标为 Experimental，提供 `enable/disable`、`toolsAdded/toolsRemoved`、`invokeTool/cancelInvocation` 和 `toolInvoked/toolResponded`；`enable` 会为当前已注册工具触发 `toolsAdded`，tool output 被官方标为 untrusted 并提示 prompt injection 风险。来源：<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>（CDP tot，2026-08-13 查阅）。
- [实查] WebMCP 规范是 2026-08-12 的 Draft Community Group Report，不是 W3C Standard，也不在 W3C Standards Track；核心 API 是 `document.modelContext`，`tools` 是 Permissions Policy 控制的 feature，默认 allowlist 为 `self`。规范还把 browser-agent observation 定义为 implementation-defined，并只把 APC 作为可能的实现例子。来源：<https://webmachinelearning.github.io/webmcp>（Draft Community Group Report，2026-08-12；2026-08-13 查阅）。
- [实查] Chrome Status 在 2026-08-12 更新的 WebMCP 条目仍为 `Proposed`、`is_released:false`；条目记录 Origin Trial 为 M149-M156。2026-05-15 的 Chromium Intent 曾给出 M149-M156 Origin Trial、预计 M157 Shipping 的时间表。来源：<https://chromestatus.com/api/v0/features/5117755740913664>（更新 2026-08-12；2026-08-13 查阅）；<https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/OJxuQRP3AAAJ>（Intent，2026-05-15；2026-08-13 查阅）。
- [实查] Chrome 的 WebMCP implementation-status 在 2026-08-12 记录 Chrome M149 Origin Trial、Edge M150 Origin Trial，Firefox/Safari 仍是 standards-position/issue 阶段。来源：<https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md>（main，2026-08-13 查阅）。
- [实查] `chrome.debugger` 官方页面最后更新于 2026-01-07，restricted domains 清单包含 Page、DOM、Accessibility、Network、Runtime 等，但没有 WebMCP；API 的 `sendCommand` 要求 method 是远程调试协议定义的方法。来源：<https://developer.chrome.com/docs/extensions/reference/api/debugger>（Chrome Extension API，2026-01-07；2026-08-13 查阅）。
- [推测] 由于当前 `sendCommand` 是字符串透传且 Chromium Page/WebMCP backend 代码存在，APC/WebMCP 经扩展 debugger 具有“理论可达性”；但官方 restricted-domain 清单未列 WebMCP，且现有仓内 `.enable` guard 会先拒绝它，所以不能把裸 CDP 的成功外推为扩展通道成功。理论依据：<https://developer.chrome.com/docs/extensions/reference/api/debugger>（2026-01-07）；<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>、<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>（CDP tot，2026-08-13 查阅）。

### 代价与可行性

- [实查] APC 接入会落在 extension debugger/CDP 层而不是现有 page-side schema reader；当前 `Page` 已在仓内 enable 白名单，WebMCP 则不在白名单，直接走 `sendCommand` 与 `.enable` guard 是两条不同路径。`/Users/lg/workspace/vortex/packages/extension/src/lib/debugger-manager.ts:113-170`; `/Users/lg/workspace/vortex/packages/extension/src/lib/cdp-domains.ts:14-31`
- [实查] APC 当前观测样本的解码体积约为 observe 的 4.2 倍，且只测了一个页面；现有记录没有跨 channel、跨页面复杂度或扩展通道数据。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:51-60,78-84`
- [推测] APC 的硬成本包括 base64/二进制传输、protobuf 解码、Chrome 版本兼容和公开输出预算；公开 proto 定义降低了“无法知道字段”的障碍，但没有消除 Experimental 协议漂移和 decoder 维护成本。依据：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>、<https://chromium.googlesource.com/chromium/src/+/main/components/optimization_guide/proto/features/common_quality_data.proto>（CDP/Chromium main，2026-08-13 查阅）。
- [实查] WebMCP 不只是 readback：CDP tool 定义携带 frame/origin/schema/annotations，`invokeTool` 会执行页面注册函数，且 output 是 untrusted；规范还规定了 origin exposure 与 `tools` Permissions Policy。来源：<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>（CDP tot，2026-08-13 查阅）；<https://webmachinelearning.github.io/webmcp>（2026-08-12 draft，2026-08-13 查阅）。
- [推测] WebMCP 若进入 Vortex 的公开动作面，必须把 origin/frame、schema 校验、写操作确认、untrusted output 和导航后工具失效作为独立边界；不能把 `readOnly` annotation 当作权限证明，因为规范把它定义为 hint。依据：<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>、<https://webmachinelearning.github.io/webmcp>（CDP tot 2026-08-13 查阅；规范 2026-08-12）。
- [实查] 若把 WebMCP discovery/invoke 增加为新的 public MCP tool，会直接占用 I15 的 tools/list 预算；当前硬上限和工具数量断言见 `/Users/lg/workspace/vortex/packages/mcp/tests/invariants/I15.tools-list-budget.test.ts:129-157`。
- [实查] 现有 schema readback 采用 page-side 真源与 query 内联副本双源约定；若 APC/WebMCP 不可用时需要页面侧 fallback，fallback 仍受该自包含函数和 parity 约束。`/Users/lg/workspace/vortex/packages/extension/src/page-side/schema-readback.ts:1-13`; `/Users/lg/workspace/vortex/packages/extension/src/handlers/query.ts:1646-1685`

### 什么证据能证伪它

- [推测] 在目标 Chrome Stable/Edge 的真实扩展通道中，如果 `chrome.debugger.sendCommand` 对 `Page.getAnnotatedPageContent` 或 `WebMCP.enable` 返回 restricted-domain、method-not-found 或协议版本错误，则会证伪“裸 CDP 成功具有产品可达性”的假设。相关仓内调用路径：`/Users/lg/workspace/vortex/packages/extension/src/lib/debugger-manager.ts:79-110,163-170`; 外部协议：<https://developer.chrome.com/docs/extensions/reference/api/debugger>、<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>、<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>（分别为 2026-01-07、CDP tot；2026-08-13 查阅）。
- [推测] 在确实注册 WebMCP tool 的页面上，如果扩展通道不能稳定收到 `toolsAdded/toolsRemoved`、不能区分 frame/origin，或导航后工具生命周期无法闭合，则会证伪 WebMCP discovery 对当前 tab 架构可用的假设。事件与 origin 语义来源：<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>、<https://webmachinelearning.github.io/webmcp>（CDP tot 2026-08-13 查阅；规范 2026-08-12）。
- [推测] 如果 APC 在 Stable/Beta/Dev/Canary 的 decode failure、schema drift 或 payload p95 持续高于预算，且与现有 observe 的 actionable target overlap 没有稳定增益，则会证伪 APC 作为可持续观察源的假设。协议状态来源：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>（CDP tot，2026-08-13 查阅）。
- [推测] 如果真实页面中 WebMCP 注册覆盖率很低，或注册工具的 schema/description 与实际 side effect 经常不一致，即使调用成功也不能证明它比 AX/DOM 定位更少猜测；这会证伪“工具声明本身就是可靠业务 postcondition”的假设。规范安全与调用语义：<https://webmachinelearning.github.io/webmcp>、<https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/>（2026-08-12/2026-08-13）。
- [推测] 如果 `Schema.getDomains` 在后续 Chrome 版本仍漏报可用实验域或保留已废弃域，则任何以它作为完整能力矩阵的实现都会被再次证伪；现有 Chrome 151 记录已给出该现象。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:8-34`

## 被我推翻的既有判断

- [实查] “APC 没有公开 proto 定义/解析入口”需要拆成两句话：Chromium 当前公开的 CDP Page 文档已经指向 `common_quality_data.proto`，Chromium main 也公开了 `AnnotatedPageContent` 消息定义，因此“没有公开 proto 定义”已被推翻；当前仍能成立的较窄表述是“本次 spike 没有现成 TypeScript 解码器，且没有验证扩展通道”。证据：<https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getAnnotatedPageContent>、<https://chromium.googlesource.com/chromium/src/+/main/components/optimization_guide/proto/features/common_quality_data.proto>（Chromium/CDP，2026-08-13 查阅）；原记录：`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:66-81`
- [实查] “用 `Schema.getDomains` 建立完整能力矩阵”站不住：Chrome 151 的记录显示 WebMCP 不在清单但 `WebMCP.enable` 可接受，同时清单保留废弃域；因此能力探测必须以实际命令结果为准，不能把 domain 清单当完整事实源。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:8-38`
- [实查] “裸 CDP 命令可用即可说明 Vortex 能用”站不住：现有 spike 明确未经过 `chrome.debugger`，而 Chrome 官方 restricted-domain 清单当前未列 WebMCP；两者之间仍有未验证的扩展权限/通道边界。`/Users/lg/workspace/vortex/reports/external-baseline-2026-08/experimental-domains-probe.md:78-83`; <https://developer.chrome.com/docs/extensions/reference/api/debugger>（2026-01-07；2026-08-13 查阅）。
- [实查] “Phase 1 已经覆盖可泛化的多动作效果指纹”站不住：设计接口列出多种 action，但当前 `applyFingerprint` 和 `vortex_act` 守卫只对 click 建立 effect fingerprint；fill/type/select/scroll 的 micro-verify 存在，但尚未接入该 Phase 1 指纹输出。`/Users/lg/workspace/vortex/packages/shared/src/effect-fingerprint.ts:15-47`; `/Users/lg/workspace/vortex/packages/mcp/src/lib/fingerprint-apply.ts:19-45`; `/Users/lg/workspace/vortex/packages/extension/src/action/micro-verify.ts:27-50`
- [实查] 除以上条目外，本轮没有足够证据推翻 brief 背景中的其余已确认事实；没有为凑数添加新的判断。
