# 根因分析：富文本粘贴（语雀 Lake）缺口 + 强动态 SPA 截图依赖

> 来源：2026-06-25 实战会话（Claude Code 用 vortex 驱动真实 Chrome，给语雀文档上传 Markdown、并在 voc 工单页做 UI 校验）。
> 结论：暴露两个能力缺口——① 无「真实粘贴 / 富文本 Markdown 转换」路径；② act/observe 在强动态 SPA（Lake 编辑器、vxe-table 虚拟滚动）上失稳，被迫退回 `vortex_evaluate` 裸 DOM + 频繁截图。
> 
> **订正**：原『不重解析选择器』为误诊——gate 每轮已重解析选择器（actionability.ts:293），真因见 §3。
> 
> 架构前提：vortex = Chrome MV3 扩展 + native server + MCP，经 `chrome.debugger`(CDP) 驱动**真实登录态 Chrome**（非 Playwright headless）。

---

## 1. 现象

| # | 现象 | 影响 |
|---|------|------|
| A | 给语雀（banniu.yuque.com，Lake 编辑器）粘贴 Markdown：第一次侥幸成功转换，重粘时未转换（以原始 `# 标题`/`\| 表格 \|` 纯文本插入），且 `navigator.clipboard.readText()` 报 `NotAllowedError: Document is not focused` | 无法稳定把 Markdown 灌进富文本编辑器；最终交还人工 |
| B | `vortex_act` 在 Lake 编辑器 / voc 工单 vxe-table 上反复 `Actionability timeout ... NOT_ATTACHED` | 放弃 act，改用 `vortex_evaluate` 现查 DOM/Vue 实例 + 大量 `vortex_screenshot` 看状态 |

---

## 2. 缺口一：富文本粘贴 / Markdown 转换（现象 A）

富文本编辑器（语雀 Lake、Notion、ProseMirror 系）的 **Markdown 自动转换只在真实 `paste` 事件（携带 `clipboardData`）时触发**。vortex 当前**没有任何产生真实粘贴的路径**：

1. **无 clipboard / paste 工具**。公开工具集（`vortex_act/type/fill/press/select/...`）中无 clipboard、无 paste 原语。

2. **文本插入 = CDP `Input.insertText`（纯文本，非 paste）**
   - `packages/extension/src/handlers/dom.ts:751-766`、`packages/extension/src/action/fallback.ts:99-113`。
   - 注释原文：「contentEditable path — Input.insertText is the only way to ...」。
   - 它给编辑器一个 trusted 的 `beforeinput/input`，能把字符送进 contenteditable——但**不是 paste、不带 `clipboardData`**，因此 Lake 不做 Markdown 转换，`#`/表格语法被当**纯文本**原样插入（即重粘时看到的「未转换」）。

3. **`vortex_press` 的 Cmd+V 是哑的**
   - `packages/extension/src/handlers/keyboard.ts:82-101`：合成的 CDP `Input.dispatchKeyEvent` **绕过 macOS NSResponder 键绑定层**，编辑类快捷键不会自动执行，须随 keyDown 显式传 CDP `commands` 字段（对齐 Playwright `macEditingCommands`）。
   - `editingCommandsForKey()`（同文件 105+）**目前只实现了 `Cmd+A → selectAll`**；`copy/cut/paste/undo` 仍是注释里写的「扩展点」，**未实现** → `vortex_press` 发 Cmd+V 不触发粘贴。

4. **`navigator.clipboard.readText()` 在自动化上下文被拒**
   - 扩展 `vortex_evaluate` 运行在内容脚本世界，且自动化窗口**无 OS 焦点**（实测 `document.hasFocus()` 恒 `false`）→ 浏览器安全策略直接抛 `NotAllowedError: Document is not focused`。
   - 这也解释「第一次成功、之后不可复现」：首粘时窗口恰有焦点，`readText` 拿到 `pbcopy` 内容 + 手搓的合成 `ClipboardEvent` 生效；焦点一丢即失效。

> **净结论**：当前 vortex 对「向富文本编辑器粘贴 Markdown 并转换」无受支持路径；唯一文本通道 `Input.insertText` 只能灌纯文本。

---

## 3. 缺口二：强动态 SPA 上 act/observe 失稳 → 截图依赖（现象 B）

1. **act 默认 actionability 超时仅 2000ms**
   - `packages/extension/src/action/auto-wait.ts:18`（`DEFAULT_TIMEOUT_MS = 2000`，2026-06-09 为提速从 5000 收紧）。
   - `NOT_ATTACHED` 重试间隔 0（立即自旋）：`auto-wait.ts:27`。
   - 2s 内元素仍未稳定附着 → 抛 `TIMEOUT`，`lastReason=NOT_ATTACHED`：`packages/extension/src/page-side/actionability.ts:299-301`。

2. **目标页是最不利场景**
   - 语雀 Lake 编辑器：contenteditable 持续重渲染。
   - voc 工单 **vxe-table 虚拟滚动**：单元格随滚动高频 attach/detach。
   - 结果：observe 拿到的 ref 转瞬 stale，元素在 2s 窗口内反复脱离 DOM → `NOT_ATTACHED → TIMEOUT`（即反复看到的 act 失败）。

3. **强动态 SPA act 失稳的三条真因**
   
   **B1 — heal 候选集捞不到虚拟表格单元格**
   - 现状：`heal.ts:108` 候选仅扫 `a,button,input,select,textarea,[role],[onclick],[tabindex]`。vxe-table 单元格是裸 `<td>`/`<div>`（无 role、无 onclick、无 tabindex），永远落不进候选 → 必然 `STALE_REF`，自愈对这类元素结构性失效。
   - 真因：候选集过窄，导致虚拟表格等无语义装饰的结构无法自愈。
   
   **B2 — heal 只在 2s 超时后触发一次**
   - 现状：`healAwareGate` 是「gate → 超时 → heal 一次 → 再 gate」。打标（`data-vtx-heal`）到真正动作之间页面再次重渲染就抛错，无第二次自愈。
   - 真因：heal 生命周期与重渲染周期不同步，持续重渲染的动态 SPA 无法在自旋期持续重定位。
   
   **B3 — 终态错误提示指向动态 SPA 套路**
   - 现状：heal 也失败时抛 `STALE_REF` / `TIMEOUT`，hint 较泛。
   - 真因：终态提示未对动态 SPA 场景专项指引（如「act 前紧贴一次 `vortex_observe`、或改用 `vortex_evaluate` 现查 DOM/Vue 实例」）。
   
   - 虚拟滚动/canvas 类内容 `vortex_get_text/extract` 也读不全。
   - → 「看状态」只剩 `vortex_screenshot` 最可靠，「定位元素」只剩在 `vortex_evaluate` 里现查 DOM / Vue 组件实例（`el.__vueParentComponent` 上行找组件，比 DOM 点击稳）。

---

## 4. 改进建议

| 缺口 | 建议（按性价比） |
|---|---|
| 富文本粘贴 Markdown | 新增 `vortex_paste(text/html)` 原语：host 侧经 CDP 把内容写入系统剪贴板后，用 `Input.dispatchKeyEvent` keyDown 携 `commands:["paste"]` 触发编辑器粘贴命令；并在 `editingCommandsForKey` 补全 `paste/copy/cut/undo`（已有 `selectAll` 范式可仿）。 |
| clipboard 读写 | 暴露 `vortex_clipboard_set/get`（host 侧 CDP，不依赖页面焦点），替代受限的 `navigator.clipboard.*`。 |
| 动态 SPA act 失稳 | heal 候选集放宽 + 自旋期 descriptor 重定位 + 终态指引 |
| 减少截图依赖 | `get_text/extract` 增强对 contenteditable / 虚拟滚动的结构化提取；或提供「读富文本编辑器内容」专用能力。 |

---

## 5. 给使用方（agent）的即时规避

- **选场景 / 全选 / 清空** 这类，优先 `vortex_press Meta+A`（selectAll 已实现），而非手搓 Selection API（Lake 会忽略 JS Selection）。
- **强动态页**（虚拟表格 / 富文本）：定位优先走 `vortex_evaluate` 现查 DOM 或框架实例；看状态用截图；少用基于 observe ref 的 `vortex_act`。
- **富文本粘贴 Markdown**：vortex 当前能力下不该走自动化，应一开始就交还人工（本次最终即如此处理）。

---

> 证据文件索引：
> - `packages/extension/src/handlers/keyboard.ts:82-101`（CDP 绕过 OS 键绑定；paste 未实现）
> - `packages/extension/src/handlers/dom.ts:751-766` / `action/fallback.ts:99-113`（`Input.insertText` 纯文本）
> - `packages/extension/src/action/auto-wait.ts:18,27`（2000ms / NOT_ATTACHED 立即自旋）
> - `packages/extension/src/page-side/actionability.ts:299-301`（NOT_ATTACHED 判定）
> - `packages/extension/src/action/heal.ts`（选择器自愈范围）
