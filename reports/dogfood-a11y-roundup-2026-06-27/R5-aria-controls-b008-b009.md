# R5 报告 — aria-controls 关联采集 (B008 修复 + B009 限制)

**日期**: 2026-06-27
**范围**: Element Plus collapse / accordion + aria-controls 关联 a11y
**分支**: `fix/observe-b008-aria-controls` → main (ff merge)
**commit**: b9b8b5d

## 1. 修复 B008 — aria-controls 关联采集

### 1.1 根因

`observe.ts` 的 `elements` schema 已有 `controls?: number[]` 字段定义 (line 123-124) +
`observe-render.ts` 已有 `controls=@ref:ex,@ref:ey` 渲染 (line 501-502)。**但真实路径
(scanOneFrame elements.push) 未填充 controls 字段** —— type + 渲染都齐,只差采集。

### 1.2 修复

`observe.ts:3080+` 加第二轮 pass 算 controls:
- 读 `aria-controls` + `aria-owns`(同语义, popover / listbox 父级)
- 拆 id list (space-separated)
- 在 `collectedEls` 中查下标
- 填 `elements[i].controls`

### 1.3 单测

| 包 | 通过 | 失败 |
|----|------|------|
| @vortex-browser/extension | **1605 / 1605** (209 文件) | 0 |
| observe-aria-controls.test.ts (新) | **8 / 8** | 0 |

8 用例: 单 id / 多 id / ghost id 静默忽略 / aria-owns / controls+owns 合并去重 /
id 重复 / 空格分隔。

## 2. 现场活复验

### 2.1 EP collapse (filter=interactive)

```
observe 输出:
  - button "Consistency" [ref=@629f:e4] [active] [expanded] [cursor=pointer] [listener]
  - button "Feedback"    [ref=@629f:e5] [cursor=pointer] [listener]
  - button "Efficiency"  [ref=@629f:e6] [cursor=pointer] [listener]
  - button "Controllability" [ref=@629f:e7] [cursor=pointer] [listener]
```

**没有 `controls=` 标记！** EP collapse 按钮 `aria-controls="el-collapse-content-0"`
指向 `<div role="region">` —— region 默认**非 interactive** (`filter=interactive` 跳过)。
filter=all 也跳过 region (TABLE_EXTRA_SELECTORS 扩展不含 [role=region])。

**B009 限制**: B008 修复仅在 aria-controls 指向**已收集元素**时输出 ref。指向非收集
区域(region / tabpanel / listbox / tree 容器)时仍静默, agent 看不到关联。

### 2.2 现场可生效场景 (interactive 元素间)

- `<button aria-controls="dialog-id">` 指向 dialog 容器 — dialog 容器若有 role=dialog
  可能被选(看具体实现)
- `<input aria-controls="tooltip-id">` 指向 tooltip
- 互引控件(button aria-controls 指向另一个 button/select)

## 3. 新缺陷 B009 — 关联到非收集元素时 controls 失效

### 3.1 现象

`controls?: number[]` type 限定为下标数组。当目标元素**不在 collectedEls** 时
(idxList 空),字段不写 —— agent 看不到 aria-controls 关联。

### 3.2 根因

`baseCandidates` 收集门 (line 2647+ INTERACTIVE_SELECTORS) 不收 region / tabpanel
等非交互容器。这些容器是 aria-controls 的典型目标。

### 3.3 修复方向 (后续 PR)

**方案 A**: 扩展 `baseCandidates` 收集 [role=region] / [role=tabpanel] /
[role=listbox] / [role=tree] 等容器。范围扩大但更完整。

**方案 B**: 修改 controls type 为 `Array<{ id?: string; index?: number }>`。
找不到下标时用 id 字符串, 渲染为 `controls=#el-collapse-content-0,@ref:ex`。
agent 至少看到 id 知道关联。

**推荐方案 B**: 改动小, 不扩大收集范围, agent 拿到 id 也能 querySelector 找目标。

### 3.4 桶归类

**vortex-defect**(B009): B008 修复局限, 关联到非收集元素时静默。

## 4. 总结 — 5 轮 vortex a11y 召回狗粮

| 轮 | 类型 | 关键产出 |
|----|------|----------|
| **R1** | 收尾 | B001/B002/B003/B004 4 个 a11y 修复接入真实路径 + 单测 1589+536 + 活复验 EP dialog + Tailwind pre |
| **R2** | 找 bug | B001 验证 + 发现 B005: aria-level DOM 嵌套深度 fallback 缺 |
| **R3** | 修 bug | B005 修复 inferTreeitemLevel 纯函数 + 8 用例 + 活复验 EP tree-select [level=1/2] 正确 |
| **R4** | 找 bug | B006: slider valuemin/max 暴露缺(记 backlog,未修) |
| **R5** | 修 bug | B008 修复 aria-controls 关联采集(限 interactive 元素间) + B009 限制记 backlog |

### 4.1 commit 链 (main)

```
b9b8b5d fix(observe): B008 aria-controls / aria-owns 关联采集
83b4182 docs(dogfood): R4 报告(B006 slider valuemin/max 缺失)
977bb91 docs(dogfood): R3 活复验报告(B005 aria-level 嵌套深度 fallback)
782579b fix(observe): B005 treeitem 嵌套深度 fallback
2c405ed docs(dogfood): R2 报告(B001 验证 + B005 新缺陷)
f35c28d docs(dogfood): R1 收尾活复验报告(B001/B002/B003/B004)
f914d7b test(observe): modal-scope 多信号判定单测(N0002 B002)
4b1b62e feat(observe-render): [level=N] 状态标记渲染(N0002 B001)
f4df710 fix(observe): B001/B003/B004 接入 scanOneFrame 真实路径
```

### 4.2 单测总计

- R1 收尾: 1589 + 536 = 2125 测试
- R3 B005: +8 = 2133
- R5 B008: +8 = **2141 测试** (extension 1605 + mcp 536)

### 4.3 backlog 待办

- **B006**: slider valuemin/max 暴露(独立字段 vs 拼接字符串设计决策)
- **B009**: aria-controls 限非收集元素 (方案 B 推荐)
- mcp tsc build FSWatcher.on 类型错误(独立 PR)

## 5. 工具栈总结

- **vortex mcp stdio 客户端** (`/tmp/mcp-r*.mjs`): 写 JS 脚本 spawn mcp 进程,
  调 `initialize` / `tools/call` 经 JSON-RPC, 实现 dogfood 评测。
- **vortex CLI**: tab / page / dom / content 短命令, navigate / click / eval。
- **真实 Chrome 扩展**: @crxjs HMR 自动重载 (修改 dist 后 5s 内 connect)。
