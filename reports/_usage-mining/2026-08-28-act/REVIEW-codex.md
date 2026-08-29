有条件通过（列出必须先改的点）

本轮结论：路线 A 本身成立，且方案关于“候选必须进入 message、不能只放 extras”的关键判断经源码核对为真；但当前计划仍有一个验收判据自相矛盾，六个注入出口的测试与长度/隐私边界也没有细化到足以安全实施。以下问题修正并补齐后，才可进入实现。

## 1. 对简报要求的逐项核对

### 1.1 六处多命中分支

源码确实在 `packages/extension/src/handlers/dom.ts:366-371`、`722-727`、`1030-1035`、`1207-1212`、`1583-1588`、`1975-1979` 判断 `els.length > 1`，返回 `SELECTOR_AMBIGUOUS`、数量文本和 `extras.matchCount`，没有把命中的元素摘要带回去。因此 FINDINGS 关于“候选在分支处被丢弃”的核心事实成立。

但“六处形状一致”只能理解为错误契约一致，不能理解为查询语义完全一致：前五处调用 `window.__vortexDomResolve.queryAllDeep(sel)`，会穿透 open shadow root；第六处在 `generic-aria-select` / `element-plus-select` 路径中直接调用 `document.querySelectorAll(sel)`，只查当前文档的 light DOM。改动必须保留这一区别，不能把最后一个出口误改成深度查询，也不能用只覆盖一种查询方式的测试宣称六处一致。

### 1.2 候选放在 message 还是 extras（重点核验）

方案第 2 条的判断属实，而且是路线 A 的必要条件。

证据链如下：

- `packages/extension/src/adapter/native.ts:92-110` 的 `mapPageError` 会把 page-side 返回的 `error` 作为 `vtxError` 的 message，并把 `res.extras` 放进 `context.extras`；所以 page-side 现在的 `extras.matchCount` 并没有在内部传输时丢失。
- `packages/shared/src/errors.ts:116-143` 也确认 `context.extras` 是结构化错误上下文，并会随 payload 序列化。
- 但 `packages/mcp/src/server.ts:923-930` 的 action 错误输出调用 `formatDispatchError`；`packages/mcp/src/lib/dispatch-error.ts:13-32` 最终只拼接 `Error [code]: message` 和 hint。它只特殊读取 `context.extras.lastReason` 来追加 TIMEOUT hint，不会把普通 `extras` 序列化到 MCP 文本。

因此，候选若只放 `extras.candidates`，调用方看不到；放进 `message` 是正确的。候选也可以理论上进入显式 `hint`，但那会与错误正文和默认 hint 的职责混在一起，方案选择 message 更稳妥。该事实不需要改判，但 §5 应把“page-side 返回对象的 extras 可保留用于结构化上下文、不可作为调用方可见通道”写清楚，避免实施者误以为必须删除 extras 或把候选只放 extras。

现有零命中路径也支持这一结论：`dom.ts:153-168` 将候选摘要传给 `buildNoMatchMessage` 生成正文，同时另存结构化 `extras`；`candidate-suggest.ts:77-88` 是可借鉴的文案风格，不是可直接用于 Element 对象的实现。

### 1.3 真实日志回放

FINDINGS 中的两条关键样本核对成立：`a[href="/frontend"]` 命中 2 个，`div.relative.aspect-video` 命中 11 个，错误正文当前只有数量和“更具体 selector / observe”的 hint。前者后续确实靠 evaluate 自行查找，后者也出现了先改成同样多命中的容器 selector、再猜到 probe 属性的轨迹。这支持补充诊断信息的目标。

不过，这两条样本也暴露出方案当前判据的问题：相同标签、相同文本、相同 selector 中的属性并不保证能区分候选；11 个视频卡容器尤其可能共享 class、没有自身文本或唯一属性。方案 §3 已承认摘要可能完全同形，但 §1.1 又要求“使调用方无需额外调用即可分辨它们”，两者冲突。应改成：每个候选都必须有受预算约束的摘要；摘要足以区分时调用方可直接改写 selector，摘要仍同形时必须明确报告“无法仅凭摘要区分”，继续 fail-closed，不能把“每个候选有摘要”验收成“必然可消歧”。若路线 A 不提供可直接使用的定位串或索引入参，就不能对同形候选承诺无额外调用完成选择。

## 2. 对方案各节的审核

### §1 判据

第 2、3、4、6 条方向正确，但需要以下必改项：

1. 修正第 1 条的绝对化表述，拆成“摘要覆盖率”和“可辨识性/同形降级”两个判据，并给出同形候选的预期文案。
2. 第 5 条“变异验证”目前没有说明变异的是六个出口还是仅摘要纯函数。若只删掉 builder 的摘要，不能证明六个分支都真正携带了候选；必须让每个出口的断言在去掉该出口摘要后分别失败，至少覆盖前五个 deep-shadow 出口和第六个 light-DOM 出口。
3. 第 6 条的 `new Function` 方向正确但不充分。它应复刻实际传给 `chrome.scripting.executeScript` 的函数及参数，验证函数体不依赖模块变量、闭包变量、未注入的 helper 或不可序列化对象；只把一个纯函数包装进 `new Function` 不能证明六处实际注入函数可运行。
4. “成功路径逐字节不变”应有可执行回归断言，而不是仅列为目标；至少要证明单命中及正常成功返回对象、动作顺序和副作用没有被摘要逻辑改变。

### §2 现状勘察与 §4 取舍

事实基本准确。`candidate-suggest.ts` 的可复用范围是 host 侧的排序/文案范式；它的 `NameCandidate` 只有 `name/tag`，不能直接代表六个已经命中的 DOM Element。`observe.ts` 的 `buildSelector` 确实在 page-side 注入函数内部，且 shadow 场景的 `stampRid` 会写 DOM，因此路线 A 不依赖它是合理的。用户已选路线 A，本审核不建议改路线。

方案还应补充一个实现边界：仓库已有 `dom.ts:185-200`、`212-237` 的元素展示字段（tag、id、classes、innerText、attributes），但 `QUERY_ALL` 允许最多 100 个元素且属性未做总量预算，不能原样搬进错误正文。可借鉴字段和截断思路，不能把现有 query 序列化器当成已经满足错误消息隐私/大小约束的实现。

### §5 改动地图

文件范围合理，但“从元素提取摘要的纯函数”需要定义输入边界。真正的 page-side 读取 DOM 不是 host 侧纯函数；建议纯函数只接收已裁剪的可序列化 DTO（例如 tag/name/text/允许的少量属性/可见性/顺序），页面注入函数负责从当前 `els` 立即生成 DTO，再由 host 侧纯函数统一组装 message。这样既能单测文案，也能避免把 Element、闭包 helper 或跨 world 对象传给 host。

六处必须使用各自已经命中的 `els` 生成摘要，不应在错误分支之后重新 query；否则 DOM 发生变化时，错误中的候选可能不是触发拒绝的那一批。第六处应明确保留 `document.querySelectorAll` 的范围语义。

`errors.hints.ts` 的改动方向合理，但计划没有给出新 hint 的确切恢复动作。默认元信息要求 hint 含 next-action 动词和工具名/参数关键词（见该文件顶部注释），并且当前 `SELECTOR_AMBIGUOUS` 是 `recoverable: true`。新 hint 应指向“从正文候选中选取并改写 selector”，不要只说再 observe；如果摘要无法区分，也必须让正文/hint 不暗示已有唯一 ref。要为默认 hint 的精确文案及 recoverable 语义补测试。

### §6 第 1/2/3 条及路线约束

第 1、2 条对调用习惯和多命中数据可得性的分析成立；第 3 条关于 extras 的结论经上述传递链核实成立。第 4 条对 `buildSelector` 的限制也成立。路线 A 的 fail-closed 约束应继续保持：候选摘要只能诊断，不能自动挑第一个，也不能因为摘要失败而把多命中降为成功。

### §7 假设表

把“转 evaluate 率下降”列为上线后观察、而非本轮验收，正确；把两条真实 selector 列为离线验证对象，也正确。但“页面文本进错误正文的隐私与长度风险”不应只作为待验证推测，而应转成实现前的硬约束：

- 对 accessible name、文本、属性值分别设置上限，并设置整个候选段/整个错误 message 的总字节上限；不能只限制单个 `text` 字段。
- 不要无条件把全部 `data-*` 值放入错误；应按原 selector 中出现的属性做白名单，并对属性名和值分别截断、清洗换行和控制字符。
- 明确候选数量上限或“全部候选的极短摘要 + 总预算”策略。`div.relative.aspect-video` 的 11 个命中必须有测试，不能只测 2 个候选。
- 超限时的标记要保留命中总数和被省略数量，避免正文看起来像完整候选列表。

MCP 的 `RESPONSE_SIZE_LIMIT` 主要在成功结果序列化路径（`server.ts:1092-1100`）处理；action 错误在 `server.ts:923-930` 直接格式化，并不自动获得同一截断保护。因此不能把 MCP 的 100KB 成功响应保护当作错误正文的预算方案。

## 3. 必须先补齐的验收清单

在实施前，计划至少应把下面项目写成具体测试/断言：

1. 调用 `formatDispatchError` 的集成级断言：候选在 message 时最终 MCP 文本可见；候选只在 `context.extras.candidates` 时最终文本不可见；`lastReason` 的既有 TIMEOUT 行为不被破坏。
2. 纯函数断言：覆盖空字段、引号/换行/Unicode、超长文本、属性值清洗、总预算、同形候选，以及 2 个和 11 个候选；断言保留 `matched N` 和省略计数。
3. 注入断言：实际六个 page-side 函数分别在 `new Function` 剥离模块作用域后运行；前五个用 shadow-root fixture，第六个用 light-DOM fixture，并验证摘要来自已命中的集合而非第二次查询。
4. 六出口断言：每个出口返回 `errorCode: SELECTOR_AMBIGUOUS`、原有数量信息、message 中的摘要；对第六个出口单独断言不改变其 light-DOM 查询语义。
5. 变异断言：分别删除六个出口的摘要拼接后，对应出口测试必须失败；只删纯 builder 的测试不满足“六处一致”的目标。
6. 成功回归断言：每种动作至少保留一个单命中成功样本，比较摘要改动前后的成功 payload/副作用。

上述补充完成后，方案的核心事实、路线和改动方向可以接受；在此之前不应开始实现。
