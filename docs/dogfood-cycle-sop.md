# Dogfood Cycle SOP — Claude 校验承重闸门

> 配套 `.claude/commands/dogfood-cycle.md`（编排）+ `reports/_dogfood/`（脚手架）。
> 本文档把历史上反复印证的「Opus 活浏览器白盒校验」固化为可执行 SOP。

## 一句话

M3（opencode）自主跑评测产出 `anomalies.json`，**默认不可信**。Claude 的唯一职责是用 vortex 工具在清洁新 tab 逐条复现，把每条异常归入四桶之一，只有 `vortex-defect` 才进入修复。

## 0. 浏览器串行铁律

- M3 与 Claude 共用同一个 vortex-server(6800) → 同一个 Chrome，**无法并发**。
- Claude 接手校验**前**必须确认 M3 子进程已退出（`run-opencode-eval.mjs` 阻塞返回即代表退出）。
- 校验前 `vortex_tab_list` 确认无 M3 残留 tab；每条异常复测都开**全新 tab**，测完关掉（防 page-side 缓存漂移，0008 实证）。

## 1. 摄取 + 旁路自动筛查（零浏览器成本，先跑）

读 `anomalies.json`，逐条标记，**不碰浏览器**：

1. **schema 合法性**：不符合 `reports/_dogfood/anomalies.schema.json` → 退回，要求 M3 补全（多半是漏 `tried_alternatives` 或 `action_path_is_vortex_native`）。
2. **旁路筛查**：满足任一即标 `SUSPECT(bypass)`：
   - `action_path_is_vortex_native === false`；或
   - `action_sequence` 里**核心交互动作**用了 `vortex_evaluate` / `vortex_query`（`.click()` / `.value=` / `dispatchEvent` / `textContent` / `querySelector`）而非 `vortex_act` / `vortex_fill` / `vortex_press`。
   - SUSPECT 不代表非缺陷，但**校验时优先用纯 vortex 原生路径复测**，历史上多半证伪（0009 MUI：7/8 假象出自旁路）。
3. **优先级排序**：`suspected-blocking` > `experience` > `unsure`；SUSPECT 项重点盯。

## 2. 逐条活校验（四桶归类）

对每条 `m3_severity ≥ experience` 的异常（`unsure` 有余力再做），开**全新 tab** 跑最小复现序列，**只用 vortex 工具**（act/fill/press/observe；evaluate 仅读 DOM 真值核对），归入四桶：

| 桶 | 判据 | 后续 |
|----|------|------|
| **vortex-defect** | 纯 vortex 路径复现失败 **且** evaluate 读 DOM 真值证明本应成功（元素存在/可点/值已变） | 进修复，定位 file:line |
| **m3-error** | 换纯 vortex 路径能成功；或 M3 用了旁路；或漏测边界项 | 误报，记录证伪证据 |
| **site-issue** | 目标站自身问题（后端故障 / 元素真不可点 / 登录墙），与 vortex 无关 | 非缺陷（如 N0062 班牛后端 Dubbo 故障） |
| **already-graceful-degradation** | vortex **正确**拒绝：actionability 门拒不可见/被遮挡元素、虚拟列表越界缓冲项被裁剪真不可点 | 非缺陷，行为正确（0008 #38） |

判定要点（来自历史教训）：
- **区分「工具调用失败」vs「旁路 DOM 操作观察」**：M3 报"click 失败"但动作链显示它用 evaluate `.click()` → 这不是 vortex 失败，换 `vortex_act` 复测才算数（0009）。
- **虚拟列表**必测首/末/中间/缓冲边界项再下结论；越界项被 popper overflow 裁剪 = 真不可点 = graceful（别误判 0008 #38）。
- **networkRequests:0 常是 windowMs 假象**：effect 窗口太窄导致漏采，回读 UI 真值再判（N0062 #43）。
- **报告里的"根因/现象"措辞只当线索**，不当结论。

## 3. 根因定位（仅 vortex-defect）

- 用 **codegraph** 而非 grep：`codegraph_context <关键词>` → `codegraph_explore` 看相关符号源码，定位 file:line。
- **不靠报告的根因猜测**（brief 已禁止 M3 写根因）。历史上报告根因默认不可信，须实机白盒（N0062/N0063/N0064 多条「根因」被实机推翻）。
- 写进 `validated-defects.md`：现象 → 纯 vortex 复现序列 → DOM 真值 → 桶归类 → （若 vortex-defect）根因 file:line + 修复方向。

## 4. 产物：`reports/<cycle>/validated-defects.md`

```markdown
# <cycle> 校验结论 (Claude)

日期 | 站点 | M3 异常数 N | 校验阈值 experience

## 逐条裁决
| ID | 现象 | 桶 | 纯vortex复现 | DOM真值 | 根因 file:line | 备注 |
|----|------|----|------|------|------|------|
| A-1 | observe 漏 chip 删除按钮 | vortex-defect | ELEMENT_NOT_FOUND | querySelectorAll 命中3 | observe.ts:NNN | ... |
| A-2 | dialog 关闭后不可点 | already-graceful-degradation | NOT_VISIBLE | visibility:hidden | — | vortex 正确拒绝 |

## 汇总
- vortex-defect: K 条 → 进修复计划
- m3-error: M 条（含 SUSPECT 证伪 X 条）
- site-issue: P 条 / graceful: Q 条
```

## 5. 修复计划 + 人工闸门

- 仅当存在 `vortex-defect`，每条出 fix-plan（写 `reports/<cycle>/fix-plan.md`）：
  - **TDD**：先写失败单测（RED）→ 改实现（GREEN）→ 重构。
  - **bench 回归 case**：在 `packages/vortex-bench/cases/` 加 case 锁住该缺陷；必要时刷 baseline。
  - 涉及 page-side / 承重墙（observe scan / dom.ts / actionability 门）的改动**必活浏览器 spike** 验证，不靠单测假绿。
- **人工闸门**：呈现 `validated-defects.md` + `fix-plan.md`，**询问用户是否进入实修**。实修与 git 提交**不自动做**。

## 6. 记账（Phase 4）

```bash
node scripts/dogfood-rotation.mjs record --cycle <id> --site <id> \
  --defects K --fp M --note "<一句话>"
```
更新 `rotation-pool.json` 的 `history` + `last_covered`，并在 `reports/_dogfood/ledger.md` 追加一行 cycle 概览（便于趋势观察：哪些站反复出缺陷、误报率走势）。
