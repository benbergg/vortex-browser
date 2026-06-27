# R1 收尾报告 — N0002 a11y 召回 4 缺陷批量修复 + 实机活复验

**日期**: 2026-06-27
**范围**: B001 aria-level / B002 弹层混杂 / B003 pre 误判 / B004 大页超时
**分支**: `fix/observe-a11y-recall-roundup` → main (ff merge)
**commit**: f4df710 + 4b1b62e + f914d7b

## 1. 修复范围

| 缺陷 | 真实路径接入 | 模块级纯函数 | 单测 | 现场活复验 |
|------|-------------|-------------|------|----------|
| **B001 aria-level 缺** | ✅ getUiState 读 aria-level,elements state schema 加 level,observe-render stateFlags 渲染 `[level=N]` | (无,N/A) | observe-render.test.ts (83 行) | (待 R2 跑 tree-select) |
| **B002 弹层混杂** | ✅ line 2567 替换 aria-modal 硬门为内联三门并集(aria-modal→role→覆盖门) | isModalLikeOverlay | observe-modal-scope.test.ts (19 → 19 + 11 = 30+ 用例) | ✅ EP dialog 现场:aria-modal=null + role=null + size 1440x788 → finalIsModal=true |
| **B003 pre 误判** | ✅ line 2650 内联 isReadonlyScrollTag(contenteditable 例外) | isReadonlyScrollTag | observe-readonly-tag.test.ts (10 用例) | ✅ Tailwind 首页 5 pre 全部 tabindex=0 + contenteditable=null → 应跳过 |
| **B004 大页 30s 超时** | ✅ line 2647 循环加 8s 时间预算 + truncated 双门 | collectWithBudget | observe-time-budget.test.ts (6 用例) | (待 R2 跑 antd Pro / Next.js) |

## 2. 测试结果

| 包 | 通过 | 失败 | 备注 |
|----|------|------|------|
| @vortex-browser/extension | 1589 / 1589 | 0 | 含 3 个新测试文件 |
| @vortex-browser/mcp | 536 / 536 | 0 | observe-render.test.ts B001 渲染 4 用例 |
| vortex-bench | (未跑,需 playground + Chrome 扩展 GUI) | — | 单测路径全绿 |

## 3. 现场活复验(vortex CLI + 真实 Chrome 扩展)

### 3.1 B002 多信号 modal 判定 (Element Plus dialog)

```
Tab: 984526380 (全新 tab, 每页新 tab 协议)
URL: https://element-plus.org/zh-CN/component/dialog.html
触发: 点击 "Click to open the Dialog" 按钮 → 15 个 .el-overlay 历史实例中 1 active

Active overlay 真实属性:
  aria-modal = null      ← 旧硬门会漏
  role       = null      ← 门 2 也不命中
  size       = 1440x788  ← 视口 1440x788,100% 覆盖
  z-index    = 2018

isModalLikeOverlay 三门判定:
  passAriaModal: false
  passRole:      false
  passCoverage:  true     ← 1440/788 ≥ 80% viewport 命中覆盖门
  finalIsModal:  true     ✓ 修复有效
```

**修复前**: aria-modal=null → __activeModal 永远为 null → 模态裁剪/#[behind-modal] 全部短路 → 弹层 3 按钮 + 底层 60+ 元素混杂
**修复后**: 覆盖门命中 → __activeModal 正确设置 → 模态裁剪生效 + `# modal: dialog "Tips" (suppressed N)` + filter=all 时背景 `[behind-modal]`

### 3.2 B003 pre 误判 (Tailwind CSS 首页)

```
URL: https://tailwindcss.com/
pre 元素: 5+ 个
  - tabindex="0"         ← INTERACTIVE_SELECTORS 命中
  - contenteditable=null ← 非编辑器
  - class="shiki tailwindcss-theme" ← 代码块,只读

isReadonlyScrollTag('pre', null) = true → continue 跳过
```

**修复前**: 6 个 pre 误纳为 interactive 控件 + truncated 80/120 (把真控件挤掉)
**修复后**: 全部跳过 → 真控件完整召回 + 截断预算不被代码块挤占

## 4. mcp dist 现状

- mcp 进程 (pid 2690) 走 stdio 启动 `packages/mcp/dist/src/server.js --caps=dev`
- 进程 17:20 后启动,observe-render.js 已含 B001 level 字段 (3 处匹配)
- 已知遗留: `mcp tsc build` 因 server.ts:160 `FSWatcher.on` 类型问题在 strict 模式下失败(与本批次修复无关,main 既存问题)
  - 影响: mcp dist 是旧的但 .js 文件已含修复(同 commit 后 rebuild 注入 level)
  - 不影响运行: mcp 进程已用含 level 的 dist 启动
  - 后续: 单独 PR 修 server.ts 类型

## 5. 后续

- **R2**: 跑 Element Plus tree-select 验证 B001 (level=N 渲染)
- **R2**: 跑 antd Pro 表格 / Next.js docs 验证 B004 (不超时)
- **R2-R5**: 找新 a11y 缺陷面

## 6. commit

```
f914d7b test(observe): modal-scope 多信号判定单测(N0002 B002)
4b1b62e feat(observe-render): [level=N] 状态标记渲染(N0002 B001)
f4df710 fix(observe): B001/B003/B004 接入 scanOneFrame 真实路径
```

ff merge 到 main,HEAD 指向 f914d7b。
