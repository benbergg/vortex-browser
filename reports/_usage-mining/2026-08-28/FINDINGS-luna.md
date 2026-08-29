# vortex 日志缺陷分析

## 结论

本轮没有证据证明 `act`、`evaluate`、`query` 或 DOM action 的主执行语义存在新的 A 类缺陷；它们的失败均能由调用方脚本/参数、页面状态或调试器环境解释。

发现 1 个带真实复现证据的 A 类工具边界，拆成两个相互关联的缺陷候选：`vortex_dev_reload` 在 browser 绑定竞态下不恢复，以及该失败分支没有遵守统一错误信封。两者都发生在同一条 dev-only 工具路径，建议合并修复和回归覆盖。

统计口径严格沿用 `scripts/usage-baseline/collect.mjs`：按 `tool_result.is_error === true` 配对统计；另用 Node `readline` 流式扫描原始 JSONL，未整文件加载或重新遍历 864M 日志。

- 3 天：695 次，38 错（5.5%）；15 个 `evaluate|TIMEOUT`、4 个 `navigate|TIMEOUT`、4 个 `evaluate|JS_EXECUTION_ERROR`。
- 14 天：3860 次，183 错（4.7%）；错误码总量为 `TIMEOUT 79`、`SELECTOR_AMBIGUOUS 20`、`OBSCURED 20`、`JS_EXECUTION_ERROR 17`、`NOT_ATTACHED 8`、`CDP_NOT_ATTACHED 7`、`INVALID_PARAMS 6`、`PAGE_NOT_READY 3`、`STALE_SNAPSHOT 2` 等。
- 3 天窗口 Top1 会话占 77.3%，因此跨期判断以 14 天窗口为准。

## 候选 1：`vortex_dev_reload` 固定使用已失效的 browserId，不做竞态恢复

**一句话结论**：`diagnostics.version` 返回的 browserId 在重载 POST 前已经失效时，`vortex_dev_reload` 只把旧 ID 原样再发一次，直接失败，没有重新解析当前 browser 或进行一次有界重试。

**分类**：`A 工具缺陷`

**证据**：

1. `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/50fa3fbf-5773-484f-8497-bb9007299807.jsonl`，`tool_use_id=toolu_014yj78JUARBLYWAaJ1Jnafg`，实际入参 `{}`。错误全文：

   ```text
   {
     "reloaded": false,
     "error": "INVALID_PARAMS",
     "message": "未知 browser: 1a275b0c-5105-4083-b84f-b012fcbe04e6",
     "hint": "扩展连着(当前绑定 1a275b0c-5105-4083-b84f-b012fcbe04e6),重载触发被 hub 拒绝——按上面的 error/message 处理,不要去查扩展是否加载。"
   }
   ```

2. `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/9de9aafa-a6ae-4641-b6e8-aa52394451a8.jsonl`，`tool_use_id=toolu_01RDtW7q5ZW3yb3SnFswxhCz`，实际入参 `{}`。错误全文与样本 1 相同，browserId 仍为 `1a275b0c-5105-4083-b84f-b012fcbe04e6`。

3. 当前源码 `packages/mcp/src/server.ts:403-425` 先从 `diagnostics.version` 读取 `before.browserId`，随后只构造一次 `POST /dev/reload-extension`，把该 ID 放进 body；没有针对 HTTP 404/`INVALID_PARAMS` 的重新绑定路径。`packages/hub/src/http-routes.ts:250-260` 对已不存在的 ID 必然返回“未知 browser”。

**归因四问**：

1. **实际入参有问题参数吗？** 有。公共工具入参虽为 `{}`，但该调用的有效下游入参是 server 从第一次 `diagnostics.version` 响应取得并注入 POST body 的 `browserId`；错误全文直接确认该 ID 已成为 hub 的实际入参。
2. **下游有消费者吗？** 有。`server.ts:408-410` 读取 `VtxResponse.browserId`，`server.ts:421-425` 将其作为 `/dev/reload-extension` 的路由参数；hub 的 `selectBrowser` 在 `http-routes.ts:250-258` 消费并校验它。
3. **改前 vs 改后行为会不同吗？** 会。对同一类“第一次诊断成功、POST 前 browser 消失或重连”的状态，增加一次重新诊断/当前 browser 选择或有限重试后，行为会从确定性 404 失败变为可能成功重载；若期间确实没有 browser，则仍应返回 `EXTENSION_NOT_CONNECTED`。
4. **修改后的路径真实环境会走到吗？** 会。该工具真实调用入参就是 `{}`，且 14 天内同一失效 ID 的 `INVALID_PARAMS` 失败出现 2 次；现有测试只覆盖静态传递 ID，不覆盖 ID 在两次请求之间失效的竞态。测试命令 `pnpm --filter @vortex-browser/mcp exec vitest run tests/dev-reload-browser-binding.test.ts --maxWorkers=2 --minWorkers=1` 当前 5/5 通过，但不能证明竞态已覆盖。

**建议的修复方向**：

在收到“未知 browser”或诊断请求与 POST 之间连接发生变化时，重新获取一次当前绑定并最多重试一次；重试仍无 browser 时明确返回连接错误。为该竞态增加一个模拟 browser 消失/重连的测试。

## 候选 2：`vortex_dev_reload` 的失败响应绕过统一 `Error [CODE]` 错误信封

**一句话结论**：`vortex_dev_reload` 在 HTTP 失败时虽然设置了 `isError: true`，却把 `{error,message,hint}` 序列化成普通 JSON 文本返回，导致调用方和错误聚合器无法按所有 vortex 工具通用的 `Error [CODE]: ...` 契约识别它。

**分类**：`A 工具缺陷`

**证据**：

1. 上述两个 `vortex_dev_reload` 样本以及 `/Users/lg/.claude/projects/-Users-lg-workspace-vortex/91c5ffb4-b44a-4495-898b-8e4e5cd12200/subagents/agent-a1aab8002dbdc2a63.jsonl` 中的 `tool_use_id=toolu_019VpxCTv5XQ5kBG3aAgAHii`（实际入参 `{}`）均以 JSON 对象文本开头，而不是 `Error [INVALID_PARAMS]` 或 `Error [EXTENSION_NOT_CONNECTED]`。
2. 当前源码 `packages/mcp/src/server.ts:431-445` 和 `:448-455` 在 `isError: true` 分支直接返回 JSON/普通文本；同文件 `:80-85` 定义的统一 `formatError` 约定没有被该分支使用。
3. 全错误码扫描按 `is_error` 统计时把这 3 个 `dev_reload` 失败归为 `NO_CODE`，而不是 `INVALID_PARAMS`/`EXTENSION_NOT_CONNECTED`；这不是关键词误收，而是响应文本本身没有标准错误前缀。

**归因四问**：

1. **实际入参有问题参数吗？** 有。三个失败的公共入参均为 `{}`，是合法的 dev_reload 默认调用；错误码丢失发生在该调用返回的实际文本格式，不是调用方漏传字段。
2. **下游有消费者吗？** 有。MCP 调用方只能从 `tool_result.is_error` 和 text content 消费错误；`scripts/usage-baseline/collect.mjs:26-35` 的统一签名器也直接消费该文本。当前 JSON 中的 `error` 字段没有作为结构化 MCP error 保留下来。
3. **改前 vs 改后行为会不同吗？** 会。将失败文本统一渲染为 `Error [CODE]: message` 并保留 hint 后，现有错误码聚合、模型恢复提示和不同 vortex 工具的错误处理会得到同一结果；底层 browser 失败本身不会被掩盖或伪装成成功。
4. **修改后的路径真实环境会走到吗？** 会。当前源码的 HTTP 失败分支已被上述 3 个真实 `is_error` 样本命中；不需要额外 live 条件即可验证文本契约。

**建议的修复方向**：

让 dev_reload 的 HTTP 错误走统一错误格式化/结构化错误路径，至少输出 `Error [CODE]: message` 并附 hint；为三种错误分支增加响应格式回归测试，并让错误码扫描可直接归类。

## 已排除

- **`evaluate|TIMEOUT`（14 天 35 次，3 天 15 次）**：例如 `64df9f37-ccde-41e3-99e6-253c4ba87bf2.jsonl` 的 `toolu_01FTZLh9LoACSWoFJnL5ewxq` 实际传入 `async:true, timeout:30000`，代码包含多次 DOM 扫描、点击和 `await sleep`；错误全文明确是 `js.evaluateAsync timed out after 30000ms`。`packages/extension/src/handlers/js.ts:20-33` 是有界等待，`:204-218` 校验 timeout，`:295-296`/`:418-418` 使用该预算。属于调用方脚本耗时/页面状态，分类 B/C，不是 vortex 忽略 timeout。
- **`query|TIMEOUT`（7 次）**：样本 `9de9aafa-a6ae-4641-b6e8-aa52394451a8.jsonl` 中 `tool_use_id` 对应入参是 `mode=style, pattern=h1, tabId=1165994209`，错误全文指出 page main thread blocked；未发现缺失或被丢弃的字段。`packages/extension/src/handlers/query.ts:1837-1882` 正常校验并透传 mode/pattern/tabId。分类 C。
- **`navigate|TIMEOUT`（14 天 6 次以上）**：错误全文分别指向 `page.reload` 超时和页面 main thread long task；实际入参含 `reload:true` 或 `waitUntil:networkidle`。属于站点/页面环境，分类 C。
- **`act|SELECTOR_AMBIGUOUS`（20 次）**：样本实际 selector 如 `img[src*="..."]` 匹配 2 个、`div.relative.aspect-video` 匹配 11 个；`packages/extension/src/handlers/dom.ts:365-371`/`:1579-1588` 明确 fail closed。调用方应使用 observe ref 或更具体 selector，分类 B。
- **`act|OBSCURED`（20 次）与 `act|TIMEOUT`（7 次）**：样本实际目标分别被 `<div.el-dialog__wrapper>` 覆盖、命中自身 `<div.relative.aspect-video>` 祖先，或 `NOT_VISIBLE`；`packages/extension/src/action/auto-wait.ts:65-100` 为这些状态提供针对性诊断。页面遮挡/不可见不是工具误报，分类 C。
- **`act|NOT_ATTACHED`（8 次）**：样本是动态菜单/卡片 selector 已不在 DOM；错误全文要求重新 observe。与 `CDP_NOT_ATTACHED`（调试器占用）不是同一类。分类 B/C。
- **`act|STALE_SNAPSHOT`（2 次）**：实际入参确实使用 `@ref`，页面已变化；错误要求刷新 observe。当前 `packages/mcp/src/server.ts:786-816` 和 `resolveTargetParam` 路径会执行快照/tab 校验；相关错误早于 2026-08-24 的 query ref 接线提交，不能据此指向当前实现缺陷。分类 B，或历史已修复边界。
- **`wait_for|INVALID_PARAMS`（2 次）**：实际入参分别只有 `{time:"3"}` 或 selector/timeout，没有必填 `mode`；`packages/mcp/src/tools/schemas-public.ts:253-265` 将 `mode` 标为 required，分类 B。
- **`evaluate|INVALID_PARAMS`（2 次）**：一个实际传 `script` 而非 required `code`，另一个传 `timeout:90000` 超过 60000 上限；`packages/extension/src/handlers/js.ts:204-212` 会按契约拒绝，分类 B。
- **`evaluate|JS_EXECUTION_ERROR`（3 天 4 次，14 天 17 次）**：失败脚本真实读取不存在元素的 `parentElement/querySelectorAll`，或语法错误；脚本本身的异常，分类 B。
- **`CDP_NOT_ATTACHED`（14 天 7 次）**：错误全文明确是另一个 debugger 已占用 tab；`packages/extension/src/lib/debugger-manager.ts:82-97` 正确分类并给出可恢复提示。属于环境竞争，分类 C。
- **`extract|PAGE_NOT_READY`（3 次）**：错误全文明确是自身 page-side `dom-resolve` 注入在坏的 service-worker/navigation 状态超时；`packages/extension/src/adapter/page-side-loader.ts:24-35` 与 `:45-75` 已有 3 秒有界超时、驱逐缓存和 retryable 标记。分类 C。
- **`fill|TIMEOUT`（3 次）**：关键样本是 2026-08-16 的 Element Plus daterange playground，随后同一入参成功；对应的 30 秒 hub deadline 问题已在 2026-08-19 的 timeout ladder 提交中调整，当前 `packages/shared/src/timeout.ts:64-102` 与 `packages/mcp/src/server.ts:881-900` 已不再按旧固定 deadline 截断。应作为历史已修复，不列当前 A。
- **成功但空返回**：`evaluate` 的 4 个样本是合法 `[]`/空字符串/`{}` 结果；`query` 的 4 个样本是 tokens/style 在目标页面没有匹配项，且当前 `packages/extension/src/handlers/query.ts:2153-2157` 已给 tokens 自陈。`tab_list` 的空 tabs 同时带 `otherBrowsers`，表示当前绑定浏览器无 tab，不是空载荷缺陷。分类 B/C。

## 我没查的部分

- 没有重新运行采集脚本，也没有整文件读取原始 transcript；只使用现成 3 天/14 天快照，并通过流式 JSONL 配对抽样。
- 没有对所有 183 个错误逐一展开完整上下文；已完成全错误码聚合，并对所有高频错误码和全部 `NO_CODE`/低频异常至少抽取样本。
- 没有进行 live 浏览器复现、没有重建扩展或 MCP、没有修改任何源码/测试；第 4 问中无法仅凭离线日志证明的新路径均已明确标注为需要 live 验证或只作修复方向。
- 没有把 `evaluate` 占比、`observe:evaluate` 比值或单个 3 天 Top1 会话偏斜当作缺陷结论。
