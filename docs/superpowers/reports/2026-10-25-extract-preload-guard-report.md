---
created: 2026-10-25
updated: 2026-10-25
status: done
tags: [vortex, extract, page-not-ready, hint, report, dast]
---

# vortex_extract 预加载治理 + hint 修正 —— 实施报告

- 计划：`docs/superpowers/plans/2026-10-25-extract-preload-guard.md`（仓库内）
- 上游分析：`Athena/docs/superpowers/reports/2026-10-25-vortex-mcp-log-analysis-report.md`（7 天日志分析主报告）
- 仓库 / 分支：`/Users/lg/workspace/vortex` · `feat/extract-preload-guard` → 已合并 `main`（merge commit `88173cc`）
- 提交范围：`76bca37 … dc990a9`（9 个提交，含 1 个计划文档提交）+ `560c36e` 报告 + 本次 DAST 结果补充提交
- ⚠️ merge commit 的标题写的是「真机 DAST 待验证」——**该 DAST 已于同日完成**，见第 5 节。

## 1. 目标

按 7 天日志分析的结论，首轮实施三件互相独立、可分别回滚的事：

1. `vortex_extract`（`content.getText`）在**无 selector** 时不再预加载 `dom-resolve` page-side 模块（去掉一处无谓依赖）。
2. 修掉 agent 可见 hint 里指向**永远收不到**的 `context.extras` 的悬空引用。
3. 给注入超时补上结构化证据（`context.extras` + MCP 侧一行 stderr JSON）。

**证据等级（初版）**：历史 5 次 `PAGE_NOT_READY` 全部落在"无 selector 的 extract"上，这只能证明**相关性**；本轮是**静态去依赖**，真机修复效果**待 DAST 验证**，底层诱因**未定性**。
**证据等级（本版，已含真机 DAST）**：见第 5 节结论——在"主线程忙"这一触发条件下，补丁把无 selector 路径的 `PAGE_NOT_READY` 从 100% 复现降到 0/300；但**底层诱因未根治**，风险以 20s `TIMEOUT` 形态**平移**。

## 2. 实际改动

### Task 1 —— GET_TEXT 预加载按需化

- 提交：`5e4d461`（实现）、`f174e47`（复核返工）
- 文件：
  - `packages/extension/src/handlers/content.ts:35` —— `await loadPageSideModule(tid, frameId, "dom-resolve")` 改为 `if (selector) await ...`（守卫用**解析后**的 `selector`，覆盖 index/@ref 反查路径）。
  - `packages/extension/tests/content-get-text-preload.test.ts`（新增，445 行）—— 真实 `ActionRouter.dispatch` + `registerContentHandlers`，只 mock `chrome.*`；每例 `vi.resetModules()` 避免 loader 的 `loadedModules` 缓存造成假绿。
- 行为边界：无 selector 路径**仍然执行** MAIN world 的 inline func 注入，只是不再 `files` 预加载；有 selector 的调用序列与改前完全一致（files → func）。

### Task 2 —— agent 可见 hint 修正

- 提交：`162d9b6`（实现）、`dcaae71`（复核返工）
- 文件：
  - `packages/shared/src/errors.hints.ts` —— 去掉 5 条 hint 里的 `context.extras` 悬空引用（`JS_EXECUTION_ERROR` / `INTERNAL_ERROR` / `UNSUPPORTED_TARGET` / `COMMIT_FAILED` / `ACTION_FAILED_ALL_PATHS` / `NO_MATCHING_OPTION` / `NAVIGATION_FAILED`）；新增 `export const PAGE_NOT_READY_INJECT_HINT` 并登记进 `OVERRIDE_HINTS`（此前 extension 内联写死同一段文案，绕过 I19/I20 扫描）。
  - `packages/extension/src/adapter/page-side-loader.ts` —— 注入超时改用 shared 常量；**message / 超时时长 / 竞速 / 缓存驱逐 / `recoverable` 全部未变**。
  - `packages/shared/tests/invariants/I21.no-dangling-context-refs.test.ts`（新增）—— 扫两张表 + 扫 extension/mcp/hub 源码里的**内联 hint 字面量**，禁止 `context.extras` / `extras.<field>` / `lastReason` / "see the context" 等把 agent 指向不可见字段的措辞。
  - `packages/shared/src/errors.ts` —— 仅注释：`context.extras` 是结构化载荷字段，**当前 MCP 错误文本不渲染它**（CLI 会渲染）。
  - `packages/extension/tests/page-side-loader-error-extras.test.ts`（新增）—— 永不 settle mock + 2999/3000ms 边界 + hint 恒等于 shared 常量 + `recoverable` + 计时器清理。

### Task 3 —— 注入超时的结构化证据

- 提交：`36d604c`（实现）、`dc990a9`（复核返工）
- 文件：
  - `packages/extension/src/adapter/page-side-loader.ts` —— 超时错误带 `context.extras = { module, tabId, frameId, timeoutMs }`（`frameId` 缺省为 `null`，`0` 是合法值不误判）。
  - `packages/mcp/src/server.ts` —— `handleCallTool` 收到 `PAGE_NOT_READY` 且 extras 形状合法时，向 **stderr** 输出一行 JSON：**字段白名单**（`module`/`tabId`/`frameId`/`timeoutMs`）+ 固定字段（`vortex`/`source`/`ts`/`code`，**不被 extras 同名键覆盖**）；多余键（如 `selector`/`message`）一律不输出。
  - `packages/mcp/tests/agent-visible-errors.test.ts`（新增）—— spy `process.stderr.write`，断言单行合法 JSON、字段集合精确、agent 可见文本与 `isError` 逐字未变。
- 边界：只有**普通单工具出口**写证据行；sequence 步骤（`server.ts:815`）与 observe 专用出口（`:604-607`）**未覆盖**（observe 侧该预加载是软失败，`.catch(() => {})`）。
- **留存边界**：stderr 是否被持久保存取决于 MCP 客户端对子进程 stderr 的处理，本项目**未内置日志文件 sink**，客户端侧留存行为**本轮未验证**。在 `~/.vortex/run/` 另写 JSONL 并不需要改 hub（本轮只是没做）。

## 3. 独立复核（codex / gpt-6.1-sol，跨族）

| 轮次 | 对象 | 结论 | 报告 |
| --- | --- | --- | --- |
| Task 1 | `5e4d461` | 有条件通过（2 阻塞：证据等级越级断言、报告错误描述） | `/tmp/vortex-analysis/review-impl-1-codex.md` |
| Task 1 返工 | `f174e47` | （并入 Task 1 轮） | 同上 |
| Task 2 | `162d9b6` | **不通过**（2 阻塞：`UNSUPPORTED_TARGET` / `JS_EXECUTION_ERROR` 的 hint 对错误原文做了不成立的承诺） | `/tmp/vortex-analysis/review-impl-2-codex.md` |
| Task 2 返工 | `dcaae71` | **通过** | `/tmp/vortex-analysis/review-impl-2-codex-round2.md` |
| Task 3 | `36d604c` | 有条件通过（1 验收条件：不得宣称"已稳定落盘"） | `/tmp/vortex-analysis/review-impl-3-codex.md` |
| Task 3 返工 | `dc990a9` | **通过** | `/tmp/vortex-analysis/review-impl-3-codex-round2.md` |

每份报告首行均为 `独立性声明：作者族=MiniMax 复核族=codex 判定=独立复核`（作者 MiniMax 族、复核 codex 族 ⇒ **跨族独立复核成立**）。

**被复核推翻的我方表述**（留档，避免后人重犯）：
- "5/5 重试即成功"不成立（有两组同参重试继续失败，恢复靠 navigate / 参数变化 / 等待）；
- "12:13:25 的 observe 证明 func 注入在坏态下正常"不成立（该 observe 仅 1.276s 返回，且 codex 那次是**另一个 tab**）；
- `TAB_NOT_FOUND` 的 tabId **确实在原 tab_list** 里，是"旧 tabId 失效、消失原因未定"，不是"agent 捏造"。

## 4. 测试结果（离线）

| 包 | 结果 | 备注 |
| --- | --- | --- |
| `@vortex-browser/extension` | 294 文件 / 2735 测试全绿 | 含新增 `content-get-text-preload.test.ts`、`page-side-loader-error-extras.test.ts` |
| `@vortex-browser/shared` | 14 文件 / 460 测试全绿 | 含 I19 / I20 / 新增 I21 |
| `@vortex-browser/mcp` | 77 文件通过 / 2 文件失败（11 项） | 失败为 `tests/wire-timeout-per-action.test.ts`、`tests/client-hello-handshake.test.ts`，日志明确 `listen EPERM: operation not permitted 0.0.0.0` ⇒ **本沙箱环境限制**，不判回归；codex 侧沙箱同样复现 |

命令一律为 `pnpm --filter @vortex-browser/<pkg> test -- --maxWorkers=2 --minWorkers=1`（仓库 AGENTS.md 禁止根目录 `pnpm -r test`）。

## 5. 真机 DAST（本机最小复现，已完成）

### 5.1 环境与方法

- **真实浏览器**：本机 Microsoft Edge（用户日常浏览器，Vortex 扩展以 unpacked 方式加载仓库 `packages/extension/dist`）。Vortex MCP（stdio）经 hub `127.0.0.1:6800` 驱动真实页面。
- **驱动方式**：自写 stdio JSON-RPC 客户端 `dast-run.mjs`（不经过 LLM），直接调 `vortex_tab_create` / `vortex_extract` / `vortex_tab_close`。
- **冷态定义**（每轮独立）：**新起本地 http server 随机端口**（= 新 origin ⇒ 新 SW / 新缓存域）+ **新开后台 tab**（`active:false`）+ 页面加载后**第一次**调用即 `vortex_extract`。
- **触发条件构造**：页面内做 N ms 同步忙等（模拟真实 SPA 的重渲染 / 长任务占住主线程）。N=0 为正常页面对照组。
- **对照组**：同一脚本、同一浏览器，分别在**原版**（`git checkout f226f08 -- packages/extension/src/handlers/content.ts` + 重建扩展，dist stamp `4.1.0+mvn9yf1u`）与**补丁版**（`main`，dist stamp `4.1.0+mvna4wgi`）上跑。
- 原始数据：`/tmp/vortex-analysis/dast/*.jsonl`（每行一次调用的 `isError` / 错误码 / 耗时 / 正文摘要）。

### 5.2 结果

| 场景 | 版本 | n | 首次 extract 失败 | 失败码 | 首次耗时（中位） | 第二次调用 |
| --- | --- | --- | --- | --- | --- | --- |
| busy 8s | 原版 | 30 | **30/30** | `PAGE_NOT_READY` | ~3.05s（硬切超时） | 27/30 仍 `PAGE_NOT_READY` |
| busy 25s | 原版 | 10 | **10/10** | `PAGE_NOT_READY` | ~3.04s | 10/10 仍失败 |
| 正常页 | 原版 | 30 | 0/30 | — | ~0.11s | 0 错 |
| busy 8s | **补丁** | 30 | **0/30** | — | ~8.14s（等主线程忙完，正文正确） | 0 错，~50ms |
| busy 8s | **补丁补跑** | 270 | **0/270** | — | ~8.14s | 0 错 |
| busy 25s | **补丁** | 10 | **10/10** | `TIMEOUT` | ~23.8s | 0 错（缓存已热） |
| 正常页 | 补丁 | 30 | 0/30 | — | ~0.09s | 0 错 |
| 带 selector（open shadow） | 补丁 | 5 | 0/5 | — | ~0.11s | 正文含 `shadow-visible-text` |

**触发条件下合计 300 次独立冷态（30 + 270）：0 错** ⇒ 原版在该条件下 100% 失败（30/30），补丁 0/300，95% 置信上界 ≈ 1%。

`busy 25s` 的补丁行为值得单独看：错误从"3s 硬切的 `PAGE_NOT_READY`（文案说'tab 处于坏的 SW/导航态'，实际是主线程被占住）"变成"20s 预算耗尽的 `TIMEOUT`（`Action content.getText exceeded its 20000ms budget`，hint 明确说**页面主线程被阻塞**）"。语义更正确（终于指向真因），但**不是零成本**：耗时从 3s 变成 20s。

### 5.3 结论（可对外表述的版本）

1. **在"主线程忙"这一触发条件下，补丁确实消除了无 selector 路径上的 `PAGE_NOT_READY`**：原版 30/30 必现，补丁 300/300 不现。这把第 1 节的"相关性"升级为"**该条件下错误被消除**"。
2. **底层诱因未根治**：files 注入在主线程忙时依然会 >3s 不 settle，**有 selector 的路径仍会踩**（本次未在 selector + busy 组合上单独统计，属已知缺口）。
3. **风险以 `TIMEOUT` 形态平移**：极端忙（>20s）时错误形态改变、耗时变长。codex 在复核时提出的这一顾虑已被**实证**，不是推测。
4. **未根治 `files` 注入挂死本身**——那需要 loader 层自愈（codex 判定**暂不推荐**：多模块共用、最坏 6.3–6.8s、fake-timer 测试会悬等、`Promise.race` 不取消原 `executeScript`、缺亚秒退避恢复证据）。
5. **未覆盖**：真实业务站（bytenew smartscene 等）的原始触发窗口未复现；只在本机 Edge + 本地合成 busy 页面 + 单浏览器上做过；"真站同条件 P95 劣化 ≤10%"与"scroll 单独预算"两条耗时门槛**未测**（无真站样本）。

### 5.4 对照 codex 验收门槛

| codex 门槛 | 结果 |
| --- | --- |
| 先在原版复现 | ✅ 原版 busy 8s 30/30 `PAGE_NOT_READY` |
| files 首次 vs func 首次各自独立冷态配对 ≥30 对 | ✅ 原版 30（files 首次）vs 补丁 30（func 首次），各自独立 origin/tab/SW |
| 修后每模式连续 30 次 0 错 | ✅ busy 8s 30/30、正常页 30/30、selector 5/5 |
| 累计 ≥300 次独立冷态 0 错 | ✅ 触发条件下 300/300 |
| 同时统计 `PAGE_NOT_READY`/`TIMEOUT`/`JS_EXECUTION_ERROR`/正文缺失 | ✅ 统计口径含 `TIMEOUT` 与正文长度；**`JS_EXECUTION_ERROR` 0 次** |
| 耗时门槛（本地非 scroll fixture <3s） | ✅ 正常页 ~0.09s；busy 场景单列（8.1s / 23.8s） |
| 真站同条件 P95 劣化 ≤10%、scroll 单独预算 | ❌ 未测（无真站样本） |
| 原版复现不出来就只能写"静态去依赖" | ✅ 已复现，可写更强结论 |

## 6. 本轮明确未做（留待后续，非遗漏）

- **loader 内部重试**（超时后重试一次）：codex 判定**暂不推荐**（多模块共用、最坏 6.3–6.8s、fake-timer 测试会悬等、`Promise.race` 不取消原 `executeScript` 造成迟到重叠、缺亚秒退避恢复证据）。
- **MCP 层入参 schema 校验**（`server.ts` 的 `CallToolRequestSchema` 无入参校验）：暂缓。
- **`GET_HTML`（`content.getHTML`）同款无条件预加载**：该工具不在 `PUBLIC_TOOLS`，不可调用，本轮不改。
- **注入超时接入共享超时阶梯**、**`3000ms` 与 `INJECT_TIMEOUT_MS` 自动绑定**：暂缓。
- **在 `~/.vortex/run/` 写 JSONL 文件 sink**：暂缓（见 Task 3 边界说明）。
- **`content.getText` 预算 20s 的调参**：DAST 显示 20s 是"主线程被占住"的合理上界表达，但 20s 对 agent 偏长，属独立议题。

## 7. 证据等级声明

- 单测与静态链路：**已核实**。
- 真机行为：**已验证**（第 5 节），但只覆盖"主线程忙"这一合成触发条件、单浏览器、本地页面。
- 不得据此宣称"已根治注入挂死""已把失败率降到 0"；准确表述是"**已消除无 selector 路径在该触发条件下的 `PAGE_NOT_READY`；files 注入挂死本身未根治，风险以 20s `TIMEOUT` 形态平移**"。
- stderr 证据行的**持久留存**未验证（无内置 sink）。

## 8. 后续建议（优先级）

1. **P0 决定是否做 loader 自愈**：若接受 20s `TIMEOUT` 形态，则本轮可收口；若要根治，需专门设计（并推翻 codex 对 loader 重试的暂缓意见），代价与回归面见第 6 节。
2. **P1 客户端配置**：`~/.codex/config.toml` 的全局 `approval_policy = "never"` 与 10 个 vortex 工具的 `approval_mode = "approve"` 冲突，是 7 天里 2 次"MCP tool call requires approval"的直接原因（客户端配置缺陷，不是 Vortex 缺陷）。
3. **P1 MCP 层入参校验**：让 `act` / `mouse_click` 的 `required` 与枚举在服务端拦截，把 agent 侧误用（如 `what` 写成 `action`、`mouse_click` 传 `ref`）变成点名参数的错误。
4. **P2 真站 DAST 补测**：在真实业务站上补 P95 劣化与 scroll 预算两条门槛，并把 `selector + busy` 组合纳入统计（有 selector 路径仍会踩 files 注入）。
5. **P2 失败重试策略**：agent 侧 100% 原样重试、零退避；服务端目前对 `PAGE_NOT_READY` **零自动重试**（`client.ts` 只重试 throw 的传输错误）。是否需要提供"退避后重试同一调用"的显式手段。
6. **P2 持久化证据**：若需要服务端侧证据留档，按 `~/.vortex/run/` 写 JSONL（并定义轮转与写失败降级）。

## 9. 协作与独立性

- 调研与实现：Herdr + `mcode`（`minimax/MiniMax-M3.1-Flash`），角色分离为日志取证 / 源码根因 / 证据缺口三路 + 三路实现。
- 独立复核：Herdr + `codex`（`gpt-6.1-sol`），**跨族**（作者族 MiniMax、复核族 codex）⇒ 独立复核成立；每轮均给出首行声明、阻塞/建议/已核实三段式结论。
- 真机 DAST 由主会话在用户本机真实浏览器上执行（脚本化、可复算），原始数据留存于 `/tmp/vortex-analysis/dast/`；测试期间只开后台 tab 并逐轮关闭，结束后核对浏览器 tab 列表无残留。
- 实现者与复核者均未 push、未改 `main`；所有提交先落在 `feat/extract-preload-guard`，合并到 `main` 与 push 由主会话在复核通过后执行。
