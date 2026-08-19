# 复审：按你的审核意见修完了

上一轮报告 `reports/_review/luna-pseudo-font-impl-review.md`。修复在 `e44dcb7`，
分支 `feat/query-pseudo-font`（现在共 3 个 commit）。

## 逐条处置

| 你报的 | 处置 |
|--------|------|
| High `maxResults` 全局 maximum:200 误伤 chart | **成立且是 v3.0.0 起的既有回归**（`f7ecb25` 引入）。放宽到 2000，description 按 mode 写清各自上限，加不变量测试锁住（变异 200 转红） |
| High CDP 与探针「数量相同、顺序不同」错位 | **采纳**。探针产指纹（tag+id+文本长度），CDP 侧用 `Runtime.callFunctionOn` 在**同一个数组对象**上求指纹（与 objectId 同源），逐项核对，不一致自陈 |
| High `fontFacesPartial` 契约不清 | **部分采纳**：字段本来就在返回里（`restRes` 透传，真站验过），缺的是语义说明。CHANGELOG 写清 partial（跨域读不到）与 truncated（family 超 20）是两种不同的不完整，`fontFamiliesTotal` 给真实总数 |
| Medium 空 content 粗筛可能丢 | **采纳**，注入侧只排 none/normal |
| Medium `firstChoiceInUse` 语义 | **不改名**，但 CHANGELOG 写清它只答「首选 family 有没有贡献字形」，判主导请比 `glyphCount`（`rendered` 已带） |
| Medium objectId 未释放 | **采纳**，finally 释放数组 + 逐元素对象 |
| Medium 默认全开的代价 | **不改**，schema description 已写「font 用 CDP…需 debugger」 |
| Medium `@font-face` 不递归 grouping rules | **采纳**，递归 `@media`/`@supports`/`@layer`（深度上限 5） |

## 请复核

1. 上面每条的修法是否真的闭合了你报的问题，尤其**指纹方案**：指纹取自
   `Runtime.callFunctionOn(arrayId)`，与 `Runtime.getProperties(arrayId)` 同源，
   我认为这消除了两次独立求值的窗口。有没有仍然漏的场景？指纹强度（tag+id+文本长度）
   够不够？三处一致（真源函数 / CDP 表达式 / 探针内联）靠 `deep-query-expr.test.ts`
   的行为对拍锁，这个锁真的锁得住吗？
2. **新代码本身有没有引入新问题**：`release()` 在 finally 里逐个 await，失败吞掉——
   会不会拖慢或掩盖真错误？`walk()` 的 `cssRules` 检测会不会误入 `CSSKeyframesRule`？
3. 我做的变异验证：14 条，其中「删显式指纹判断」一开始不红（行为等价，只是 reason
   变成 `Cannot read properties of undefined`），补断言锁消息后转红。还有哪条判据是
   改坏了不红的？
4. 我驳回的两条（不改 `firstChoiceInUse` 名字、不改默认全开）理由站得住吗？

全量：extension 2415、mcp 757，全绿；`pnpm build` 过；真站（知乎）复验字体路径正常、
指纹校验未误触发。

报告写 `reports/_review/luna-pseudo-font-recheck.md`。带 `file:line`，禁类比推理。
