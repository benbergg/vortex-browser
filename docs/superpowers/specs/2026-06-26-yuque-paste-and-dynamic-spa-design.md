# 设计：富文本粘贴（vortex_paste）+ 动态 SPA act 自愈增强

> 日期：2026-06-26
> 来源：审核 `docs/2026-06-25-yuque-paste-and-dynamic-spa-rootcause.md`，对其全部技术论断做白盒核实后产出。
> 架构前提：vortex = Chrome MV3 扩展 + native server + MCP，经 `chrome.debugger`(CDP) 驱动**真实登录态 Chrome**。

---

## 0. 审核结论（核实纪要）

对原根因文档逐条白盒核实，结论：**缺口一（富文本粘贴）诊断与方向全部准确；缺口二（动态 SPA）存在一处关键误诊。**

### 0.1 已核实属实

| 论断 | 证据 |
|---|---|
| 无 clipboard/paste 公开原语 | 工具集核对 |
| `Input.insertText` 只灌纯文本、不带 clipboardData | `packages/extension/src/handlers/dom.ts:751-766` |
| `editingCommandsForKey` 仅实现 `Cmd+A→selectAll`，paste/copy/cut/undo 未实现 | `packages/extension/src/handlers/keyboard.ts:105-118` |
| `navigator.clipboard.readText()` 无 OS 焦点时抛 `NotAllowedError` | 浏览器安全策略，原文实测 `document.hasFocus()===false` |
| `DEFAULT_TIMEOUT_MS=2000`、`NOT_ATTACHED` 自旋间隔 0 | `packages/extension/src/action/auto-wait.ts:16,27` |

### 0.2 关键误诊（须订正原文档）

原文档 §3 + 改进表称 act「**死盯同一 stale ref，而非重新解析选择器**」，并据此提改进「自旋时重新解析选择器」。**该诊断错误，对应修复无效**：

1. **gate 本就每轮重解析选择器**：`waitActionable` 自旋循环每轮调 `checkActionability → probe`，`probe` 跑 `document.querySelector(selector)`（`actionability.ts:293`），从不持有 stale 元素引用。
2. **已有 descriptor 自愈兜底**：超时且 `lastReason===NOT_ATTACHED` 时，`healAwareGate` 用 ref 携带的 descriptor(role+name) 全页按可访问名重匹配（`heal.ts` + `resolve-target.ts:57`）。

动态 SPA 上真正失败的三条真因（原文未命中）见 §2。

---

## 1. 缺口一设计：`vortex_paste`（富文本 / Markdown 粘贴）

### 1.1 核心判断

富文本编辑器（ProseMirror / Slate / Lexical / 语雀 Lake）的 Markdown 自动转换，**由编辑器自身监听 `paste` 事件 → 读 `clipboardData` → `preventDefault` → 自行插入并转换**，不依赖浏览器默认插入、绝大多数不校验 `isTrusted`。

因此原文档提议的 `commands:["paste"]` + 写系统剪贴板路径，反而是**更脆弱**的方案：
- CDP **无**设置剪贴板的原语；只能 host 侧 `pbcopy`/`clip`/`xclip`（仅文本、三平台分支）或 page 侧 `navigator.clipboard.write`（回到焦点/权限受限的老问题）。
- `Input.dispatchKeyEvent` 的 `commands` 字段**仅 macOS** 生效（NSResponder 编辑命令层）。

更简单、跨平台、零焦点依赖的主路径是**页面侧合成 `ClipboardEvent('paste')` + 构造的 `DataTransfer`**。`new DataTransfer()` 在现代 Chrome 已可构造，`clipboardData` 经构造器 init dict 传入即生效。

### 1.2 方案权衡（已定：混合）

| 方案 | 兼容性 | 复杂度 | 跨平台 |
|---|---|---|---|
| **S 合成 ClipboardEvent**（主路径） | 覆盖自管 paste 的富文本编辑器（大多数）；被校验 isTrusted 的编辑器拒收 | 低（纯 page-side） | 天然全平台、无焦点依赖 |
| **T 可信 CDP 粘贴**（commands + OS 剪贴板） | 最高（trusted） | 高（剪贴板分支 + mac-only commands + 焦点/shell） | 差，需逐平台 |
| **混合**（首版落地） | S 主路径 + 回读护栏；命中 NO_EFFECT 才提示升级到 T | 中 | 主路径全平台，T 记在案 |

**决定**：首版实现混合方案——S 为主路径 + 回读护栏；T 写进本 spec 作未来 escalation（首版**不**实现）。`vortex_clipboard_set/get` 与粘贴解耦、无实际需求，**不做**（合成路径不碰 OS 剪贴板）。

### 1.3 接口

新增公开工具 `vortex_paste`，action 归入 `DomActions`（命名 `dom.paste`，与 `dom.type` / `dom.fill` 同形，因其针对元素并经 actionability gate）。

```
vortex_paste({
  target: string,        // @ref 或 CSS selector，指向编辑器 / contenteditable
  text: string,          // text/plain 载荷（即 Markdown 源文本）
  html?: string,         // 可选 text/html 载荷
})
```

- schema 形态对齐 `packages/mcp/src/tools/schemas-public.ts` 既有 gated 原语（target + 文本参数 + 可选 timeout/force，复用现有约定）。
- 返回 `{ success: true, target, healed?, ... }`，与 click/fill 路径一致。

### 1.4 Handler 流程（host → page-side）

1. **解析 target**：`resolveTarget(args)`，拿到 selector + 可选 descriptor（复用既有逻辑）。
2. **actionability gate**：`healAwareGate(...)`（复用，含缺口二增强后的自愈）。
3. **聚焦 + 定位光标**：复用现有 contenteditable 聚焦逻辑（对齐 `dom.ts` type 路径的 focus + selection 处理），使粘贴落在 caret 处。
4. **page-side（MAIN world）合成派发**：
   ```js
   const dt = new DataTransfer();
   dt.setData('text/plain', text);
   if (html != null) dt.setData('text/html', html);
   const evt = new ClipboardEvent('paste', {
     clipboardData: dt, bubbles: true, cancelable: true,
   });
   targetEl.dispatchEvent(evt);
   ```
5. **回读护栏（族 A 范式，对齐 insertText 路径 `dom.ts:765-793`）**：
   - 派发前捕获 `textContent`（`ceText` 基线）。
   - 派发后比对：若 `now === before` 且非空文本未含入 → 判定编辑器拒收（很可能校验了 isTrusted），返回 `NO_EFFECT`，hint 指向升级到方案 T。
   - 排除「重粘相同文本」假阳：参照 insertText 护栏的 `now !== txt` 判据。

### 1.5 回退阶梯

- **plain `<input>` / `<textarea>`**（非 contenteditable、无 Markdown 语义）：合成 paste 的浏览器默认插入对这类元素不触发，故这类目标**不走 paste**，路由到既有 `dom.fill` / insertText。`vortex_paste` 仅对 contenteditable 生效；非 contenteditable 时给出明确提示「用 vortex_fill」。
- **方案 T（escalation，记在案，首版不实现）**：若某编辑器校验 isTrusted 拒收合成事件，未来在 `vortex_paste` 上加 `trusted:true` 开关，走「host 侧填充 OS 剪贴板（pbcopy / clip / xclip）+ `editingCommandsForKey` 补 `paste` + `Input.dispatchKeyEvent` Cmd/Ctrl+V 携 `commands:["paste"]`」。届时一并补全 `editingCommandsForKey` 的 paste/copy/cut/undo（已有 selectAll 范式）。

### 1.6 硬风险与验证计划

**唯一硬风险**：语雀 Lake 是否校验 `isTrusted`。
- **必须**在实现期用真实登录态 Chrome 对真实语雀文档**实机 spike**（符合「报告诊断默认不可信须白盒实机核实」纪律）。
- spike 步骤：observe 定位 Lake 编辑器 → `vortex_paste` 灌一段含 `# 标题` / 表格的 Markdown → 截图 + 回读 textContent 确认是否转换为富文本结构。
- 若 Lake 拒收合成事件 → 升级方案 T 并重测；若接受 → 首版收口。

---

## 2. 缺口二设计：动态 SPA act 自愈增强

订正方向：「自旋时重新解析选择器」**已在做**（gate 每轮 `querySelector`），不改。真正三条真因对应三个改动。

### 2.1 B1 — heal 候选集捞不到虚拟表格单元格

- **现状**：`heal.ts:108` 候选只扫 `a,button,input,select,textarea,[role],[onclick],[tabindex]`。vxe-table 单元格是裸 `<td>`/`<div>`，永远落不进候选 → 必然 `STALE_REF`，自愈对这类元素结构性失效。observe 存的 `hit.selector` 多为 nth-child 链，重渲染后结构性失配。
- **改**：窄候选集按 `descriptor.name` **零命中**时，回退到一次「全元素按可访问名扫描」（候选放宽到全体元素或追加 `td,th,li,[class]` 等）。
- **护栏**：仍走既有 `AMBIGUOUS_DESCRIPTOR` 歧义判定——宽集多命中即拒绝自愈，不引入误选。窄集优先、宽集兜底，日常路径不受影响。

### 2.2 B2 — heal 只在 2s 超时后触发一次

- **现状**：`healAwareGate` 是「gate → 超时 → heal 一次 → 再 gate」。打标（`data-vtx-heal`）到真正动作之间页面再次重渲染就抛错，无第二次自愈。
- **改**：在自旋循环内，连续 `NOT_ATTACHED` 达阈值（~500ms）即**中途按 descriptor 重定位**并切到 healed 选择器继续自旋——把「按名重找」从一次性事后兜底变为自旋期持续重定位。持续重渲染的元素能被名字反复锁定，而非死等 2s 后才试一次。
- **实现位置**：`waitActionable`（`auto-wait.ts`）需能在 descriptor 存在时于循环内回调 heal；或将 heal 触发逻辑下沉进自旋。保持 force/timeout 语义不变。

### 2.3 B3 — 终态错误提示指向动态 SPA 套路

- **现状**：heal 也失败时抛 `STALE_REF` / `TIMEOUT`，hint 较泛。
- **改**：终态 hint 明确给出「act 前紧贴一次 `vortex_observe` / 强动态区改用 `vortex_evaluate` 现查 DOM 或框架实例（如 `el.__vueParentComponent` 上行找组件）」的指引，把原文档 §5 的规避经验固化进 hint。保留 `timeout` 可调说明。
- **不做**自动 re-observe（属 agent 职责）。

### 2.4 附带 — 订正原根因文档

修订 `docs/2026-06-25-yuque-paste-and-dynamic-spa-rootcause.md`：删除「死盯 stale ref / 不重解析选择器」的错误表述与对应改进项，替换为本 spec §0.2 + §2 的三条真因。

---

## 3. 单元 / 边界划分

| 单元 | 职责 | 依赖 | 测试 |
|---|---|---|---|
| `dom.paste` handler | 解析 target → gate → 聚焦 → 派发合成 paste → 回读护栏 | `resolveTarget` / `healAwareGate` / debuggerMgr | handler 单测（合成事件、回读 NO_EFFECT、非 contenteditable 路由）|
| page-side 合成派发体 | 构造 DataTransfer + ClipboardEvent + dispatch + 回读 | 无（纯 page-side，`new Function` 注入复刻剥离作用域单测）| page-side 注入单测 |
| `vortex_paste` schema | 公开工具描述 + 参数 | schemas-public | tools/list 预算回归 |
| heal 候选集放宽（B1）| 窄集零命中 → 宽集 + 歧义护栏 | `heal.ts` `__inlineMatch` | heal 候选集单测（裸 td 命中 / 多命中拒绝）|
| 自旋期重定位（B2）| 循环内达阈值触发 descriptor heal | `auto-wait.ts` / `heal.ts` | waitActionable 重定位单测 |
| 终态 hint（B3）| 强动态 SPA 指引文案 | `errors.hints.ts` / `auto-wait.ts` | hint 文案断言 |

---

## 4. 验收标准

- **缺口一**：`vortex_paste` 对至少一个真实富文本编辑器（语雀 Lake 实机 spike）成功灌入 Markdown 并转换为富文本；编辑器拒收时返回 `NO_EFFECT`（非假成功）。非 contenteditable 目标给出路由提示。
- **缺口二**：构造 / 复现一个虚拟滚动重渲染场景，act 经 B1+B2 自愈成功命中裸单元格；heal 失败时终态 hint 含动态 SPA 套路。
- **回归**：bench 全绿；ext/mcp 单测全绿；tools/list 预算不超。
- **纪律**：承重墙改动（heal / auto-wait）须活浏览器 spike 验证（对齐既往教训）。

---

## 5. 非目标（YAGNI）

- `vortex_clipboard_set/get` 独立原语 —— 合成 paste 不需要，无实际需求，不做。
- 方案 T 可信 CDP 粘贴 —— 首版不实现，仅记在案（§1.5）。
- 自动 re-observe —— 属 agent 职责，不做。
- `editingCommandsForKey` 补全 paste/copy/cut/undo —— 仅在升级方案 T 时连带做，首版不做。

---

## 6. 证据文件索引

- `packages/extension/src/handlers/keyboard.ts:82-118`（CDP 绕过 OS 键绑定；editingCommandsForKey 仅 selectAll）
- `packages/extension/src/handlers/dom.ts:751-793`（`Input.insertText` 纯文本 + 族 A 回读护栏范式）
- `packages/extension/src/action/auto-wait.ts:16-27`（2000ms / NOT_ATTACHED 即时自旋）
- `packages/extension/src/page-side/actionability.ts:293,299-301`（probe 每轮 querySelector / NOT_ATTACHED 判定）
- `packages/extension/src/action/heal.ts:94-136`（descriptor 自愈 + 候选集 line 108）
- `packages/extension/src/lib/resolve-target.ts:57-67`（ref→selector + descriptor 携带）
- `packages/extension/src/handlers/dom.ts:97-116`（healAwareGate：超时后一次性自愈）
