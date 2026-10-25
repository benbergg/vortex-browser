---
created: 2026-10-25
updated: 2026-10-25
status: done
tags: [vortex, extract, page-not-ready, hint, report]
---

# vortex_extract 预加载治理 + hint 修正 —— 实施报告

- 计划：`docs/superpowers/plans/2026-10-25-extract-preload-guard.md`（仓库内）
- 上游分析：`Athena/docs/superpowers/reports/2026-10-25-vortex-mcp-log-analysis-report.md`（7 天日志分析主报告）
- 仓库 / 分支：`/Users/lg/workspace/vortex` · `feat/extract-preload-guard`（基线 `main@f226f08`）
- 提交范围：`76bca37 … dc990a9`（8 个提交，含 1 个计划文档提交）

## 1. 目标

按 7 天日志分析的结论，首轮实施三件互相独立、可分别回滚的事：

1. `vortex_extract`（`content.getText`）在**无 selector** 时不再预加载 `dom-resolve` page-side 模块（去掉一处无谓依赖）。
2. 修掉 agent 可见 hint 里指向**永远收不到**的 `context.extras` 的悬空引用。
3. 给注入超时补上结构化证据（`context.extras` + MCP 侧一行 stderr JSON）。

**证据等级**：历史 5 次 `PAGE_NOT_READY` 全部落在"无 selector 的 extract"上，这只能证明**相关性**；本轮是**静态去依赖**，真机修复效果**待 DAST 验证**，底层诱因**未定性**。

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

## 4. 测试结果

| 包 | 结果 | 备注 |
| --- | --- | --- |
| `@vortex-browser/extension` | 294 文件 / 2735 测试全绿 | 含新增 `content-get-text-preload.test.ts`、`page-side-loader-error-extras.test.ts` |
| `@vortex-browser/shared` | 14 文件 / 460 测试全绿 | 含 I19 / I20 / 新增 I21 |
| `@vortex-browser/mcp` | 77 文件通过 / 2 文件失败（11 项） | 失败为 `tests/wire-timeout-per-action.test.ts`、`tests/client-hello-handshake.test.ts`，日志明确 `listen EPERM: operation not permitted 0.0.0.0` ⇒ **本沙箱环境限制**，不判回归；codex 侧沙箱同样复现 |

命令一律为 `pnpm --filter @vortex-browser/<pkg> test -- --maxWorkers=2 --minWorkers=1`（仓库 AGENTS.md 禁止根目录 `pnpm -r test`）。

## 5. 本轮明确未做（留待后续，非遗漏）

- **真机 DAST**：未做。这是判定"真 bug"的铁律（`docs/audit-ledger.md`）——原版必须先复现，再做 ≥30 对冷态配对与 ≥300 次独立冷态 0 错，并**同时**统计 `TIMEOUT` 与总耗时（去掉 files 注入后 func 可能成为首次注入，风险可能**平移**成 router 20s `TIMEOUT`）。
- **loader 内部重试**（超时后重试一次）：codex 判定**暂不推荐**（多模块共用、最坏 6.3–6.8s、fake-timer 测试会悬等、`Promise.race` 不取消原 `executeScript` 造成迟到重叠、缺亚秒退避恢复证据）。
- **MCP 层入参 schema 校验**（`server.ts` 的 `CallToolRequestSchema` 无入参校验）：暂缓。
- **`GET_HTML`（`content.getHTML`）同款无条件预加载**：该工具不在 `PUBLIC_TOOLS`，不可调用，本轮不改。
- **注入超时接入共享超时阶梯**、**`3000ms` 与 `INJECT_TIMEOUT_MS` 自动绑定**：暂缓。
- **在 `~/.vortex/run/` 写 JSONL 文件 sink**：暂缓（见 Task 3 边界说明）。

## 6. 证据等级声明

- 本轮全部改动是**静态改动**：静态链路与单测已核实，**真机触发效果与生产留存未验证**。
- 不得据此宣称"已根治注入挂死""已降低失败率""已达成 DAST 门槛"。
- 历史 5 次 `PAGE_NOT_READY` 与"无 selector 路径"是**相关性**；底层诱因（files 注入为何 >3s 不 settle）**未定性**。

## 7. 后续建议（优先级）

1. **P0 真机 DAST**（唯一能把"静态去依赖"升级为"已修复"的路径）：先在未打补丁的版本上复现 `PAGE_NOT_READY`，再按冷态配对 + 300 次独立冷态的门槛验收；统计口径必须含 `TIMEOUT` 与总耗时。
2. **P1 客户端配置**：`~/.codex/config.toml` 的全局 `approval_policy = "never"` 与 10 个 vortex 工具的 `approval_mode = "approve"` 冲突，是 7 天里 2 次"MCP tool call requires approval"的直接原因（客户端配置缺陷，不是 Vortex 缺陷）。
3. **P1 MCP 层入参校验**：让 `act` / `mouse_click` 的 `required` 与枚举在服务端拦截，把 agent 侧误用（如 `what` 写成 `action`、`mouse_click` 传 `ref`）变成点名参数的错误。
4. **P2 失败重试策略**：agent 侧 100% 原样重试、零退避；服务端目前对 `PAGE_NOT_READY` **零自动重试**（`client.ts` 只重试 throw 的传输错误）。是否需要在 `vortex_navigate` 之外提供"退避后重试同一调用"的显式手段。
5. **P2 持久化证据**：若 DAST 需要服务端侧证据留档，按 `~/.vortex/run/` 写 JSONL（并定义轮转与写失败降级）。

## 8. 协作与独立性

- 调研与实现：Herdr + `mcode`（`minimax/MiniMax-M3.1-Flash`），角色分离为日志取证 / 源码根因 / 证据缺口三路 + 三路实现。
- 独立复核：Herdr + `codex`（`gpt-6.1-sol`），**跨族**（作者族 MiniMax、复核族 codex）⇒ 独立复核成立；每轮均给出首行声明、阻塞/建议/已核实三段式结论。
- 实现者与复核者均未 push、未改 `main`；所有提交都落在 `feat/extract-preload-guard` 分支。
