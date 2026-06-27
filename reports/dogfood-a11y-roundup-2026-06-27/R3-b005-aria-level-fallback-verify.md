# R3 报告 — B005 修复 + 实机活复验 (aria-level 嵌套深度 fallback)

**日期**: 2026-06-27
**范围**: B005 修复 + Element Plus tree-select 现场验证
**分支**: `fix/observe-b005-aria-level-fallback` → main (ff merge)
**commit**: 782579b

## 1. 修复

### 1.1 根因

B001 修复只读 `el.getAttribute("aria-level")`。Element Plus / antd Tree 等组件**在 DOM 上忘了写** aria-level 属性(违反 ARIA 1.2 spec treeitem level required),但 DOM 嵌套 (tree → group → treeitem) 能反映层级深度。vortex 拿到的是空字符串 / null,丢掉 [level=N] 标记。

### 1.2 修复路径

**模块级纯函数** (`observe.ts`):
```ts
export function inferTreeitemLevel(
  el: Element,
  closest: (sel: string) => Element | null = (s) => el.closest(s),
): number | undefined {
  const treeRoot = closest("[role=tree]");
  if (!treeRoot) return undefined;
  let level = 1;
  let n: Element | null = el.parentElement;
  while (n && n !== treeRoot) {
    if (n.getAttribute("role") === "group") level++;
    n = n.parentElement;
  }
  return level;
}
```

**注入体接入** (scanOneFrame 内 getUiState):
- `aria-level` 读失败时
- `el.getAttribute("role") === "treeitem"` 命中
- 走嵌套深度 fallback(每穿过 [role=group] 累加 1)

## 2. 单测

| 包 | 通过 | 失败 |
|----|------|------|
| @vortex-browser/extension | **1597 / 1597** (208 文件) | 0 |
| observe-treeitem-level.test.ts | **8 / 8** (新) | 0 |

8 个用例覆盖:
- treeitem 直接在 tree 内 → level=1
- tree → group → treeitem → level=2
- tree → group → group → treeitem → level=3
- 树 4 层 → level=4
- 无 [role=tree] 祖先 → undefined
- 中间有 div 包裹(非 group)→ 不算层级
- aria-level 显式存在 → 不影响 fallback(上层逻辑用 attribute 优先)

## 3. 现场活复验 (mcp stdio 客户端 + EP tree-select)

**环境**: vortex mcp stdio 协议 (server.js --caps=dev) + Chrome 扩展 (B005 修复已 HMR 重载)
**目标站**: https://element-plus.org/zh-CN/component/tree-select.html
**操作**: 点开 combobox → 展开 Level one 1 → vortex_observe 抓快照

**observe 输出关键行**:
```
- treeitem "Level one 1" [ref=@ba15:e0] [expanded] [level=1] [listener] [dropzone]:
  - treeitem "Level two 1-1" [ref=@ba15:e2] [level=2] [listener] [dropzone]:
- treeitem "Level one 2" [ref=@ba15:e4] [level=1] [listener] [dropzone]:
- treeitem "Level one 3" [ref=@ba15:e6] [level=1] [listener] [dropzone]:
```

**关键证据**:
- ✅ `treeitem "Level one 1" [level=1]` — 顶层
- ✅ `treeitem "Level two 1-1" [level=2]` — Level one 1 的子节点
- ✅ 兄弟 treeitem (Level one 2/3) 各 [level=1] — 不互相干扰

**修复前**: observe 输出 `treeitem "Level one 1" [expanded]` 无 [level=...]
**修复后**: 输出 `[level=1]` / `[level=2]` 标记,agent 可见层级深度

## 4. 经验教训

- B001 单走 aria-level attribute 路径是**不完整**修复。CDP AX tree 的 properties.level 是从 DOM 嵌套深度推断的(浏览器自动补),vortex observe 走 page-side 注入体自采 DOM attribute 丢了这条信号。
- 双轨策略必须:**attribute 优先 + 嵌套深度 fallback**。
- 类似模式适用:很多 ARIA 计算后状态(aria-valuenow / aria-posinset / aria-setsize)在忘写时,浏览器 AX 树能从其他 DOM 信号推断,vortex 应该补 fallback。

## 5. 后续

- **R4**: 找下一个新缺陷面(候选: A5 iframe scanned 信号 / 复杂 widget aria-valuenow / foldable 折叠面板)
- **R5**: 找下一个新缺陷面
