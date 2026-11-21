# 活校验缺陷清单 — 循环 `dogfood-history-2026-11-21`

> 循环类型：**原语轴 + 站点轴（最小一轮）**。
> 异常来源：① 原语轴按 `docs/audit-ledger.md` 推进的 `history` 审计；② 站点轴 `dogfood-rotation.mjs pick` 选 `quill`（`reports/dogfood-quill-2026-11-21/EVAL-BRIEF.md`）的 M3 真站运行。
> 四桶按 `docs/dogfood-cycle-sop.md` §2：**只有 `vortex-defect` 进修复**。

## 0. 桶定义

| 桶 | 判据 |
|---|---|
| `vortex-defect` | 纯 vortex 路径失败，且真值证明本应成功 |
| `m3-error` | 换纯 vortex 路径能成功 / 调用方自身错（参数名幻觉、陈旧 ref、路径绕过） |
| `site-issue` | 目标站自身问题 |
| `already-graceful-degradation` | vortex 正确拒绝并给出可执行指引 |

## 1. 站点轴：quill（`https://quilljs.com/`）

### 1.1 运行事实

| 项 | 值 |
|---|---|
| brief | `reports/dogfood-quill-2026-11-21/EVAL-BRIEF.md`（由 `dogfood-rotation.mjs pick --site quill` 渲染） |
| M3 运行 | 3 次，**均未产出 `anomalies.json`** ⇒ 站点轴的**产物级闭环未完成**：① 第一次会话被截断；② 第二次 M3 侧 `500 Internal server error`；③ 第三次在拷贝截图时被 opencode 权限拒绝（`The user rejected permission to use this specific tool call`）⇒ **全部是模型/代理侧失败，不是 vortex 机制失败**（第三次已真实驱动站点：`tab_create` → `wait_for` → `observe` → `act type` 三次 → 多次 `evaluate` 读真值 ⇒ **循环机制可执行 ✓**） |
| 可用的原始产物 | `reports/dogfood-quill-2026-11-21/m3-session.log`（44 KB，M3 的完整调用序列与返回） |
| 候选异常 | M3 在日志里对 Quill 编辑器执行 `act type` 后自述「内容被清空 / 没写进去」（值 `AAA111` / `BBB222` / `REPRO9`）⇒ 候选 **Q-1** |

### 1.2 Q-1 —— `act type` 到 Quill 编辑器「内容被清空」⇒ **m3-error**

| 步骤 | 内容 |
|---|---|
| 现象 | M3 对 `#snow-container .ql-editor`（ref `@233d:e35` / `@4fc7:e35`）连续 `act type`，自述文本没写进去、内容被清空 |
| 纯 vortex 复现 | **不成立**。`/tmp/vortex-quill-dast.mjs`（全新 tab `1166016270`、显式 tabId）：`act click` ⇒ `success:true`、`focusChanged:true`、DOM 真值 `active:true / activeTag:"ql-editor"`；`act type {value:"ZZZ"}` ⇒ `success:true, typed:3, path:"cdp-insertText"`；DOM 真值 `innerHTML = "<h1>ZZZ</h1>"`、`textLen 3` ⇒ **文本确实进了编辑器** |
| DOM 真值 | Quill 演示页初始态是一个 `<h1>` 标题，**光标落在标题内** ⇒ typing 替换标题文本 ⇒ 编辑器总文本从 676 字符变成 3 字符 ⇒ 「内容被清空」是 **Quill 初始态 + 光标位置**的正常结果，不是写入失败 |
| 桶 | **m3-error**（M3 用的是**陈旧 ref**（`@233d:e35` / `@4fc7:e35` 来自更早的快照）且把 Quill 的正常替换行为读成失败；纯 vortex 路径用当轮新 ref（`@8725:e0`）即可成功） |
| 证据等级 | A（真机 DAST 复现 + DOM 真值；DAST 脚本 `/tmp/vortex-quill-dast.mjs`） |

### 1.3 站点轴附带观察（不构成缺陷）

| 现象 | 桶 | 依据 |
|---|---|---|
| `observe {target:".ql-editor"}` 报 `SELECTOR_AMBIGUOUS: Selector matched 3 elements` | already-graceful-degradation | 工具明确告知匹配数与可改的选择器 ⇒ 正确拒绝 |
| M3 用 `fill` 写 contenteditable 时收到 `INVALID_TARGET: ... is contentEditable; use action "type" instead of "fill"` | already-graceful-degradation | 错误码 + 可执行指引（改用 type）⇒ 正确拒绝 |
| `observe` 返回 `# degraded: listener discovery failed ...` | already-graceful-degradation | 已声明结果部分可用并给出重试建议 |

## 2. 原语轴：`vortex_history`（back/forward）

### 2.1 审计对象

| 项 | 值 |
|---|---|
| 公开契约 | `packages/mcp/src/tools/schemas-public.ts:365-375`：`direction` 枚举 = `back` / `forward`（**没有 `go(index)`**） |
| 运行时 | `packages/extension/src/handlers/page.ts:140-170` `navigateHistory(debuggerMgr, tid, delta: -1|1)`：CDP `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` |
| 调用点 | `page.ts:283,291`（BACK/FORWARD 共用）；`packages/mcp/src/tools/dispatch.ts:44-47` 路由；`packages/cli/src/commands/page.ts:21,24` 同一 action ⇒ **修一处覆盖 MCP + CLI 两个方向** |
| 真机 DAST | `/tmp/vortex-history-dast.mjs`（全新 tab `1166016188`、显式 tabId、收尾 tab_close） |

### 2.2 D-HIST-1 —— 退到浏览器内部页历史项 ⇒ 裸 CDP 错误 ⇒ **vortex-defect**

| 步骤 | 内容 |
|---|---|
| 现象 | `vortex_history {direction:"back"}` 退到该 tab 的**第一条历史项**（`vortex_tab_create` 建的新标签页）时返回 `Error [JS_EXECUTION_ERROR]: {"code":-32000,"message":"Not allowed"}` + **通用 hint**（让人重试/换方法）⇒ 调用方无法分辨「浏览器拒绝恢复」与「vortex 自己坏了」⇒ 只会盲目重试 |
| 对照：同类结局另一种处理 | 栈顶 `forward` 越界 ⇒ `Error [NO_EFFECT]: Already at the newest entry in history; cannot go forward.` + hint「Load a page directly with vortex_navigate(url)」⇒ **同一类结局（无法前进/后退）两种处理、严重不对称** |
| 纯 vortex 复现 | **成立**（真机 DAST，第 5 步 `history_back_to_newtab`）：`filter` 不涉及；步骤 = 建 tab → 导航 A(`example.com`) → 导航 B(`iana.org`) → back(默认) → forward → forward(栈顶边界 ⇒ NO_EFFECT ✓) → back(回 A ✓) → **back(退到新标签页 ⇒ JS_EXECUTION_ERROR ✗)** |
| DOM 真值（URL 真值） | 目标历史项 = 该 tab 的**初始新标签页**（浏览器内部页，Chrome 拒绝 `Page.navigateToHistoryEntry` 导航到它）⇒ 失败后 URL 不变 |
| 桶 | **vortex-defect**（vortex 有能力把它翻译成结构化结局 + 可执行 hint —— 同函数的边界分支已经这么做了；现在却把裸 CDP 错误放出去 ⇒ 分类过泛） |
| 根因 file:line | `packages/extension/src/handlers/page.ts:163-165`（`Page.navigateToHistoryEntry` 无 catch）；分类发生在 `packages/extension/src/lib/router.ts:97-126`（非 `VtxError` ⇒ `JS_EXECUTION_ERROR`） |
| 证据等级 | **A**（真机 DAST 复现 + 服务端 sink 记录到同一次调用的 `JS_EXECUTION_ERROR`：`~/.vortex/logs/mcp-2026-11-21.jsonl`）+ 根因定位到 file:line |
| 影响面（已按两轮审核纠正口径） | 客户端 transcript 侧 `history` **1 次调用 / 0 错误** ⇒ **真实 agent 流量里尚未观测到**；快照聚合的 13 次里 12 次来自**本轮合成 DAST**（sink client = `vortex-history-dast@0.0.0`）⇒ 频次 = **缺测量**（补的尺子：服务端 sink 已开启 ⇒ 后续每周快照的 `sink` 源可给真实频次） |

## 3. 四桶分布（本轮）

| 桶 | 条数 | 条目 |
|---|---:|---|
| vortex-defect | **1** | D-HIST-1 |
| m3-error | 1 | Q-1（陈旧 ref + Quill 初始态误读） |
| site-issue | 0 | — |
| already-graceful-degradation | 3 | `SELECTOR_AMBIGUOUS` / `INVALID_TARGET`(contentEditable) / `observe` degraded 提示 |

⇒ **只有 D-HIST-1 进修复**（方案见 `fix-plan.md`，经两轮独立审核逐条处置）。

## 4. D-HIST-1 修复结论（2026-11-21）

**修法**（最小改动，只改共享一处 ⇒ 覆盖 MCP + CLI 两个方向）：

| 文件:行 | 改动 |
|---|---|
| `packages/extension/src/handlers/page.ts:164-196` | 只在 `Page.navigateToHistoryEntry` 一处包 try/catch；把 CDP 错误文本当 JSON 解析后**精确**比 `code === -32000 && message === "Not allowed"`；命中 ⇒ 抛 `vtxError(NO_EFFECT, …, { hint: HISTORY_RESTORE_REFUSED_HINT, recoverable: false })`；**不匹配 ⇒ 原异常对象原样抛回**（不吞错、不改分类） |
| `packages/extension/src/handlers/page.ts:198-219` | 新增 `isHistoryRestoreRefused()` / `isInternalPageUrl()`：只有当目标 entry 的 URL 确实是 `chrome:`/`edge:`/`about:` 时才补「目标是浏览器内部页」归因（对应审核 C7） |
| `packages/shared/src/errors.hints.ts:150-163,173` | 新增 `HISTORY_RESTORE_REFUSED_HINT`（I19：50~300 字符、含 next-action 动词与工具名）并登记进 `OVERRIDE_HINTS` ⇒ 受 I19/I20/I21 不变量扫描约束（审核 B3） |

**验证结果**（全部为实测；证据见 `Athena/tasks/20261121-01-vortex自主dogfood循环/验证.md`）：

| 判据 | 改前 | 改后 |
|---|---|---|
| 真机 DAST（`/tmp/vortex-history-dast.mjs`，断言化 + 非零退出） | **12/15 PASS**（拒绝分支仍报 `JS_EXECUTION_ERROR`） | **16/16 PASS**（拒绝分支 = `NO_EFFECT` + hint + 位置未变；且 buildStamp 与期望一致） |
| 服务端 sink 同一调用（`~/.vortex/logs/mcp-2026-11-21.jsonl`） | `errorCode:"JS_EXECUTION_ERROR"` | `errorCode:"NO_EFFECT"`（服务端真相） |
| bench case（suite B，本地 fixture，不依赖外网） | — | `contract/history-back-refused` **PASS**（13 calls，断言命中新拒绝分支，不是只断言错误码） |
| 单测（`packages/extension/tests/page-history-cdp.test.ts`） | 新断言 RED | GREEN（含负向用例：非匹配错误保持身份、同 code 不同 message 不翻译、attach/getHistory 失败不翻译） |
| `pnpm lint:errors` | 39 处违规（既有） | **输出逐字相同**（39 处）⇒ 本次未新增违规 |
| `pnpm ship:preflight` | Gate2 FAIL（既有） | **输出逐字相同** ⇒ 本次未新增门禁回归 |
| tools/list 字节 + sha256 | 24369 B / `daea76e2…` | **同值**（`packages/mcp/src` 逐字未改 ⇒ 工具面未触碰） |
| CodeQL（最终代码重建库） | — | 15 条（3 error + 12 warning，与上一轮基线同数），**改动文件命中 0** |
| semgrep（`/tmp/vortex-audit.yml`） | — | 改动文件命中 0 |

**影响面口径不变**：客户端 transcript 侧 `history` = 1 次调用 / 0 错误 ⇒ 真实 agent 流量里尚未观测到该失败；频次仍属**缺测量**，补的尺子 = 已开启的服务端 sink（每周快照的 `sink` 源）。本次修复解决的是**契约不对称**（同类结局两种处理），不是高频故障。

**未完成**：合并进 `main` / 推送（需用户授权）。
