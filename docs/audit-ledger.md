# vortex 白盒原语审计台账

Ralph-loop 跨轮状态锚点。每轮:① 读本文件 + `git log` 定下一个**尚未审计**的原语；② 审计；③ 更新「审计记录」表与「连续无 bug 计数」。

---

## 方法·铁律（每轮必守）

1. **甄别公开可达面**：白盒读 handler + dispatch + 公开 schema。MCP 派发不可达的 legacy handler **不算缺陷**。
2. **SAST**：Semgrep（`/tmp/vortex-audit.yml`）+ CodeQL（security-extended，对当前源重建 DB）。
3. **DAST 复现才算真 bug**：候选必须用真扩展隔离 tab（`active:false` + 钉 `tabId`）实机复现。报告命中、SAST 命中**默认不可信**。
4. **有 bug**：TDD RED → GREEN → build → DAST 复验 → `git-commit` skill 提交 → 开 PR。**连续无 bug 计数清零**。
5. **无 bug**：如实记 clean，计数 +1。
6. **不臆造防御代码**，mock 过 ≠ 验证完成。build 后若 MCP 断连，先等重连再复验。

**停止条件**：连续无 bug 计数 ≥ 10 时，输出 `<promise>AUDIT SWEEP CLEAN</promise>`。

---

## 连续无 bug 计数：0

> `fill_form` clean(计数曾 +1);本轮 `wait_for` 发现真 bug(custom 模式隐藏 tab rAF 冻结挂死),计数归零。**2026-11-21：审计 `history` 发现真 bug（退到浏览器内部页历史项 ⇒ 裸 CDP "Not allowed" 冒泡成 JS_EXECUTION_ERROR，栈顶 forward 边界却是 NO_EFFECT ⇒ 同类结局两种处理），计数仍为 0**。下一个候选原语：`drag`（或 `file_upload`/`sequence`/`resize`——24 个公开工具面里尚未审计的）。

## 待办 backlog（非当前原语，独立迭代）

- **测试假阳(P3,预存)**：`storage-list-keys.test.ts` / `js-evaluate-host-object-serialize.test.ts` 的「源码不引用模块函数」source-lock 用 `fn.toString().not.toMatch(/summarizeStorage|normalizeEvaluateResult/)`，正则误匹配 func 内**注释**里的同名标识符（func 实际已正确内联、不调模块函数）→ 假阳失败。无产品影响。修法：正则改为匹配「调用」形态（如 `/\bsummarizeStorage\s*\(/`）而非裸标识符。
- **vitest 扫 worktree(P3)**：`.claude/worktrees/*` 被纳入 test 扫描，陈旧副本制造大量假失败。vitest config 应 exclude `**/.claude/**`。

## 审计记录

| 原语 | 结论 | PR / commit | 日期 |
|---|---|---|---|
| query | 已审（详见 git log / memory） | — | 2026-06 |
| screenshot | 已审 | — | 2026-06 |
| storage | 已审 | — | 2026-06 |
| file_upload | 已审 | — | 2026-06 |
| navigate | 已审 | — | 2026-06 |
| evaluate | 已审 | — | 2026-06 |
| network（GET_REQUEST_DETAIL 编码） | bug → 修复 | PR #61 `1578e2e` | 2026-06-20 |
| extract（GET_TEXT 漏 open shadow 文本） | bug → 修复 | PR #62 `ca785eb` | 2026-06-20 |
| console（GET_LOGS level='all' 哨兵） | bug → 修复 | PR #63 `040cf71` | 2026-06-20 |
| fill_form | **clean**（部分成功语义对称、DAST 双向证实无假成功/假失败） | — | 2026-06-20 |
| wait_for（custom 隐藏 tab rAF 冻结挂死） | bug → 修复 | PR 待开 | 2026-06-20 |
| history（back 退到浏览器内部页 ⇒ 裸 CDP 错误） | bug → 修复（待审核/实施，循环 `dogfood-history-2026-11-21`） | PR 待开 | 2026-11-21 |

---

## 日志驱动的根因登记（2026-10-30 一周日志分析）

窗口 2026-10-23 21:30 → 2026-10-30 21:30（本地时间）。数据源：Claude Code transcript + Pi 会话（521 次调用，41 次错误，7.9%），抽取器 `scripts/usage-baseline/collect.mjs`（三源 + vortex 自身 sink），快照 `reports/_eval/baseline/2026-10-30-week-2026-10-30.json`。
分析报告：`Athena/docs/superpowers/reports/2026-10-30-vortex-week-log-diagnosis-report.md`。

| 编号 | 现象 | 复现 | 根因 | 证据 | 修复 | 回归结论 |
|---|---|---|---|---|---|---|
| L-01 | `evaluate` 超时（10 次，占错误 22%）：预算序列 5/60/45/40/55/5/45/30/40/5 秒（非单调），累计预算 330s、实测累计耗时 ≈5.69 分钟 | 9 次是 loki 查询类调用（8 次多步串行 `await fetch(...)` 扫描 + 1 次同步查询表达式），1 次是 SQL 编辑器执行 + sleep 取文本 | extension 的 `js.evaluate*` 超时文案硬编码且**方向相反**（“set shorter timeout / vortex_navigate 清 tab”）；且 evaluate 走 handler 自管超时，**绕过 action 层已有的四态 liveness 归因** | transcript 逐条还原（10 次超时的调用代码与 timeout 值）；`packages/extension/src/handlers/js.ts` 超时分支 | 文案移入 `packages/shared/src/errors.hints.ts` 的 `EVALUATE_TIMEOUT_HINT`（拆任务 / 按需加预算 / tab 不响应时换页），不再断言页面存活；并补上超时后活性探测（复用 `lib/liveness-probe.ts` 300ms 预算），按 page-alive / page-unresponsive / probe-failed / tab-gone 给不同 hint，结论写进 `context.extras.liveness` | 单测 `packages/extension/tests/js-evaluate-timeout.test.ts`（7 例：hint 恒等、page-alive / tab-gone 两态、旧文案不出现）；I19/I21 不变量扫描通过；extension 全量 2737 pass；**真机 DAST**（真实 Chrome + 本地页面）：page-alive → 拆任务 hint，page-unresponsive → 主线程被占 hint（`probe-failed`/`tab-gone` 两态与 OOPIF 一致性仍未真机验证） |
| L-02 | hub 收到非法 JSON（客户端发 Python repr 的 `"tabId":None`）时返回 **HTML + 内部堆栈**（含 node_modules 绝对路径与请求体片段） | `POST /api/js/evaluate` body=`{"code":"1","tabId":None}` → HTTP 400，body 是 `text/html` 栈页面 | `express.json()` 没有错误中间件，body-parser 的 `entity.parse.failed` 落到 Express 默认错误处理 | 真机 curl（status=400，content-type=text/html，含 `body-parser` 栈） | 新增 `packages/hub/src/json-body-error.ts` + 注册在路由之后；只接管已知 body-parser 错误类型（parse.failed→400、too.large→413），不泄栈、不回显请求体 | 单测 `packages/hub/tests/json-body-error.test.ts`（JSON 形状 / 无栈 / 无请求体 / 正常请求不受影响） |
| L-03 | 客户端 schema 校验拒绝（14 次，占错误 30%）：`data/tabId must be number`、`data/async must be boolean`、`data/maxLength must be number`、`data/depth must be number` | agent 传 `tabId:"984536681"`、`async:"true"`、`maxLength:"20000"`、`depth:"4"` | **客户端**按 vortex 发布的 strict schema 校验，请求**根本没到服务端**；vortex 侧看不到这类失败（也无 sink 可看）。按源归类：**14 次全部来自 Pi 客户端**（Pi 20 次错误里占 14；Claude Code 26 次错误里 0 次）—— 严格程度是客户端差异，不是所有客户端的共同约束 | transcript 里调用原值 + 同一格式也出现在 playwright MCP（“data must have required property 'action'”），证明是客户端通用校验逻辑；vortex 源码内无该文案；按源错误构成统计 | **本轮不改 schema**（缺客户端 `anyOf` 兼容证据 + 受益面仅严格校验客户端；改公开契约还要同步处理 `computeSchemaHash` 不覆盖 schema 形状的盲点）。方案见报告 §4-A，先查客户端能否放宽/关闭校验 | 未修（待客户端兼容验证） |
| L-04 | `navigate` TAB_NOT_FOUND（2 次）：调用时 tab 已不可用，vortex 零自愈 | 旧 tabId 在调用时已失效 | 与上一轮同一类：MCP 侧只重试传输层 throw，`resp.error` 形式的业务错误不重试 | 上一轮报告已登记，本周复现 | 未修（证据够但属能力面改动，需单独设计） | 未修 |
| L-05 | 结构性缺口：诊断只能反解 agent transcript，换客户端就要重做解析器，且拿不到服务端真相 | 本轮三源抽取器写了 400+ 行适配 | vortex 无自身使用/错误 sink | 本轮抽取器工作量即成本证据 | 新增 `packages/mcp/src/usage-log.ts`（默认关，`VORTEX_USAGE_LOG=1` 开启；只记长度与错误码；写盘失败不影响调用；保留 14 天）+ `docs/usage-log.md` | 单测 `packages/mcp/tests/usage-log.test.ts`；抽取器新增 `sink` 源可直读。**2026-11-21 实测闭合**：sink 真实落盘 `~/.vortex/logs/mcp-2026-11-21.jsonl`（21 行），基线快照 `2026-11-21-week-2026-11-21-sink.json` 的 `perSource[sink]` = 21 calls / 15 ok / 6 errors ⇒ 服务端真相已可直接读（注意坑：`StdioClientTransport` 默认只透传安全白名单 env，客户端必须显式注入 `VORTEX_USAGE_LOG=1` 才会开） |

