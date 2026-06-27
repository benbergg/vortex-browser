# R6 报告 — 广度 a11y 召回评测(Next.js + ant.design + Radix UI)

**日期**: 2026-06-27
**范围**: 3 真实站点跨组件库 a11y 召回评测 + 5 个新缺陷发现 + B009 复现
**状态**: 5 个新缺陷 + 1 个 B009 复现,**R6 不修**(记 backlog + 后续 PR)

## 1. 测试目标

R6 是"扩大范围和深度"系列首轮。跑 3 个真实站点找 ARIA 计算后态 / 控件关联
的 a11y 召回缺陷:

| 站点 | 重点面 | 来源 |
|------|-------|------|
| nextjs.org/docs | cmdk search palette + 多级 nav landmark + ⌘K 快捷键 | 文档站代表 |
| ant.design/components/table | 复杂 table 组件 + 6 个 search input + live region | 组件库代表 |
| radix-ui.com/primitives/docs/components/dialog | Radix Tabs 关联 + alertdialog + Radix API 文档 | 无障碍库代表 |

## 2. 现场发现 (5 个新缺陷 + 1 个 B009 复现)

### 2.1 B010 — 搜索按钮缺 aria-keyshortcuts

**Next.js docs** 顶部 4 个搜索按钮文本含 "⌘K" / "Search documentation...⌘K"。

```
DOM 真值:
  button[0]: text="Search documentation...⌘K", ariaKeyshortcuts=null, role=null
  button[1]: text="Search...",            ariaKeyshortcuts=null, role=null
```

**修复建议**: 站点加 `aria-keyshortcuts="Meta+K"` (Mac) 或 `"Control+K"` (Win/Linux)
—— 显式告知屏幕阅读器用户可按 ⌘K 触发,即使浏览器/AT 不自动处理。

**vortex 缺什么**: 即便站点加了 aria-keyshortcuts,vortex observe 也**没渲染**
`[keyshortcuts=...]` 标记(line 3457-3650 elements schema 没 keyshortcuts 字段)。
**B010.2 (vortex 缺陷)**: vortex observe 不暴露 aria-keyshortcuts 给 agent。

### 2.2 B013 — search 容器缺 [role=search] landmark

**Next.js docs** 5 nav, 1 main, 1 banner, 1 contentinfo,**search=0**。
**ant.design components** search=0(6 个 search input 都没包在 [role=search] 里)。

**修复建议**: 站点用 `<search>` HTML5 元素或 `<div role="search">` 包裹搜索框
—— ARIA 11 / HTML 5.2 spec 推荐, 便于屏幕阅读器用户跳转。

**vortex 缺什么**: 即便站点加了 role=search,vortex observe **没渲染** `role=search`
元素的特殊处理(应该输出 `search ... :` 行,与 nav/main/banner 区分开)。
**B013.2 (vortex 缺陷)**: vortex observe 对 [role=search] landmark 无标识。

### 2.3 B014 — live region 缺 aria-atomic 标注

**ant.design components/table** 有 7+ 个 `aria-live="polite"` 区域
(table title / tokens / table rows 等),但**全部** `aria-atomic=null` (默认 false)。

**修复建议**: 站点应为长 live 区域加 `aria-atomic="true"` —— 默认 false 时
AT 只读 diff 部分, 长 table 区域更新时可能漏重要信息。

**vortex 缺什么**: 即便站点加了 aria-atomic,vortex observe **没渲染** `aria-atomic`
属性(line 3457+ elements schema 无 atomic 字段)。
**B014.2 (vortex 缺陷)**: vortex observe 不暴露 aria-atomic / aria-busy / aria-relevant
等 live region 元数据。

### 2.4 B015 — search input 缺 role=search(同 B013 站点侧)

**ant.design** 6 个 input[type=search] / input[placeholder*="Search" i]
**全部**没在 [role=search] 容器内 —— site-issue。

### 2.5 B016 — aria-keyshortcuts 全站缺

**Radix UI 文档站** 0 个 aria-keyshortcuts 属性。
**ant.design** 0 个 aria-keyshortcuts 属性。

**修复建议**: 命令面板 / 关闭按钮 (Esc) / 提交按钮 (Cmd+Enter) 应加 aria-keyshortcuts
—— 现代 SaaS 标配,AT 用户高度依赖。

**vortex 缺什么**: 同 B010.2, vortex observe 不暴露 aria-keyshortcuts 字段。

### 2.6 B009 复现 — Radix Tabs aria-controls 指向 tabpanel 静默

**Radix UI dialog 文档页** Radix Tabs:
```
DOM:
  tab[0]: aria-controls="radix-_R_...-content-index.jsx" 指向 tabpanel 容器
  tab[1]: aria-controls="radix-_R_...-content-styles.css"

vortex observe 输出:
  - tablist [ref=@b98f:e32]:
    - tab "index.jsx" [ref=@b98f:e33] [selected]
    - tab "styles.css" [ref=@b98f:e34]
```

**没有 `controls=@xxx:ex` 标记**!tabpanel 容器是 [role=tabpanel],非 interactive,
不在 collectedEls → B008 修复 idxList 空 → 字段不写。

**B009 复现确认**: B008 修复在所有"aria-controls 指向非收集元素"场景都失效。
- EP collapse (B009 R5): region 容器
- Radix Tabs (B009 R6): tabpanel 容器
- 任何 tab / disclosure / popover / listbox 触发器都中招

**修复方案 B (R8 backlog)**: controls type 改 `Array<{ id?: string; index?: number }>`,
ref 不到时用 id 字符串。

## 3. 累计新缺陷汇总

| ID | 标题 | 来源 | vortex 能否修 |
|----|------|------|---------------|
| B010.1 | 站点: search 按钮缺 aria-keyshortcuts | Next.js / antd | — (站点修) |
| **B010.2** | **vortex: observe 不暴露 aria-keyshortcuts** | R6 跨站确认 | ✓ |
| B013.1 | 站点: search 容器缺 role=search landmark | Next.js / antd | — |
| **B013.2** | **vortex: observe 无 [role=search] 标识** | R6 跨站确认 | ✓ |
| B014.1 | 站点: live region 缺 aria-atomic | ant.design | — |
| **B014.2** | **vortex: observe 不暴露 aria-atomic/busy/relevant** | R6 跨站确认 | ✓ |
| B015 | 站点: search input 不在 role=search 内 | ant.design | — |
| B016 | 站点 + vortex: aria-keyshortcuts 全站缺 | 3 站 | ✓ |
| **B009** | **vortex: aria-controls 限非收集元素 (Radix Tabs 复现)** | R6 确认 | ✓ |

## 4. vortex 可修优先级(后续 R7-R10 候选)

- **R7 (高优)**: 修 B010.2 + B016 加 keyshortcuts 字段 (R4 B006 同时修)
- **R8 (中优)**: 修 B009 aria-controls 扩 id 字符串 (单 fix, 解 R5+R6 两案例)
- **R9 (低优)**: 修 B013.2 search landmark 标识 + B014.2 live region 元数据

## 5. 现场复验工具 (沿用 R5)

- vortex mcp stdio JSON-RPC 客户端 (`/tmp/mcp-r6*.mjs`)
- 真实 Chrome 扩展,@crxjs HMR 自动重载
- vortex CLI 短命令 (navigate / tab)
- 现场 DOM 真值 + observe 产物 对照 (按 dogfood SOP)

## 6. 后续 R 计划

- **R7**: 修 B010.2/B016 (keyshortcuts 字段) + B006 (slider valuemin/max 一起修)
- **R8**: 修 B009 (aria-controls id 字符串 fallback)
- **R9**: 跑含 iframe 复杂站(CodeSandbox / StackBlitz) + A5 iframe scanned signal
- **R10**: 跑 Radix Tabs / shadcn / 复杂 menu+menubar 关联深度评测
