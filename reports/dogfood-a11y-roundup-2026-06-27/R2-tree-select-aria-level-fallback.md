# R2 报告 — B001 验证 + 新缺陷 B005 发现 (aria-level 嵌套深度 fallback 缺)

**日期**: 2026-06-27
**范围**: B001 验证 + Element Plus tree-select 现场 + 新缺陷 B005 确诊
**目标**: 验证 B001 修复在 EP tree-select 站点是否生效

## 1. B001 验证 — 现场

### 1.1 DOM aria-level 直接读

```
URL: https://element-plus.org/zh-CN/component/tree-select.html
测试: Array.from(document.querySelectorAll('[role=treeitem]')).slice(0,8)

结果(全部 aria-level=null):
  Level one 1     | ariaLevel: null | role: treeitem
  Level two 1-1   | ariaLevel: null | role: treeitem
  Level three     | ariaLevel: null | role: treeitem
  Level one 2     | ariaLevel: null | role: treeitem
  ...
```

**Element Plus 的 treeitem 在 DOM 上**没有**写 `aria-level` 属性。**这是 site-issue (EP 自身没遵循 ARIA 1.2 spec treeitem level required)。

### 1.2 B001 修复范围 (N0002 B001)

修复路径: `observe.ts getUiState` 读 `el.getAttribute("aria-level")`。
**只在 DOM 上有 aria-level 时生效。** EP tree-select DOM 上没写 → B001 修复在 EP 无效。

### 1.3 浏览器 AX 树 properties.level

ax-snapshot.ts:87-88 读 `getProp(n, "level")` (CDP AX tree properties.level)。
**CDP AX tree 反映浏览器从 DOM 嵌套深度推断的 level(因为 EP DOM 嵌套 group 包含 treeitem)。**
但 vortex observe 走 page-side (observe.ts getUiState),不走 ax-snapshot 的 background 路径。

## 2. 新缺陷 B005 — 嵌套深度 fallback 缺

### 2.1 现象

Element Plus / antd Tree 等站点在 DOM 上**忘了**写 aria-level,但 DOM 嵌套结构(group → treeitem → group → treeitem)能反映层级深度。vortex observe 走 getUiState 读 DOM aria-level,没读出来 → 不渲染 [level=N] 标记。

### 2.2 现场模拟 (DOM 嵌套深度)

```
treeitem 节点嵌套深度 (按 querySelector 模拟):
  Level one 1   → depth=1
  Level two 1-1 → depth=3
  Level three   → depth=5
```

按 tree root (1 层) + 嵌套 group 推算:
- Level one: 层级 1
- Level two: 层级 2
- Level three: 层级 3

### 2.3 根因 (codegraph 定位)

| 路径 | 现状 | 期望 |
|------|------|------|
| `observe.ts:1810` `el.getAttribute("aria-level")` | DOM attribute 单一源 | 加 fallback:treeitem 嵌套深度推断 |
| `observe-render.ts:220` `if (state.level != null) flags.push(\`level=\${state.level}\`)` | 已有 | OK |
| `ax-snapshot.ts:87-88` `getProp(n, "level")` | 读 CDP AX tree properties.level | OK (background 路径正确) |

**B005 根因**: page-side 路径(observe.ts getUiState)**无**嵌套深度 fallback。treeitem 角色 + DOM 上无 aria-level → 无 [level=N] 标记 → agent 看不到层级。

### 2.4 桶归类

**vortex-defect**(B005): vortex 在 page-side 路径无嵌套深度 fallback,应能从父链 [role=tree|group] 嵌套层数推断 level。

### 2.5 修复方向

在 `getUiState` 内,aria-level 读取失败时:
- 若 `el.role === 'treeitem'`
- 沿 `el.parentElement` 上溯,每穿过一个 `[role=tree]` 或 `[role=group]` 累加 1
- 直到根 / 命中 `[role=tree]` 顶层停止
- 顶层是 tree,Level 1;Level 2 是 treeitem 嵌在 group 内(group 嵌在 tree 内)

加 `level: number` 字段到 getUiState 返回类型,模块级 `inferTreeitemLevel(el)` 纯函数 + 单测。

### 2.6 经验教训

- B001 修复只覆盖 DOM attribute 路径,**不覆盖** 站点忘写 aria-level 但靠 DOM 嵌套推断的场景(EP / antd Tree)。
- 浏览器 AX tree 能从嵌套深度算 properties.level,但 vortex observe 走 page-side 自采 DOM attribute,丢了这条信号。
- 应该双轨:DOM aria-level 优先,嵌套深度 fallback 兜底。

## 3. 后续

- **R3**: 修 B005(嵌套深度 fallback)+ 复测 + 合并
- **R4**: 找下一个新缺陷面
- **R5**: 找下一个新缺陷面
