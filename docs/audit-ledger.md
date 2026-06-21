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

> `fill_form` clean(计数曾 +1);本轮 `wait_for` 发现真 bug(custom 模式隐藏 tab rAF 冻结挂死),计数归零。下一个候选原语：`history`（back/forward/go，CDP Page.navigateToHistoryEntry 边界）或 `query`。

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
