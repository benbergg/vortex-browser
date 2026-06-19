# Fix Plan — DEFECT-1 observe 截断顺序盲区（浮层被丢）

## 问题复述
observe 候选按 DOM 序取前 `maxElements=80`（observe.ts:1759 拼接 + 1787-1788 截断）。Portal 弹层挂 `body` 末尾，DOM 序最后。密集页（本例 536 个交互元素 / 108 个在视口内）上，刚点开的视口内下拉选项被顶部 sticky 导航+目录占满的前 80 挤掉，observe 完全看不到。

## 关键约束（已实测，决定方案选型）
- **视口优先排序不够**：视口内交互元素 108 > 80，sticky 导航/目录 DOM 序在前，仍会挤掉下拉。
- 必须**专门优先「可见浮层（overlay）的交互后代」**——即用户刚交互打开的那层。

## 推荐方案：overlay-priority 候选排序（承重墙改动）

在 page-side 扫描构建 `allCandidates` 之前（observe.ts:1759 附近），检测「可见浮层根」，把其交互后代**置于候选列表最前**，再走既有 80 截断。

### 浮层检测（框架无关启发式，取并集）
visible 且满足任一：
1. `role ∈ {dialog, alertdialog, listbox, menu, tree, grid, tooltip}`（ARIA 语义弹层）；
2. `position:fixed|absolute` 且 z-index 抬升（> 周围/ > 某阈值），且作为 `body` 晚序子树（Portal 典型）。

对每个浮层根，收集其内 `ATOMIC_INTERACTIVE_SELECTORS` 后代，**前置**到 `allCandidates`（去重，保持浮层内 DOM 序）。

### 为何这样改
- 浮层是用户当前交互焦点，前置后必然survive 80 截断，且**无浮层时不改变任何顺序**（最小化 bench baseline 扰动）。
- 与既有 `inViewport`/`[offscreen]`/盲区信号体系一致，属同一「感知优先级」维度。

### 改动点
- `packages/extension/src/handlers/observe.ts` page-side 扫描：`allCandidates` 拼接前插入 overlay 检测 + 前置逻辑（~line 1759）。
- 可能复用：`ATOMIC_INTERACTIVE_SELECTORS`（:321）、`querySelectorAllDeep`（穿 shadow）。
- 截断 meta 行（`# truncated`）保留；可选追加 `# overlay prioritized` 提示。

## TDD + 验证（承重墙——必活浏览器 spike）
1. **RED**：新增 bench synth fixture：一个 >80 交互元素的页 + 一个 Portal 下拉（body 末尾、视口内）。断言 observe 输出含下拉选项 ref。先跑红。
2. **GREEN**：实现 overlay-priority，使断言过。
3. **回归**：`pnpm -F @vortex-browser/extension build` → `vortex_dev_reload` → 真站复现（本 antd select：点开基础 Select，observe 应出现 Jack/Lucy/yiminghe option ref）。
4. **bench 全量**：`pnpm -F @vortex-browser/bench bench run --all` + `bench diff`。重点核对：① 无浮层 case 输出/ref 不变（baseline 零漂移期望）；② 既有弹层 case（el-select / jd-review-modal 等）改善或不变；③ observeMissed* 指标不升。
5. 单测：`pnpm -F @vortex-browser/extension test` + mcp。

## 备选（已评估，非首选）
- **viewport-first 排序**：实测不够（108>80），单用无效，可作 overlay-priority 之后的次级排序增强。
- **抬高 maxElements**：不治本（DOM 序问题仍在），且膨胀 token。
- **prevSnapshotId 产出「仅增量」视图**：能侧面缓解（只看新增弹层），但属新功能、改动面更大，留作后续增强。

## 风险
- 承重墙（感知核心），改 candidate 排序须确保无浮层路径零回归——靠 bench baseline diff 把关。
- overlay 检测启发式需防误判（如把普通 absolute 定位卡片当浮层前置）——靠 RED fixture + 真站 sweep 校准阈值。
