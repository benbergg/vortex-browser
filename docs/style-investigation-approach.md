# 页面样式调研能力：实现思路

> 触发：「vortex 在页面样式这块有能力短板，例如调研 gamma.app 样式时经常找不准，横向比较一下，补齐这块能力。」
> 状态：候选路线待选定。本文不含接口定义与实施步骤。

## 0. 实现流程图

```mermaid
flowchart TD
    Q["调研意图<br/>「这个按钮什么样」"] --> OBS[vortex_observe<br/>a11y 树 → @ref3]
    OBS -->|@ref| BREAK1{{"断链 ①<br/>query 不接 @ref"}}
    BREAK1 -.->|只能猜选择器| GUESS[".css-m7knwo?<br/>emotion 哈希类名"]
    GUESS --> STYLE[query mode=style]

    STYLE --> P1["color / background<br/>fontWeight / fontSize"]
    STYLE --> BREAK2{{"缺口 ②<br/>无 font-family / line-height<br/>letter-spacing / radius<br/>shadow / gradient / spacing"}}
    STYLE --> BREAK3{{"缺陷 ③<br/>祖先上溯 8 层<br/>gamma 背景在第 10 层"}}
    BREAK3 --> NULLC["contrastRatio: null"]
    NULLC --> BREAK4{{"缺陷 ④<br/>null → wcagAA:false<br/>把「不知道」说成「不合格」"}}

    STYLE --> BREAK5{{"整层缺席 ⑤<br/>675 个 --chakra-* token<br/>186 张样式表 / @layer<br/>一个都不暴露"}}

    BREAK1 & BREAK2 & BREAK5 -.->|唯一出路| EVAL["vortex_evaluate<br/>手写 getComputedStyle"]
    EVAL --> ANS["答案<br/>（模型自己拼，易错、不可复现）"]
    P1 --> ANS

    style BREAK1 fill:#ffe0e0
    style BREAK2 fill:#ffe0e0
    style BREAK3 fill:#ffe0e0
    style BREAK4 fill:#ff9999
    style BREAK5 fill:#ffe0e0
```

## 0.5 问题重定义

**表象**：调研 gamma.app 样式「找不准」。

**真正失效的机制**（五条互相独立，不是一个问题的五种说法；全部在 gamma.app 实测坐实）：

| # | 失效机制 | 实证 | 约束性质 |
|---|---------|------|---------|
| ① | **寻址断链**：`vortex_query` 是唯一不接 `@ref` 的元素类 handler | `resolve-target.ts:17` 被 dom/mouse/capture/file/page/content 全部引用，`query.ts` 引用数 **0**；实测 `mode=style pattern=@ref1` 报 `Invalid CSS selector` | 历史习惯 |
| ② | **属性面对错了问题**：只给 7 项 | `query.ts:750` styleProbeFunc 自陈「回答配色/对比度对不对」；gamma h1 真值 `font-family: ESBuild` / `letter-spacing: -1.2px` / `line-height: 60px`，工具一项不给 | 历史习惯（当初需求是 a11y 审计） |
| ③ | **背景上溯 8 层不够，且只看 backgroundColor** | `query.ts:824` 写死 `j < 8`；gamma h1 的 painted 背景在**第 10 层**（body）。同文件 `geometry` 探针 `:669` 写的是 `j < 12` —— 同一种上溯两个魔数 | 历史习惯（拍脑袋的 8） |
| ④ | **把 null 当 false 断言** | `query.ts:850` `wcagAA: contrastRatio != null && >= 4.5`。gamma h1 实际对比度约 13:1（AAA 通过），工具输出 `wcagAA:false` | 历史习惯 = **缺陷** |
| ⑤ | **授权 CSS / 设计 token 整层缺席** | gamma.app 实测：675 个 `--chakra-*` 自定义属性、186 张样式表（183 张 CSSOM 可读）、`@layer chakra-global`、100 条 `!important`。vortex 零暴露 | 历史习惯 |

**物理必然的约束**（只有两条）：
- 跨域样式表 CSSOM 不可读 —— CORS，实测 3/186 张被挡。CDP 不受此限。
- 级联/特异性/`@layer` 的权威排序，页面侧要自己重算 —— 半物理：可实现，但 gamma.app 同时用了 `@layer` 和 100 条 `!important`，手搓易错。CDP `CSS.getMatchedStylesForNode` 直接给已排序结果。

**反事实**：去掉①②③④（全是历史习惯），「调研 gamma.app 的主按钮」就能一次问对——寻址接得上、属性够用、背景取得到、不说假话。⑤ 仍在，但那是「知道更多」而非「找不准」。**结论：当前表象主要是①②的投影，④是必须顺手修掉的诚实性缺陷。**

**本次修根因**，不修症状：①是接线缺失、④是判据错误，都是根因本身。

## 1. 目标与判据

1. 用 `vortex_observe` 拿到的 `@ref` 能**直接**喂给样式探针，无需构造选择器。判据：gamma.app 上 observe → 样式查询两步走通，全程不出现手写 CSS 选择器。
2. 一次调用即可回答「这个元素长什么样」，覆盖排版（family/size/weight/line-height/letter-spacing）、盒（padding/margin/radius/border）、绘制（背景含渐变、shadow、opacity）、动效（transition）。判据：gamma.app 主 CTA 的 `radius:24px` / `PPMori 16px/500` / `padding:0 32px` 一次拿全。
3. 拿不到背景时输出「未判定」，**不得**输出 `wcagAA:false`。判据：gamma.app h1 不再被报成 AA 不合格。
4. 不新增 `vortex_evaluate` 依赖：上述问题不再需要旁路。判据：复现脚本里 evaluate 调用数归零。

不收「样式调研体验更好」这类无法判定的说法。

## 2. 现状勘察

- 样式探针：`packages/extension/src/handlers/query.ts:750` `styleProbeFunc`，调用点 `:1686-1692`，注入 MAIN world。返回 `color / background / bgFromAncestor / fontWeight / fontSize / contrastRatio / wcagAA / wcagAAA`。
- 几何探针：同文件 `:576` `geometryProbeFunc`，给 bbox / clip / `occludedBy`，祖先上溯 `:669` 用 `j < 12`。
- 元素寻址统一入口：`packages/extension/src/lib/resolve-target.ts:17` `resolveTarget(args)`，支持 `selector` 或 `{index, snapshotId}`（即 `@ref`），并带 stale 自愈 descriptor。**`query.ts` 未引用它**（grep 计数 0）。
- CDP CSS 域：全仓 `getMatchedStyles` 命中数 **0** —— 从未接入。
- 可复用机制：`queryAllDeep` 穿 open shadow（`:774`）、`withDiagnosis` 自陈信封、`vtxError` 第 4 参 hint 通道。

**live spike（gamma.app，已实测）**：页面侧遍历 CSSOM 求匹配规则，1701 条规则 / **6ms** / 183 张可读 / 3 张跨域被挡，成功命中决定性规则 `.css-m7knwo`，且**保留 `var(--chakra-transition-easing-ease-out)` 原文**（token 名而非解析值）。同时确认该站存在 `@layer chakra-global` 与 100 条 `!important`。

## 3. 候选路线（≥2 条，落在不同层）

### 路线 A —— 修接线与判据（寻址层 + 现有探针）
- 切入点：`query.ts` 引入 `resolveTarget`；扩充 `styleProbeFunc` 属性面并分组；`j < 8` 改为走到 painted 为止；`contrastRatio` 为 null 时输出 `wcagAA: "unknown"` 而非 `false`。
- 为什么行得通：①③④是纯粹的接线/常量/判据错误，改动落在单文件；`resolveTarget` 已被 6 个 handler 验证。
- 代价：不解决⑤（授权 CSS / token）。属性面扩大会增加返回体积，需要分组或 `attr` 选择。
- 失效条件：如果用户真正要问的是「这个蓝是哪个 token / 这条规则从哪来」，A 完全答不了。

### 路线 B —— 新增 `mode=rules`：页面侧 CSSOM 匹配规则
- 切入点：`query.ts` 新增一个 probe，遍历 `document.styleSheets` 求 `el.matches(selectorText)`，返回规则原文（含 `var()` 未解析形态）+ 来源样式表 + 是否 `!important`。
- 为什么行得通：**已 live spike**，6ms / 183 张可读 / 命中决定性规则并保留 token 名。无需 debugger、不受 CDP 占用影响、天然跨 frame。
- 代价：级联顺序要自己算。`@layer` + `!important` 实证存在，手搓特异性排序易错——**排错了比不给更糟**（又一次「把不知道说成知道」）。跨域 3 张样式表读不到。
- 失效条件：站点重度依赖 `@layer` 分层或 CSS-in-JS 运行时插入规则时，「哪条最终生效」可能给错。

### 路线 C —— 接 CDP `CSS.getMatchedStylesForNode`
- 切入点：新增 CDP CSS 域调用，`DOM.pushNodeByPathToFrontend` 或复用 observe 已有的 `backendDOMNodeId`（`reasoning/ref-store.ts:16` 已存）。
- 为什么行得通：浏览器自己给的权威级联序，含 `@layer`、伪元素、继承链、跨域样式表——是 DevTools Styles 面板的同一数据源。
- 代价：需要 attach debugger；**刚在上一个任务实测确认 CDP 会被别的扩展占**，被占时整条能力不可用；需要 nodeId 映射；返回体积大需裁剪。
- 失效条件：另一个扩展持有 debugger 时；页面主线程卡死时（CDP 仍可用，但 DOM 域可能滞后）。

### 路线 D —— 新增 `mode=tokens`：抽设计变量面
- 切入点：读 `:root` / 主题根上的 CSS 自定义属性，按 color / fontSize / spacing / radius 归类，输出调色板与字阶。
- 为什么行得通：gamma.app 675 个变量已实测可读；这是「调研样式」最高价值的单一输出——直接给出人家的设计系统。
- 代价：只解决⑤；变量命名各站不同，归类需启发式；未被使用的变量会产生噪声。
- 失效条件：不用 CSS 变量的站（老站、纯 SCSS 编译站）返回空。

## 4. 取舍与选定

- **A 是地板，不作为候选取舍项**：④「拿不到背景就报 AA 不合格」是在说假话，与项目「诚实表征层」的定位直接冲突；①是 6 个 handler 都有、唯独 query 漏掉的接线。这两条无论选哪条深度路线都要修。
- 真正要选的是深度方向：**B（授权规则，页面侧）/ C（授权规则，CDP 权威）/ D（设计 token）**。
- 放弃「B+C 都做、按可用性降级」作为首选：C 的价值恰恰是级联权威性，B 的级联是自算的；两者结果不一致时无法判定谁对，等于给用户两个互相打架的答案。要合并必须先定义「不一致时怎么说」，那是独立一轮设计。

**选定：A（地板）+ D（设计 token 面）。** 用户 2026-08-19 确认。

- 放弃 B，因为：**排期，不是不可行**。（2026-08-19 外部评审订正：原写法「B 必须自算级联、排错比不给更糟」下得太重——B 完全可以只返回命中规则原文 + `!important` / `@layer` 标记而**不宣称谁最终生效**，那恰好绕开了我用来否它的那个诚实性风险。真实理由是本轮先做地板 A 与直接对得上诉求的 D，B 作为「证据面」排在其后。）
- 放弃 C，因为：上一个任务已实测确认 `chrome.debugger` 会被别的扩展占，被占时整条能力不可用；而样式调研恰恰是长时间反复查询的场景，一个「有时候完全用不了」的能力不能作为主路。
- 选 D 而非 B/C 的正面理由：原始诉求是「调研 gamma.app 样式」——要的是设计语言。A 给单元素精确读数，D 给整套调色板与字阶，两者合起来正好是这件事；B/C 回答的是「哪条规则最终生效」这个调试问题，与本次诉求不同岗。
- **D 的已知边界（评审指出，接受）**：D 告诉你站点**定义了哪些**变量，不告诉你**某个元素用的是哪一个**。A 给的是解析后的值（`rgb(5, 64, 173)`），D 给的是 token 名与值，两者之间的「谁在用谁」这一跳本轮不做。
- B 不是否决，是排期靠后：等 D 上线后若「知道 token 名但不知道谁在用」成为真实卡点，按「只给命中规则、不宣称最终胜者」的形态接 B（这也顺带补上上面那条边界）。另有一条更省的中间做法值得先评估——把 A 拿到的解析值与 D 的 token 值做等值匹配，零新增探针就能回答大部分「这个蓝是哪个 token」。

- 放弃「直接让模型用 evaluate」：实测可行（本次勘察就是这么做的），但每次要现写 JS、结果形态不稳定、不可复现，且与已记录的 `observe:evaluate=1:12` 旁路问题同源。

## 5. 改动地图（选定后细化）

按选定的 A + D：

- `packages/extension/src/handlers/query.ts` —— 承重文件。引入 `resolveTarget` 打通 `@ref`（A①）；`styleProbeFunc` 属性面按 typography / box / paint / motion 分组扩充（A②）；祖先上溯改为「找到 painted 为止」并纳入 `background-image`（A③）；`contrastRatio` 为 null 时对比度三项输出未判定而非 false（A④）；新增 tokens probe（D）。
- `packages/mcp/src/schemas-public.ts` —— `mode` 枚举加 `tokens`；`pattern` 在 `tokens` 下的语义（过滤前缀，可空）；`style` 的 `pattern` 说明改为「CSS 选择器或 @ref」。
- `packages/extension/src/lib/resolve-target.ts` —— 只复用，不改。
- 数据流：observe 存快照（`lib/snapshot-store.ts`）→ `@ref` → `resolveTarget` 反查 selector + 绑定 tab/frame → 注入页面侧 probe → 结构化返回。tokens 路径不需要元素寻址，直接读文档根。

## 6. 被证伪的直觉

- **「这是对标缺口，竞品都有」——错。** 实查：`chrome-devtools-mcp`（Google 官方，52 个工具）**零 CSS 工具**，computed styles 是 open feature request（issue #86）；`playwright-mcp` 无专门样式工具，靠 `browser_evaluate` + `getComputedStyle`。唯一有对标实现的是第三方 `chrome-inspector-mcp`（`getMatchedStyles` / `getComputedStyle` / `getNodes`）。**所以这不是追赶，是没人占的位**；对标基线应是 DevTools Styles 面板这个人类基线，而不是某个竞品。
- **「找不准 = 召回不行，observe 漏了元素」——错。** observe 能找到；断的是 observe 与样式探针之间的寻址（①）。
- **「页面侧读不到授权 CSS，必须上 CDP」——错。** 实测 183/186 张样式表 CSSOM 可读，6ms 完成匹配。CDP 的不可替代价值只在**级联排序权威性**与**跨域样式表**，不在「能不能读」。
- **「mode=style 是设计调研工具」——错。** 它的 docstring 明写是 a11y 对比度审计，属性面按那个问题裁的，用错了岗位。

## 7. 待验证假设 → 实测结论（2026-08-19 gamma.app 真站验收）

**判据 1（@ref 打通）达成**：`vortex_observe` 拿到 `@39df:e8`（hero CTA），直接
`vortex_query({mode:"style", pattern:"@39df:e8"})` 返回该元素样式，全程未写一个 CSS 选择器。

**判据 2（属性面）达成**：`h1` 返回 `fontFamily: "ESBuild, sans-serif"` / `letterSpacing: "-1.2px"`
/ `lineHeight: "60px"`；CTA 返回 `borderRadius: "24px"` / `padding: "0px 32px"` /
`fontFamily: "PPMori, sans-serif"` / `backgroundColor: "rgb(5, 64, 173)"`。

**判据 3（不说假话）达成且超出预期**：`h1` 现在返回 `background: "rgb(255,255,255)"`
（`bgFromAncestor: true`，上溯到第 10 层 body）、`contrastRatio: 15.51`、`wcagAAA: true`
——**修复前这里是 `contrastRatio: null` + `wcagAA: false`，对一个 AAA 通过的标题谎报不合格**。
更重要的是 `mode=style pattern=div maxResults=50` 的真实分布：**18/50 是 `translucent`**
（gamma 吸顶栏 `rgba(255,255,255,0.8)`）、**5/50 是 `background-image`**（hero 渐变）。
修复前这 23 个（占样本 46%）会被一律报成 `contrastRatio: 11.67 / wcagAA: true` ——全是
凭空捏造的数字。评审提出的半透明问题不是理论风险。

**路线 D 达成**：`mode=tokens` 在 gamma.app 返回 `total: 676`，九个分组
（color / gradient / fontFamily / fontSize / fontWeight / motion / shadow / spacing / other），
`roots: [":root","body"]`（body 确有独立贡献，Chakra 主题挂在 `body.chakra-ui-light`）。
`--chakra-fonts-heading: 'ESBuild',sans-serif` 与 h1 实测字体对得上；渐变组抓到了
`--chakra-colors-gradient-*` 全套；`--chakra-borders-1px: "1px solid"` 正确落 `other` 未被
吞成 shadow。`truncatedGroups` 逐组报告丢弃数（color 423 / spacing 120 / ...），
没有它 `showing: 27 / total: 676` 无法解读。

**判据 4（evaluate 归零）达成**：判据 1-3 与路线 D 的全部查询未使用 `vortex_evaluate`。
唯一一次 evaluate 用于**性能计量**（复刻探针最坏成本），不属于调研流程本身。

**性能与体积实测**（替代原先「无上限上溯是否可接受」的推测）：50 元素 × 25 属性 ×
无上限祖先上溯 = **5ms**，最大祖先深度 **12**（>原先写死的 8，证实那个魔数在真站会漏），
序列化 **32.5KB**。评审估算的 110-330KB 高了 4-10 倍，1000ms 阈值远未触及。
**裁决：不加深度上限、不加 payload cap**，理由是实测而非推测；调用方可用 `attr` 选组进一步压。

### 仍未验证 / 已知边界

- `roots` 靠比对 computed value 得出，区分不了「body 继承」与「body 重复声明同值」；
  要那个得读 CSSOM 规则来源。已写进探针 JSDoc。
- shadow 分类是启发式（两个以上长度 + 颜色），只保证常见形态，不解析完整 CSS 语法。
- `mode=tokens` 的 pattern 是字面子串，`@ref` 不在此处 lift；描述里按 mode 点名了哪四个
  接受 @ref。**裁决：不再加 pattern 级参数说明**——mode 说明已精确列出四个 mode 名，
  再加会吃掉 tools/list 仅剩的约 100B 余量。
- 原始「待验证假设」段（下方保留）中关于返回体积与祖先深度的两条已由上述实测取代。

## 7.1 原始待验证假设（保留备查）

- 【推】扩大属性面后的返回体积是否需要 `attr` 分组过滤 —— 需按 gamma.app 实测字节数定。
- 【推】路线 C 的 `backendDOMNodeId` 是否在 observe 快照里稳定可用于 CSS 域 —— 实施前必须实测。
- 【推】路线 B 自算特异性在 `@layer` + `!important` 并存时的正确率 —— 实施前必须用 gamma.app 做一次与 DevTools Styles 面板的人工对拍。
- 【已实证】CSSOM 可读率、耗时、token 名保留、`@layer` 与 `!important` 的存在。
- 【已实证】`@ref` 不被 query 接受、背景在第 10 层、`wcagAA:false` 假阴性。
