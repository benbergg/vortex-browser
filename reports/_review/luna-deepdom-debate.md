# 深 DOM 性能压测辩论结论

## 结论

我的立场是：**部分撤回原判**。

原终审把“无上限祖先上溯”列为主要性能风险，这个判断在现有实测面前不再成立，至少不能继续作为本问题的首要风险结论。对方给出的成本归因符合代码路径，也符合数据的量级关系：40k 节点、50 个视口内元素时，`elementFromPoint` 为 116.5ms，而对比度祖先上溯为 2.4ms；深度 500 的病态上溯为 59ms，说明它仍有最坏情况，但不是当前语料中的主瓶颈。关于共享祖先，实测 depth 12 和 depth 500 的共享/独立链耗时近似，不能支持“共享祖先本身会额外放大成本”的说法。

但我不把这组数据升级成跨环境的性能定律。当前证据是 Chrome 151、单机、构造语料和有限重复；没有看到压测脚本、原始时间序列或多机器/多版本结果，因此可以确认风险排序和复现方向，不能据此制定跨环境墙钟阈值。尤其“超线性”应表述为该语料和浏览器实现下的观测，而不是 DOM 规模到命中测试耗时的普遍保证。文档自己记录了 10 次端到端调用的 1.4 倍抖动，这足以否定用端到端墙钟作阻断门。

## 对三条主张的攻击

### 主张 1：对比度上溯不是瓶颈，重复共享祖先不是额外风险

基本接受，但收窄表述：

- 数据支持“在给定 40k/depth 30 语料中，对比度上溯不是主瓶颈”。
- 数据支持“共享祖先没有表现出额外成本”，但不证明任何缓存永远没有收益。若未来确实存在大量同一祖先、且实现引入可复用的稳定样式快照，缓存仍可能减少脚步数；只是目前没有理由把它作为本轮优化。
- “缓存可把 25100 步降到 500 步”是模型化推算，不是当前实现的实测收益。它可以作为后续实验假设，不能作为拒绝缓存的唯一证据。
- 对比度上溯不能靠深度硬截断，否则会将未知伪装成精确 ratio。当前更合理的动作是保留无上限语义，并以确定性步数或页内计数观察极端情况。

### 主张 2：真正随页面规模增长的是 `elementFromPoint`

接受其方法论警告，但不同意把“超线性”无条件推广到所有页面和浏览器。`elementFromPoint` 虽然在源码中只是一次调用，但它委托给浏览器命中测试和渲染树；代码形状审查确实看不到内部成本。40k/10k/2k 的数据以及视口内外分流足以说明它应当进入性能归因表。

这里还要区分两件事：

- 视口内元素才会触发昂贵的命中测试；视口外提前得到 `null`，不能把所有匹配元素数量直接乘以 116.5ms。
- 页面规模、布局复杂度、绘制层、合成层和浏览器版本都会影响实现成本。因此压测应记录元素命中测试次数和页内阶段计时，使用多轮分布而不是固定墙钟阈值。

### 主张 3：`occluded` 把“没测”捏造成了 `false`

接受，而且这是本轮更明确、优先级更高的缺陷。

当前代码在 `query.ts:652-658` 先计算 `inViewport`，随后无条件调用 `document.elementFromPoint`（若 API 不存在则使用 `null`），再通过 `!!(topEl && ...)` 生成 `occluded`。因此视口外或命中测试不可用时，`topEl === null` 会得到 `occluded: false`。这与“命中自身/后代，确实测得未遮挡”的 `false` 不可区分，违反诚实表征原则。

改为 `true | false | null` 是低成本的语义修正：已有 `inViewport` 可作为视口外判据，不需要新增探测；视口外路径本来也不会因为返回 `null` 而增加成本。该变化应补充输出级契约测试，至少锁定视口内命中自身为 `false`、命中遮挡物为 `true`、视口外为 `null`，并验证 `occludedBy` 只在 `true` 时出现。

## 路线选择

支持 **路线 B：修不可判定语义 + 建压测锁住**，并完整吸收路线 A 的压测产出物。

- 纯 A 不足：已经确认存在错误确定性时，只留下成本仪表盘而不修返回值是不完整的收尾。
- B 的改动边界清楚：查询 geometry 的 `occluded` 三态、整形层保留 `null`、契约/变异测试、变更说明，以及可重复的逐维度压测报告。
- C 不适合作为本轮主线：成本自陈有协议体积和描述预算代价，且如果传递墙钟耗时会把测量噪声暴露给调用方；它也不能修复 `false` 捏造问题。若未来加入 C，应优先采用确定性计数，例如命中测试次数、祖先上溯步数和匹配元素数，不应先加入不稳定毫秒数。

路线 B 的“破坏性变更”评估需要保持准确：公开 schema 当前没有明确描述 `occluded`，但 extension 的 geometry 返回形状和测试已经把它作为字段使用。因此仍需在变更说明和契约测试中明确三态，而不能因为 schema 没列出它就当作无兼容成本。

## §7 假设核验

### 下游是否把 `occluded` 当二值使用

对仓库内代码进行了读取点检查，**没有发现 `query` 返回体的 `occluded` 被下游按二值读取或用于点击决策的反例**。匹配结果中：

- 生产写入点只有 `packages/extension/src/handlers/query.ts:657-658`。
- 读取/形状断言主要在 `query-geometry.test.ts`、`query-contract-shape.test.ts` 和 `element-shaping.test.ts`。
- `packages/extension/src/handlers/observe.ts` 的 `occludedBy` 属于 observe 自己的遮挡采集路径，不是 query geometry 的 `occluded` 消费者。
- `hit-ownership`、`actionability`、CDP click 等路径使用独立的 hit-test/blocker 语义，不能作为 query `occluded` 的下游读取点。
- `vortex-bench` 中出现的 `occluded` 主要是 judge 文本或 force-occluded case，不是读取 query geometry 字段作二值判断。

所以“仓库内没有二值下游”已从推测提升为当前代码范围内的检查结论；但外部 MCP 消费者、模型提示词和未检出的运行时脚本不受全仓源码搜索覆盖，仍需在公开变更说明中提醒调用方不要使用 `!occluded` 作为“可点击”判据。值得注意的是，若调用方写的是 `if (!occluded)`，加入 `null` 后 JavaScript 仍会进入该分支，这种调用方不会因为类型变化自动变安全。

### `null` 是否会被整形层或序列化剥掉

当前 `element-shaping.ts` 的 `pick` 条件是 `src[k] !== undefined`，所以 `null` 会被保留；geometry 键表也包含 `occluded`。但现有测试只覆盖 `false`、`true` 和 `occludedBy` 缺席，没有锁定 `null` 的输出级行为。该假设在实现前仍必须由三态契约测试确认，而不能只依赖代码阅读。

### 压测归因是否稳定

现有文档给出重复、冷热和视口内外分流结果，足以支持“本轮语料中的归因次序”而非一次偶然数字。仍建议落盘原始样本和执行环境；若进入 bench，不要把端到端毫秒数设为 CI 阻断条件。

### 40k 节点是否代表真实上界

尚未被证明。它适合作为压力点，不应命名为真实上界。后续应使用若干真实重型站点校准节点数量和命中测试形态，但这不影响本轮先修三态语义。

### 点击路径是否有同源缺陷

目前不应把它与 query 缺陷混为一谈。点击/actionability 路径已经将 `elementFromPoint=null` 作为独立 blocker，并有专门的降级和错误提示测试；它至少没有把该值直接压成“未遮挡”。它仍值得单独保持测试，但不是本轮 query geometry 修复的理由。

## 最终建议

1. 撤回“对比度无上限上溯是本轮主要性能风险”的原措辞，改为“存在深度病态最坏情况，但在现有语料中不是主瓶颈”。
2. 接受 `elementFromPoint` 是应纳入性能账的隐藏成本，并保留可重复压测语料；指标使用阶段计时和确定性计数，不用端到端墙钟阻断。
3. 采用路线 B，先把 query geometry 的 `occluded` 修为三态，并增加 `null` 透传和变异测试。
4. 公开说明三态兼容变化，特别提醒外部调用方不要用 `!occluded` 推断可点击。
5. 暂不做祖先样式缓存、对比度深度上限或成本字段；这些应由后续真实站点和确定性计数证据驱动。

## 第二轮

### 1. 完整修复判据

我接受第一轮的三态方向，但撤回“只用 `inViewport` 就足够”的不完整判据。第二轮证据表明，`occluded` 应为 `null` 的最小条件至少是：

1. `rect.width <= 0` 或 `rect.height <= 0`，元素没有可命中的面积；
2. 元素中心点不在视口内；
3. `document.elementFromPoint` 不存在；
4. 调用 `elementFromPoint(cx, cy)` 抛异常，或返回值不是可用于命中归属判断的 `Element | null`。

前三项是可确定的页面状态，第四项是页面 API/浏览器能力不可用。对第 4 项不能让异常穿透 geometry 维度，也不能把异常转成 `false`；应保留 geometry 维度错误隔离的约定，或者明确产出 `occluded: null` 并附带该维度错误原因，不能同时伪装成“已测且未遮挡”。

这里还要区分“元素完整在视口内”和“中心点在视口内”。现有 `inViewport` 是完整 bbox 包围判定，因此一个跨越视口边缘但中心点在视口内的元素可能是 `inViewport: false`，却可以做中心点命中测试。不要把 `inViewport` 直接当成 `occluded` 判定条件，否则会把这类可测元素错误降级为 `null`。建议将命中资格单独定义为 `hasArea && centerInViewport`，并让 `inViewport` 继续表达既有的完整可见范围语义，除非产品明确决定同时改变其契约。

零尺寸和 `display:none` 暴露了更深一层的问题：当前 `inViewport` 对 `(0,0,0,0)` 返回 `true`，这不是“视口内”的有用事实，而是“几何探针拿到了退化 rect”。我建议本轮同时修正 `inViewport`：零面积时返回 `false`，并把 `occluded` 返回 `null`。这是同一个几何可判定性修复，不应继续输出 `inViewport: true, occluded: null` 这种相互矛盾的组合。

这会改变已有 `inViewport` 取值，兼容面比只改 `occluded` 大，但改变是可解释且可测试的：零面积元素没有 viewport 内的可交互几何。应补充变更说明，并确认 observe/capture 等消费方不会把 `inViewport=false` 的零面积元素当作普通屏外可操作元素。不要通过 `display:none` 字符串或 computed style 猜测；bbox 的零面积是直接且稳定的几何事实，`visibility:hidden`、`opacity:0` 等则不应在本轮被混入“不可测”，它们仍可能有布局和命中语义，需要单独的可见性契约。

### 2. shadow DOM 是否进入本轮

建议**拆到下一轮**，但将它记录为明确的 P1 缺陷，而不是搁置为低优先级。

三态修复回答的是“什么时候不应该给答案”：零面积、中心点屏外、API 不可用或异常时输出 `null`。shadow 缺陷回答的是“在确实可测时如何得到正确命中元素”：裸 `document.elementFromPoint` 返回 shadow host，导致一个未被遮挡的 shadow-internal 元素被判为 `true`。它会改变已有 `true/false`，而不是仅新增 `null`，所以回归面和兼容风险不同。

拆轮的理由不是技术上无法修，而是需要单独锁定 composed-tree 语义：

- `elementsProbeFunc` 经 `executeScript({ func })` 注入，不能 import `page-side/shadow-walk.ts`，必须内联一个自包含的下钻函数；
- 需要测试 open shadow 的真实叶子命中、host 作为查询目标时的 composed containment，以及 closed shadow 仍不可下钻；
- `el.contains(topEl)` 不能简单当成所有 shadow 场景的 composed containment 真源，host/叶子边界需要单独定义；
- 还要核对 shadow 深度上限、坐标是否使用同一 viewport、命中返回 host 后下钻失败时是 `null` 还是 host 的可解释降级。

因此本轮先修 1-4 并把 shadow 回归测试/自包含实现作为下一轮独立任务，是比把两个语义变化混在一个补丁里更安全的边界。

### 3. 必须转红的变异清单

三态契约不能只测一个视口外样例。至少应有以下变异与对应红灯：

| 变异靶点 | 必须转红的测试 |
|---|---|
| 把 `occluded` 的零面积守卫删除，重新无条件调用 `elementFromPoint` | 零宽元素、零高元素各一条：`occluded === null`，且无 `occludedBy` |
| 把零面积判定从 `width <= 0 || height <= 0` 改成只检查 `width === 0` | 零高测试必须转红；负宽/负高边界测试也应转红或明确错误 |
| 把中心点视口判定删除，改回只依赖 `inViewport` 或无守卫调用 | 视口外元素测试必须转红，且 `occluded === null` |
| 把中心点边界 `cx >= 0 && cx <= vw && cy >= 0 && cy <= vh` 的任一边界改错 | 位于四条 viewport 边界的中心点测试必须转红，边界容差规则需固定 |
| 把 `typeof document.elementFromPoint === "function"` 的不可用分支改成默认 `false` | API 缺失测试必须转红：`occluded === null`，不能是 `false` |
| 删除 `try/catch` 或把 `elementFromPoint` 异常转成 `false` | 抛异常测试必须转红：返回 `null`/错误自陈，而不是 `false` |
| 把命中自身/后代的结果改成无条件 `true` | 视口内自身命中和后代命中测试必须转红 |
| 把遮挡条件 `topEl !== el && !el.contains(topEl)` 改成只检查 `topEl !== el` | 后代命中测试必须转红 |
| 把遮挡条件改成 `el.contains(topEl)` 或反转 `!` | 浮层遮挡测试必须转红 |
| 删除 `if (item.occluded) item.occludedBy = desc(topEl)` 的条件 | 三态/未遮挡测试必须断言 `occludedBy` 缺席并转红 |
| 把 `pick` 的 `src[k] !== undefined` 改成 truthiness 判断 | 输出级 `occluded: null` 透传测试必须转红 |
| 从 `GEOMETRY_ELEMENT_KEYS` 删除 `occluded` | 输出级三态测试必须转红 |
| 将 `inViewport` 的零面积结果继续固定为 `true` | 零尺寸和 display:none 测试必须断言 `inViewport === false` 并转红 |
| 将 display:none 专门写成 computed-style 分支而不是依赖零面积几何 | 退化 rect 测试应仍通过，避免把本轮范围扩大到 CSS 可见性推断 |

测试还必须验证组合行为，而不是只断言单个字段：零尺寸/display:none 的结果应同时满足 `inViewport === false`、`occluded === null`、无 `occludedBy`；视口外但有面积的元素应保留真实 bbox 和 `inViewport === false`，同时 `occluded === null`；视口内自身命中仍为 `false`，浮层命中仍为 `true`。

### 第二轮结论

第二轮证据扩大了第一轮缺陷面：路线 B 仍然成立，但实现范围应从“视口外 `occluded=null`”扩大为“所有无法进行有意义中心点命中判断的退化几何均为三态未知”，并同步修正零面积的 `inViewport`。shadow 命中穿透不应偷偷混入同一变更；它应作为下一轮独立的 composed hit-test 修复，带自己的自包含注入测试和兼容评估。
