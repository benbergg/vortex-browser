# 伪元素与字体路线对抗性辩论

## 1. 丙错在哪

- High | `docs/style-pseudo-font-approach.md:84-109`、计划中的 `styleProbeFunc` 字体测量逻辑 | 路线丙把固定哨兵字符串的宽度变化当成元素首选 family 实际生效，会产生确定性的错误否定。 | `@font-face` 可设置 `unicode-range: U+4E00-9FFF`，元素为 `font-family: Brand, monospace`，真实文本是中文且 Brand 已加载；探测若用 ASCII 哨兵，哨兵按 monospace 回落，宽度等于纯 monospace，丙报告字体未生效，但元素中文 glyph 确实由 Brand 渲染。 | 使用元素真实文本并按字符脚本测量，返回 `measuredForText` 而不是无条件的 `fontApplied`；仍无法证明整个元素只使用一个 family。
- High | `docs/style-pseudo-font-approach.md:84-93`、`packages/extension/src/handlers/query.ts:759-925` | 测量差异也可能来自未复制的排版上下文，不是 family 生效，导致错误肯定。 | 不复制 `font-size/font-weight/font-stretch/letter-spacing/font-size-adjust/font-variation-settings` 时，声明栈和纯 monospace 两个 span 的 used font size、face 选择和字距不同；尤其 `font-size-adjust` 会按字体 x-height 调整字号，fallback 仍可能产生宽度差。 | 复制影响字体选择和 glyph 几何的 computed 属性，并把样本、宽度和判定范围返回；不要把单一宽度差命名为元素级字体真相。
- Low | `docs/style-pseudo-font-approach.md:68-72` | 查过，无问题：gamma 反向对照证明测量法在该样本上有效。 | `monospace=500.91`、不存在字体同宽、ESBuild/PPMori 异宽，足以证明该组字符串和字体有判别力，但不能外推到 unicode-range 或字形分片。

## 2. 第四条路线

- Critical | `docs/style-pseudo-font-approach.md:45-47,90-110`、`packages/extension/src/lib/debugger-manager.ts:177` | 方案没有审查 CDP 的 `CSS.getPlatformFontsForNode`，该 API 直接提供节点使用的平台字体，足以推翻“丙是最优”的前提。 | 解析 `DOM.NodeId` 后调用 `CSS.enable` 和 `CSS.getPlatformFontsForNode`，可获得 `PlatformFontUsage` 的 family、glyphCount、isCustomFont；这不是宽度推断，也不是 FontFace 状态旁证。仓库已有 `debuggerMgr.sendCommand`、DOM/CDP node 映射和大量 debugger 使用。 | 新增路线丁：ref → DOM node → `CSS.getPlatformFontsForNode`；伪元素仍由 page-side 读取；CDP 失败时降级 measured，再降级 FontFace，并返回 evidence level。至少先做 spike，未证明 API 不可用前不应认定丙最优。
- High | `packages/extension/src/lib/debugger-manager.ts:108-177` | debugger 被占只能否决“CDP 唯一路径”，不能否决 CDP 可选增强。 | CDP busy 时字体 API 失败，但丙也会受 MutationObserver、CSP、布局和 unicode-range 影响；优先 CDP、失败降级并返回 unavailable 原因，错误面不比丙更大。 | 把 CDP 设计成可选优先路径，不可用时走测量/旁证。
- Low | `docs/style-pseudo-font-approach.md:45-47` | 查过，无问题：跨域 CSSOM 仍是独立约束。 | CDP 节点字体使用不等于 `@font-face` URL 来源；src 仍需单独处理 CORS/跨域，路线丁应拆分两个 evidence 字段。

## 3. 哨兵测量设计

- High | `docs/style-pseudo-font-approach.md:84-88` | 单一固定字符串不足，至少需真实文本、ASCII 和目标脚本样本的反向对照。 | 字体只覆盖中文、只含 emoji、缺少某些 glyph 或包含 ligature 时，固定 ASCII 会测到 fallback或出现宽度巧合，分别造成错误否定或肯定。 | 每类样本分别测声明栈与纯 monospace，返回样本宽度和范围；使用元素真实文本中的代表字串。
- Medium | `docs/style-pseudo-font-approach.md:84-88` | 测量字符串必须防止换行、空白折叠和容器宽度干扰。 | 长真实文本可能换行，`getBoundingClientRect().width` 反映行盒而非 glyph 总宽；空格和短标点也可能被折叠或宽度巧合。 | span 设置 `white-space:pre`、`display:inline-block`、绝对定位和足够长的固定字符串，并校验宽度为正且有限。
- Medium | `docs/style-pseudo-font-approach.md:84-88` | 元素排版属性必须复制。 | 不复制 weight/stretch/style/variation/letter-spacing 时会选错 face 或改变 glyph 几何；不复制 font-size-adjust 时 used size 也可能不同。 | 复制所有影响字体选择和 glyph 几何的 computed 字段，而非只复制字号和字重。
- Low | `docs/style-pseudo-font-approach.md:126-129` | 查过，无问题：jsdom 不适合真实布局测量。 | 文档已明确宽度恒为 0 风险，纯函数判据可单测，真实宽度与字体加载必须在 Chrome 验收。

## 4. 降级判据

- High | `docs/style-pseudo-font-approach.md:84-93` | 插节点不抛异常不代表测量有效；“两次宽度相等”不能直接等价为字体未生效。 | CSP 通常不阻止普通 DOM append；节点未连接、布局为零、页面 CSS 强制样式或字体加载尚未完成时，两次宽度都可能为 0 或相同，丙会误报 not-applied。 | 失败须包括未连接、宽度 <=0/非有限、computed 样式不符合探针预期、空文本；结果用 `measurement-failed`，不能映射成 not-applied。
- Medium | `docs/style-pseudo-font-approach.md:87-88` | 插节点会产生可观察副作用，不能把丙继续描述成近似纯读。 | MutationObserver、React/编辑器全局监听可能在 append 时触发重渲染，即使随后移除也可能留下状态变化。 | 返回副作用/evidence 标记；若尝试 detached API，仍需真实浏览器验证，不要假设 offscreen 节点不可观察。

## 5. 伪元素

- High | `docs/style-pseudo-font-approach.md:55,68-72` | 仅按 `content !== none` 不能判断“正在渲染”。 | `content:"x"; display:none` 会被纳入但不可见；`content:""` 加 background-image、尺寸和 display block 可能是有效图标块；`visibility:hidden`、`opacity:0` 也需排除或标注。 | 同时读取 display、visibility、opacity、尺寸和绘制属性；返回 content/背景/尺寸/evidence。若只表达 computed pseudo 存在，字段不要叫 rendered。
- Medium | `docs/style-pseudo-font-approach.md:76-88` | 只收 before/after 是合理的 v1 scope，但 25/1194 不能外推到图标站。 | Font Awesome 类站点可能数百或数千元素都使用 `::before`，会触发总量/响应截断；`::marker`、`::placeholder`、`::selection` 也不是同一类装饰。 | 明确 `pseudoScope=before|after`，增加元素/伪元素总上限和 truncated 自陈；其他伪元素独立规划。
- Low | `docs/style-pseudo-font-approach.md:68-72` | 查过，无问题：gamma 的 25/1194 支持按存在才返回字段的体积策略。 | 这只能支持 gamma 的体积判断，不能保证所有站点。

## 6. 字节预算

- Medium | `docs/style-pseudo-font-approach.md:66,111-115`、`packages/mcp/src/tools/schemas-public.ts:477-497` | 120B 余量本身不是否决丙的理由，但丙的 evidence 契约比甲乙更长，不能只按两个组名计预算。 | 丙需要 measured、declared-loaded、失败原因、样本或宽度语义；若不写公开说明，外部消费者无法解释返回，若写入 tools/list，120B 很快消耗。 | 将证据等级写入稳定返回契约/CHANGELOG，压缩无关 description 后再调整 cap；不能用省字节掩盖契约缺失。
- Low | `docs/style-pseudo-font-approach.md:66` | 查过，无问题：仅增加 pseudo/font 两组名不会单独淘汰丙。 | 真正的预算成本来自 evidence 语义，不是路线名称。

## 7. 推荐

- Critical | `docs/style-pseudo-font-approach.md:90-109`、仓库现有 CDP 能力 | 推荐推翻丙为主路，采用“丁：CDP `CSS.getPlatformFontsForNode` 优先 + page-side 伪元素 + measured/FontFace 降级”。 | CDP 平台字体接口直接回答节点实际使用的 family/glyph，丙只能对测试字符串做推断；丙在 unicode-range 和排版上下文不完整时会答错。CDP busy 时再降级丙，并明确 evidence level。若我错，代价是增加 debugger attach、node 映射、CSS domain 失败处理和一次 CDP 往返；若继续丙而我对，代价是上线一个会答错核心字段的字体探针。 | 先做 `CSS.getPlatformFontsForNode` spike，验证 ref 到 DOM node 映射和 debugger 占用降级；在 spike 证明 API 不可用前，不应把丙定为最优。

结论：我不能被路线丙说服。至少应先验证 CDP `CSS.getPlatformFontsForNode`；在此之前，丙只能作为无 CDP 时的降级方案，不能作为最优主路线。
