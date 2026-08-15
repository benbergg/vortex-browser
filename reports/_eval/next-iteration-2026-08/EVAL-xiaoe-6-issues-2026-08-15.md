# 评估：小鹅通考试页 6 条实战问题 —— 2026-08-15

来源：用户在 Edge 上用 vortex 完成小鹅通 H5 考试（Vue2 + swiper，20 题）+ 15 题问卷后的问题清单。
核实方式：transcript 原始调用回放（`336ee13c` 会话，54 次调用）+ 最小复现页实机 spike（`scratchpad/spike-issues.html`）+ 源码勘察。

| # | 用户主张 | 判定 | 优先级 |
|---|---|---|---|
| 1a | act 点击 swiper 隐藏项能静默生效 | **成立，且机制比主张更严重** | **P0** |
| 1b | observe 列出预渲染隐藏项且无可见性标记 | **成立** | P1 |
| 2 | extract 返回过时快照（缓存未失效） | **不成立**（实为 SPA 渲染竞态） | P3 |
| 3 | query mode=component 输出爆炸且无收敛参数 | **成立**（预算维度选错） | P1 |
| 4a | act 无文本消歧 / 无索引参数 | 成立（能力缺口，非缺陷） | P2 |
| 4b | 选择器零命中报 NOT_ATTACHED，分类错 | **成立** | P2 |
| 5 | evaluate timeout 硬上限 60000ms | 成立（设计约束） | P2 |
| 6 | act scroll 的 success 语义含糊 | 部分成立（`moved` 已是信号，但三义合一） | P3 |

与 hidden-tab rAF 冻结（`DIAGNOSIS-hidden-tab-evaluate-2026-08-15.md`）**均不同源**，唯一交集是第 5 条与那条诊断的派生项撞同一个 `MAX_INNER_TIMEOUT_MS` 约束点。但第 1a 与 hidden-tab 那条共享同一个**元模式**：工具的返回与页面真实状态不符，且都落在 `actionability.ts`。

---

## 1a（P0）act 对"命中目标祖先"的 hit-test 结果无条件放行

**根因（单行判据过宽）**：`packages/extension/src/page-side/actionability.ts:143`

```js
if (hit === el || el.contains(hit) || hit.contains(el)) return { ok: true };
```

第三个条件 `hit.contains(el)` 的本意是"命中了包住目标的包装层（如 label 包 input）也算可点"，但它无差别地把**命中 BODY / 任意祖先容器**也判为可点——而"目标点上命中的是自己的祖先"恰恰是目标被裁剪、被 transform 移走、被 clip-path 遮住的典型信号。

**实机复现（最小页，非推理）**

| 场景 | `elementFromPoint(中心点)` | probe 结果 | 实际后果 |
|---|---|---|---|
| 兄弟 overlay 遮挡可见按钮 | `div#ov` | `OBSCURED`（blocker: div#ov）✅ | 正确拦截 |
| 目标被祖先 `overflow:hidden` 裁掉 98% | `BODY`（是目标的祖先） | **`ok: true`** ❌ | act 报 `success:true, mode:realMouse`，页面 onclick **完全没触发** |

对照证明门本身有效，坏的只有这一条判据。

**为什么危险**：gate 放行后 CDP 在元素中心点派发真实鼠标事件，落点命中谁就是谁——
- 落点是 BODY → 点击落空，工具仍报 success（本次 spike 实测）
- 落点上恰好压着另一个元素 → **点中错误的目标并真实生效**（用户在小鹅通遭遇的错位一位，与此机制一致；确证需该站现场）

两种后果同源，都属于"不报错而做错事"。

**修复方向（未实施）**：`hit.contains(el)` 不能裸放行，需附加条件——目标中心点是否落在所有祖先的 clip 矩形内（逐级 `getBoundingClientRect` ∩ `overflow != visible`）。祖先命中时应报 OBSCURED 并点名裁剪它的容器，与今天 `0f9db90`（遮挡点名压在上面的是谁）同一路数。

## 1b（P1）observe 不标注被裁剪/不可见

同一 spike 页，`observe filter=interactive includeBoxes=true` 输出：

```
- button "题2 选项" [ref=@48cf:e0] bbox=[2,94,67,25]      ← 真正可见
- button "题3 选项" [ref=@48cf:e1] bbox=[402,94,67,25]    ← 被祖先裁掉 98%，无任何标记
```

视口外的 `#btn-prev`（x=-398）被正确排除，但**坐标落在视口内、却被祖先 `overflow:hidden` 裁掉的元素照常列出**，且 `bbox` 给的是布局盒——用户说"includeBoxes 解决不了"属实。

模型据此无法区分当前项与预渲染项，只能退回 `evaluate` 用 `elementFromPoint(innerWidth/2, innerHeight/2)` 自判（用户 13:50:12 的实际做法）。

**修复方向**：节点增可见性标记（如 `[clipped]` / `[offscreen]`），或提供 `filter:"visible"`。与 1a 应共用同一个"裁剪可见性"纯函数，避免第三次把同一知识固化在单个调用点。

## 2（P3）extract 不是缓存，是 SPA 渲染竞态 —— 主张不成立

**证伪 1（代码）**：`content.ts:10` `GET_TEXT` 每次都 `chrome.scripting.executeScript` 实时读 DOM，全链路无缓存层。

**证伪 2（实机）**：spike 页改 DOM 文本 + 删节点后立即 extract，输出**同步反映新 DOM**。

> 我自己第一次"复现成功"是假阳性：spike 页的 `history.pushState` 在 `file://` 下抛 `SecurityError` 中断了 handler，DOM 根本没变。修正后不复现。

**真实时序（原始 transcript）**：

```
13:45:58 act 点击"参与考试" → success
13:46:00 extract → 介绍页 568 字   ← 点击后仅 2 秒
13:46:03 tab_list → URL 已是 /examination/detail/
13:46:09 observe → 答题页新 DOM（1/20）
13:46:15 evaluate → 答题页 307 字
```

extract 拿到的是**当时真实的旧 DOM**：URL（history）先变，Vue 组件后挂载，两次 extract 都落在旧 DOM 时期，所以 568 字节完全一致。

**残留的真实问题**（降级为 P3）：extract 不提示"页面刚发生导航/正在渲染"，调用方无法区分"这就是新页面"与"旧页面还没换掉"。

## 3（P1）query component 的预算按节点数封顶，管不住字节数

`packages/extension/src/handlers/query.ts:309-311`：`MAX_DEPTH=3`、`ARRAY_CAP=40`、`globalBudget.cap=3000`。注释写明是为防爆炸而加（"vxe-table cell 曾吐 10 万字符"），但**预算单位是节点数，字符串值不计长度**——题干/选项这类长文本，3000 个节点轻松到 8 万字符。这正是本次 81624 字符的成因：防爆炸机制存在但量纲选错。

`maxResults` 存在于 schema，但限的是匹配元素个数，不是输出体积。

**修复方向**：预算加字符维度（累计序列化字节即停），或出口统一走 `truncateWithTextTrailer`（`lib/truncate.ts` 已有）。

## 4（P2）

**4a**：`act.target` 只接受 CSS selector 或 `@ref`，无 `nth`/索引、不支持按文本消歧，`SELECTOR_AMBIGUOUS` 时只能回退 evaluate 打临时 id（用户的实际做法）。属能力缺口。注：`:has-text()` 被拒是**刻意设计**，`INVALID_SELECTOR` 的 hint 已明确指路 observe（`errors.hints.ts:147`）。

**4b**：`dom.ts:131-140` 把"选择器零命中"也报 `NOT_ATTACHED`，而 hint 写的是 "Element **detached from DOM**. Call vortex_observe to re-locate…"（`errors.hints.ts:143`）——对"从未存在"的选择器，这个 hint 指向错误方向。`ELEMENT_NOT_FOUND` 码已存在（`errors.ts:3`）却未用于此。message 正文其实说清了 "matched no element"，所以是**码与 hint 错位**，不是完全误导。

## 5（P2）evaluate timeout 上限 60000ms

`packages/shared/src/timeout.ts:20` `MAX_INNER_TIMEOUT_MS = 60_000`，硬校验在 `handlers/js.ts:284`。主张属实。

与 hidden-tab 诊断中"模型加码超时到 90000 被拒"撞的是同一个约束点，但成因不同：那条是为绕开冻结而加码（加多少都没用），这条是**真实需要长时批处理**（20 题遍历 ~26s，稍复杂即超）。放宽上限要权衡 SW 存活与卡死回收，属设计决策，不作为缺陷记。

## 6（P3）scroll 的 moved:false 三义合一

`dom.ts:1472-1490` `doScroll` 恒返回 `success:true` + 回读 `moved`，是刻意设计（#18，agent 据 moved 判断而非盲信 success）。

实机对照：

| target | 结果 |
|---|---|
| `body`（页面不可滚） | `success:true, moved:false, scrolledSelf:false` |
| `#scroller`（真滚动容器） | `success:true, moved:true, scrolledSelf:true` |

所以"无法判断意图达成"不准确——`moved` 就是那个信号。但注释自己列出的三种成因（已在目标边界 / 容器不可滚 / 容器解析错）被压成同一个 `moved:false`，调用方分不清"没必要动"和"目标选错了"。属诊断粒度不足。

---

## 建议动手顺序

1. **1a**（P0，判据单行、修复面小、危害最大：不报错而做错事）
2. hidden-tab rAF 冻结（P0，另一份诊断）
3. **1b + 3**（P1，都是"信息不足/失真"，1b 与 1a 共用裁剪可见性纯函数）
4. 4b / 6（P2-P3，错误分类与诊断粒度）
5. 2（P3，导航态提示）；5 单独作为设计决策讨论
