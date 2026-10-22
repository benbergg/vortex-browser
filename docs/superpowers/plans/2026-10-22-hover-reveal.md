---
created: 2026-10-22
updated: 2026-10-22
status: draft
tags: [plan, vortex, hover]
---

# Hover 隐藏元素识别与点击 实施计划

**Goal:** 让 vortex 具备通用能力：目标被父级 `:hover` 隐藏时，动作侧自动 hover 祖先把它揭示出来再操作；发现侧向 agent 报告「hover 触发元素 X 会揭示控件 Y」。

**Spec:** `docs/superpowers/specs/2026-10-22-hover-reveal-design.md`

**Tech Stack:** TypeScript / Chrome MV3（`chrome.scripting.executeScript` + `chrome.debugger` CDP `Input.dispatchMouseEvent`）/ vitest

## Global Constraints

- **一次只做一个 Task**，做完停下汇报，等评审通过再接下一个。
- **TDD 顺序不可颠倒**：先写测试 → **真跑出 RED** → 再改实现 → 跑出 GREEN。
- 只碰该 Task 的 **Files** 段列出的文件，要动别的**先问**。
- 跑测试**必须**限并发：`npx vitest run <file> --maxWorkers=2 --minWorkers=1`，工作目录 `packages/extension`。
- 构建扩展**必须**用 `pnpm build`（`vite build && node scripts/build-page-side.mjs`），**禁止**单跑 `build:main`。
- 提交遵循 Conventional Commits，中文描述，动词开头、结尾无句号，**禁止**署名。
- 代码注释用中文，只写「为什么」，不复述代码。
- **通用性红线**：不得出现 iPaaS 专有的类名/文案/选择器（如 `ipaas-*`、`流程节点`、`新增`字面量）。
- 新增 page-side 模块必须同步：`src/adapter/page-side-loader.ts` 的 `PageSideModule` 联合类型 +
  `scripts/build-page-side.mjs` 的 `entries`。

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/extension/src/page-side/hover-reveal.ts` | **新建**。page-side 模块：解析目标 → 枚举「可见且有盒」的祖先候选；判定目标可见性。挂 `window.__vortexHoverReveal`。 |
| `packages/extension/src/action/reveal.ts` | **新建**。host 侧编排：候选 → CDP mouseMoved → 复查可见性 → 产出 `revealed` 证据。 |
| `packages/extension/src/action/auto-wait.ts` | 改。`waitActionable` 在 `NOT_VISIBLE` 时调用一次 reveal；失败诊断改为可执行指引。 |
| `packages/extension/src/action/wait-actionable-auto-force.ts` | 改。透传 reveal 证据。 |
| `packages/extension/src/handlers/dom.ts` | 改。`healAwareGate` 返回 reveal 证据；CLICK/TYPE/FILL/SELECT 结果并入 `revealed`。 |
| `packages/extension/src/adapter/page-side-loader.ts` | 改。模块联合类型加 `hover-reveal`。 |
| `packages/extension/scripts/build-page-side.mjs` | 改。新增 page-side 入口。 |
| `packages/extension/tests/hover-reveal-page-side.test.ts` | **新建**。page-side 行为测试（jsdom）。 |
| `packages/extension/tests/act-hover-reveal.test.ts` | **新建**。auto-wait/reveal 接线与失败诊断测试。 |

---

## Task 1 —— page-side：祖先候选枚举 + 可见性判定

**Files:**
- Create: `packages/extension/src/page-side/hover-reveal.ts`
- Create: `packages/extension/tests/hover-reveal-page-side.test.ts`

**Interfaces:**
- Produces: `window.__vortexHoverReveal.collectCandidates(selector, maxDepth)` → `Array<{depth,x,y,w,h,tag,cls,text}>`（由近及远，只含可见且有盒者）；`window.__vortexHoverReveal.isVisible(selector)` → `boolean`。

- [ ] **Step 1: 写失败测试**（jsdom 造一个「父级 :hover 揭示子元素」的 DOM）
  - `collectCandidates` 返回由近及远的可见祖先；隐藏祖先（`display:none`）被剔除；零尺寸祖先被剔除。
  - `isVisible` 对 `display:none` 元素返回 false，对可见元素返回 true。
- [ ] **Step 2: 跑出 RED**（`npx vitest run tests/hover-reveal-page-side.test.ts --maxWorkers=2 --minWorkers=1`）
- [ ] **Step 3: 最小实现**（只做这两个函数，不接 CDP）
- [ ] **Step 4: 跑出 GREEN**
- [ ] **Step 5: 提交**（`feat(extension): 新增 hover-reveal page-side 模块，枚举可见祖先候选`）

---

## Task 2 —— host 侧 reveal 编排 + 接入 actionability 门

**Files:**
- Create: `packages/extension/src/action/reveal.ts`
- Create: `packages/extension/tests/act-hover-reveal.test.ts`
- Modify: `packages/extension/src/action/auto-wait.ts`
- Modify: `packages/extension/src/action/wait-actionable-auto-force.ts`
- Modify: `packages/extension/src/adapter/page-side-loader.ts`
- Modify: `packages/extension/scripts/build-page-side.mjs`

**Interfaces:**
- Produces: `revealByHover({tabId, frameId, selector, maxCandidates})` → `{revealed:boolean, trigger?:{tag,cls,text}, attempts:number}`。
- Consumes: Task 1 的 `window.__vortexHoverReveal`。

- [ ] **Step 1: 写失败测试**
  - `NOT_VISIBLE` 时 `waitActionable` 调用 reveal；reveal 成功 ⇒ 门通过、结果带 `revealed` 证据。
  - reveal 失败 ⇒ 错误信息含可执行指引（不再只有「调大 timeout」）。
  - 非 `NOT_VISIBLE` 原因（`OBSCURED`/`NOT_ATTACHED`/`DISABLED`）⇒ **不**调用 reveal（零副作用）。
  - reveal 候选上限有界（≤6 次 mouseMoved）。
- [ ] **Step 2: 跑出 RED**
- [ ] **Step 3: 最小实现**
- [ ] **Step 4: 跑出 GREEN**（含既有 auto-wait/actionability 测试不回归）
- [ ] **Step 5: 提交**（`feat(extension): 目标被 hover 隐藏时自动 hover 祖先揭示后再动作`）

---

## Task 3 —— dom handler 接线：证据回传

**Files:**
- Modify: `packages/extension/src/handlers/dom.ts`
- Modify: `packages/extension/tests/act-hover-reveal.test.ts`（追加断言）

- [ ] **Step 1: 写失败测试**（CLICK 结果含 `revealed`；非 hover 场景不含）
- [ ] **Step 2: 跑出 RED**
- [ ] **Step 3: 最小实现**（`healAwareGate` 透传 → 各动作结果并入）
- [ ] **Step 4: 跑出 GREEN**
- [ ] **Step 5: 提交**（`feat(extension): 动作结果回传 revealed 证据`）

---

## Task 4 —— 发现侧：observe 报告 hover 揭示控件

**Files:**
- Modify: `packages/extension/src/page-side/hover-reveal.ts`（加 `findRevealPairs()`）
- Modify: `packages/extension/src/handlers/observe.ts`（frame 级 `hoverControls`）
- Modify: `packages/mcp/src/lib/observe-render.ts`（`# hover-revealed:` meta 行）
- Modify: `packages/mcp/src/tools/schemas-public.ts`（如需新增 observe 参数则改；默认不改 schema）
- Create: `packages/extension/tests/hover-reveal-discovery.test.ts`

- [ ] **Step 1: 写失败测试**（`:hover` 规则解析：触发选择器 / 被揭示选择器 / 当前隐藏判定；跨源样式表跳过）
- [ ] **Step 2: 跑出 RED**
- [ ] **Step 3: 最小实现**
- [ ] **Step 4: 跑出 GREEN**
- [ ] **Step 5: 提交**（`feat(extension): observe 报告 hover 揭示控件`）

---

## Task 5 —— 真站验收 + 回归

- [ ] **Step 1: 构建扩展**（`pnpm -C packages/extension build`），确认 Edge 侧生效
- [ ] **Step 2: 真站验证**：iPaaS 流程页上识别 ⊕ 按钮并成功点击（popover 打开），留证据
- [ ] **Step 3: 回归**：`pnpm --filter @vortex-browser/extension test -- --maxWorkers=2 --minWorkers=1` 与 mcp 包测试
- [ ] **Step 4: 写实施报告**（`docs/superpowers/reports/`）
- [ ] **Step 5: 提交**（`docs: 补 hover 揭示实施报告`）
- [ ] **Step 6: 交人工评审，**未经确认不合并 main
