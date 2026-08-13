# vortex 使用日志缺陷分析

分析日期：2026-08-14

## 结论

本轮没有坐实 A 类工具缺陷。

- A 工具缺陷：0 个
- B 模型误用：3 个
- C 站点或环境：1 个
- 已在真实浏览器复现：4 个

当前窗口基线为 4187 次调用、272 次错误，错误率 6.5%。`vortex_act` 错误率最高（428 次中 98 次，22.9%），但本轮抽查到的错误都能由调用参数或运行环境解释，不能仅凭错误率认定为工具缺陷。

## 发现 B-1：把可见文本直接作为 target

### 现象

日志 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/60b113eb-c5cb-4296-b36e-d6246a0b5ef2.jsonl:1879-1881` 中调用：

```json
{"target":"查询按钮","action":"click"}
```

返回：

```text
Error [INVALID_SELECTOR]: target "查询按钮" looks like UI text passed as a selector ...
```

这是 B 类，不是行为缺陷：调用方把自然语言可见文本放进了只接受 CSS 或 `@ref` 的 `target` 字段。

### 复现

真实浏览器 tab `984533718`，页面为 `http://localhost:5173/synth/fingerprint-actions.html`：

1. 调用 `vortex_act(target="邮箱", action="click")`。
2. 实际返回：

```text
Error [INVALID_SELECTOR]: target "邮箱" looks like UI text passed as a selector: it is a bare type selector with no CSS structure and no hyphen, so it can only match a built-in HTML tag name (which is ASCII) — never a custom element (those require a hyphen). vortex_act target accepts a CSS selector ... or an @ref from vortex_observe.
```

3. 随后调用 `vortex_observe` 得到 `textbox "邮箱" [ref=@4ea8:e0]`，用 `@4ea8:e0` 操作可以成功。该结果证明错误提示给出的恢复路径可用。

### 根因

调用链是：

- `packages/mcp/src/tools/schemas-public.ts:42-45` 将 `target` 契约定义为 `@ref` 或 CSS selector，没有 visible-text locator 语义。
- `packages/mcp/src/lib/ref-parser.ts:90-99,144-150` 检测无 CSS 结构的非 ASCII 文本，并在 MCP 入口以 `INVALID_SELECTOR` 快速拒绝。
- `packages/extension/src/handlers/dom.ts:120-125` 仅对没有 descriptor 的 stale/not-attached selector 构造候选提示；本例在 MCP 层已提前拒绝，因此不会进入扩展层查找。

根因是模型选择了错误的定位契约，而不是 vortex 将合法 selector 错误解析。`target` 当前没有承诺按可见文本查找。

### 解决方案

不改行为。调用方应先 `vortex_observe`，再使用返回的 fresh `@ref`，或者传入明确的 CSS selector。

如果后续仍有大量同类 B 类错误，低成本改进是压缩并强化 schema 文案，明确写出“普通文本不是 selector；不要传按钮文字”，或增加一个独立的语义定位字段。不要把任意字符串自动解释成文本搜索：这会改变合法 CSS/type selector 的语义，并可能在重名元素上选错目标。

### 置信度

高。日志和真实浏览器返回一致；当前 schema、解析器和扩展入口的契约均已核对。

## 发现 B-2：observe 后继续使用旧 snapshot ref

### 现象

日志 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/49e35f05-b200-40da-a08c-b5ab107bdaa4.jsonl:5214-5218` 显示先产生新快照 `snap_msrepoda_3`，随后仍调用旧 ref `@8295:e0`，返回：

```text
Error [STALE_SNAPSHOT]: Ref bound to expired snapshot (hash mismatch)
Hint: Page has changed since the snapshot. Call vortex_observe to capture a fresh snapshot, then retry with the new ref.
```

这是 B 类：旧 ref 被新快照替换后继续使用，正是 hash 校验要阻止的情况。

### 复现

在真实浏览器中按同样流程操作：

1. `vortex_observe` 得到一组带 hash 的 refs，例如旧 ref `@4c29:e0`。
2. 再次调用 `vortex_observe`，活动快照变化。
3. 使用旧 `@4c29:e0` 调用 `vortex_extract`。
4. 实际返回：

```text
Error [STALE_SNAPSHOT]: Ref bound to expired snapshot (hash mismatch)
```

5. 使用新观察结果中的 fresh ref（当次验证为 `@3793:e0`）重试，实际返回：

```json
{"focused":true,"success":true,"value":"new@example.com"}
```

### 根因

调用链是：

- `packages/mcp/src/server.ts:523-565` 的 observe 专用分发在每次成功 observe 后更新 `activeSnapshotId`、`activeSnapshotHash` 和 tab 绑定。
- `packages/mcp/src/lib/ref-parser.ts:161-206` 解析带 hash 的 ref；当 ref hash 与当前 `activeSnapshotHash` 不一致时，在动作到达扩展前抛出 `STALE_SNAPSHOT`。
- `packages/mcp/src/lib/ref-parser.ts:200-204` 的具体条件是 `r.hash !== activeSnapshotHash`，错误消息明确要求重新 observe。

根因是调用方没有把 observe 输出视为一次性、与当前快照绑定的 ref 集合。这里没有发现工具把旧 ref 误当成 fresh ref，或在 hash 不同的情况下继续操作。

### 解决方案

不改行为。模型应在每次 observe 后只使用该次输出的 refs；页面变化、导航、reload 或新的 observe 后，应丢弃旧 refs 并重新取 ref。

可选的低成本改进是继续保留当前错误提示，并在 schema/使用示例中显式强调“新的 observe 会使旧 `@hash:eN` 全部失效”。不建议为了减少 B 类错误而静默按 index 迁移旧 ref；那会把可见的 stale 错误变成可能操作错误元素的 silent false success。

### 置信度

高。日志中有明确 hash mismatch，真实浏览器旧 ref 复现失败、fresh ref 重试成功。

## 发现 B-3：把 debug_read 的 pattern 当作正则表达式

### 现象

日志 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/60b113eb-c5cb-4296-b36e-d6246a0b5ef2.jsonl:5859-5862` 中调用：

```json
{"source":"network","filter":{"pattern":"header|column|query|table"},"tail":30}
```

返回：

```text
Error [TIMEOUT]: Request network.getLogs timed out
```

相邻日志 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/60b113eb-c5cb-4296-b36e-d6246a0b5ef2.jsonl:5895-5897` 在另一页重试同一 pattern，实际返回 `[]`，并附带“Network capture ... started with this call”的诊断。日志上下文还显示该调用发生在首次建立网络捕获或页面切换附近，因此 timeout 本身不能作为 pattern 语义缺陷的证据。

这是 B 类的调用语义误用：`pattern` 是 URL 子串，不是正则表达式。

### 复现

真实浏览器 tab `984533718`，同一 fixture：

1. 调用 `vortex_debug_read(source="network", filter.pattern="header|column|query|table", tail=10)`。
2. 实际返回为空数组（没有把 `|` 当成正则运算符）：

```json
[]
```

3. 改用实际 URL 子串 `fingerprint-actions`：

```json
[
  {
    "requestId": "13666.3",
    "url": "http://localhost:5173/synth/fingerprint-actions.html?header=vortex-analysis",
    "method": "GET",
    "type": "Fetch",
    "status": 200
  }
]
```

该结果证明 filter 是字面包含匹配，且可正常返回网络条目。

### 根因

调用链是：

- `packages/mcp/src/tools/schemas-public.ts:284-303` 将 network filter 描述为 `pattern`，并说明它是 flat key；当前公开文案没有明确写“substring/literal，不支持 regex”。
- `packages/extension/src/handlers/network.ts:334-359` 读取 `args.pattern`，最终在 `merged.filter((e) => e.url.includes(pattern))` 中做字面 `includes`。
- `packages/extension/src/handlers/network.ts:360-381` 随后执行 status、limit 和空结果诊断，未出现正则编译或正则匹配路径。

根因是模型按常见日志工具习惯把多个关键词拼成正则，但当前工具契约只提供 URL 子串过滤。前一次 `network.getLogs` timeout 更可能来自 lazy attach、页面/扩展状态或请求量，而不是证明该字符串应该支持正则。

### 解决方案

不改行为。调用方应使用单个 URL 子串；多个关键词应分多次读取，或先取得网络列表后在模型侧筛选。

低成本改进是把 schema description 改成“`pattern` is a literal URL substring; regex is not supported”，这样能减少误用而不增加执行复杂度。只有在有明确需求和性能预算时才考虑新增独立 `patternRegex` 字段；直接把现有字段改成正则会改变已有调用的字面匹配语义，并引入无效正则、ReDoS 和错误转义问题。

### 置信度

高（对 pattern 语义）；中（对日志中的 timeout 具体环境原因）。真实浏览器已验证字面过滤和成功读取，但没有把那次历史 timeout 归因到单一 hub/扩展内部原因。

## 发现 C-1：fresh ref click 在 hub-to-extension 边界超时

### 现象

日志基线 top error 有 40 次：

```text
act | Error [TIMEOUT]: Actionability timeout after Nms; last reason: NOT_ATTACHED
```

本轮还保留了一次不同层级的 click 超时候选：旧日志 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/60b113eb-c5cb-4296-b36e-d6246a0b5ef2.jsonl:5859-5862` 记录 network.getLogs timeout；当前真实浏览器对 fresh ref click 的实际返回为：

```text
Error [TIMEOUT]: Request dom.click timed out
Hint: The hub-to-extension request exceeded its deadline; the page itself may be fine. Retry with a larger timeout argument, or call vortex_observe to check the extension is still responsive.
```

### 分类与复现

归为 C 类环境/链路现象，不认定为 A 类工具缺陷。

真实浏览器 tab `984533718`、fixture `http://localhost:5173/synth/fingerprint-actions.html`：

1. `vortex_observe` 成功返回 fresh refs，例如 `textbox "邮箱" [ref=@a2fe:e0]`。
2. 立即调用 `vortex_act(target="@a2fe:e0", action="click", timeout=3000, observeEffect=true, windowMs=3000)`。
3. 实际返回 `Request dom.click timed out`，并提示 hub-to-extension deadline。
4. 同页重新 observe，使用 fresh `@4ea8:e0` 对同一邮箱字段执行 `fill`，实际成功返回：

```json
{"focused":true,"success":true,"value":"new@example.com"}
```

因此已复现“click 请求链路超时”，但未证明页面元素不可操作，也未证明 `dom.click` 的 actionability 逻辑错误。当前证据只支持 C/未归因的 transport、extension 状态或单次时序问题。

### 根因分析

当前代码证据链显示有多个独立 deadline：

- `packages/mcp/src/server.ts:530-547` 为 observe 等请求通过 `timeoutLadder` 设置 inner/hub 预算并调用 `sendRequest`。
- `packages/shared/src/timeout.ts:6-20,41-50` 规定 extension inner、hub pending、client transport 必须递增。
- `packages/mcp/src/client.ts:157-177` 设置比 hub 多一个 step 的 transport timer，并发送 `timeoutMs`。
- `packages/extension/src/action/auto-wait.ts:51-111` 对 actionability 做轮询，默认 2000ms，调用方 timeout 被 cap 到 25000ms；它会在 semantic failure 或轮询耗尽时返回带 `lastReason` 的 VtxError。
- `packages/extension/src/handlers/dom.ts:227-301` 的 click handler 在 actionability gate 后还要加载 page-side `dom-resolve`，必要时加载 `click-effect`，再进入 synthetic/CDP click 路径。

这条链路可以解释为什么一次 click 可能比简单 fill 更容易暴露边界超时，但本轮没有足够证据确定是哪个组件耗尽 deadline。另一个重要事实是：同一页面 fresh ref 的 fill 成功，排除了“tab 完全失联”以及“ref 一定 stale”这两个更窄的假设；不能据此推出 click 是工具缺陷。

### 解决方案

当前阶段不提出产品修复。应在后续专项诊断中记录每一层实际 deadline、request id、extension handler 开始/结束时间，并用稳定 fixture 重复比较 click、fill 和 `observeEffect` 开关；在没有边界时序证据前，不应调整 timeout 或改变 click 重试语义。

如果后续确认是环境噪声，保留当前错误提示并将其作为可重试的 C 类诊断即可。若确认是某一层 deadline 配置错误，再针对具体层修复，避免把 hub timeout 粗暴改成无限等待。

### 置信度

中。超时在真实浏览器复现，但根因仍未定位；同页 fill 成功只提供排除性证据。

## 已排除

- `act` 高错误率本身：日志中的 `NOT_ATTACHED` 既可能是不存在的目标，也可能是模型没有使用 fresh ref；没有逐条将 40 次签名归因到工具错误，因此不计 A 类。
- `target="查询按钮"`、`target="邮箱"` 和 `target="All statuses"`：它们分别是可见文本/自然语言，不是 CSS 或 fresh `@ref`。MCP 的明确 `INVALID_SELECTOR` 或扩展层 `NOT_ATTACHED` 是符合当前契约的 B 类结果。
- 旧 ref 的 TTL 假设：真实验证得到的是 MCP 层 `hash mismatch`，不是扩展侧 TTL 过期；`packages/mcp/src/lib/ref-parser.ts:196-204` 已在进入扩展前拒绝 hash 不匹配，因此不能把该样本报告成 snapshot TTL 缺陷。
- `debug_read` 首次懒 attach：日志中首次 network read 可能只返回空数组/诊断，且历史请求在 attach 前不一定有 CDP 记录；这是当前工具明确提示的采集时序，不能仅凭空返回认定过滤器丢数据。
- 单次 `network.getLogs` timeout：已在真实浏览器再次遇到 hub-to-extension timeout，但没有稳定重现到某个具体 pattern 或页面行为；作为 C 类链路现象记录，不计 A 类。
- `vortex_act` 的 selector parser：真实浏览器对非法 UI 文本给出明确 `INVALID_SELECTOR`，对 fresh ref 的 fill 成功；没有观察到错误 selector 被静默执行或错误元素被点击。

## 统计口径

“已复现 4 个”包括 B-1、B-2、B-3 三个调用误用和 C-1 一个链路现象。A 类为 0，因此本报告没有可提交的产品代码修复项，也没有修改产品代码或创建临时 fixture。
