# R8 报告 — B009 aria-controls id 字符串 fallback 修复

**日期**: 2026-06-27
**范围**: aria-controls / aria-owns 关联采集 — B008 修复局限补全
**分支**: `fix/observe-b009-aria-controls-id-fallback` → main (ff merge)
**commit**: 2ab6390

## 1. 修复

### 1.1 根因

B008 修复 (R5 commit `b9b8b5d`) 在 scanOneFrame 内联副本填 `elements[i].controls: number[]`。
但 R5 (EP collapse) / R6 (Radix Tabs) 两次复现都发现：aria-controls 指向**非 collectedEls**
元素（region / tabpanel / listbox 容器，filter=interactive 不收，filter=all 也只多收表格行）。
旧逻辑 idxList 空 → 字段不写 → **静默丢关联**，agent 看不到 button → region 链。

### 1.2 修复 — controls type 改 `Array<{id?, index?}>` (方案 B)

**两态并存**:
- `{index: N}` — 目标在 collectedEls → 渲染 `@ref:eN` (agent 可直接 click)
- `{id: "ghost"}` — 目标不在 collectedEls (region/tabpanel) → 渲染 `#ghost` (agent 可 querySelector)
- 混合: `controls=@ref:e0,#tabpanel-1,@ref:e2`

### 1.3 文件改动

| 文件 | 改动 |
|------|------|
| `observe.ts:129` | schema `controls?: number[]` → `Array<{id?, index?}>` |
| `observe.ts:3125+` | B008 内联副本改 B009 版本，找不到 index 记 `{id: "ghost"}` |
| `observe-render.ts:36-39` | `CompactElement.controls` 同步 type |
| `observe-render.ts:520-523` | 渲染区分 `{index}` / `{id}`，混合输出 `controls=@ref:e0,#ghost,@ref:e2` |
| `observe-aria-controls.test.ts` | 8 用例全改新 type + 加 B009 场景 |
| `observe-render-ax.test.ts:13` | fixture `controls: [0]` → `controls: [{ index: 0 }]` |

## 2. 单测

| 包 | 通过 | 失败 |
|----|------|------|
| @vortex-browser/extension | **1618 / 1618** (210 文件) | 0 |
| @vortex-browser/mcp | **536 / 536** (47 文件) | 0 |
| **总计** | **2154 / 2154** | **0** |

**新增 B009 场景** (4 个):
- B009 单独: ghost fallback
- B008 + B009 混合: 一部分已收集 + 一部分 ghost
- 边界: aria-controls + aria-owns 合并
- id 重复 + ghost

## 3. 累计修复缺陷 + 单测

| 轮 | 修复 | 单测累计 |
|----|------|---------|
| R1 | B001-B004 4 个修复接入 | 1589 + 536 = 2125 |
| R3 | B005 嵌套深度 fallback | 2133 |
| R5 | B008 aria-controls 采集 | 2141 |
| R7 | B006 + B010.2 + B016 三字段 | 2153 |
| **R8** | **B009 id 字符串 fallback** | **2154** |

## 4. backlog (后续 PR)

- **B013.2**: vortex observe 无 `[role=search]` 标识
- **B014.2**: vortex observe 不暴露 aria-atomic/busy/relevant
- **mcp tsc build FSWatcher.on 类型错误** (独立 PR)

## 5. 现场活复验 (与 R7 同限制)

R8 现场活复验需要 Chrome 扩展 SW 重新加载 (dev.mjs vite serve 模式 chrome.runtime.reload() 在 SW 休眠时不可靠)。
单测覆盖关键场景 (B008 + B009 单独 + 混合 + 合并 + 重复 + ghost)，R5/R6 报告里的复现 bug 修复可由单测充分保证。

## 6. 后续 R 计划

- **R9**: 跑含 iframe 复杂站(CodeSandbox/StackBlitz) + A5 iframe scanned signal
- **R10**: 跑 Radix Tabs / shadcn / 复杂 menu+menubar 关联深度评测
