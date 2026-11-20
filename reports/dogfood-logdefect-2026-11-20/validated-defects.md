# 活校验缺陷清单 — 日志驱动周期 `dogfood-logdefect-2026-11-20`

> 周期类型：**日志驱动**（不是站点评测周期）。
> 异常来源：`reports/_eval/baseline/2026-11-20-week-2026-11-20.{json,md}` 一周窗口（窗口 2026-11-13 → 2026-11-20）的原始 transcript 重算
> （`scripts/usage-baseline/extract.mjs` 口径，四源 claude/pi/codex/sink）。
> 本文件按 `docs/dogfood-cycle-sop.md` §2 的四桶归类；每条都带 file:line 与证据等级。
> **没有跑站点评测**，所以本周期不做 `dogfood-rotation.mjs record` 记账（避免制造站点评测事实）。

## 桶定义（SOP §2）

| 桶 | 判据 | 本周期处置 |
|---|---|---|
| `vortex-defect` | 纯 vortex 路径复现失败且真值证明本应成功 | 进修复（本轮 3 条） |
| `m3-error` | 换纯 vortex 路径能成功 / 调用方自身错 | 不修 |
| `site-issue` | 目标站自身问题 | 不修 |
| `already-graceful-degradation` | vortex 正确拒绝 | 不修 |

## 四桶归类结果（本周窗口 = 2026-11-13 → 2026-11-20）

| 编号 | 现象（证据） | 桶 | 证据等级 | file:line | 本轮处置 |
|---|---|---|---|---|---|
| D-1 | `vortex_debug_read` 公开 schema 未声明运行时真支持的 `pattern` / `includeResources`；`filter` 传字符串时被 `Object.assign` 静默丢弃，随后报 "pattern is required"（错误指向错字段） | **vortex-defect** | A（真机 DAST 复现 + 单测 RED/GREEN） | `packages/mcp/src/tools/schemas-public.ts:316-345`；`packages/mcp/src/tools/dispatch.ts:283-318` | **已修**（本轮） |
| D-1b | `vortex_debug_read {source:"request", reqid:"<不存在>"}` 报 `INTERNAL_ERROR`（应为"查无此记录"类错误码，且 hint 未给出合法调用形状） | **vortex-defect** | A（真机 DAST 复现） | `packages/extension/src/handlers/network.ts:479-506` | **已修**（新增 `REQUEST_NOT_FOUND`） |
| D-2 | `scripts/usage-baseline/collect.mjs` 的 `browserRoute()` 只在 `src === "claude"` 分支被调用 ⇒ `routes.vortex` 恒等于 Claude 源调用数，Pi/Codex 源恒 0 | **vortex-defect**（度量缺陷） | A（单测 RED/GREEN + 同窗口前后对比） | `scripts/usage-baseline/collect.mjs:60-65` | **已修**（按源计路由） |
| D-3 | 客户端 schema 拒绝 48 次（参数类型/枚举不符，客户端本地拒绝，未进服务端） | m3-error | A（transcript 统计） | — | 不修（客户端侧） |
| D-4 | `vortex_evaluate` 参数名幻觉（`expression` vs `code`） | m3-error | A | — | 不修 |
| D-5 | `TAB_NOT_FOUND` 8 次（tab 已被关闭/换页） | already-graceful-degradation | A | — | 不修 |
| D-6 | 目标站返回错误页 | site-issue | A | — | 不修 |
| D-7 | 无匹配浏览器（扩展未连接/浏览器被关） | already-graceful-degradation | A | — | 不修 |

## 证据等级

- **A**：真机 DAST 复现（含"改前复现 + 改后证伪"两边），或可执行单测的 RED→GREEN。
- **B**：仅统计证据（transcript 计数），无真机复现。
- **C**：SAST/文档推断。

本轮 D-1 / D-1b / D-2 全部为 A。
