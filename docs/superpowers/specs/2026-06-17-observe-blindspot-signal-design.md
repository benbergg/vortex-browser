# observe 盲区降级信号契约 — 设计文档

> 日期：2026-06-17 ｜ 状态：设计已批准（决策见下），待 writing-plans → TDD
> 上游：`2026-06-17-vortex-production-readiness-loop-design.md` 的 Phase 1 A 族
> 证据：`reports/_dogfood/spike-perception-blindspot-2026-06-17.md`（A1/A2/A3 真站实锤）

## 1. 问题（已真站验证）
observe 遇虚拟列表 / canvas / closed-shadow / 预算截断时**静默返回局部视图，不发盲区信号**，让 agent 把局部当全局（元瓶颈）。实测：ag-grid 1000 行召回 ~8；Excalidraw 3 画布对象 0 召回；closed-shadow button+input 0 召回。

## 2. 本轮范围
实现 **A2 虚拟列表 / A1 canvas / A4 截断量化 / A3 closed-shadow(best-effort)**。A5 iframe(per-element scanned) 留 backlog（P2）。

## 3. 输出契约（行内标注 + 顶部 meta 摘要）
复用现有约定（元素行内 `[tag]` + `#` meta 行，如 includeBoxes 的 `# frame N offset=`）。

**顶部 meta 行**（仅当检测到 ≥1 盲区，置于 Viewport 行后）：
```
# blindspots: grid@e29 virtual(rowcount=1000/rendered=32); canvas@e56 editor
# truncated: returned 80 of ~247 candidates
```
**行内标注**（挂在 agent 要操作的元素上，承重）：
- 虚拟容器：`[virtual: 1000/32]`（declaredTotal/rendered）
- canvas：`[blindspot=canvas]`
- closed-shadow host：`[blindspot=shadow?]`（`?`=低置信）
- 截断：快照/frame 级，仅出 meta 行（不挂元素）

## 4. 检测策略（用可靠信号，不猜）
- **A2 虚拟列表**：role=grid/treegrid/table/listbox 容器，读 `aria-rowcount`（grid/table）或子项 `aria-setsize`/最大 `aria-posinset`（listbox）。declaredTotal 显著 > renderedCount（阈值：declaredTotal > rendered + 缓冲，避免小列表误报）→ 出 `[virtual: total/rendered]`。无 ARIA 时回退：可滚动容器 scrollHeight/rowHeight >> 渲染子数（低置信，省略精确 total 或标 ~）。
- **A1 canvas**：`<canvas>` 且可交互（有 listener / cursor:pointer / 面积 > 阈值，排除装饰性 sparkline）→ `[blindspot=canvas]`。
- **A4 截断量化**：扩展 observe.ts:2086 per-frame `truncated`，携带 `candidateCount`（考虑的候选总数）+ `returnedCount` → meta `# truncated: returned M of ~N`。
- **A3 closed-shadow(best-effort)**：保守启发式——自定义元素（标签含连字符）且有 layout box + listener/cursor:pointer，但 querySelectorAllDeep 在其内**0 可观察子孙** → `[blindspot=shadow?]`。高误报风险，限自定义元素以收窄。

## 5. 代码落点
- **检测**：`packages/extension/src/handlers/observe.ts` page-side scan（querySelectorAllDeep 遍历处）给元素记录加可选字段 `blindspot?: {kind:'canvas'|'virtual'|'shadow', total?, rendered?, confidence?}`。
- **截断计数**：observe.ts:2086 区域 + 透传 candidateCount。
- **渲染**：`packages/mcp/src/lib/observe-render.ts` CompactElement 加字段；compact 序列化器出行内 tag + 汇总顶部 meta 行。

## 6. 验收（护栏：承重墙改动）
- **单测**：合成 fixture 各一（aria-rowcount 虚拟 grid / 可交互 canvas / closed-shadow host / 截断），断言信号出现 **且** 普通元素无误报（虚拟阈值不误伤短列表、canvas 不误伤 sparkline、shadow 限自定义元素）。
- **bench case**：`packages/vortex-bench/cases/` 加 fixture 锁信号。
- **活浏览器 spike（强制，load-bearing）**：重跑 §1 三站（ag-grid `/example/`、Excalidraw 画矩形、closed-shadow 构造页），确认信号现在出现。page-side scan 改动不靠单测假绿。
- **bench 全绿 + 无 silent false-success**：commit 前 `pnpm -r test` + bench 全绿。
- **无回归**：observe 既有 fixture/bench 不退化（尤其召回不降、字节预算不爆）。

## 7. 风险
- 误报（最大风险）：虚拟阈值误伤分页/短列表、canvas 误伤装饰图、shadow 启发式误标 → 单测必须含「负例不误报」断言，活浏览器复核普通页面无多余信号。
- 字节预算：meta 行 + 行内 tag 增量小，但需确认 observe 输出不超限。
