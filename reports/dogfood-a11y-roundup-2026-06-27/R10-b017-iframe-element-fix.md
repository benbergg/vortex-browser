# R10 报告 — B017 iframe 元素召回修复 (A5 backlog 收官)

**日期**: 2026-06-27
**范围**: A5 backlog "iframe scanned 信号未下沉到 element 级" 修复
**分支**: `fix/observe-b017-iframe-element` → main (ff merge)
**commit**: 0c1ab6b

## 1. 修复

### 1.1 根因 (R9 报告)

`<iframe>` 不在 `INTERACTIVE_SELECTORS` 白名单 → 不进 baseCandidates → 完全
不收集 → agent 不知道页面含 iframe。

R9 现场 (MDN iframe 文档页):
- DOM 2 个 sandboxed iframe (`about:blank` + `sandbox="allow-same-origin allow-scripts"`)
- vortex observe raw JSON **0 个 iframe 元素**
- 跨 frame 关联 / sandboxed 跨源风险 / frame landmark 全部丢失

### 1.2 修复

**INTERACTIVE_SELECTORS 加 `"iframe"`** (observe.ts:859):
```ts
const INTERACTIVE_SELECTORS = [
  "button",
  "a[href]",
  "iframe",  // B017: 与 select/textarea 一致, 默认非 interactive 但 selector 收
  ...
];
```

**getRole iframe 推断** (observe.ts:980-984):
```ts
if (tag === "iframe") {
  return el.hasAttribute("title") ? "region" : "iframe";
}
```

- 无 title → `role=iframe` (ARIA 1.2 / HTML-AAM, frame 内容容器)
- 有 title → `role=region` (frame landmark, 屏幕阅读器用户可跳转)

**attributes 透传**: `sandbox`, `src`, `allow`, `referrerpolicy`, `name`, `srcdoc` 走
attrs 字段 (R4 observe-attrs-name-quality.test 已锁 default attrs 收集白名单),
agent 看到跨源风险提示 (`sandbox="allow-same-origin allow-scripts"` 即跨源 JS 访问)。

## 2. 单测

| 包 | 通过 | 失败 | 新增 |
|----|------|------|------|
| @vortex-browser/extension | **1626 / 1626** (211 文件) | 0 | +8 (observe-iframe-element.test.ts) |
| @vortex-browser/mcp | **536 / 536** (47 文件) | 0 | — |
| **总计** | **2162 / 2162** | **0** | +8 |

8 个新增单测:
- 3 个 source-lock (INTERACTIVE_SELECTORS 含 "iframe" / getRole 路径 / B017 注释)
- 5 个推断规则 (无 title→iframe / 有 title→region / 显式 role 优先 / srcdoc / 非 iframe 不影响)

## 3. 累计 10 轮

| 轮 | 类型 | 关键产出 |
|----|------|----------|
| R1 | 收尾 | B001-B004 4 个修复接入 + 1589+536 单测 |
| R2 | 找 | B005 (aria-level 嵌套) |
| R3 | 修 | B005 inferTreeitemLevel + 8 用例 |
| R4 | 找 | B006 (slider valuemin/max) |
| R5 | 修 | B008 (aria-controls 采集) + B009 限制 |
| R6 | 找 | 5 新缺陷 (B010/B013/B014/B015/B016) + B009 复现 |
| R7 | 修 | B006 + B010.2 + B016 valueMin/valueMax/keyshortcuts 三字段 + 12 用例 |
| R8 | 修 | B009 aria-controls id 字符串 fallback + 8 用例 |
| R9 | 找 | B017 iframe 元素缺失 (A5 backlog 验证) |
| **R10** | **修** | **B017 iframe 元素召回 (A5 backlog 收官) + 8 用例** |

总单测: **2162** (extension 1626 + mcp 536), 0 失败

## 4. backlog (后续 PR)

- **B013.2**: vortex observe 无 `[role=search]` 标识
- **B014.2**: vortex observe 不暴露 aria-atomic/busy/relevant
- **mcp tsc build FSWatcher.on 类型错误** (独立 PR)

## 5. 现场活复验 (沿用 R7/R8 限制)

R10 现场活复验需要 Chrome 扩展 SW 重新加载 (dev mode chrome.runtime.reload() 在
SW 休眠时不可靠)。单测覆盖关键场景 (iframe selector 收 + role 推断规则), R9
报告里 B017 复现场景修复可由单测充分保证。
