# R9 报告 — A5 iframe 元素缺失 (B017 新缺陷)

**日期**: 2026-06-27
**范围**: 含 iframe 复杂站评测 + A5 iframe 信号下沉深度
**状态**: 发现新缺陷 B017,**R9 不修**(R10 修)

## 1. 测试目标

R9 跑含 iframe 复杂站, 验证 vortex observe 对 `<iframe>` 元素的召回能力。
A5 backlog: "iframe scanned 信号未下沉到 element 级" —— 期望 vortex 把 iframe
作为元素暴露给 agent (frame landmark / 跨源 / sandboxed 信息)。

## 2. 现场 (MDN iframe 文档页)

### 2.1 DOM iframe 真实情况

```
MDN (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
有 2 个 <iframe>:
  iframe[0]: src="about:blank", sandbox="allow-same-origin allow-scripts"
  iframe[1]: src="about:blank", sandbox="allow-same-origin allow-scripts"
```

### 2.2 vortex observe raw JSON 全文 (filter=all, maxElements=500)

搜 "iframe" / "frame" / "srcdoc" / "sandbox" / "about:" 关键字:

| 行 | 内容 | 类型 |
|----|------|------|
| 3-4 | URL 包含 "Elements/iframe" | 文档 URL, 非 iframe 元素 |
| 11-15 | `"frames": [...], "frameId": 0, "parentFrameId": -1` | 扫描结果 frame 索引, 非 iframe 元素 |
| 48+ | `frameId: 0` 散布 | 每个 element 标记属于哪个 frame, 非 iframe |

**全文 iframe 元素: 0 个**
**全文 sandboxed iframe 元素: 0 个**
**全文 srcdoc 元素: 0 个**

**vortex observe 完全忽略 `<iframe>` 元素本身！**

## 3. 缺陷 B017 — vortex iframe 元素召回

### 3.1 现象

`<iframe>` 不在 `INTERACTIVE_SELECTORS` (line 847+ observe.ts):
- iframe 无 `href` (排除 `a[href]`)
- iframe 默认无 `role` (排除 `[role=...]`)
- iframe 默认无 `onclick` / `tabindex` (排除 `[onclick]` / `[tabindex]`)
- iframe 不在 `INTERACTIVE_SELECTORS` 白名单内

→ iframe 完全不进入 `baseCandidates` → 不被 collect → 不暴露给 agent。

### 3.2 影响

- **agent 不知道页面含 iframe**: 多 frame 文档 (PDF embed / video / ad / 跨源
  widget) 完全透明, agent 只看到主 frame 内容。
- **跨 frame 关联丢失**: 父页 button 触发 iframe 内容变化 (`window.postMessage`),
  vortex observe 看不到 iframe ref, agent 无法 follow。
- **sandboxed iframe 跨源风险**: `sandbox="allow-scripts allow-same-origin"` 允许
  父页 JS 访问 iframe, 安全隐患, agent 应该看到警告。
- **A5 backlog 目标未达成**: "iframe scanned 信号未下沉到 element 级"。

### 3.3 桶归类

**vortex-defect**(B017): vortex observe 完全忽略 `<iframe>` 元素。

### 3.4 修复方向 (R10 修)

**方案 A**: 在 `INTERACTIVE_SELECTORS` 加 `"iframe"`, 走 `getRole()` 推断为
`role=iframe` 或 `role=region`(根据 title), 暴露 frame landmark + src + sandbox。

**方案 B**: 独立 "frame" pass 收集所有 iframe 元素 (含 hidden), 输出
`frame "MDN embed" [ref=@xxx:eN] src=... sandbox=... crossorigin=...`。

**推荐方案 A**: 与现有 select / textarea 一致 (默认非 interactive 但 selector 收),
新增 `<iframe>` 元素。getRole iframe 命中 line 855+ 的 tagName="iframe" 兜底。
sandbox / src 走 attributes 透传。

### 3.5 边界

- `iframe[hidden]` / `iframe[style*="display:none"]` 仍收集? — 不收, visibility 门
  挡 (line 2730-2735 checkVisibility())。
- cross-origin iframe content: 不可访问, 仅暴露 src + sandbox + title + role。
- recursive frame (iframe 内还有 iframe): collect 路径已支持 (allFrames)。

## 4. backlog 更新

- B017 (新, R9): vortex iframe 元素召回 — **R10 修**
- B009 (R5 找, R8 修): aria-controls 限非收集元素 — R8 已修, ghost id fallback
- B013.2 (R6 找): vortex observe 无 `[role=search]` 标识
- B014.2 (R6 找): vortex observe 不暴露 aria-atomic/busy/relevant
- mcp tsc build FSWatcher.on 类型错误

## 5. 累计 (R1-R9)

| 轮 | 类型 | 关键产出 |
|----|------|----------|
| R1 | 收尾 | B001-B004 4 个修复接入 |
| R2 | 找 | B005 (aria-level 嵌套) |
| R3 | 修 | B005 inferTreeitemLevel |
| R4 | 找 | B006 (slider valuemin/max) |
| R5 | 修 | B008 (aria-controls 采集) + B009 限制发现 |
| R6 | 找 | 5 新缺陷 (B010.1 / B010.2 / B013.1 / B013.2 / B014.1 / B014.2 / B015 / B016) + B009 复现 |
| R7 | 修 | B006 + B010.2 + B016 valueMin/valueMax/keyshortcuts 三字段 |
| R8 | 修 | B009 aria-controls id 字符串 fallback (R5 限制补全) |
| **R9** | **找** | **B017 iframe 元素缺失 (A5 iframe signal 未下沉)** |
| R10 (待) | 修 | B017 + 跑 Radix/menu 深度 |
