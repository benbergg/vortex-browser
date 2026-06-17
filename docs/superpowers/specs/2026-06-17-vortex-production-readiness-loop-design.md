# vortex 生产化自驱动闭环 — 设计文档

> 日期：2026-06-17 ｜ 状态：设计已批准，待实施
> 目标：让 vortex 在「可用性 / 可靠性 / 效率性」三维达到生产标准，且评估→验证→修复过程由 Claude Code 自动驱动。

## 1. 目标与验收线（停止条件）

`/loop` 以下列**全集**为停止条件，全部满足则自然终止：

1. **真实站通过率 ≥ 95% + 失败优雅降级**：真站点原语通过率 ≥95%，失败时明确报错（NOT_VISIBLE / OBSCURED / ELEMENT_NOT_FOUND 等）而非静默假成功。
2. **bench 全绿 + 无 silent false-success**：`packages/vortex-bench` 全部 case 通过；不存在「工具返回 success 但实际未生效」。
3. **效率达标**：关键原语延迟受控（screenshot 走 native captureVisibleTab、observe 字节数受控、extract 不退化）。
4. **覆盖一批指定真实站**：按 backlog 缺陷族动态选取（轮换池 8 站 + 按族补充），覆盖记入 scoreboard。

## 2. 整体架构

```
Phase 0（一次性，并行 Explore agent 三层审计）
  └─ 产出 reports/_dogfood/backlog.md（带优先级的设计级缺陷清单）
        │
        ▼
Phase 1..N（/loop 自驱动，模型自定步调）
  每轮：
    1. 取 backlog 最高优先级项（或轮换池下一站）
    2. 跑 dogfood-cycle（复用现有 .claude/commands/dogfood-cycle.md + SOP）
       M3 自主真站评测 → 我承重校验(四桶) → 复杂故障 spike 复现 → TDD 修 → bench 回归 → commit
    3. 更新 backlog + reports/_dogfood/scoreboard.md
    4. 比对 §1 验收线：未达标继续，达标停
```

## 3. Phase 0：三层并行设计审计

并行 3-4 个 **Explore agent**（只读），按层切分，聚焦**设计级缺陷**（非已修实现 bug）：

- **感知层（observe / query）**：核心是「盲区降级信号」缺失——canvas 0 召回、虚拟列表低召回无提示、closed-shadow 静默漏、截断降级元数据缺失。这是历史诊断标注的**元瓶颈**（见 memory `vortex_perception_bottleneck_audit`）。
- **执行层（act 全族）**：5 原语 + ARIA driver 残余 silent false-success 风险、SCROLL/COMMIT 边界、跨池/跨 frame。
- **协议 / 降级层**：失败是否优雅降级（明确报错 vs 静默假成功）、ref 生命周期、tools/list 预算。

每个 agent 产出结构化条目 `{缺陷, 层, 严重度, 证据 file:line, 建议验证站点}`；我汇总去重、定优先级，写入 `reports/_dogfood/backlog.md`。

## 4. Phase 1..N：每轮迭代（复用 dogfood-cycle）

直接调用现有 `dogfood-cycle` skill，已固化的规则照旧生效：

- **浏览器串行铁律**：M3（opencode）与 Claude 共用同一个 Chrome，无法并发；M3 子进程阻塞返回后我才接手。
- **旁路自动筛查**：`action_path_is_vortex_native===false` 或核心动作走 evaluate/query → 标 SUSPECT，优先纯 vortex 路径复测（历史多半证伪）。
- **四桶归类**：vortex-defect / m3-error / site-issue / already-graceful-degradation。只有 vortex-defect 进修复。
- **spike**：复杂故障开全新 tab 用 vortex 原生路径最小复现 + `vortex_evaluate` 仅读 DOM 真值核对。承重墙（observe scan / dom.ts / actionability 门）改动**必活浏览器 spike**，不靠单测假绿。

## 5. 全自动修复 + 安全护栏

每轮确认 vortex-defect 后**直接修复并提交**，不停顿询问（覆盖原 SOP 第 5 节人工闸门）。护栏（来自 `ship_checklist_vortex` 教训）：

1. **TDD**：先写失败单测（RED）→ 改实现（GREEN）→ 重构。
2. **bench 全绿门**：commit 前必须 `pnpm -r test` + bench 全绿；不绿不提交。
3. **承重墙必活浏览器 spike**：page-side / observe scan / dom.ts / actionability 门改动须真 Chrome 验证。
4. **silent false-success 门**：修复不得引入「success 但未生效」；新增回归 case 锁住。
5. **分支隔离**：不直接提交 main（git-workflow 铁律）。本闭环在专用分支 `feat/production-readiness-loop` 上累积提交。
6. **git-commit skill**：所有提交走 `git-commit` skill，符合 Conventional Commits，禁署名。
7. **ship-preflight**：阶段性跑 `pnpm ship:preflight`。

## 6. Scoreboard 与终止

每轮追加 `reports/_dogfood/scoreboard.md`，跟踪 §1 四条验收线进度 + backlog 剩余项。
backlog 清空 **且** 四线全绿 → `/loop` 自然终止，产出收尾汇报。

## 7. 自动化机制说明（回答「需要用 goal 吗」）

Claude Code 无名为 "goal" 的原语。「自动进行」= **可判定验收线（§1）** + **循环机制（`/loop` 自定步调）**。
- `/loop` 在本会话内自驱动反复跑迭代，模型自定步调（`ScheduleWakeup`），用户可随时插话/中断。
- 备选：`/schedule`（云端 cron 无人值守，单轮深度受限）、Workflow（一次性多 agent 铺开，不循环）。本闭环主轴选 `/loop`。

## 8. 产物清单

- `reports/_dogfood/backlog.md`：Phase 0 审计产出的优先级缺陷清单。
- `reports/_dogfood/scoreboard.md`：每轮验收线进度。
- `reports/<cycle>/validated-defects.md` + `fix-plan.md`：每轮 dogfood-cycle 产物。
- 代码修复 + bench 回归 case + 提交，累积在 `feat/production-readiness-loop` 分支。
