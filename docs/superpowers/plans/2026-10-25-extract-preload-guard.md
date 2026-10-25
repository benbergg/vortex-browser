---
created: 2026-10-25
updated: 2026-10-25
status: draft
tags: [plan, vortex, extract, page-not-ready, hint]
---

# vortex_extract 注入前置依赖治理 + hint 修正 实施计划

**Goal:** 让 `vortex_extract`（`content.getText`）在**没有 selector** 时不再依赖 `dom-resolve` page-side 模块注入，从而消除本次 7 天日志分析中唯一确认的 Vortex 侧缺陷（5 次 `PAGE_NOT_READY` 全部命中"无 selector 的 extract"路径）；同时修掉 agent 永远看不到的 `context.extras` 悬空 hint 引用，并给注入超时补上可落盘的结构化证据。

**Architecture:** 改动集中在三处，彼此独立、可分别回滚：
1. `packages/extension/src/handlers/content.ts` —— GET_TEXT 的 page-side 预加载改为**按需**（只有解析出 `selector` 才注入 `dom-resolve`）。
2. `packages/shared/src/errors.hints.ts` + `packages/extension/src/adapter/page-side-loader.ts` —— hint 文案单一真源 + 去掉 agent 收不到的字段引用。
3. `packages/extension/src/adapter/page-side-loader.ts` + `packages/mcp/src/server.ts` —— 注入超时带结构化 `context.extras`，MCP 侧落一行 stderr。

**Tech Stack:** TypeScript / Chrome MV3（`chrome.scripting.executeScript`）/ vitest 2.1 / pnpm monorepo

**Spec（上游分析产物，本计划的唯一事实来源）:**
- `/tmp/vortex-analysis/FINAL-REPORT.md`（30.6K，主报告）
- `/tmp/vortex-analysis/review-codex.md`（codex 独立复核，首行 `独立性声明：作者族=MiniMax 复核族=codex 判定=独立复核`）
- 归档副本：`Athena/docs/superpowers/reports/2026-10-25-vortex-mcp-log-analysis-report.md`

**REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans**

---

## Global Constraints

- **一次只做一个 Task**，做完停下汇报，等评审通过再接下一个。
- **TDD 顺序不可颠倒**：先写测试 → **真跑出 RED** → 再改实现 → 跑出 GREEN。
- 只碰该 Task 的 **Files** 段列出的文件，要动别的**先问**。
- 跑测试**必须**限并发（`AGENTS.md:55`）：
  - 全包：`pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1`
  - 单文件：`pnpm --filter @vortex-browser/extension exec vitest run tests/<file>.test.ts --maxWorkers=2 --minWorkers=1`
  - shared 包同理换成 `@vortex-browser/shared`；mcp 包换成 `@vortex-browser/mcp`。
  - **禁止**根目录 `pnpm -r test`（`AGENTS.md:60`），`--minWorkers=1` 不可省。
- 提交遵循 Conventional Commits，中文描述，动词开头、结尾无句号，**禁止**署名；只 `git add` 本 Task 涉及的路径（工作区有大量无关未跟踪文件，**禁止** `git add -A`）。
- 代码注释用中文，只写「为什么」，不复述代码。
- **本轮不改业务语义**：除 Task 1 的"何时注入"外，GET_TEXT 的取值、截断、shadow 文本、include/attrs、scroll 行为一律不动。
- **本轮明确不做**（codex 复核结论：暂缓，见文末《暂缓清单》）：page-side-loader 内部重试、MCP 层自动重试、GET_HTML 的同款 guard 清理、MCP 入参 schema 校验、注入超时接入共享超时阶梯。
- **真机 DAST 是唯一真 bug 判据**（`docs/audit-ledger.md`）：未在真机复现的，只能写"静态去依赖，修复有效性待验证"，不得写成"已根治"。

## Review Focus（最易咬人的五个点，每条都配了对应测试）

1. **`selector` 的来源不止一个**：`content.ts:15` 的 `selector = __t?.selector ?? (args.selector as string|undefined)`，其中 `__t` 来自 `resolveTargetOptional(args)`（`packages/extension/src/lib/resolve-target.ts`），**index/@ref 路径会反查出 selector**。guard 若写成 `if (args.selector)` 就会误伤 ref 路径的 shadow 穿透。→ 对应 Task 1 Step 1 的「有 selector 仍注入」与「index 路径仍注入」两条断言。
2. **hint 有硬合同**（`packages/shared/tests/invariants/I19.error-hint-quality.test.ts` / `I20.no-removed-tool-names.test.ts`）：长度 50–300、必须含 next-action 动词、必须含公开工具名（`PUBLIC_TOOL_NAMES`，`vortex_observe`/`vortex_navigate` 在内，但 `vortex_get_html` 不在）。新增/改写 hint 一旦越界，**shared 包全量测试红**。→ 对应 Task 2 Step 1 的 hint 合同断言。
3. **hint 不能引用 agent 收不到的字段**：`context.extras` 只在 `VtxErrorPayload` 里（`packages/shared/src/protocol.ts`），而 MCP 渲染层 `formatDispatchError`（`packages/mcp/src/lib/dispatch-error.ts:13-32`）与 `formatError`（`packages/mcp/src/server.ts:81-87`）**都不输出 context** ⇒ agent 只拿到 `Error [CODE]: message\nHint: hint`。任何"去看 context.extras"的文案都是死路。→ 对应 Task 2 Step 1 的新不变量 I21。
4. **测试必须是真实 dispatch，不是源码正则**：现有 `content-extract-include.test.ts` / `content-extract-maxlength.test.ts` / `content-extract-scroll.test.ts` 全是读 `content.ts` 源码做正则匹配，**改一下注释就能骗过它们**。codex 明确要求"用真实 handler dispatch 验证"。→ Task 1 的新测试必须 `new ActionRouter()` + `registerContentHandlers(router)` + `router.dispatch(...)`，只 mock `chrome.*`。
5. **fake timer 与永不 settle 的 promise**：`page-side-loader` 的超时靠 `Promise.race`（`packages/extension/src/adapter/page-side-loader.ts`），测试里**不能** `await` 一个永不 settle 的 promise（会挂死 vitest），必须 `pending.catch(e => e)` 后用 `vi.advanceTimersByTimeAsync(3000)` 推进，且推进量必须与 `INJECT_TIMEOUT_MS = 3000` 对齐。→ Task 1 Step 1 的两条「永不 settle」用例。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/extension/src/handlers/content.ts` | 改。GET_TEXT 的 page-side 预加载改为按需（`if (selector)`）。 |
| `packages/extension/src/adapter/page-side-loader.ts` | 改。超时 hint 改用 shared 常量；超时错误补 `context.extras` 结构化字段。 |
| `packages/shared/src/errors.hints.ts` | 改。JS_EXECUTION_ERROR / INTERNAL_ERROR hint 去 `context.extras`；新增 `PAGE_NOT_READY_INJECT_HINT` 并登记进 `OVERRIDE_HINTS`。 |
| `packages/mcp/src/server.ts` | 改。工具错误出口对 `PAGE_NOT_READY` 落一行结构化 stderr。 |
| `packages/extension/tests/content-get-text-preload.test.ts` | **新建**。GET_TEXT 预加载按需化的真实 dispatch 回归测试。 |
| `packages/extension/tests/page-side-loader-error-extras.test.ts` | **新建**。注入超时错误的 hint 与 `context.extras` 契约测试。 |
| `packages/shared/tests/invariants/I21.no-dangling-context-refs.test.ts` | **新建**。任何 agent 可见 hint 不得引用 `context.extras`。 |

---

## Task 1 —— GET_TEXT 的 page-side 预加载按需化

**Files:**
- Modify: `packages/extension/src/handlers/content.ts`（`:35` 附近）
- Create: `packages/extension/tests/content-get-text-preload.test.ts`

**Interfaces:**
- Consumes:
  - `registerContentHandlers(router: ActionRouter): void`（`packages/extension/src/handlers/content.ts:8`）
  - `ActionRouter.dispatch(request: NmRequest): Promise<NmResponse>`（`packages/extension/src/lib/router.ts`）
  - `NmRequest { type: "tool_request"; tool: string; args: Record<string, unknown>; requestId: string; tabId?: number; strictTab?: boolean }`（`packages/shared/src/protocol.ts:112`）
  - `loadPageSideModule(tabId: number, frameId: number | undefined, module: PageSideModule): Promise<void>`（`packages/extension/src/adapter/page-side-loader.ts`）
  - `ContentActions.GET_TEXT === "content.getText"`（`packages/shared/src/actions.ts:58`）
- Produces: 无新导出。**行为契约**：无 `selector` 的 `content.getText` **不**触发 `files: ["page-side/dom-resolve.js"]` 注入；有 `selector`（含 index/@ref 反查出的）时**仍**先注入再执行 func。

**为什么这样改（根因，已源码级确认）:** 注入的 func 只有在 `sel` 非空时才用 `window.__vortexDomResolve.queryDeep(sel)`（`content.ts:208-210`）；`sel` 为空时 root 取 `document.body`（`:210`），open shadow 文本由 `collectShadowText` 自己遍历 `el.shadowRoot` 拿（`:225-241`），**不依赖 dom-resolve 模块**。而 `:35` 的预加载是无条件硬失败：`files` 注入 3s 不 settle 就抛 `PAGE_NOT_READY`，把一次本可成功的 extract 打断。近 7 天 5 次 `PAGE_NOT_READY` **全部**落在无 selector 的 extract 上。

- [ ] **Step 1: 写失败测试**（新建 `packages/extension/tests/content-get-text-preload.test.ts`，真实 dispatch）
  - 用 `vi.resetModules()` + 动态 `import`（同 `packages/extension/tests/page-side-loader-inject-timeout-code.test.ts` 的做法，避免 `instanceof` 因模块重复求值而失效）。
  - mock `globalThis.chrome`：`scripting.executeScript`、`tabs.onRemoved.addListener`、`webNavigation.onCommitted.addListener`（loader 订阅用），必要时 `tabs.get`。
  - `executeScript` mock 按调用形状分流：**带 `files`** 的（loader 注入）返回 `[{ result: undefined }]`；**带 `func`** 的（正文注入）返回 `[{ result: { result: "TEXT" } }]`。
  - 用例：
    1. **无 selector**：`router.dispatch({ type:"tool_request", tool:"content.getText", args:{}, requestId:"r1", tabId: 1 })` ⇒ `executeScript` **恰好 1 次**，且该次调用**有 `func`、无 `files`**；`resp.error` 为空。
    2. **有 selector**：`args: { selector: ".x" }` ⇒ `executeScript` **2 次**：第 1 次含 `files: ["page-side/dom-resolve.js"]` 且 `world: "MAIN"`，第 2 次含 `func`。
    3. **index/@ref 路径不误伤**：`args: { index: 0, snapshotId: "s1" }`（`resolveTargetOptional` 能反查出 selector 的形态；若 store 未就绪而拿不到 selector，则至少断言**不抛错**且不出现 `files` 注入）——按 `resolve-target.ts` 的真实行为写断言，不要臆造。
    4. **空字符串 selector**：`args: { selector: "" }` ⇒ 无 `files` 注入（空串不是有效选择器，走 body 路径）。
    5. **核心回归：预加载挂死不再拖垮 extract**：`files` 注入 mock 永不 settle（`new Promise(() => {})`）+ 无 selector ⇒ dispatch 在 3s 内正常返回文本（**不**抛 `PAGE_NOT_READY`）；fake timer 推进 `vi.advanceTimersByTimeAsync(3000)` 期间不得出现 `TIMEOUT` 信封。
    6. **有 selector 时的失败不吞**：`files` 注入永不 settle + 有 selector ⇒ 仍抛 `PAGE_NOT_READY`（证明只是"不再无谓依赖"，不是"把错误藏起来"）。
  - 跑：`pnpm --filter @vortex-browser/extension exec vitest run tests/content-get-text-preload.test.ts --maxWorkers=2 --minWorkers=1`
- [ ] **Step 2: 跑出 RED**（用例 1/4/5 必须红；用例 2/6 必须绿）
- [ ] **Step 3: 最小实现**
  - `packages/extension/src/handlers/content.ts:35` 改为按需注入，并把原因写进中文注释：注入的 func 只在有 `selector` 时用 `window.__vortexDomResolve`，无 selector 时 root 取 `document.body`、shadow 文本由 `collectShadowText` 自遍历，**不需要 dom-resolve**；预加载是无条件硬失败，会让本可成功的 extract 被注入超时打断。
  - **不要**动 `:38` 之后的 func、截断、include/attrs、scroll、alt 逻辑。
- [ ] **Step 4: 跑出 GREEN**（新文件 + 既有 `content-extract-shadow-text.test.ts` / `content-extract-include.test.ts` / `content-extract-maxlength.test.ts` / `content-extract-scroll.test.ts` / `extract-img-alt.test.ts` 全绿）
- [ ] **Step 5: 提交** `fix(extension): extract 无 selector 时不再预加载 dom-resolve 模块`

---

## Task 2 —— agent 可见 hint 修正（去掉 `context.extras` 悬空引用）

**Files:**
- Modify: `packages/shared/src/errors.hints.ts`（`JS_EXECUTION_ERROR` hint、`INTERNAL_ERROR` hint、新增 `PAGE_NOT_READY_INJECT_HINT` + `OVERRIDE_HINTS` 登记）
- Modify: `packages/extension/src/adapter/page-side-loader.ts`（超时 hint 改用 shared 常量）
- Create: `packages/shared/tests/invariants/I21.no-dangling-context-refs.test.ts`
- Create: `packages/extension/tests/page-side-loader-error-extras.test.ts`

**Interfaces:**
- Consumes:
  - `vtxError(code, message, context?, override?): VtxError`（`packages/shared/src/errors.hints.ts:348`，第 4 参是 `Partial<VtxErrorMeta>`，可下发 `hint`）
  - `OVERRIDE_HINTS: Record<string, string>`（`packages/shared/src/errors.hints.ts:107`）—— 现有惯例：导出具名常量（`ANCESTOR_HIT_HINT` 等）并在该表登记，供 I19/I20 扫描。
  - `PUBLIC_TOOL_NAMES`（`packages/shared/src/public-tools.ts`）
- Produces:
  - `export const PAGE_NOT_READY_INJECT_HINT: string`（`packages/shared/src/errors.hints.ts`），并在 `OVERRIDE_HINTS` 里以键 `PAGE_NOT_READY_INJECT_HINT` 登记。
  - loader 抛出的 `PAGE_NOT_READY` 的 `extra.hint` **恒等于** `PAGE_NOT_READY_INJECT_HINT`（单一真源）。

**为什么这样改:** `JS_EXECUTION_ERROR` 的 hint 让 agent "Inspect the error message in context.extras"，但 MCP 渲染层根本不输出 context（见 Review Focus 3）⇒ 实测里 agent 只拿到 `Unexpected token ')'`，没有行号也没有栈。`INTERNAL_ERROR` 同病。

- [ ] **Step 1: 写失败测试**
  - `packages/shared/tests/invariants/I21.no-dangling-context-refs.test.ts`：扫描 `DEFAULT_ERROR_META` + `OVERRIDE_HINTS` 的每个 hint，断言 **不含** `context.extras`（不变量说明要写清：agent 只能看到 `Error [CODE]: message` + `Hint:`）。
  - 同文件加一条：新增的 `PAGE_NOT_READY_INJECT_HINT` 长度 50–300、含 next-action 动词（`call`/`retry`/`verify`…）、含的工具名必须在 `PUBLIC_TOOL_NAMES` 内（用 `vortex_navigate`、`vortex_observe`，**不要**用 `vortex_get_html`）。
  - `packages/extension/tests/page-side-loader-error-extras.test.ts`：
    1. `files` 注入永不 settle ⇒ 3s 后错误 `code === PAGE_NOT_READY`、`extra.hint === PAGE_NOT_READY_INJECT_HINT`（用 shared 同一份常量比较）、`extra.recoverable === true`。
    2. hint 文案里**不含** `context.extras`，且**不含** "retry" 之外的"保证成功"式承诺（不写"重试一定成功"）。
    3. hint 提到 `vortex_observe`（该失败下 observe 路径仍可用，`packages/extension/src/handlers/observe.ts:1100` 对同类预加载是软失败）。
    4. **保留既有 message 形态**：`packages/extension/tests/page-side-loader-inject-timeout-code.test.ts` 断言 message 含 `dom-resolve` 与 `SW/navigation` ⇒ 本 Task **不得**改 message，只改 hint。
- [ ] **Step 2: 跑出 RED**（shared 包 I21 红；extension 新文件红）
- [ ] **Step 3: 最小实现**
  - `packages/shared/src/errors.hints.ts`：
    - `JS_EXECUTION_ERROR.hint` 改成不引用 `context.extras`、且点明"错误原文就在 message 里"（例：`Injected JavaScript threw an error. The message above carries the JavaScript error (a SyntaxError shows the offending token); fix the argument and retry the same call.`）——必须同时满足 I19 的动词 + 关键词（`argument` 命中关键词表）与长度区间。
    - `INTERNAL_ERROR.hint` 同样去掉 `context.extras`（保留"重试 + 检查 MCP 状态"的语义，关键词可用 `state`）。
    - 新增 `export const PAGE_NOT_READY_INJECT_HINT = "..."`，并登记进 `OVERRIDE_HINTS`。
  - `packages/extension/src/adapter/page-side-loader.ts`：把内联 hint 字符串替换为 `PAGE_NOT_READY_INJECT_HINT`（从 `@vortex-browser/shared` 导入）。
- [ ] **Step 4: 跑出 GREEN**（`pnpm --filter @vortex-browser/shared test -- --maxWorkers=2 --minWorkers=1` + extension 同法，含 I19/I20 全量）
- [ ] **Step 5: 提交** `fix(hint): 移除 agent 收不到的 context.extras 引用，注入超时 hint 常量化`

---

## Task 3 —— 注入超时的结构化证据（MCP 侧落一行 stderr）

**Files:**
- Modify: `packages/extension/src/adapter/page-side-loader.ts`（超时错误补 `context.extras`）
- Modify: `packages/mcp/src/server.ts`（工具错误出口对 `PAGE_NOT_READY` 落 stderr）
- Create: `packages/extension/tests/page-side-loader-error-extras.test.ts`（与 Task 2 共用同一文件，断言补 `extras`）

**Interfaces:**
- Consumes:
  - `VtxErrorContext`（`packages/shared/src/errors.ts`）—— `context.extras` 是 `unknown`，可放任意结构化字段。
  - hub 会**原样转发**扩展的 `frame.error`（`packages/hub/src/router.ts:385`）⇒ `context` 能到 MCP 层。
  - MCP 工具错误出口：`packages/mcp/src/server.ts:932-940`（`if (resp.error) return { isError: true, content: [{ type:"text", text: formatDispatchError(resp.error) }] }`）。
- Produces:
  - `PAGE_NOT_READY` 错误的 `context.extras` 形如 `{ module: string; tabId: number; frameId: number | null; timeoutMs: number }`。
  - MCP 进程 stderr 出现一行 JSON：`{"vortex":"page_not_ready","module":...,"tabId":...,"frameId":...,"timeoutMs":...}`。

**为什么做:** 7 天日志分析里最大的取证缺口是"**服务端没有原始日志**"——`~/.vortex/run/hub-<port>.log` 只在启动时写一行（`packages/hub/src/main.ts:32`），工具级错误零落盘，导致所有根因判断只能靠客户端 transcript 转述。本 Task 用最小改动补上这一条证据链（不改 hub 路由、不动 hub 启动流程）。

- [ ] **Step 1: 写失败测试**
  - extension：注入超时 ⇒ `err.extra.context?.extras` 含 `module`/`tabId`/`frameId`/`timeoutMs`（`frameId` 无则 `null`）。
  - mcp：构造一个 `resp.error` 为 `PAGE_NOT_READY` 的场景，断言该工具调用**除了**返回 `isError` 文本外，还向 stderr 写了一行可 `JSON.parse` 的 JSON（含 `module`/`tabId`/`timeoutMs`）；非 `PAGE_NOT_READY` 的错误**不**写这行（避免噪音）。
- [ ] **Step 2: 跑出 RED**
- [ ] **Step 3: 最小实现**
  - loader：`vtxError(VtxErrorCode.PAGE_NOT_READY, msg, { extras: { module, tabId, frameId: frameId ?? null, timeoutMs: INJECT_TIMEOUT_MS } }, { hint: PAGE_NOT_READY_INJECT_HINT, recoverable: true })`。
  - mcp：在 `:932` 那个错误出口加一个窄分支（**只**判 `resp.error.code === "PAGE_NOT_READY"`），`console.error(JSON.stringify({ vortex: "page_not_ready", ...(resp.error.context?.extras as object) }))`，**不**把 extras 混进给 agent 的文本（agent 文本形态保持不变）。
- [ ] **Step 4: 跑出 GREEN**（extension + mcp 两包全量）
- [ ] **Step 5: 提交** `feat(observability): 注入超时带结构化 extras，MCP 侧落一行 stderr`

---

## 验收标准

### 离线单测（本轮必须全绿）
- `pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1`
- `pnpm --filter @vortex-browser/shared test -- --maxWorkers=2 --minWorkers=1`
- `pnpm --filter @vortex-browser/mcp test -- --maxWorkers=2 --minWorkers=1`
- 断言点清单（对应原报告 T1–T7）：
  - T1 无 selector 的 extract **不**触发 files 注入（真实 dispatch）。
  - T2 有 selector 的 extract **仍**触发 files 注入（shadow 穿透不回退，保住 PR #62 ca785eb 的行为）。
  - T3 index/@ref 路径不误伤。
  - T4 files 注入永不 settle 时，无 selector 路径仍成功返回；`TIMEOUT` 计数不增加。
  - T5 有 selector 时 `PAGE_NOT_READY` 仍照旧抛出（错误不被吞）。
  - T6 所有 agent 可见 hint 不含 `context.extras`（新不变量 I21）。
  - T7 `PAGE_NOT_READY` 错误的 hint 与 `PAGE_NOT_READY_INJECT_HINT` 单一真源一致，且不含未公开工具名。

### 真机 DAST（按 `docs/audit-ledger.md`，必须原版先复现）
- **前置**：在**未打补丁**的版本上复现 `PAGE_NOT_READY`（每种触发条件 ≥20 次冷态对照）⇒ 复现不出来，就只能写"静态去依赖，修复有效性待验证"。
- **对照**：同一 tab、同一次导航后，files 注入与 func 注入各做 30 次配对。
- **门槛**：修后累计 ≥300 次独立冷态调用 0 次 `PAGE_NOT_READY` **且** 0 次 `TIMEOUT`（0/300 的 95% 上界约 1%），单次 extract 总耗时不劣化。
- **必须同时数 `TIMEOUT` 与总耗时**：因为"去掉 files 注入后，func 注入变成该 tab 的第一次注入，若底层诱因是注入顺序，风险会平移到 func 挂 ⇒ 变成 router 20s `TIMEOUT`"（codex 复核的明确警告）。

---

## 暂缓清单（本轮明确不做，理由与触发条件）

| 项 | 暂缓理由 | 重新评估触发条件 |
|---|---|---|
| page-side-loader 超时后内部重试一次 | codex：不推荐——loader 服务多模块；最坏 6.3–6.8s；`Promise.race` 不取消原 `executeScript` ⇒ 迟到重叠；无亚秒退避恢复证据 | 拿到 DAST 证据证明"同 tab 同参数重试可在亚秒内恢复" |
| MCP 层自动重试工具调用 | 会放大副作用（act/fill 幂等性未知） | 有工具幂等性清单后 |
| GET_HTML（`content.getHTML`）同款 guard 清理 | `vortex_get_html` 默认不在 `PUBLIC_TOOLS`（`registry.ts:77-84` 不可调用）⇒ 改它无用户可见收益 | 该工具重新公开时 |
| MCP 层按 schema 校验入参（`server.ts:236-245`） | 属另一族问题（agent 用法错），且会改变错误码语义 | 与"客户端 schema 校验"方案一起评估 |
| 注入超时接入 `shared/timeout.ts` 阶梯 | codex：未证实"3s 是唯一脱离阶梯的硬编码"，`docs/inner-timeout-budget-approach.md:19` 认可局部 3s | 出现第二个同类硬编码时 |
| `~/.codex/config.toml` 的 `approval_policy` 冲突 | 属**客户端配置**，不在 Vortex 仓内 | 交由用户在本机改（10 个 vortex 工具的 `approval_mode = "approve"` 与全局 `approval_policy = "never"` 冲突） |
| hint 加"重试通常成功" | codex 不建议（无证据支撑成功率） | DAST 拿到重试成功率数据 |

---

## 执行方式

- 实现者：**herdr + mcode（`minimax/MiniMax-M3.1-Flash`）**，Task 1 → Task 2 → Task 3 **串行**（同一 checkout 只有一个写代理）。
- 复核者：**herdr + codex（`gpt-6.1-sol`）**，每个 Task 一个 fresh 会话，首行必须输出
  `独立性声明：作者族=MiniMax 复核族=codex 判定=独立复核`。
- 集成：父会话逐 Task 核对 reviewer 首行声明行 + 实际模型（`Model used` 字段），再合并。
- 提交落在 vortex 仓的功能分支上，**不 push**、**不动 `main`**。
